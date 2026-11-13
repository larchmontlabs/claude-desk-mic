import type { EngineInterface, Register } from 'claude-code'

import { ensureEngine, findPython } from './engine'
import {
  AWAKE_FOR_MS,
  type Awake,
  type Engine,
  type MicEvent,
  type Rules,
  keyterms,
  parseEvent,
  pauseMsFor,
  planUtterance,
  previewText,
  stopWordSaid,
  rulesFrom,
  splitLines,
} from './rules'

// desk-mic: /mic runs engine/listen.py (in a private venv the mod sets up on
// first run) and turns each thing you say into prompt text. listen.py does the
// listening (speech to text, filler stripping, the mute key, the pause while
// speaking, one mic at a time); this mod does the delivery, the wake and send
// words, and speak-back through engine/speak.py.
//
// Every setting comes from the settings screen (plugin.json userConfig), read
// once from register(on, options).
//
//   /mic                 toggle on/off (/mic on, /mic off)
//   /mic status          say what it's doing

// Where a user sets or changes the sensitive deepgramApiKey after install
// (it is not a row in /config): /plugin configure in Claude Code, or the CLI's
// `claude plugin configure` (both confirmed live, 2026-11-06).
export const KEY_HINT = '/plugin configure desk-mic@claude-desk-mic'

type Ctx = EngineInterface
type Phase = 'off' | 'starting' | 'on'
type Stream = { return: (value: never) => Promise<unknown> }
type Speech = { stream: Stream; pid: number | undefined; isStopped: boolean; done: Promise<void> }

type Config = {
  rules: Rules
  engine: Engine
  apiKey: string
  pauseSeconds: number
  whisperModel: string
  vadLevel: number
  muteKey: string
  speakBack: boolean
  voice: string
}

type State = {
  cfg: Config
  phase: Phase
  // Bumped on every start and stop; a background step from an older run sees
  // a different number and does nothing.
  run: number
  listener: Stream | undefined
  listening: boolean
  speaking: boolean
  muteKey: string | null
  muteKeyProblem: string
  awake: Awake
  // Live words on show in the box: what the box held before them, and every
  // text the mod put there for this sentence (a read of the box can lag a
  // fill, so it may show any of them). Gone once the sentence is finished.
  preview: { base: string; shown: string; paused: boolean } | undefined
  // What the mod last put in the box, and its earlier fills a lagging read may still return.
  box: { latest: string | undefined; older: Set<string>; lastRead: string }
  // Dictated prompts waiting for the session to be idle.
  queued: number
  awakeTimer: { cancel: () => void } | undefined
  // The main loop's running turn, so a stop word can end it.
  turnId: string | undefined
  // Learned at start; speak-back needs them too.
  python: string
  stateDir: string
  platform: 'win32' | 'darwin'
  speech: Speech | undefined
}

const KILL_TIMEOUT_MS = 10000
const ASLEEP: Awake = { isAwake: false, lastHeardMs: 0 }

export function statusText(
  on: boolean,
  listening: boolean,
  speaking: boolean,
  rules: Rules,
  muteKey: string | null,
  needsWakeWord = false,
): string | undefined {
  if (!on) return undefined
  if (!listening) return muteKey ? `mic muted (${muteKey})` : 'mic muted'
  if (speaking) return 'mic paused while speaking'
  const base = rules.mode === 'pause' ? 'mic on - sends when you pause' : `mic on - say "${rules.sendWords[0]}"`
  return needsWakeWord ? `${base} - say "${rules.wakeWords[0]}" first` : base
}

function describe(rules: Rules, pauseSeconds: number): string {
  const wake = rules.useWakeWord ? `starts on "${rules.wakeWords[0]}" and ` : ''
  if (rules.mode === 'pause') {
    return `${wake}sends each sentence after a ${pauseSeconds}s pause`
  }
  const words = rules.sendWords.map(word => `"${word}"`).join(' or ')
  return `${wake}fills the prompt box; say ${words} to send (end of a sentence works)`
}

/** How to clear the box by voice; with the wake word on, it comes first. */
function clearHint(rules: Rules): string {
  return rules.useWakeWord ? `"${rules.wakeWords[0]}, scratch that" clears the box` : '"Scratch that" clears the box'
}

/** speak.py's first stdout line, `{"type":"pid","pid":N}`, or undefined. */
export function parsePidLine(line: string): number | undefined {
  try {
    const value: unknown = JSON.parse(line)
    if (!value || typeof value !== 'object') return undefined
    const { type, pid } = value as { type?: unknown; pid?: unknown }
    return type === 'pid' && typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

/** The command that kills a process and everything it started. */
export function treeKillArgv(platform: 'win32' | 'darwin', pid: number): string[] {
  return platform === 'win32' ? ['taskkill', '/PID', String(pid), '/T', '/F'] : ['pkill', '-TERM', '-P', String(pid)]
}

const str = (v: unknown, fallback: string) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : fallback)
const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

function configFrom(options: Readonly<Record<string, unknown>>): Config {
  return {
    rules: rulesFrom(options),
    engine: options.engine === 'whisper' ? 'whisper' : 'deepgram',
    apiKey: typeof options.deepgramApiKey === 'string' ? options.deepgramApiKey.trim() : '',
    pauseSeconds: num(options.pauseSeconds, 3),
    whisperModel: str(options.whisperModel, 'base.en'),
    vadLevel: num(options.vadLevel, 2),
    muteKey: str(options.muteKey, 'auto'),
    speakBack: options.speakBack === true,
    voice: str(options.voice, 'en-US-AriaNeural'),
  }
}

async function refresh($: Ctx, st: State): Promise<void> {
  if (st.phase !== 'on') return
  const now = await $.clock.now()
  const isAwake = st.awake.isAwake && now - st.awake.lastHeardMs <= AWAKE_FOR_MS
  const needsWake = st.cfg.rules.useWakeWord && !isAwake
  $.ui.status(statusText(true, st.listening, st.speaking, st.cfg.rules, st.muteKey, needsWake))
}

/** Stops speak-back: kills speak.py's whole tree by the pid it printed, then
 *  ends its stream (which alone would kill speak.py but leave the player).
 *  `killed` settles once the kill ran; `done` once the stream has ended. */
function stopSpeech($: Ctx, st: State): { killed: Promise<void>; done: Promise<void> } {
  const s = st.speech
  if (!s) return { killed: Promise.resolve(), done: Promise.resolve() }
  st.speech = undefined
  s.isStopped = true
  const killed = treeKill($, st, s)
  return { killed, done: killed.then(() => s.done) }
}

async function treeKill($: Ctx, st: State, s: Speech): Promise<void> {
  if (s.pid !== undefined) {
    try {
      await $.process.run(treeKillArgv(st.platform, s.pid), { timeoutMs: KILL_TIMEOUT_MS })
    } catch {
      // already gone
    }
    await clearSpeakingFlag($, st.stateDir, s.pid)
  }
  void s.stream.return(undefined as never).catch(() => undefined)
}

/** A killed speak.py (taskkill /F on Windows) never removes its speaking flag.
 *  Empty it, but only while it still names the reply we killed, so a newer
 *  reply's flag is never wiped. An empty flag reads as "not speaking". */
async function clearSpeakingFlag($: Ctx, stateDir: string, pid: number): Promise<void> {
  const flag = `${stateDir}/speaking`
  try {
    if ((await $.fs.read(flag)).trim() === String(pid)) await $.fs.write(flag, '')
  } catch {
    // no flag: nothing to clear
  }
}

/** Reads a reply aloud; a reply still playing is stopped first. Runs in the
 *  background: the turn.complete hook never waits on it. */
async function speak($: Ctx, st: State, answer: string): Promise<void> {
  await stopSpeech($, st).done
  if (st.phase !== 'on' || st.speech) return
  const stream = $.process.spawn({
    argv: [st.python, '-u', `${$.plugin.root}/engine/speak.py`, '--voice', st.cfg.voice, '--state-dir', st.stateDir],
    input: answer,
  })
  let finish = () => {}
  const s: Speech = { stream, pid: undefined, isStopped: false, done: new Promise<void>(r => (finish = r)) }
  st.speech = s
  let out = ''
  try {
    // Once stopped, stop pulling: stopSpeech's own return() ends the stream.
    while (!s.isStopped) {
      const step = await stream.next()
      if (step.done) break
      const chunk = step.value
      if (chunk.stream !== 'stdout' || s.pid !== undefined) continue
      const split = splitLines(out, chunk.text)
      out = split.rest
      for (const line of split.lines) s.pid ??= parsePidLine(line)
    }
  } catch (err) {
    $.ui.log(`desk-mic: speak-back failed: ${String(err)}`, { to: 'debug' })
  }
  if (st.speech === s) st.speech = undefined
  finish()
}

/** The start failed, the listener died, or handling one of its events threw:
 *  end the listener (so the mic is never left open with nothing reading it),
 *  say why and go back to off. */
function failed($: Ctx, st: State, myRun: number, why: string, detail = ''): void {
  if (myRun !== st.run) return
  st.run++
  st.phase = 'off'
  const child = st.listener
  st.listener = undefined
  if (child) void child.return(undefined as never).catch(() => undefined)
  void dropPreview($, st).catch(() => undefined)
  $.ui.status(undefined)
  $.ui.toast(`Mic stopped: ${why}`)
  // The toast goes away; keep the reason (and the listener's last output) where it can be read later.
  if (st.stateDir) {
    const text = detail ? `${why}

Listener output:
${detail}
` : `${why}
`
    void $.fs.write(`${st.stateDir}/last-stop.txt`, text).catch(() => undefined)
  }
  void stopSpeech($, st).killed
}

/** Reads the prompt box. A read can lag the mod's last fill and return a text
 *  the mod put there earlier; that counts as the latest fill until a read
 *  confirms it. Any other text means someone else changed the box. */
async function readBox($: Ctx, st: State): Promise<string> {
  const text = (await $.prompt.read()).text
  const box = st.box
  if (box.latest !== undefined) {
    if (text === box.latest) {
      box.older.clear()
    } else if (box.older.has(text)) {
      return box.latest
    } else {
      box.latest = undefined
      box.older.clear()
    }
  }
  box.lastRead = text
  return text
}

/** Replaces the box's text, remembering it so a lagging read is recognised. */
async function fillBox($: Ctx, st: State, text: string): Promise<boolean> {
  const { isFilled } = await $.prompt.fill({ text, mode: 'replace' })
  if (isFilled) {
    st.box.older.add(st.box.latest ?? st.box.lastRead)
    st.box.latest = text
  }
  return isFilled
}

/** Forgets the mod's fills: the box was sent or changed by someone else. */
function forgetBox(st: State): void {
  st.box = { latest: undefined, older: new Set(), lastRead: '' }
}

/** Whether the box still shows this sentence's live words (or the draft under them). */
function showsPreview(st: State, boxText: string): boolean {
  const p = st.preview
  return p !== undefined && !p.paused && (boxText === p.shown || boxText === p.base)
}

/** Shows the words heard so far in the prompt box, after the draft. An empty
 *  text (the sentence was thrown away) puts the box back as it was. Typing
 *  while live words show pauses them for the rest of the sentence. */
async function onPartial($: Ctx, st: State, text: string): Promise<void> {
  if (st.preview?.paused) {
    if (text.trim() === '') st.preview = undefined
    return
  }
  const now = await readBox($, st)
  if (st.preview && !showsPreview(st, now)) {
    st.preview = { ...st.preview, paused: true }
    return
  }
  const base = st.preview ? st.preview.base : now
  const shown = text.trim() === '' ? undefined : previewText(text, st.cfg.rules, base, st.awake, await $.clock.now())
  if (shown === undefined) {
    if (st.preview && now !== base) await fillBox($, st, base)
    st.preview = undefined
    return
  }
  if (shown !== now && !(await fillBox($, st, shown))) {
    st.preview = undefined
    return
  }
  st.preview = { base, shown, paused: false }
}

/** Takes the live words out of the box, if they are still there. */
async function dropPreview($: Ctx, st: State): Promise<void> {
  const preview = st.preview
  st.preview = undefined
  if (!preview || preview.paused) return
  const now = await readBox($, st)
  if (now === preview.shown && now !== preview.base) await fillBox($, st, preview.base)
}

/** `unsure`: the speech engine was not sure it heard right, so the sentence
 *  may fill the box but is never sent, stopped or cleared on its own word. */
async function onUtterance($: Ctx, st: State, text: string, unsure = false): Promise<void> {
  const now = await readBox($, st)
  const isShowing = showsPreview(st, now)
  const draft = isShowing ? st.preview!.base : now
  const hadPreview = isShowing && now !== draft
  st.preview = undefined
  const nowMs = await $.clock.now()
  let plan = planUtterance(text, st.cfg.rules, draft, st.awake, nowMs)
  // While a reply runs or is read aloud, a bare stop word always works.
  const isBusy = st.turnId !== undefined || st.speech !== undefined
  if (isBusy && plan.action.kind === 'nothing' && stopWordSaid(text, st.cfg.rules)) {
    plan = { action: { kind: 'stop' }, awake: plan.awake }
  }
  if (unsure) {
    const kind = plan.action.kind
    if (plan.action.kind === 'submit') {
      // Hold it in the box, still awake, so the send word alone sends it.
      plan = { action: { kind: 'fill', text: plan.action.text }, awake: { isAwake: true, lastHeardMs: nowMs } }
      const send = st.cfg.rules.sendWords[0]
      $.ui.toast(
        send
          ? `Not sure I heard that right, so it was not sent. Say "${send}" to send it, or "scratch that".`
          : 'Not sure I heard that right, so it was not sent. Your next sentence sends it, or say "scratch that".',
      )
    } else if (kind === 'stop' || kind === 'clear') {
      plan = { action: { kind: 'nothing' }, awake: plan.awake }
      $.ui.toast('Not sure I heard that right. Say it again.')
    }
  }
  const action = plan.action
  // Whether the box still holds what was read (what the mic put there).
  const unchanged = async () => (await readBox($, st)) === now
  if (action.kind === 'fill') {
    // A dialog can hold the prompt box; don't lose what was said.
    if (!(await fillBox($, st, action.text))) {
      $.ui.toast(`Mic heard (box busy): ${text}`)
      return
    }
    st.awake = plan.awake
  } else if (action.kind === 'stop') {
    st.awake = plan.awake
    // Take the stop word's live words back out; the draft stays.
    if (hadPreview && (await unchanged())) await fillBox($, st, draft)
    const turnId = st.turnId
    let stopped = false
    if (turnId !== undefined) {
      try {
        await $.turn.abort({ turnId })
        stopped = true
      } catch (err) {
        $.ui.log(`desk-mic: could not stop the reply: ${String(err)}`, { to: 'debug' })
      }
      if (st.turnId === turnId) st.turnId = undefined
    }
    const hadSpeech = st.speech !== undefined
    await stopSpeech($, st).killed
    const said = stopped ? 'Stopped.' : hadSpeech ? 'Stopped reading.' : 'Nothing to stop.'
    // There is no way to take back a queued prompt, so say it will still go.
    $.ui.toast(st.queued > 0 ? `${said} A dictated prompt is still queued and will be sent.` : said)
  } else if (action.kind === 'clear') {
    st.awake = plan.awake
    await fillBox($, st, '')
  } else if (action.kind === 'submit') {
    st.awake = plan.awake
    // A plugin prompt waits until the session is idle, which can take a whole
    // turn. Never wait on it here: the listener's events must keep flowing.
    void submitted($, st, action.text)
    // The text now belongs to the submit, so free the box for the next prompt.
    if (now.trim() !== '' && (await unchanged())) await fillBox($, st, '')
  } else {
    st.awake = plan.awake
    // Nothing to do with the sentence: take its live words back out.
    if (hadPreview && (await unchanged())) await fillBox($, st, draft)
  }
  if (st.awake.isAwake) {
    // Refresh once the awake stretch runs out, so the status asks for the wake word again.
    st.awakeTimer?.cancel()
    st.awakeTimer = $.clock.after(AWAKE_FOR_MS + 1, () => void refresh($, st))
  }
}

/** Sends a dictated prompt and deals with the result whenever it comes. */
async function submitted($: Ctx, st: State, text: string): Promise<void> {
  let isSent = false
  st.queued++
  try {
    const result = await $.prompt.submit({ text, asUser: true })
    isSent = result.drop === undefined
  } catch {
    isSent = false
  } finally {
    st.queued--
  }
  try {
    if (isSent) {
      // A mod's own $.prompt.submit does not pass through its own prompt.submit
      // hook (seen under `claude plugin test`), so stop speech here as well.
      await stopSpeech($, st).killed
      return
    }
    $.ui.toast(`Not sent: ${text}`)
    // Keep the draft: put it back, unless something new is in the box by now.
    if ((await readBox($, st)).trim() === '') await fillBox($, st, text)
  } catch (err) {
    $.ui.log(`desk-mic: after a dictated submit: ${String(err)}`, { to: 'debug' })
  }
}

async function handle($: Ctx, st: State, myRun: number, event: MicEvent): Promise<void> {
  if (myRun !== st.run) return
  switch (event.type) {
    case 'ready':
      st.phase = 'on'
      st.muteKey = event.mute_key
      $.ui.toast(st.muteKey ? `Mic on (${event.device}). ${st.muteKey} mutes.` : 'Mic on (mute key unavailable)')
      break
    case 'loading':
      $.ui.status(`mic: downloading or loading Whisper model ${event.model} (first run downloads it)`)
      return
    case 'partial':
      if (st.phase === 'on') await onPartial($, st, event.text)
      return
    case 'state':
      st.listening = event.listening
      if (!st.listening) await dropPreview($, st)
      if (!st.listening) st.awake = { ...ASLEEP, lastHeardMs: st.awake.lastHeardMs }
      break
    case 'speaking':
      st.speaking = event.playing
      break
    case 'takeover':
      $.ui.toast('Took the mic over from another session.')
      break
    case 'error':
      // The mute key failing is reported, but the mic keeps working.
      if (event.stage === 'mute_key') {
        st.muteKeyProblem = event.message
        $.ui.log(`desk-mic: ${event.message}`, { to: 'debug' })
        return
      }
      failed($, st, myRun, event.message)
      return
    case 'utterance':
      if (st.phase === 'on') await onUtterance($, st, event.text)
      break
    case 'unsure':
      if (st.phase === 'on') await onUtterance($, st, event.text, true)
      break
  }
  await refresh($, st)
}

/** Finds Python, installs the engine on first run, then runs the listener
 *  until it ends. All of it runs on after /mic has returned. */
async function start($: Ctx, st: State, myRun: number, pauseMs: number): Promise<void> {
  const { cfg } = st
  const py = await findPython($)
  if (myRun !== st.run) return
  if ('error' in py) return failed($, st, myRun, py.error)
  const ready = await ensureEngine($, py, cfg.engine, $.plugin.root)
  if (myRun !== st.run) return
  if ('error' in ready) return failed($, st, myRun, ready.error)
  $.ui.status('mic starting...')

  st.python = ready.python
  st.platform = py.platform
  st.stateDir = `${py.home.replace(/[\\/]+$/, '')}/.claude-desk-mic`
  const argv = [
    st.python,
    '-u',
    `${$.plugin.root}/engine/listen.py`,
    '--emit-json',
    '--state-dir',
    st.stateDir,
    '--engine',
    cfg.engine,
    '--pause-ms',
    String(pauseMs),
    '--mute-key',
    cfg.muteKey,
    '--vad-level',
    String(cfg.vadLevel),
    '--parent-pid',
    String(py.sessionPid),
    ...(cfg.engine === 'whisper' ? ['--model', cfg.whisperModel] : []),
    ...keyterms(cfg.rules).flatMap(term => ['--keyterm', term]),
  ]
  // The key goes only in the child's environment, never argv.
  const child = $.process.spawn({ argv, env: { DEEPGRAM_API_KEY: cfg.apiKey } })
  st.listener = child

  let out = ''
  let errTail = ''
  let code: number | null = null
  try {
    while (true) {
      const step = await child.next()
      if (step.done) {
        code = step.value.code
        break
      }
      if (myRun !== st.run) continue
      const { stream, text } = step.value
      if (stream === 'stderr') {
        errTail = (errTail + text).slice(-2000)
        continue
      }
      const split = splitLines(out, text)
      out = split.rest
      for (const line of split.lines) {
        const event = parseEvent(line)
        if (!event) continue
        try {
          await handle($, st, myRun, event)
        } catch (err) {
          return failed($, st, myRun, `desk-mic hit an error and turned the mic off: ${String(err)}`)
        }
      }
    }
  } catch (err) {
    return failed($, st, myRun, `could not start the listener: ${String(err)}`)
  }
  if (myRun !== st.run) return
  $.ui.log(`desk-mic listener exited (code ${code}): ${errTail.slice(-800)}`, { to: 'debug' })
  const lastLine = errTail.trim().split(/\r?\n/).pop() ?? ''
  failed($, st, myRun, lastLine || `exit code ${code}`, errTail.slice(-1500))
}

async function stopMic($: Ctx, st: State): Promise<void> {
  st.run++
  st.phase = 'off'
  const child = st.listener
  st.listener = undefined
  // Ending the stream kills the listener on both OS.
  if (child) void child.return(undefined as never).catch(() => undefined)
  await dropPreview($, st)
  await stopSpeech($, st).killed
  $.ui.status(undefined)
}

async function micCommand($: Ctx, st: State, args: string): Promise<string> {
  const { cfg } = st
  const sub = (args.trim().split(/\s+/)[0] ?? '').toLowerCase()

  if (sub === 'status') {
    if (st.phase === 'starting') return 'Mic is starting.'
    if (st.phase === 'off') {
      return `Mic is off. When on, it ${describe(cfg.rules, cfg.pauseSeconds)}. Type /mic to turn it on.`
    }
    const key = st.muteKey
      ? ` ${st.muteKey} mutes.`
      : ` Mute key unavailable${st.muteKeyProblem ? `: ${st.muteKeyProblem}` : ''}.`
    return `Mic is on (${st.listening ? 'listening' : 'muted'}). It ${describe(cfg.rules, cfg.pauseSeconds)}.${key}`
  }

  const wantOn = sub === 'on' ? true : sub === 'off' ? false : sub === '' ? st.phase === 'off' : undefined
  if (wantOn === undefined) return 'Use /mic, /mic on, /mic off or /mic status.'

  if (!wantOn) {
    if (st.phase === 'off') return 'Mic is already off.'
    await stopMic($, st)
    return 'Mic off.'
  }

  if (st.phase === 'on') return 'Mic is already on.'
  if (st.phase === 'starting') return 'Mic is already starting.'
  if (cfg.engine === 'deepgram' && cfg.apiKey === '') {
    // A blank setting falls back to DEEPGRAM_API_KEY, so one key set on the
    // computer serves every Claude account.
    const fromEnv = ((await $.env.get('DEEPGRAM_API_KEY')) ?? '').trim()
    if (fromEnv === '') {
      return `Set your Deepgram key with ${KEY_HINT} or the DEEPGRAM_API_KEY environment variable, or switch engine to whisper.`
    }
    st.cfg = { ...cfg, apiKey: fromEnv }
  }
  // Checked before anything is spawned or installed.
  const pause = pauseMsFor(cfg.engine, cfg.pauseSeconds)
  if ('error' in pause) return pause.error

  const myRun = ++st.run
  st.phase = 'starting'
  st.listening = true
  st.speaking = false
  st.muteKey = null
  st.muteKeyProblem = ''
  st.awake = ASLEEP
  st.preview = undefined
  $.ui.status('mic starting...')
  // Finding Python, a first-run install and the listener all run on after
  // /mic returns, so a long pip run never holds the command.
  void start($, st, myRun, pause.ms).catch(err => failed($, st, myRun, String(err)))
  return `Mic starting... It ${describe(cfg.rules, cfg.pauseSeconds)}. ${clearHint(cfg.rules)}. /mic turns it off.`
}

export const register: Register = (on, options) => {
  // Module state resets on reload; the engine kills the children on unload
  // too, so "off" after a reload is the truth.
  const st: State = {
    cfg: configFrom(options),
    phase: 'off',
    run: 0,
    listener: undefined,
    listening: true,
    speaking: false,
    muteKey: null,
    muteKeyProblem: '',
    awake: ASLEEP,
    preview: undefined,
    box: { latest: undefined, older: new Set(), lastRead: '' },
    queued: 0,
    awakeTimer: undefined,
    turnId: undefined,
    python: '',
    stateDir: '',
    platform: 'win32',
    speech: undefined,
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'mic',
      description: 'Desk mic: toggle, or on | off | status',
    })
    $.ui.status(undefined)
    return next(e)
  })

  on('command.run', { command: 'mic' }, async ($, e) => ({ text: await micCommand($, st, e.args) }))

  // Any prompt, typed or spoken, stops speech and ends the awake stretch.
  on('prompt.submit', async ($, e, next) => {
    st.awake = { ...ASLEEP, lastHeardMs: st.awake.lastHeardMs }
    // A typed send empties the box; the mod's earlier fills mean nothing now.
    st.preview = undefined
    forgetBox(st)
    await stopSpeech($, st).killed
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) st.turnId = e.turnId
    return next(e)
  })

  // Speak-back: every main-loop answer while the mic is on.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && e.turnId === st.turnId) st.turnId = undefined
    const isSpoken = st.cfg.speakBack && st.phase === 'on' && e.agentId === undefined && e.reason === 'answer'
    if (isSpoken && e.answer.trim() !== '') void speak($, st, e.answer)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await stopSpeech($, st).killed
    return next(e)
  })
}

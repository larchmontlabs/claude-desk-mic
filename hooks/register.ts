import type { Register } from 'claude-code'

// desk-mic: /mic runs voice-bridge's desk_mic.py in --emit-json mode and turns
// each thing you say into prompt text. desk_mic.py does the listening
// (Deepgram, filler stripping, Right Ctrl mute, TTS pause, one-mic-at-a-time
// lock); this mod does the delivery, so no window title or fake key presses.
//
// desk_mic.py reports a sentence once you stop talking for UTTERANCE_END_MS
// (stt.py; 3000 ms by default, the same pause the phone bridge uses).
//
//   /mic                 toggle on/off (/mic on, /mic off)
//   /mic pause           send each sentence when you pause, like the phone
//   /mic pause <secs>    ...and set how long the pause is (next /mic start)
//   /mic word            build up the prompt box until you say a send word
//   /mic word <a, b>     ...and set the send word(s)
//   /mic status          say what it's doing

const BRIDGE_DIR = '<path to your voice-bridge checkout>'
const PYTHON = `${BRIDGE_DIR}/venv/Scripts/python.exe`
const DEFAULT_WORDS = ['send it']
// Where a user sets or changes the sensitive deepgramApiKey after install
// (it is not a row in /config). The command exists in `claude plugin --help`;
// the id form name@marketplace comes from the CLI's own error message.
export const KEY_HINT = 'run: claude plugin configure desk-mic@claude-desk-mic'
// Deepgram's utterance_end_ms takes 1000 ms at the least.
const MIN_PAUSE_SECONDS = 1

export type Mode = 'pause' | 'word'
export type Settings = { mode: Mode; words: readonly string[]; pauseSeconds?: number }

export type MicEvent =
  | { type: 'ready'; hotkey: string; device: string; pid: number }
  | { type: 'utterance'; text: string }
  | { type: 'state'; listening: boolean; source: string }
  | { type: 'tts'; playing: boolean }
  | { type: 'takeover'; previous_pid: number }
  | { type: 'error'; message: string }

const CLEAR_WORDS = /^\s*(?:clear (?:that|it|the prompt)|scratch that)[.!]?\s*$/i

/** Splits streamed text into whole lines; returns the lines and the leftover. */
export function splitLines(buffer: string, chunk: string): { lines: string[]; rest: string } {
  const parts = (buffer + chunk).split(/\r?\n/)
  const rest = parts.pop() ?? ''
  return { lines: parts.filter(line => line.trim() !== ''), rest }
}

/** One stdout line from desk_mic.py, or undefined if it isn't one of ours. */
export function parseEvent(line: string): MicEvent | undefined {
  try {
    const value = JSON.parse(line)
    return value && typeof value.type === 'string' ? (value as MicEvent) : undefined
  } catch {
    return undefined
  }
}

/** A comma list of send words, trimmed, blanks dropped. */
export function parseWords(input: string): string[] {
  return input
    .split(',')
    .map(word => word.trim())
    .filter(word => word !== '')
}

/** Settings from the store, falling back to defaults for anything missing or bad. */
export function parseSettings(stored: unknown): Settings {
  const value = (stored ?? {}) as Partial<Settings>
  const mode: Mode = value.mode === 'pause' ? 'pause' : 'word'
  const words =
    Array.isArray(value.words) && value.words.every(w => typeof w === 'string') && value.words.length > 0
      ? value.words
      : DEFAULT_WORDS
  const settings: Settings = { mode, words }
  if (typeof value.pauseSeconds === 'number' && value.pauseSeconds >= MIN_PAUSE_SECONDS) {
    settings.pauseSeconds = value.pauseSeconds
  }
  return settings
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The send word at the very end of `text`, as whole words, ignoring case and end punctuation. */
function endingWord(words: readonly string[]): RegExp {
  const alternatives = words.map(word => word.trim().split(/\s+/).map(escapeRegExp).join('\\s+'))
  return new RegExp(`(?:^|[\\s,;:.!?]+)(?:${alternatives.join('|')})[\\s.!?]*$`, 'i')
}

/** Removes a trailing send word. Returns the rest and whether one was there. */
function cutSendWord(text: string, words: readonly string[]): { text: string; hadWord: boolean } {
  if (words.length === 0) return { text, hadWord: false }
  const match = endingWord(words).exec(text)
  if (!match) return { text, hadWord: false }
  return { text: text.slice(0, match.index).replace(/[\s,;:]+$/, ''), hadWord: true }
}

function join(draft: string, text: string): string {
  const head = draft.trim()
  const tail = text.trim()
  if (head === '') return tail
  if (tail === '') return head
  return `${head} ${tail}`
}

export type Action =
  | { kind: 'submit'; text: string }
  | { kind: 'fill'; text: string }
  | { kind: 'clear' }
  | { kind: 'nothing' }

/** What to do with one spoken sentence, given the settings and the current draft. */
export function planUtterance(text: string, settings: Settings, draft: string): Action {
  if (CLEAR_WORDS.test(text)) return { kind: 'clear' }
  const cut = cutSendWord(text, settings.words)
  const full = join(draft, cut.text)
  if (settings.mode === 'pause' || cut.hadWord) {
    return full === '' ? { kind: 'nothing' } : { kind: 'submit', text: full }
  }
  return { kind: 'fill', text: full }
}

export function statusText(on: boolean, listening: boolean, tts: boolean, settings: Settings): string | undefined {
  if (!on) return undefined
  if (!listening) return 'mic muted (Right Ctrl)'
  if (tts) return 'mic paused while speaking'
  return settings.mode === 'pause' ? 'mic on - sends when you pause' : `mic on - say "${settings.words[0]}"`
}

function describe(settings: Settings): string {
  const pause = settings.pauseSeconds ?? 3
  if (settings.mode === 'pause') {
    return `sends each sentence after a ${pause}s pause`
  }
  const words = settings.words.map(word => `"${word}"`).join(' or ')
  return `fills the prompt box; say ${words} to send (end of a sentence works)`
}

export const register: Register = on => {
  // Module variables reset on reload; the engine kills the child on unload too,
  // so "off" after a reload is the truth.
  let isOn = false
  let isStopping = false
  let pid: number | undefined
  let listening = true
  let tts = false
  let settings: Settings = parseSettings(undefined)
  let lastError = ''

  on('session.start', async ($, e, next) => {
    const stored = await $.store.get('settings')
    if (stored !== undefined) {
      settings = parseSettings(stored)
    } else {
      // Version 0.1 kept only a mode: 'fill' (send word) or 'send' (each sentence).
      const old = await $.store.get('mode')
      settings = parseSettings({ mode: old === 'send' ? 'pause' : 'word' })
    }
    await $.command.register({
      name: 'mic',
      description: 'Desk mic: toggle, or on | off | pause [secs] | word [a, b] | status',
    })
    $.ui.status(undefined)
    return next(e)
  })

  on('command.run', { command: 'mic' }, async ($, e) => {
    const raw = e.args.trim()
    const head = raw.split(/\s+/)[0] ?? ''
    const sub = head.toLowerCase()
    const rest = raw.slice(head.length).trim()
    const refresh = () => $.ui.status(statusText(isOn, listening, tts, settings))
    const save = async () => {
      await $.store.set('settings', settings)
      refresh()
    }
    const restartNote = isOn ? ' Takes effect the next time you turn the mic on.' : ''

    if (sub === 'pause' || sub === 'send') {
      if (rest !== '') {
        const seconds = Number(rest)
        if (!Number.isFinite(seconds) || seconds < MIN_PAUSE_SECONDS) {
          return { text: `Pause must be a number of seconds, ${MIN_PAUSE_SECONDS} or more.` }
        }
        settings = { ...settings, mode: 'pause', pauseSeconds: seconds }
        await save()
        return { text: `Mic ${describe(settings)}.${restartNote}` }
      }
      settings = { ...settings, mode: 'pause' }
      await save()
      return { text: `Mic ${describe(settings)}.` }
    }

    if (sub === 'word' || sub === 'fill') {
      if (rest !== '') {
        const words = parseWords(rest)
        if (words.length === 0) return { text: 'Give at least one send word, like /mic word over.' }
        settings = { ...settings, mode: 'word', words }
      } else {
        settings = { ...settings, mode: 'word' }
      }
      await save()
      return { text: `Mic ${describe(settings)}.` }
    }

    if (sub === 'status') {
      if (!isOn) return { text: `Mic is off. When on, it ${describe(settings)}. Type /mic to turn it on.` }
      return { text: `Mic is on (${listening ? 'listening' : 'muted'}). It ${describe(settings)}.` }
    }

    const wantOn = sub === 'on' ? true : sub === 'off' ? false : sub === '' ? !isOn : undefined
    if (wantOn === undefined) {
      return { text: 'Use /mic, /mic on, /mic off, /mic pause [secs], /mic word [a, b] or /mic status.' }
    }

    if (!wantOn) {
      if (!isOn) return { text: 'Mic is already off.' }
      isStopping = true
      if (pid !== undefined) {
        await $.process.run(['taskkill', '/PID', String(pid), '/T', '/F'], { timeoutMs: 10000 })
      }
      return { text: 'Mic off.' }
    }

    if (isOn) return { text: 'Mic is already on.' }
    isOn = true
    isStopping = false
    listening = true
    tts = false
    pid = undefined
    lastError = ''
    $.ui.status('mic starting...')

    const env: Record<string, string> = {}
    if (settings.pauseSeconds !== undefined) {
      env.UTTERANCE_END_MS = String(Math.round(settings.pauseSeconds * 1000))
    }
    const child = $.process.spawn({
      argv: [PYTHON, '-u', 'desk_mic.py', '--emit-json'],
      cwd: BRIDGE_DIR,
      env,
    })

    const handle = async (event: MicEvent) => {
      switch (event.type) {
        case 'ready':
          pid = event.pid
          $.ui.toast(`Mic on (${event.device}). Right Ctrl mutes.`)
          break
        case 'state':
          listening = event.listening
          break
        case 'tts':
          tts = event.playing
          break
        case 'takeover':
          $.ui.toast('Took the mic over from another session.')
          break
        case 'error':
          lastError = event.message
          break
        case 'utterance': {
          const box = await $.prompt.read()
          const action = planUtterance(event.text, settings, box.text)
          if (action.kind === 'fill') {
            const filled = await $.prompt.fill({ text: action.text, mode: 'replace' })
            // A dialog can hold the prompt box; don't lose what was said.
            if (!filled.isFilled) $.ui.toast(`Mic heard (box busy): ${event.text}`)
          } else if (action.kind === 'clear') {
            await $.prompt.fill({ text: '', mode: 'replace' })
          } else if (action.kind === 'submit') {
            if (box.text.trim() !== '') await $.prompt.fill({ text: '', mode: 'replace' })
            void $.prompt.submit({ text: action.text })
          }
          break
        }
      }
      refresh()
    }

    void (async () => {
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
          const { stream, text } = step.value
          if (stream === 'stderr') {
            errTail = (errTail + text).slice(-2000)
            continue
          }
          const split = splitLines(out, text)
          out = split.rest
          for (const line of split.lines) {
            const event = parseEvent(line)
            if (event) await handle(event)
          }
        }
      } catch (err) {
        lastError = `could not start desk_mic.py: ${String(err)}`
      }
      const wasStopping = isStopping
      isOn = false
      pid = undefined
      $.ui.status(undefined)
      if (!wasStopping) {
        const lastLine = errTail.trim().split(/\r?\n/).pop() ?? ''
        const why = lastError || lastLine || `exit code ${code}`
        $.ui.toast(`Mic stopped: ${why}`)
        $.ui.log(`desk-mic stopped (code ${code}): ${errTail.slice(-800)}`, { to: 'debug' })
      }
    })()

    return { text: `Mic starting. It ${describe(settings)}. "Scratch that" clears the box. Right Ctrl mutes, /mic turns it off.` }
  })
}

import type { On } from 'claude-code'
import { type Engine, expect, mock, test } from 'claude-code/testing'

declare const setTimeout: (callback: () => void, ms: number) => unknown

import { LISTENER_EVENTS_JSONL } from './fixtures/listener-events'
import type { Rules } from './rules'
import { KEY_HINT, parsePidLine, statusText, treeKillArgv } from './register'

const WORD: Rules = { mode: 'word', sendWords: ['send it'], stopWords: ['stop', 'cancel', 'wait', 'hold on', 'never mind'], useWakeWord: false, wakeWords: ['claude'] }
const PAUSE: Rules = { mode: 'pause', sendWords: ['send it'], stopWords: ['stop', 'cancel', 'wait', 'hold on', 'never mind'], useWakeWord: false, wakeWords: ['claude'] }
const WAKE: Rules = { ...WORD, useWakeWord: true }

/** The fixture line of one event type, as the listener writes it. */
function fixtureLine(type: string): string {
  const line = LISTENER_EVENTS_JSONL.split(/\r?\n/).find(l => l.includes(`"type":"${type}"`))
  if (line === undefined) throw new Error(`no ${type} line in the fixture`)
  return line
}

const READY = (muteKey: string | null) =>
  JSON.stringify({ type: 'ready', device: 'Desk Microphone', mute_key: muteKey, pid: 4242 })
const UTTER = (text: string) => JSON.stringify({ type: 'utterance', text })
const UNSURE = (text: string) => JSON.stringify({ type: 'unsure', text })
const PARTIAL = (text: string) => JSON.stringify({ type: 'partial', text })
const STATE = (listening: boolean) => JSON.stringify({ type: 'state', listening, source: 'mute key' })
const ERROR = (stage: string, message: string) => JSON.stringify({ type: 'error', stage, message })

const tick = () => new Promise<void>(resolve => setTimeout(() => resolve(), 2))

/** Waits (real time, a short while) until `check` holds; fails the test otherwise. */
async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (check()) return
    await tick()
  }
  throw new Error(`timed out waiting for: ${what}`)
}

/** Lets background work run on with nothing new to wait for. */
async function drain(): Promise<void> {
  for (let i = 0; i < 15; i++) await tick()
}

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void }
function deferred<T>(): Deferred<T> {
  let resolve: (v: T) => void = () => {}
  let reject: (e: unknown) => void = () => {}
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** One spawned listener: the test feeds it lines and an exit. */
class Feed {
  items: ({ line: string } | { exit: number })[] = []
  wake: (() => void) | undefined
  sawReturn = false
  ended = false
  push(item: { line: string } | { exit: number }) {
    this.items.push(item)
    this.wake?.()
  }
  async take() {
    while (this.items.length === 0 && !this.sawReturn) await new Promise<void>(r => (this.wake = r))
    return this.items.shift()
  }
}

type Speaker = { argv: readonly string[]; input: string | undefined; pid: number; killed: Deferred<void>; sawReturn: boolean }

type RigOptions = {
  platform?: 'win32' | 'darwin'
  pipHangs?: boolean
  fillBusy?: boolean
  fillThrows?: boolean
  // prompt.read lags one fill behind, as the real prompt box can.
  staleReads?: boolean
  env?: Record<string, string>
  submit?: (text: string) => Promise<{ text: string }>
}

const HOME = { win32: 'C:/Users/t', darwin: '/Users/t' }
const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

/** The world beneath the mod: Python, pip, the listener, speak.py, the prompt box. */
function rig(on: On, o: RigOptions = {}) {
  const platform = o.platform ?? 'win32'
  const clock = mock.clock(on)
  mock.env(on, o.env ?? {})
  const r = {
    clock,
    platform,
    statuses: [] as (string | undefined)[],
    toasts: [] as string[],
    runs: [] as (readonly string[])[],
    spawns: [] as { argv: readonly string[]; env: Record<string, string> | undefined }[],
    listeners: [] as Feed[],
    speakers: [] as Speaker[],
    draft: '',
    shownBefore: '',
    fills: [] as string[],
    submits: [] as { text: string; origin: unknown }[],
    aborts: [] as string[],
    writes: {} as Record<string, string>,
    nextPid: 77,
    get status() {
      return this.statuses[this.statuses.length - 1]
    },
    get listener() {
      const l = this.listeners[this.listeners.length - 1]
      if (!l) throw new Error('no listener spawned')
      return l
    },
  }

  on('ui.status', (_, e) => {
    r.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    r.toasts.push(String(e.text))
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'mic' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.abort', (_, e) => {
    r.aborts.push(e.turnId)
    return { value: undefined }
  })
  // Paths are kept with forward slashes (the engine hands them over with backslashes on Windows).
  const key = (path: string) => path.replace(/\\/g, '/')
  on('fs.read', (_, e) => ({ value: r.writes[key(e.path)] ?? 'pkg==1\n' }))
  on('fs.write', (_, e) => {
    r.writes[key(e.path)] = e.text
    return { value: undefined }
  })
  on('fs.exists', (_, e) => ({ value: key(e.path) in r.writes }))
  on('process.run', async (_, e) => {
    const argv = e.argv
    r.runs.push(argv)
    const code = argv.join(' ')
    if (code.includes('sys.version_info')) return ok(JSON.stringify([[3, 12], platform, HOME[platform]]))
    if (code.includes('sys.executable')) return ok('/py/python\n')
    if (code.includes('getppid')) return ok('4242\n')
    if (argv.includes('pip') && o.pipHangs) return new Promise<never>(() => {})
    if (argv[0] === 'taskkill' || argv[0] === 'pkill') {
      const pid = Number(argv[argv[0] === 'taskkill' ? 2 : 3])
      r.speakers.find(s => s.pid === pid)?.killed.resolve()
    }
    return ok()
  })
  on('prompt.read', () => {
    const text = o.staleReads ? r.shownBefore : r.draft
    return { value: { text, cursor: text.length } }
  })
  // The engine beneath: an edit leaves the spliced text in the box; a change only reports.
  on('prompt.edit', (_, e) => {
    const text = e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end)
    return { text, cursor: e.start + e.inputText.length }
  })
  on('prompt.change', (_, e) => ({ text: e.text }))
  on('prompt.fill', (_, e) => {
    if (o.fillThrows) throw new Error('fill denied by another hook')
    if (o.fillBusy) return { isFilled: false }
    r.shownBefore = r.draft
    r.draft = e.text
    r.fills.push(e.text)
    return { isFilled: true }
  })
  on('prompt.submit', async (_, e) => {
    r.submits.push({ text: e.text, origin: e.origin })
    if (o.submit) return o.submit(e.text)
    return { text: e.text }
  })
  // The kit aborts next.signal when the mod calls return() on the stream.
  on('process.spawn', async function* (_, e, next) {
    r.spawns.push({ argv: e.argv, env: e.env })
    if (e.argv.some(a => a.endsWith('/engine/speak.py'))) {
      const s: Speaker = { argv: e.argv, input: e.input, pid: r.nextPid++, killed: deferred<void>(), sawReturn: false }
      r.speakers.push(s)
      next.signal.addEventListener('abort', () => (s.sawReturn = true))
      let finished = false
      try {
        yield { stream: 'stdout', text: `{"type":"pid","pid":${s.pid}}\n` }
        // Playing until the tree kill lands; then the child dies.
        await s.killed.promise
        yield { stream: 'stderr', text: 'killed\n' }
        finished = true
        return { value: { code: 1, signal: null } }
      } finally {
        if (!finished) s.sawReturn = true
      }
    }
    const f = new Feed()
    r.listeners.push(f)
    next.signal.addEventListener('abort', () => {
      f.sawReturn = true
      f.wake?.()
    })
    try {
      while (true) {
        const item = await f.take()
        if (item === undefined) break
        if ('exit' in item) {
          f.ended = true
          return { value: { code: item.exit, signal: null } }
        }
        yield { stream: 'stdout', text: `${item.line}\n` }
      }
      return { value: { code: null, signal: 'SIGTERM' } }
    } finally {
      if (!f.ended) f.sawReturn = true
    }
  })
  return r
}

type Rig = ReturnType<typeof rig>
type Dollar = Engine

async function begin($: Dollar) {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
}

async function mic($: Dollar, args = ''): Promise<string> {
  const ran = await $.command.run({
    command: 'mic',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })
  return String(ran.text)
}

/** /mic, the listener spawned, and its ready line read. */
async function micOn($: Dollar, r: Rig, muteKey: string | null = 'Right Ctrl') {
  const before = r.listeners.length
  expect(await mic($, 'on')).toMatch(/Mic starting/)
  await until(() => r.listeners.length > before, 'the listener spawn')
  await say(r, READY(muteKey))
}

/** prompt.edit and prompt.change are events the engine raises, not calls on
 *  a test's typed `$`; the kit's `$` still raises them by name. */
type Raise = { edit: (e: unknown) => Promise<unknown>; change: (e: unknown) => Promise<unknown> }

/** The person types: the engine's prompt.edit, as the composer raises it,
 *  replacing the whole box with `text`. */
async function typeInBox($: Dollar, r: Rig, text: string) {
  const before = r.draft
  await ($.prompt as unknown as Raise).edit({ origin: { kind: 'composer' }, text: before, cursor: before.length, start: 0, end: before.length, inputText: text })
  r.draft = text
}

/** Something other than the mod empties the box (a typed send, a clear). */
async function boxCleared($: Dollar, r: Rig) {
  r.draft = ''
  await ($.prompt as unknown as Raise).change({ text: '', cursor: 0, origin: { kind: 'clear' } })
}

/** One listener line, then wait for the mod to have handled it. */
async function say(r: Rig, line: string) {
  r.listener.push({ line })
  await until(() => r.listener.items.length === 0, 'the line to be read')
  await drain()
}

const turn = (answer: string, extra: Record<string, unknown> = {}) => ({
  answer,
  durationMs: 1,
  isAborted: false,
  turnId: 't1',
  reason: 'answer' as const,
  ...extra,
})

const argPair = (argv: readonly string[], flag: string) => {
  const i = argv.indexOf(flag)
  return i < 0 ? undefined : argv[i + 1]
}

// ---- pure parts --------------------------------------------------------

test('status line text', async () => {
  expect(statusText(false, true, false, WORD, 'Right Ctrl')).toBe(undefined)
  expect(statusText(true, false, false, WORD, 'Right Ctrl')).toBe('mic muted (Right Ctrl)')
  expect(statusText(true, false, false, WORD, 'Right Option')).toBe('mic muted (Right Option)')
  expect(statusText(true, false, false, WORD, null)).toBe('mic muted')
  expect(statusText(true, true, true, PAUSE, 'Right Ctrl')).toBe('mic paused while speaking')
  expect(statusText(true, true, false, WORD, 'Right Ctrl')).toBe('mic on - say "send it"')
  expect(statusText(true, true, false, PAUSE, 'Right Ctrl')).toBe('mic on - sends when you pause')
  expect(statusText(true, true, false, WAKE, 'Right Ctrl', true)).toBe('mic on - say "send it" - say "claude" first')
})

test('speak.py pid line and the tree kill per OS', async () => {
  expect(parsePidLine('{"type":"pid","pid":77}')).toBe(77)
  expect(parsePidLine('{"type":"ready","pid":77}')).toBe(undefined)
  expect(parsePidLine('not json')).toBe(undefined)
  expect(treeKillArgv('win32', 77)).toEqual(['taskkill', '/PID', '77', '/T', '/F'])
  expect(treeKillArgv('darwin', 77)).toEqual(['pkill', '-TERM', '-P', '77'])
})

// ---- refusing to start -------------------------------------------------

test('refuses to start without a key', { options: { engine: 'deepgram' } }, async ($, on) => {
  const r = rig(on)
  await begin($)
  const text = await mic($)
  expect(text).toMatch(/Deepgram key/)
  expect(text).toContain(KEY_HINT)
  await drain()
  expect(r.spawns.length).toBe(0)
  expect(r.runs.length).toBe(0)
})

test('a blank key setting falls back to DEEPGRAM_API_KEY', { options: { engine: 'deepgram' } }, async ($, on) => {
  const r = rig(on, { env: { DEEPGRAM_API_KEY: ' env-key ' } })
  await begin($)
  expect(await mic($)).toMatch(/Mic starting/)
  await until(() => r.listeners.length === 1, 'the listener spawn')
  expect(r.spawns[0]!.env).toEqual({ DEEPGRAM_API_KEY: 'env-key' })
})

test('the key setting wins over DEEPGRAM_API_KEY', { options: { engine: 'deepgram', deepgramApiKey: 'setting-key' } }, async ($, on) => {
  const r = rig(on, { env: { DEEPGRAM_API_KEY: 'env-key' } })
  await begin($)
  await mic($)
  await until(() => r.listeners.length === 1, 'the listener spawn')
  expect(r.spawns[0]!.env).toEqual({ DEEPGRAM_API_KEY: 'setting-key' })
})

// A pause under one second never reaches the mod: plugin.json's `min: 1`
// fails the load first (the kit refuses `pauseSeconds: 0.5`). The Whisper
// message itself is covered by pauseMsFor's test in rules.test.ts.

for (const pauseSeconds of [6, 2.0005]) {
  test(
    `refuses a Deepgram pause outside 1 to 5 seconds (${pauseSeconds})`,
    { options: { engine: 'deepgram', deepgramApiKey: 'k', pauseSeconds } },
    async ($, on) => {
      const r = rig(on)
      await begin($)
      expect(await mic($)).toMatch(/1 to 5 seconds/)
      await drain()
      expect(r.spawns.length).toBe(0)
      expect(r.runs.length).toBe(0)
    },
  )
}

test('whisper takes a long pause', { options: { engine: 'whisper', pauseSeconds: 6 } }, async ($, on) => {
  const r = rig(on)
  await begin($)
  await micOn($, r)
  expect(argPair(r.spawns[0]!.argv, '--pause-ms')).toBe('6000')
})

// ---- starting ----------------------------------------------------------

test('mic returns before the install finishes', { options: { engine: 'whisper' } }, async ($, on) => {
  const r = rig(on, { pipHangs: true })
  await begin($)
  expect(await mic($)).toMatch(/Mic starting/)
  await until(() => r.runs.some(a => a.includes('pip')), 'the pip run')
  expect(await mic($, 'on')).toMatch(/already starting/)
  expect(r.spawns.length).toBe(0)
})

test('listener args', { options: { deepgramApiKey: 'secret-key' } }, async ($, on) => {
  const r = rig(on)
  await begin($)
  await micOn($, r)
  const argv = r.spawns[0]!.argv
  expect(argv.some(a => a.replace(/\\/g, '/').endsWith('/engine/listen.py'))).toBe(true)
  expect(argv).toContain('--emit-json')
  expect(argPair(argv, '--state-dir')).toBe(`${HOME.win32}/.claude-desk-mic`)
  expect(argPair(argv, '--engine')).toBe('deepgram')
  expect(argPair(argv, '--pause-ms')).toBe('3000')
  expect(argPair(argv, '--mute-key')).toBe('auto')
  expect(argPair(argv, '--vad-level')).toBe('2')
  expect(argv).not.toContain('--model')
  const terms = argv.flatMap((a, i) => (a === '--keyterm' ? [argv[i + 1]] : []))
  expect(terms).toEqual(['claude', 'send it'])
  expect(argv.slice(-4)).toEqual(['--keyterm', 'claude', '--keyterm', 'send it'])
  expect(argPair(argv, '--parent-pid')).toBe('4242')
  expect(r.spawns[0]!.env?.DEEPGRAM_API_KEY).toBe('secret-key')
  expect(argv.some(a => a.includes('secret-key'))).toBe(false)
})

test('listener args for whisper', { options: { engine: 'whisper' } }, async ($, on) => {
  const r = rig(on, { platform: 'darwin' })
  await begin($)
  await micOn($, r)
  const argv = r.spawns[0]!.argv
  expect(argPair(argv, '--engine')).toBe('whisper')
  expect(argPair(argv, '--model')).toBe('base.en')
  expect(argPair(argv, '--state-dir')).toBe(`${HOME.darwin}/.claude-desk-mic`)
})

test('start message with the wake word on', { options: { engine: 'whisper' } }, async ($, on) => {
  rig(on)
  await begin($)
  const text = await mic($)
  expect(text).toContain('"claude, scratch that" clears the box')
})

test('start message with the wake word off', { options: { engine: 'whisper', useWakeWord: false } }, async ($, on) => {
  rig(on)
  await begin($)
  const text = await mic($)
  expect(text).toContain('"Scratch that" clears the box')
  expect(text).not.toContain('claude, scratch that')
})

test('loading a whisper model has its own status', { options: { engine: 'whisper' } }, async ($, on) => {
  const r = rig(on)
  await begin($)
  await mic($)
  await until(() => r.listeners.length > 0, 'the listener spawn')
  await say(r, fixtureLine('loading'))
  expect(r.status).toBe('mic: downloading or loading Whisper model base.en (first run downloads it)')
  expect(r.statuses).toContain('mic: installing packages (first run)...')
})

// ---- stopping and status -----------------------------------------------

test('mic off ends the listener stream', { options: { engine: 'whisper' } }, async ($, on) => {
  const r = rig(on)
  await begin($)
  await micOn($, r)
  expect(await mic($, 'off')).toBe('Mic off.')
  await until(() => r.listener.sawReturn, 'the listener stream to be returned')
  expect(r.runs.some(a => a[0] === 'taskkill')).toBe(false)
  expect(r.status).toBe(undefined)
  expect(await mic($, 'status')).toMatch(/Mic is off/)
})

test('unknown subcommand gives the usage line', async ($, on) => {
  rig(on)
  await begin($)
  expect(await mic($, 'loud')).toBe('Use /mic, /mic on, /mic off or /mic status.')
})

test('mute key name comes from the ready event', { options: { engine: 'whisper' } }, async ($, on) => {
  const r = rig(on)
  await begin($)
  await micOn($, r, 'Right Option')
  expect(r.toasts.some(t => t.includes('Right Option'))).toBe(true)
  await say(r, STATE(false))
  expect(r.status).toContain('Right Option')
})

test('ready with a null mute key does not claim mute works', { options: { engine: 'whisper' } }, async ($, on) => {
  const r = rig(on)
  await begin($)
  await micOn($, r, null)
  expect(r.toasts).toContain('Mic on (mute key unavailable)')
  expect(r.status ?? '').not.toMatch(/ctrl|option|alt|shift|f13/i)
  await say(r, STATE(false))
  expect(r.status).toBe('mic muted')
})

test('status asks for the wake word until it is heard', { options: { engine: 'whisper' } }, async ($, on) => {
  const r = rig(on)
  await begin($)
  await micOn($, r)
  expect(r.status).toBe('mic on - say "send it" - say "claude" first')
  await say(r, UTTER('Claude, list the PRs'))
  expect(r.status).toBe('mic on - say "send it"')
})

for (const [stage, message] of [
  ['mic', 'microphone access denied'],
  ['model', 'Could not load the Whisper model base.en.'],
  ['deepgram', 'Could not connect to Deepgram.'],
] as const) {
  test(`listener error resets to off (${stage})`, { options: { engine: 'whisper' } }, async ($, on) => {
    const r = rig(on)
    await begin($)
    expect(await mic($)).toMatch(/Mic starting/)
    await until(() => r.listeners.length === 1, 'the listener spawn')
    r.listener.push({ line: ERROR(stage, message) })
    r.listener.push({ exit: 1 })
    await until(() => r.toasts.some(t => t.includes(message)), 'the error toast')
    await drain()
    expect(r.status).toBe(undefined)
    expect(await mic($, 'status')).toMatch(/Mic is off/)
    const again = await mic($, 'on')
    expect(again).toMatch(/Mic starting/)
    await until(() => r.listeners.length === 2, 'a new listener')
  })
}

test('listener exit shows why', { options: { engine: 'whisper' } }, async ($, on) => {
  const r = rig(on)
  await begin($)
  await micOn($, r)
  r.listener.push({ line: ERROR('connection', 'Deepgram connection closed: x') })
  r.listener.push({ exit: 1 })
  await until(() => r.toasts.some(t => t.includes('Deepgram connection closed: x')), 'the exit toast')
  await drain()
  expect(r.status).toBe(undefined)
})

test('why the mic stopped is kept in last-stop.txt', { options: { engine: 'whisper' } }, async ($, on) => {
  const r = rig(on)
  await begin($)
  await micOn($, r)
  r.listener.push({ exit: 1 })
  await until(() => r.toasts.some(t => t.startsWith('Mic stopped')), 'the exit toast')
  await drain()
  const kept = r.writes['C:/Users/t/.claude-desk-mic/last-stop.txt']
  expect(kept).toMatch(/exit code 1/)
})

test('a mute key failure alone keeps the mic on', { options: { engine: 'whisper' } }, async ($, on) => {
  const r = rig(on)
  await begin($)
  await mic($)
  await until(() => r.listeners.length === 1, 'the listener spawn')
  await say(r, ERROR('mute_key', 'mute key unavailable: no access'))
  await say(r, READY(null))
  expect(await mic($, 'status')).toMatch(/Mic is on/)
  expect(await mic($, 'status')).toMatch(/no access/)
})

// ---- the wake word and the prompt box -----------------------------------

test('wake word gates the prompt box', { options: { engine: 'whisper' } }, async ($, on) => {
  const r = rig(on)
  await begin($)
  await micOn($, r)
  await say(r, UTTER('list the PRs'))
  expect(r.draft).toBe('')
  await say(r, UTTER('Claude, list the PRs'))
  expect(r.draft).toBe('list the PRs')
  await say(r, UTTER('send it'))
  expect(r.submits.map(s => s.text)).toEqual(['list the PRs'])
  expect(r.draft).toBe('')
})

test('awake runs out after 30 s of quiet', { options: { engine: 'whisper' } }, async ($, on) => {
  const r = rig(on)
  await begin($)
  await micOn($, r)
  await say(r, UTTER('Claude, list the PRs'))
  expect(r.fills.length).toBe(1)
  await r.clock.advance(29000)
  await say(r, UTTER('and the stale ones'))
  expect(r.fills.length).toBe(2)
  // 31 s after the last sentence it heard, it needs the wake word again.
  await r.clock.advance(31000)
  await say(r, UTTER('and the old ones'))
  expect(r.fills.length).toBe(2)
  expect(r.status).toBe('mic on - say "send it" - say "claude" first')
})

test('muting resets the wake word', { options: { engine: 'whisper' } }, async ($, on) => {
  const r = rig(on)
  await begin($)
  await micOn($, r)
  await say(r, UTTER('Claude, list the PRs'))
  expect(r.fills.length).toBe(1)
  await say(r, STATE(false))
  await say(r, STATE(true))
  await say(r, UTTER('and the stale ones'))
  expect(r.fills.length).toBe(1)
})

test('a typed prompt resets the wake word', { options: { engine: 'whisper' } }, async ($, on) => {
  const r = rig(on)
  await begin($)
  await micOn($, r)
  await say(r, UTTER('Claude, list the PRs'))
  await $.prompt.submit({ text: 'typed', wait: false, origin: { kind: 'composer' } })
  await say(r, UTTER('and the stale ones'))
  expect(r.fills.length).toBe(1)
})

test('dictated submit uses asUser', { options: { engine: 'whisper', useWakeWord: false } }, async ($, on) => {
  const r = rig(on)
  await begin($)
  await micOn($, r)
  await say(r, UTTER('run the tests send it'))
  expect(r.submits.length).toBe(1)
  expect(r.submits[0]!.text).toBe('run the tests')
  expect(r.submits[0]!.origin).toMatchObject({ kind: 'plugin', asUser: true })
})

test('the box is cleared as soon as a dictated prompt is sent', { options: { engine: 'whisper', useWakeWord: false } }, async ($, on) => {
  const pending = deferred<{ text: string }>()
  const r = rig(on, { submit: () => pending.promise })
  await begin($)
  await micOn($, r)
  await say(r, UTTER('run the tests'))
  await say(r, UTTER('send it'))
  expect(r.submits.map(x => x.text)).toEqual(['run the tests'])
  expect(r.fills).toEqual(['run the tests', ''])
  pending.resolve({ text: 'run the tests' })
  await drain()
  expect(r.fills).toEqual(['run the tests', ''])
})

test('events keep flowing while a dictated submit waits for the turn', { options: { engine: 'whisper', useWakeWord: false } }, async ($, on) => {
  const pending = deferred<{ text: string }>()
  const r = rig(on, { submit: () => pending.promise })
  await begin($)
  await micOn($, r)
  // Claude is busy: the submit does not resolve until the turn ends.
  await say(r, UTTER('run the tests send it'))
  expect(r.submits.length).toBe(1)
  // The next prompt can be dictated meanwhile, and the mute key still shows.
  await say(r, UTTER('then fix the lint'))
  expect(r.draft).toBe('then fix the lint')
  await say(r, STATE(false))
  expect(r.status).toBe('mic muted (Right Ctrl)')
  pending.resolve({ text: 'run the tests' })
  await drain()
  expect(r.draft).toBe('then fix the lint')
})

test('text typed while a submit waits is left alone', { options: { engine: 'whisper', useWakeWord: false } }, async ($, on) => {
  const pending = deferred<{ text: string }>()
  const r = rig(on, { submit: () => pending.promise })
  await begin($)
  await micOn($, r)
  await say(r, UTTER('run the tests'))
  await say(r, UTTER('send it'))
  r.draft = 'typed meanwhile'
  pending.resolve({ text: 'run the tests' })
  await drain()
  expect(r.draft).toBe('typed meanwhile')
})

test('rejected submit keeps the draft', { options: { engine: 'whisper', useWakeWord: false } }, async ($, on) => {
  const r = rig(on, { submit: () => Promise.reject(new Error('dialog closed')) })
  await begin($)
  await micOn($, r)
  await say(r, UTTER('run the tests'))
  await say(r, UTTER('send it'))
  expect(r.draft).toBe('run the tests')
  expect(r.toasts.some(t => t.includes('Not sent: run the tests'))).toBe(true)
  expect(await mic($, 'status')).toMatch(/Mic is on/)
})

test('a rejected submit does not overwrite new text in the box', { options: { engine: 'whisper', useWakeWord: false } }, async ($, on) => {
  const pending = deferred<{ text: string }>()
  const r = rig(on, { submit: () => pending.promise })
  await begin($)
  await micOn($, r)
  await say(r, UTTER('run the tests send it'))
  r.draft = 'typed meanwhile'
  pending.reject(new Error('dialog closed'))
  await drain()
  expect(r.draft).toBe('typed meanwhile')
  expect(r.toasts.some(t => t.includes('Not sent: run the tests'))).toBe(true)
})

test('an error while handling an event ends the listener', { options: { engine: 'whisper', useWakeWord: false } }, async ($, on) => {
  const r = rig(on, { fillThrows: true })
  await begin($)
  await micOn($, r)
  r.listener.push({ line: UTTER('run the tests') })
  await until(() => r.listener.sawReturn, 'the listener stream to be returned')
  await drain()
  expect(r.status).toBe(undefined)
  expect(r.toasts.some(t => t.startsWith('Mic stopped: desk-mic hit an error'))).toBe(true)
  expect(r.toasts.some(t => t.includes('could not start'))).toBe(false)
  expect(await mic($, 'status')).toMatch(/Mic is off/)
})

test('busy dialog keeps the spoken text', { options: { engine: 'whisper', useWakeWord: false } }, async ($, on) => {
  const r = rig(on, { fillBusy: true })
  await begin($)
  await micOn($, r)
  await say(r, UTTER('run the tests'))
  expect(r.toasts.some(t => t.includes('run the tests'))).toBe(true)
  expect(r.draft).toBe('')
  expect(r.submits.length).toBe(0)
})

test('busy dialog leaves the awake state unchanged', { options: { engine: 'whisper' } }, async ($, on) => {
  const r = rig(on, { fillBusy: true })
  await begin($)
  await micOn($, r)
  await say(r, UTTER('Claude, list the PRs'))
  // Not filled, so not awake: a follow-up without the wake word is ignored.
  const toasts = r.toasts.length
  await say(r, UTTER('and the stale ones'))
  expect(r.toasts.length).toBe(toasts)
})

// ---- speak-back ----------------------------------------------------------

const SPEAK = { engine: 'whisper', speakBack: true }

test('speaks the reply when speakBack is on', { options: SPEAK }, async ($, on) => {
  const r = rig(on)
  await begin($)
  await micOn($, r)
  const result = await $.turn.complete(turn('Done. **All** tests pass.'))
  expect(result.text).toBe('Done. **All** tests pass.')
  await until(() => r.speakers.length === 1, 'the speak spawn')
  const s = r.speakers[0]!
  expect(s.input).toBe('Done. **All** tests pass.')
  expect(s.argv.some(a => a.replace(/\\/g, '/').endsWith('/engine/speak.py'))).toBe(true)
  expect(argPair(s.argv, '--voice')).toBe('en-US-AriaNeural')
  expect(argPair(s.argv, '--state-dir')).toBe(`${HOME.win32}/.claude-desk-mic`)
  // Still playing: the hook did not wait on it.
  expect(s.sawReturn).toBe(false)
})

test('subagent and aborted turns are not spoken', { options: SPEAK }, async ($, on) => {
  const r = rig(on)
  await begin($)
  await micOn($, r)
  await $.turn.complete(turn('sub', { agentId: 'a1' }))
  await $.turn.complete(turn('stopped', { reason: 'aborted', isAborted: true }))
  await $.turn.complete(turn(''))
  await drain()
  expect(r.speakers.length).toBe(0)
})

test('no speech when speakBack is off', { options: { engine: 'whisper' } }, async ($, on) => {
  const r = rig(on)
  await begin($)
  await micOn($, r)
  await $.turn.complete(turn('hello'))
  await drain()
  expect(r.speakers.length).toBe(0)
})

test('no speech while the mic is off', { options: SPEAK }, async ($, on) => {
  const r = rig(on)
  await begin($)
  await $.turn.complete(turn('hello'))
  await drain()
  expect(r.speakers.length).toBe(0)
})

for (const platform of ['win32', 'darwin'] as const) {
  test(`a new prompt stops speech (${platform})`, { options: SPEAK }, async ($, on) => {
    const r = rig(on, { platform })
    await begin($)
    await micOn($, r)
    await $.turn.complete(turn('a long answer'))
    await until(() => r.speakers.length === 1, 'the speak spawn')
    await drain()
    const result = await $.prompt.submit({ text: 'next question', wait: false, origin: { kind: 'composer' } })
    expect(result.text).toBe('next question')
    expect(r.runs).toContainEqual(treeKillArgv(platform, 77))
    await until(() => r.speakers[0]!.sawReturn, 'the speak stream to be returned')
  })
}

test('a new reply stops the old one', { options: SPEAK }, async ($, on) => {
  const r = rig(on)
  await begin($)
  await micOn($, r)
  await $.turn.complete(turn('first'))
  await until(() => r.speakers.length === 1, 'the first speak spawn')
  await drain()
  await $.turn.complete(turn('second'))
  await until(() => r.speakers.length === 2, 'the second speak spawn')
  const first = r.speakers[0]!
  expect(first.sawReturn).toBe(true)
  const killAt = r.runs.findIndex(a => a.join(' ') === treeKillArgv('win32', first.pid).join(' '))
  expect(killAt).toBeGreaterThan(-1)
  expect(r.speakers[1]!.input).toBe('second')
})

test('mic off stops speech', { options: SPEAK }, async ($, on) => {
  const r = rig(on)
  await begin($)
  await micOn($, r)
  await $.turn.complete(turn('a long answer'))
  await until(() => r.speakers.length === 1, 'the speak spawn')
  await drain()
  await mic($, 'off')
  expect(r.runs).toContainEqual(treeKillArgv('win32', 77))
  await until(() => r.speakers[0]!.sawReturn, 'the speak stream to be returned')
})

test('muting stops speech', { options: SPEAK }, async ($, on) => {
  const r = rig(on)
  await begin($)
  await micOn($, r)
  await $.turn.complete(turn('a long answer'))
  await until(() => r.speakers.length === 1, 'the speak spawn')
  await drain()
  await say(r, STATE(false))
  expect(r.runs).toContainEqual(treeKillArgv('win32', 77))
})

test('a spoken prompt stops speech once submitted', { options: { ...SPEAK, useWakeWord: false } }, async ($, on) => {
  const r = rig(on)
  await begin($)
  await micOn($, r)
  await $.turn.complete(turn('a long answer'))
  await until(() => r.speakers.length === 1, 'the speak spawn')
  await drain()
  await say(r, UTTER('run the tests send it'))
  await until(() => r.submits.length === 1, 'the submit')
  expect(r.runs).toContainEqual(treeKillArgv('win32', 77))
  await until(() => r.speakers[0]!.sawReturn, 'the speak stream to be returned')
})

test('session end stops speech', { options: SPEAK }, async ($, on) => {
  const r = rig(on)
  await begin($)
  await micOn($, r)
  await $.turn.complete(turn('a long answer'))
  await until(() => r.speakers.length === 1, 'the speak spawn')
  await drain()
  await $.session.end({ reason: 'other', sessionId: 's1' } as never)
  expect(r.runs).toContainEqual(treeKillArgv('win32', 77))
})

const FLAG = `${HOME.win32}/.claude-desk-mic/speaking`

test('a killed reply clears its speaking flag', { options: SPEAK }, async ($, on) => {
  const r = rig(on)
  await begin($)
  await micOn($, r)
  await $.turn.complete(turn('a long answer'))
  await until(() => r.speakers.length === 1, 'the speak spawn')
  await drain()
  // The tree kill skips speak.py's own cleanup, so the flag still names it.
  r.writes[FLAG] = '77'
  await mic($, 'off')
  expect(r.writes[FLAG]).toBe('')
})

test('a flag that names another reply is left alone', { options: SPEAK }, async ($, on) => {
  const r = rig(on)
  await begin($)
  await micOn($, r)
  await $.turn.complete(turn('a long answer'))
  await until(() => r.speakers.length === 1, 'the speak spawn')
  await drain()
  r.writes[FLAG] = '99'
  await mic($, 'off')
  expect(r.writes[FLAG]).toBe('99')
})


// ---- live words in the box ------------------------------------------------

test('words show in the box while speaking, then the sentence sends', { options: { engine: 'whisper' } }, async ($, on) => {
  const r = rig(on)
  await begin($)
  await micOn($, r)
  await say(r, PARTIAL('Claude, what'))
  expect(r.draft).toBe('what')
  await say(r, PARTIAL('Claude, what time is it'))
  expect(r.draft).toBe('what time is it')
  await say(r, UTTER('Claude, what time is it, send it'))
  expect(r.submits.map(s => s.text)).toEqual(['what time is it'])
  expect(r.draft).toBe('')
})

test('no live words before the wake word', { options: { engine: 'whisper' } }, async ($, on) => {
  const r = rig(on)
  await begin($)
  await micOn($, r)
  await say(r, PARTIAL('list the'))
  expect(r.fills).toEqual([])
})

test('live words sit after the draft and are not doubled', { options: { engine: 'whisper', useWakeWord: false } }, async ($, on) => {
  const r = rig(on)
  await begin($)
  await micOn($, r)
  await say(r, UTTER('list PRs'))
  await say(r, PARTIAL('and the stale'))
  expect(r.draft).toBe('list PRs and the stale')
  await say(r, UTTER('and the stale ones'))
  expect(r.draft).toBe('list PRs and the stale ones')
})

test('an empty live update puts the box back', { options: { engine: 'whisper', useWakeWord: false } }, async ($, on) => {
  const r = rig(on)
  await begin($)
  await micOn($, r)
  await say(r, UTTER('list PRs'))
  await say(r, PARTIAL('mic'))
  expect(r.draft).toBe('list PRs mic')
  await say(r, PARTIAL(''))
  expect(r.draft).toBe('list PRs')
})

test('muting puts the box back', { options: { engine: 'whisper', useWakeWord: false } }, async ($, on) => {
  const r = rig(on)
  await begin($)
  await micOn($, r)
  await say(r, PARTIAL('half a'))
  expect(r.draft).toBe('half a')
  await say(r, STATE(false))
  expect(r.draft).toBe('')
})

test('text typed into the box is not overwritten by live words', { options: { engine: 'whisper', useWakeWord: false } }, async ($, on) => {
  const r = rig(on)
  await begin($)
  await micOn($, r)
  await say(r, PARTIAL('half a'))
  await typeInBox($, r, 'typed by hand')
  await say(r, PARTIAL('half a sentence'))
  // Typing during live words pauses them, so no keystroke is overwritten.
  expect(r.draft).toBe('typed by hand')
  await say(r, UTTER('half a sentence done'))
  expect(r.draft).toBe('typed by hand half a sentence done')
})


test('live words are not piled up when the box is slow to update', { options: { engine: 'whisper' } }, async ($, on) => {
  const r = rig(on, { staleReads: true })
  await begin($)
  await micOn($, r)
  await say(r, PARTIAL('Claude, does this'))
  await say(r, PARTIAL('Claude, does this use'))
  await say(r, PARTIAL('Claude, does this use the same'))
  await say(r, PARTIAL('Claude, does this use the same version'))
  expect(r.draft).toBe('does this use the same version')
  await say(r, UTTER('Claude, does this use the same version, send it'))
  expect(r.submits.map(s => s.text)).toEqual(['does this use the same version'])
  expect(r.draft).toBe('')
})


// ---- a sentence the speech engine was not sure of -------------------------

test('an unsure sentence waits in the box, unsent, until "send it"', { options: { engine: 'whisper' } }, async ($, on) => {
  const r = rig(on)
  await begin($)
  await micOn($, r)
  await say(r, PARTIAL("Claude, what's the weather"))
  await say(r, UNSURE("Claude, what's the weather today send it"))
  expect(r.submits).toEqual([])
  expect(r.draft).toBe("what's the weather today")
  expect(r.toasts.some(t => t.includes('send it'))).toBe(true)
  await say(r, UTTER('send it'))
  expect(r.submits.map(s => s.text)).toEqual(["what's the weather today"])
  expect(r.draft).toBe('')
})

test('an unsure sentence without the wake word is ignored', { options: { engine: 'whisper' } }, async ($, on) => {
  const r = rig(on)
  await begin($)
  await micOn($, r)
  await say(r, UNSURE('the tv is on'))
  expect(r.fills).toEqual([])
  expect(r.submits).toEqual([])
})


// ---- stop words --------------------------------------------------------------

test('"stop" ends the running reply and stops speech', { options: { ...SPEAK, useWakeWord: false } }, async ($, on) => {
  const r = rig(on)
  await begin($)
  await micOn($, r)
  await $.turn.start({ text: 'list PRs', turnId: 't9' })
  await say(r, UTTER('stop'))
  expect(r.aborts).toEqual(['t9'])
  expect(r.submits).toEqual([])
  expect(r.toasts.some(t => t.includes('Stopped'))).toBe(true)
})

test('"stop" with no reply running stops nothing and keeps the draft', { options: { engine: 'whisper', useWakeWord: false } }, async ($, on) => {
  const r = rig(on)
  await begin($)
  await micOn($, r)
  await $.turn.start({ text: 'list PRs', turnId: 't9' })
  await $.turn.complete(turn('done', { turnId: 't9' }))
  await say(r, UTTER('list the PRs'))
  await say(r, PARTIAL('stop'))
  await say(r, UTTER('stop'))
  expect(r.aborts).toEqual([])
  expect(r.draft).toBe('list the PRs')
})

test('a subagent turn is not the one "stop" ends', { options: { engine: 'whisper', useWakeWord: false } }, async ($, on) => {
  const r = rig(on)
  await begin($)
  await micOn($, r)
  await $.turn.start({ text: 'main', turnId: 'main1' })
  await $.turn.start({ text: 'sub', turnId: 'sub1', agentId: 'a1' })
  await say(r, UTTER('cancel'))
  expect(r.aborts).toEqual(['main1'])
})

// ---- review fixes: a slow box, stop words, unsure ------------------------
test('a slow box does not double text across sentences', { options: { engine: 'whisper', useWakeWord: false } }, async ($, on) => {
  const r = rig(on, { staleReads: true })
  await begin($)
  await micOn($, r)
  await say(r, PARTIAL('list the'))
  await say(r, PARTIAL('list the PR'))
  await say(r, UTTER('list the PRs'))
  await say(r, PARTIAL('and the'))
  await say(r, PARTIAL('and the stale'))
  await say(r, UTTER('and the stale ones'))
  expect(r.draft).toBe('list the PRs and the stale ones')
})

test('a slow box is still cleared after a send', { options: { engine: 'whisper', useWakeWord: false } }, async ($, on) => {
  const r = rig(on, { staleReads: true })
  await begin($)
  await micOn($, r)
  await say(r, PARTIAL('list'))
  await say(r, PARTIAL('list the PRs'))
  await say(r, UTTER('list the PRs send it'))
  expect(r.submits.map(s => s.text)).toEqual(['list the PRs'])
  expect(r.draft).toBe('')
})

test('mic off takes live words out of the box', { options: { engine: 'whisper', useWakeWord: false } }, async ($, on) => {
  const r = rig(on)
  await begin($)
  await micOn($, r)
  await say(r, PARTIAL('half a sent'))
  await mic($, 'off')
  expect(r.draft).toBe('')
})

test('an unsure stop word stops nothing', { options: { engine: 'whisper', useWakeWord: false } }, async ($, on) => {
  const r = rig(on)
  await begin($)
  await micOn($, r)
  await $.turn.start({ text: 'list PRs', turnId: 't9' })
  await say(r, UNSURE('wait'))
  expect(r.aborts).toEqual([])
})

test('a slow box does not resend the last prompt (pause mode)', { options: { engine: 'whisper', useWakeWord: false, sendMode: 'pause' } }, async ($, on) => {
  const r = rig(on, { staleReads: true })
  await begin($)
  await micOn($, r)
  await say(r, PARTIAL('list the'))
  await say(r, PARTIAL('list the PRs'))
  await say(r, UTTER('list the PRs'))
  await say(r, PARTIAL('run the'))
  await say(r, PARTIAL('run the tests'))
  await say(r, UTTER('run the tests'))
  expect(r.submits.map(s => s.text)).toEqual(['list the PRs', 'run the tests'])
})

test('a slow box does not resend the last prompt (word mode)', { options: { engine: 'whisper' } }, async ($, on) => {
  const r = rig(on, { staleReads: true })
  await begin($)
  await micOn($, r)
  await say(r, PARTIAL('Claude, list'))
  await say(r, PARTIAL('Claude, list the PRs'))
  await say(r, UTTER('Claude, list the PRs, send it'))
  await say(r, PARTIAL('Claude, run'))
  await say(r, PARTIAL('Claude, run the tests'))
  await say(r, UTTER('Claude, run the tests, send it'))
  expect(r.submits.map(s => s.text)).toEqual(['list the PRs', 'run the tests'])
})

test('a bare stop works while a reply is running, even right after a send', { options: { engine: 'whisper' } }, async ($, on) => {
  const r = rig(on)
  await begin($)
  await micOn($, r)
  await say(r, UTTER('Claude, delete the old branches, send it'))
  await $.turn.start({ text: 'delete the old branches', turnId: 't5' })
  await say(r, UTTER('stop'))
  expect(r.aborts).toEqual(['t5'])
})

test('a stop word says when a dictated prompt is still queued', { options: { engine: 'whisper', useWakeWord: false } }, async ($, on) => {
  const pending = deferred<{ text: string }>()
  const r = rig(on, { submit: () => pending.promise })
  await begin($)
  await micOn($, r)
  await $.turn.start({ text: 'first', turnId: 't1' })
  await say(r, UTTER('deploy it send it'))
  await say(r, UTTER('stop'))
  expect(r.aborts).toEqual(['t1'])
  expect(r.toasts.some(t => t.includes('still queued'))).toBe(true)
  pending.resolve({ text: 'deploy it' })
})

test('an unsure sentence with no send word gets no "not sent" toast', { options: { engine: 'whisper', useWakeWord: false } }, async ($, on) => {
  const r = rig(on)
  await begin($)
  await micOn($, r)
  await say(r, UNSURE('list the PRs'))
  expect(r.draft).toBe('list the PRs')
  expect(r.toasts.some(t => t.includes('not sent'))).toBe(false)
})

test('the env key is not in the listener argv', { options: { engine: 'deepgram' } }, async ($, on) => {
  const r = rig(on, { env: { DEEPGRAM_API_KEY: 'env-key' } })
  await begin($)
  await mic($)
  await until(() => r.listeners.length === 1, 'the listener spawn')
  expect(r.spawns[0]!.argv.join(' ')).not.toContain('env-key')
})


// ---- the box as the engine reports it: a person's edits always win ---------

test('text the person deleted by hand never comes back', { options: { engine: 'whisper', useWakeWord: false } }, async ($, on) => {
  const r = rig(on, { staleReads: true })
  await begin($)
  await micOn($, r)
  await say(r, UTTER('delete all branches'))
  expect(r.draft).toBe('delete all branches')
  await typeInBox($, r, '')
  await say(r, UTTER('list the PRs send it'))
  expect(r.submits.map(s => s.text)).toEqual(['list the PRs'])
})

test('an unsure sentence the person cleared is not sent later', { options: { engine: 'whisper', useWakeWord: false } }, async ($, on) => {
  const r = rig(on)
  await begin($)
  await micOn($, r)
  await say(r, UNSURE('delete prod send it'))
  expect(r.draft).toBe('delete prod')
  await typeInBox($, r, '')
  await say(r, UTTER('send it'))
  expect(r.submits).toEqual([])
})

test('a box cleared by something else is not filled back', { options: { engine: 'whisper', useWakeWord: false } }, async ($, on) => {
  const r = rig(on)
  await begin($)
  await micOn($, r)
  await say(r, UTTER('list the PRs'))
  await boxCleared($, r)
  await say(r, UTTER('run the tests'))
  expect(r.draft).toBe('run the tests')
})

test('a bare stop word long after the send does nothing', { options: { engine: 'whisper' } }, async ($, on) => {
  const r = rig(on)
  await begin($)
  await micOn($, r)
  await say(r, UTTER('Claude, build it, send it'))
  await $.turn.start({ text: 'build it', turnId: 't7' })
  await r.clock.advance(31000)
  await say(r, UTTER('wait'))
  expect(r.aborts).toEqual([])
  await say(r, UTTER('Claude, stop'))
  expect(r.aborts).toEqual(['t7'])
})

test("the mod's own fill, as the engine reports it, keeps the box the mod's", { options: { engine: 'whisper', useWakeWord: false } }, async ($, on) => {
  const r = rig(on, { staleReads: true })
  await begin($)
  await micOn($, r)
  await say(r, UTTER('list the PRs'))
  await ($.prompt as unknown as Raise).change({ text: 'list the PRs', cursor: 12, origin: { kind: 'plugin', name: 'desk-mic' } })
  await say(r, UTTER('and the stale ones'))
  expect(r.draft).toBe('list the PRs and the stale ones')
})

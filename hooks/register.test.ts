import { expect, test } from 'claude-code/testing'

declare const setTimeout: (callback: () => void, ms: number) => unknown

import { LISTENER_EVENTS_JSONL } from './fixtures/listener-events'
import type { Rules } from './rules'
import { statusText } from './register'

const WORD: Rules = { mode: 'word', sendWords: ['send it'], useWakeWord: false, wakeWords: ['claude'] }
const PAUSE: Rules = { mode: 'pause', sendWords: ['send it'], useWakeWord: false, wakeWords: ['claude'] }

/** The fixture line of one event type, as the listener writes it. */
function fixtureLine(type: string): string {
  const line = LISTENER_EVENTS_JSONL.split(/\r?\n/).find(l => l.includes(`"type":"${type}"`))
  if (line === undefined) throw new Error(`no ${type} line in the fixture`)
  return line
}

test('status line text', async () => {
  expect(statusText(false, true, false, WORD, 'Right Ctrl')).toBe(undefined)
  expect(statusText(true, false, false, WORD, 'Right Ctrl')).toBe('mic muted (Right Ctrl)')
  expect(statusText(true, false, false, WORD, 'Right Option')).toBe('mic muted (Right Option)')
  expect(statusText(true, false, false, WORD, null)).toBe('mic muted')
  expect(statusText(true, true, true, PAUSE, 'Right Ctrl')).toBe('mic paused while speaking')
  expect(statusText(true, true, false, WORD, 'Right Ctrl')).toBe('mic on - say "send it"')
  expect(statusText(true, true, false, PAUSE, 'Right Ctrl')).toBe('mic on - sends when you pause')
})

test('/mic starts the listener and what it hears lands in the prompt box', async ($, on) => {
  let draft = ''
  const submitted: string[] = []
  let spawned: readonly string[] = []

  const statuses: (string | undefined)[] = []
  on('ui.status', (_, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(String(e.text))
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'mic' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.read', () => ({ value: { text: draft, cursor: draft.length } }))
  on('prompt.fill', (_, e) => {
    draft = e.text
    return { isFilled: true }
  })
  on('prompt.submit', (_, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('process.spawn', async function* (_, e) {
    spawned = e.argv
    yield { stream: 'stdout', text: `${fixtureLine('ready')}\n` }
    // Wake word on (the manifest default): "send it" needs no wake word only
    // if the awake state from the first sentence was stored.
    yield { stream: 'stdout', text: '{"type":"utterance","text":"Claude, list the open PRs"}\n' }
    yield { stream: 'stdout', text: '{"type":"utterance","text":"send it"}\n' }
    yield { stream: 'stdout', text: `${fixtureLine('speaking')}\n` }
    yield { stream: 'stdout', text: `${fixtureLine('state')}\n` }
    return { value: { code: 0, signal: null } }
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ran = await $.command.run({
    command: 'mic',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })

  expect(String(ran.text)).toMatch(/Mic starting/)
  expect(spawned).toContain('--emit-json')
  // The mic's read loop runs on after /mic returns; give it a moment to drain.
  for (let i = 0; i < 50 && submitted.length === 0; i++) {
    await new Promise<void>(resolve => setTimeout(() => resolve(), 10))
  }
  for (let i = 0; i < 50 && !statuses.includes('mic muted (Right Option)'); i++) {
    await new Promise<void>(resolve => setTimeout(() => resolve(), 10))
  }
  expect(submitted).toEqual(['list the open PRs'])
  expect(draft).toBe('')
  expect(toasts.some(t => t.includes('Right Option'))).toBe(true)
  expect(statuses).toContain('mic paused while speaking')
  expect(statuses).toContain('mic muted (Right Option)')
})

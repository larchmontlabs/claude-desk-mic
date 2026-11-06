import { expect, test } from 'claude-code/testing'

declare const setTimeout: (callback: () => void, ms: number) => unknown

import { parseEvent, parseSettings, parseWords, planUtterance, splitLines, statusText } from './register'

test('splitLines keeps a partial line for the next chunk', async () => {
  const first = splitLines('', '{"type":"ready"}\n{"type":"utt')
  expect(first.lines).toEqual(['{"type":"ready"}'])
  expect(first.rest).toBe('{"type":"utt')
  const second = splitLines(first.rest, 'erance","text":"hi"}\r\n')
  expect(second.lines).toEqual(['{"type":"utterance","text":"hi"}'])
  expect(second.rest).toBe('')
})

test('parseEvent ignores lines that are not ours', async () => {
  expect(parseEvent('{"type":"utterance","text":"hi"}')).toEqual({ type: 'utterance', text: 'hi' })
  expect(parseEvent('Traceback (most recent call last):')).toBe(undefined)
  expect(parseEvent('[1,2]')).toBe(undefined)
})

const WORD = { mode: 'word', words: ['send it'] } as const
const PAUSE = { mode: 'pause', words: ['send it'] } as const

test('word mode adds to the draft until the send word', async () => {
  expect(planUtterance('list the open PRs', WORD, '')).toEqual({ kind: 'fill', text: 'list the open PRs' })
  expect(planUtterance('and close the stale ones', WORD, 'list the open PRs ')).toEqual({
    kind: 'fill',
    text: 'list the open PRs and close the stale ones',
  })
  expect(planUtterance('Send it.', WORD, 'list the open PRs')).toEqual({ kind: 'submit', text: 'list the open PRs' })
  expect(planUtterance('send it', WORD, '   ')).toEqual({ kind: 'nothing' })
  expect(planUtterance('Scratch that.', WORD, 'oops')).toEqual({ kind: 'clear' })
})

test('a send word at the end of a sentence is cut off, then it sends', async () => {
  expect(planUtterance('does it apply to the phone version, send it.', WORD, '')).toEqual({
    kind: 'submit',
    text: 'does it apply to the phone version',
  })
  expect(planUtterance('and the desk one Send It', WORD, 'check the phone one')).toEqual({
    kind: 'submit',
    text: 'check the phone one and the desk one',
  })
})

test('the send word only counts at the very end, as whole words', async () => {
  expect(planUtterance('send it to Bob tomorrow', WORD, '')).toEqual({ kind: 'fill', text: 'send it to Bob tomorrow' })
  expect(planUtterance('please resend it', WORD, '')).toEqual({ kind: 'fill', text: 'please resend it' })
})

test('any of several send words works, with extra spaces inside the phrase', async () => {
  const words = { mode: 'word', words: ['over', "that's it"] } as const
  expect(planUtterance('run the tests. Over.', words, '')).toEqual({ kind: 'submit', text: 'run the tests' })
  expect(planUtterance("run the tests that's   it", words, '')).toEqual({ kind: 'submit', text: 'run the tests' })
})

test('pause mode sends each sentence, with any typed draft in front and no send word', async () => {
  expect(planUtterance('run the tests', PAUSE, '')).toEqual({ kind: 'submit', text: 'run the tests' })
  expect(planUtterance('on the desk mic', PAUSE, 'run the tests')).toEqual({
    kind: 'submit',
    text: 'run the tests on the desk mic',
  })
  expect(planUtterance('run the tests, send it', PAUSE, '')).toEqual({ kind: 'submit', text: 'run the tests' })
  expect(planUtterance('send it', PAUSE, '')).toEqual({ kind: 'nothing' })
})

test('parseSettings reads old and new stored values', async () => {
  expect(parseSettings(undefined)).toEqual({ mode: 'word', words: ['send it'] })
  expect(parseSettings({ mode: 'pause', words: ['over'], pauseSeconds: 2 })).toEqual({
    mode: 'pause',
    words: ['over'],
    pauseSeconds: 2,
  })
  expect(parseSettings({ mode: 'pause', words: [], pauseSeconds: -1 })).toEqual({ mode: 'pause', words: ['send it'] })
})

test('parseWords splits a comma list and drops blanks', async () => {
  expect(parseWords(" over , that's it ,, ")).toEqual(['over', "that's it"])
  expect(parseWords('  ')).toEqual([])
})

test('status line text', async () => {
  expect(statusText(false, true, false, WORD)).toBe(undefined)
  expect(statusText(true, false, false, WORD)).toBe('mic muted (Right Ctrl)')
  expect(statusText(true, true, true, PAUSE)).toBe('mic paused while speaking')
  expect(statusText(true, true, false, WORD)).toBe('mic on - say "send it"')
  expect(statusText(true, true, false, PAUSE)).toBe('mic on - sends when you pause')
})

test('/mic starts desk_mic.py and what it hears lands in the prompt box', async ($, on) => {
  let draft = ''
  const submitted: string[] = []
  let spawned: readonly string[] = []

  const statuses: (string | undefined)[] = []
  on('ui.status', (_, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'mic' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('store.get', () => ({ value: undefined }))
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
    yield { stream: 'stdout', text: '{"type":"ready","hotkey":"right ctrl","device":"Mic","pid":5}\n' }
    yield { stream: 'stdout', text: '{"type":"utterance","text":"list the open PRs"}\n' }
    yield { stream: 'stdout', text: '{"type":"utterance","text":"send it"}\n' }
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
  expect(submitted).toEqual(['list the open PRs'])
  expect(draft).toBe('')
})

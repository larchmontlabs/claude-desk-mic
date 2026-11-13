import { expect, test } from 'claude-code/testing'

import { LISTENER_EVENTS_JSONL } from './fixtures/listener-events'
import {
  type Awake,
  type Rules,
  keyterms,
  parseEvent,
  parseWords,
  pauseMsFor,
  planUtterance,
  previewText,
  isEchoOf,
  wakeWordHeard,
  rulesFrom,
  splitLines,
} from './rules'

const ASLEEP: Awake = { isAwake: false, lastHeardMs: 0 }
const AWAKE: Awake = { isAwake: true, lastHeardMs: 0 }

const WORD: Rules = { mode: 'word', sendWords: ['send it'], stopWords: ['stop', 'cancel', 'wait', 'hold on', 'never mind'], useWakeWord: false, wakeWords: ['claude'] }
const PAUSE: Rules = { mode: 'pause', sendWords: ['send it'], stopWords: ['stop', 'cancel', 'wait', 'hold on', 'never mind'], useWakeWord: false, wakeWords: ['claude'] }
const WAKE_WORD: Rules = { ...WORD, useWakeWord: true }
const WAKE_PAUSE: Rules = { ...PAUSE, useWakeWord: true }

/** The action alone, for the cases where the wake word is off. */
function act(text: string, rules: Rules, draft: string) {
  return planUtterance(text, rules, draft, ASLEEP, 0).action
}

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

test('parseEvent accepts every line of the listener fixture', async () => {
  const lines = LISTENER_EVENTS_JSONL.split('\n').filter(line => line.trim() !== '')
  expect(lines.length).toBeGreaterThan(0)
  const stages: string[] = []
  for (const line of lines) {
    const event = parseEvent(line)
    expect(event).toEqual(JSON.parse(line))
    if (event?.type === 'ready') {
      expect(typeof event.mute_key).toBe('string')
      expect(parseEvent(JSON.stringify({ ...event, mute_key: null }))).toEqual({ ...event, mute_key: null })
    }
    if (event?.type === 'error') stages.push(event.stage)
  }
  expect(stages.sort()).toEqual(['connection', 'deepgram', 'device', 'mic', 'model', 'mute_key', 'takeover'])
})

test('parseEvent rejects the old event names and bad shapes', async () => {
  expect(parseEvent('{"type":"tts","playing":true}')).toBe(undefined)
  expect(parseEvent('{"type":"ready","hotkey":"right ctrl","device":"Mic","pid":5}')).toBe(undefined)
  expect(parseEvent('{"type":"error","message":"no stage"}')).toBe(undefined)
  expect(parseEvent('{"type":"speaking","playing":"yes"}')).toBe(undefined)
})

test('word mode adds to the draft until the send word', async () => {
  expect(act('list the open PRs', WORD, '')).toEqual({ kind: 'fill', text: 'list the open PRs' })
  expect(act('and close the stale ones', WORD, 'list the open PRs ')).toEqual({
    kind: 'fill',
    text: 'list the open PRs and close the stale ones',
  })
  expect(act('Send it.', WORD, 'list the open PRs')).toEqual({ kind: 'submit', text: 'list the open PRs' })
  expect(act('send it', WORD, '   ')).toEqual({ kind: 'nothing' })
  expect(act('Scratch that.', WORD, 'oops')).toEqual({ kind: 'clear' })
})

test('a send word at the end of a sentence is cut off, then it sends', async () => {
  expect(act('does it apply to the phone version, send it.', WORD, '')).toEqual({
    kind: 'submit',
    text: 'does it apply to the phone version',
  })
  expect(act('and the desk one Send It', WORD, 'check the phone one')).toEqual({
    kind: 'submit',
    text: 'check the phone one and the desk one',
  })
})

test('the send word only counts at the very end, as whole words', async () => {
  expect(act('send it to Bob tomorrow', WORD, '')).toEqual({ kind: 'fill', text: 'send it to Bob tomorrow' })
  expect(act('please resend it', WORD, '')).toEqual({ kind: 'fill', text: 'please resend it' })
})

test('any of several send words works, with extra spaces inside the phrase', async () => {
  const words: Rules = { ...WORD, sendWords: ['over', "that's it"] }
  expect(act('run the tests. Over.', words, '')).toEqual({ kind: 'submit', text: 'run the tests' })
  expect(act("run the tests that's   it", words, '')).toEqual({ kind: 'submit', text: 'run the tests' })
})

test('pause mode sends each sentence, with any typed draft in front and no send word', async () => {
  expect(act('run the tests', PAUSE, '')).toEqual({ kind: 'submit', text: 'run the tests' })
  expect(act('on the desk mic', PAUSE, 'run the tests')).toEqual({
    kind: 'submit',
    text: 'run the tests on the desk mic',
  })
  expect(act('run the tests, send it', PAUSE, '')).toEqual({ kind: 'submit', text: 'run the tests' })
  expect(act('send it', PAUSE, '')).toEqual({ kind: 'nothing' })
})

test('with the wake word off, the awake state is passed through untouched', async () => {
  expect(planUtterance('run the tests', PAUSE, '', AWAKE, 99999)).toEqual({
    action: { kind: 'submit', text: 'run the tests' },
    awake: AWAKE,
  })
})

test('parseWords splits a comma list and drops blanks', async () => {
  expect(parseWords(" over , that's it ,, ")).toEqual(['over', "that's it"])
  expect(parseWords('  ')).toEqual([])
})

test('wake word starts a draft, follow-ups need no wake word', async () => {
  expect(planUtterance('Claude, list the PRs', WAKE_WORD, '', ASLEEP, 0)).toEqual({
    action: { kind: 'fill', text: 'list the PRs' },
    awake: { isAwake: true, lastHeardMs: 0 },
  })
  expect(planUtterance('and the stale ones', WAKE_WORD, 'list the PRs', AWAKE, 0)).toEqual({
    action: { kind: 'fill', text: 'list the PRs and the stale ones' },
    awake: { isAwake: true, lastHeardMs: 0 },
  })
  const sent = planUtterance('send it', WAKE_WORD, 'list the PRs and the stale ones', AWAKE, 0)
  expect(sent.action).toEqual({ kind: 'submit', text: 'list the PRs and the stale ones' })
  expect(sent.awake.isAwake).toBe(false)
})

test('wake word and send word in one breath', async () => {
  const plan = planUtterance('Claude, what time is it, send it', WAKE_WORD, '', ASLEEP, 0)
  expect(plan.action).toEqual({ kind: 'submit', text: 'what time is it' })
  expect(plan.awake.isAwake).toBe(false)
})

test('a repeated wake word while awake is stripped', async () => {
  expect(planUtterance('Claude, and the closed ones', WAKE_WORD, 'list the PRs', AWAKE, 0)).toEqual({
    action: { kind: 'fill', text: 'list the PRs and the closed ones' },
    awake: { isAwake: true, lastHeardMs: 0 },
  })
})

test('wake word must match exactly; near-misses are ignored', async () => {
  expect(planUtterance('Cloud, run the tests', WAKE_WORD, '', ASLEEP, 0)).toEqual({
    action: { kind: 'nothing' },
    awake: ASLEEP,
  })
  const near = planUtterance('claudette run', WAKE_WORD, '', ASLEEP, 0)
  expect(near.action).toEqual({ kind: 'nothing' })
  expect(near.awake.isAwake).toBe(false)
})

test('the wake word may be followed by any of , . ! ? :', async () => {
  for (const mark of [',', '.', '!', '?', ':', '']) {
    expect(planUtterance(`Claude${mark} run the tests`, WAKE_PAUSE, '', ASLEEP, 0).action).toEqual({
      kind: 'submit',
      text: 'run the tests',
    })
  }
})

test('clear needs the wake word when asleep', async () => {
  const asleep = planUtterance('scratch that', WAKE_WORD, 'typed text', ASLEEP, 0)
  expect(asleep.action).toEqual({ kind: 'nothing' })
  expect(asleep.awake.isAwake).toBe(false)
  const woke = planUtterance('Claude, scratch that', WAKE_WORD, 'typed text', ASLEEP, 0)
  expect(woke.action).toEqual({ kind: 'clear' })
  expect(woke.awake.isAwake).toBe(false)
})

test('pause mode needs the wake word every time', async () => {
  const first = planUtterance('Claude run the tests', WAKE_PAUSE, '', ASLEEP, 0)
  expect(first.action).toEqual({ kind: 'submit', text: 'run the tests' })
  expect(first.awake.isAwake).toBe(false)
  expect(planUtterance('run them again', WAKE_PAUSE, '', first.awake, 0).action).toEqual({ kind: 'nothing' })
})

test('a wake word alone does nothing and stays awake', async () => {
  expect(planUtterance('Claude.', WAKE_WORD, '', ASLEEP, 500)).toEqual({
    action: { kind: 'nothing' },
    awake: { isAwake: true, lastHeardMs: 500 },
  })
  expect(planUtterance('Claude.', WAKE_PAUSE, '', ASLEEP, 500).awake).toEqual({ isAwake: true, lastHeardMs: 500 })
})

test('awake expires after 30 s of quiet', async () => {
  const first = planUtterance('Claude, list the PRs', WAKE_WORD, '', ASLEEP, 0)
  expect(first.action.kind).toBe('fill')
  expect(first.awake).toEqual({ isAwake: true, lastHeardMs: 0 })
  expect(planUtterance('and the stale ones', WAKE_WORD, 'list the PRs', AWAKE, 29000)).toEqual({
    action: { kind: 'fill', text: 'list the PRs and the stale ones' },
    awake: { isAwake: true, lastHeardMs: 29000 },
  })
  const late = planUtterance('and the stale ones', WAKE_WORD, 'list the PRs', AWAKE, 31000)
  expect(late.action).toEqual({ kind: 'nothing' })
  expect(late.awake.isAwake).toBe(false)
  expect(planUtterance('Claude, and the stale ones', WAKE_WORD, 'list the PRs', AWAKE, 31000)).toEqual({
    action: { kind: 'fill', text: 'list the PRs and the stale ones' },
    awake: { isAwake: true, lastHeardMs: 31000 },
  })
})

test('rulesFrom splits comma lists and lowercases nothing', async () => {
  expect(
    rulesFrom({ sendMode: 'word', sendWords: 'send it, over', useWakeWord: true, wakeWords: 'Claude, Computer' }),
  ).toMatchObject({ mode: 'word', sendWords: ['send it', 'over'], useWakeWord: true, wakeWords: ['Claude', 'Computer'] })
  expect(rulesFrom({ sendMode: 'word', sendWords: 'send it', useWakeWord: true, wakeWords: ' , ' }).wakeWords).toEqual([
    'claude',
  ])
  expect(rulesFrom({ sendMode: 'word', sendWords: '', useWakeWord: false, wakeWords: '' }).sendWords).toEqual([
    'send it',
  ])
  expect(rulesFrom({ sendMode: 'pause', sendWords: '', useWakeWord: false, wakeWords: '' })).toMatchObject({
    mode: 'pause',
    sendWords: [],
    useWakeWord: false,
    wakeWords: [],
  })
})

test('rulesFrom reads the manifest defaults', async () => {
  expect(rulesFrom({ sendMode: 'word', sendWords: 'send it', useWakeWord: true, wakeWords: 'claude' })).toEqual({
    mode: 'word',
    sendWords: ['send it'],
    stopWords: ['stop', 'cancel', 'wait', 'hold on', 'never mind'],
    useWakeWord: true,
    wakeWords: ['claude'],
  })
})

test('keyterms leave out the wake word when it is off', async () => {
  expect(keyterms({ useWakeWord: false, wakeWords: ['claude'], sendWords: ['send it'], stopWords: [], mode: 'word' })).toEqual([
    'send it',
  ])
})

test('keyterms put wake words first', async () => {
  expect(keyterms({ useWakeWord: true, wakeWords: ['claude'], sendWords: ['send it'], stopWords: [], mode: 'word' })).toEqual([
    'claude',
    'send it',
  ])
})

test('pauseMsFor checks the range each engine accepts', async () => {
  expect(pauseMsFor('deepgram', 3)).toEqual({ ms: 3000 })
  expect(pauseMsFor('deepgram', 1)).toEqual({ ms: 1000 })
  expect(pauseMsFor('deepgram', 5)).toEqual({ ms: 5000 })
  for (const bad of [0.5, 6, 2.0005]) {
    const result = pauseMsFor('deepgram', bad)
    expect('error' in result ? result.error : '').toBe(
      'Pause must be 1 to 5 seconds, in whole milliseconds, for Deepgram (desk-mic settings).',
    )
  }
  const short = pauseMsFor('whisper', 0.5)
  expect('error' in short ? short.error : '').toBe('Pause must be 1 second or more (desk-mic settings).')
  expect(pauseMsFor('whisper', 6)).toEqual({ ms: 6000 })
})


// ---- live words while a sentence is still being spoken --------------------

test('previewText shows the words so far, after the draft', async () => {
  expect(previewText('run the', WORD, '', ASLEEP, 0)).toBe('run the')
  expect(previewText('and the stale', WORD, 'list PRs', ASLEEP, 0)).toBe('list PRs and the stale')
})

test('previewText hides a send word at the end', async () => {
  expect(previewText('run the tests, send it', WORD, '', ASLEEP, 0)).toBe('run the tests')
})

test('previewText shows nothing until the wake word is heard', async () => {
  expect(previewText('list the', WAKE_WORD, '', ASLEEP, 0)).toBeUndefined()
  expect(previewText('Claude, what time', WAKE_WORD, '', ASLEEP, 0)).toBe('what time')
  expect(previewText('and the stale', WAKE_WORD, 'list PRs', AWAKE, 1000)).toBe('list PRs and the stale')
  expect(previewText('and the stale', WAKE_WORD, 'list PRs', AWAKE, 31000)).toBeUndefined()
})

test('previewText leaves clear words alone', async () => {
  expect(previewText('scratch that', WORD, 'list PRs', ASLEEP, 0)).toBeUndefined()
})


// ---- stop words --------------------------------------------------------------

test('a stop word said alone stops; inside a request it does not', async () => {
  expect(act('stop', WORD, '')).toEqual({ kind: 'stop' })
  expect(act('Stop.', WORD, '')).toEqual({ kind: 'stop' })
  expect(act('Hold on!', WORD, 'list PRs')).toEqual({ kind: 'stop' })
  expect(act('stop the server', WORD, '')).toEqual({ kind: 'fill', text: 'stop the server' })
  expect(act('stop', PAUSE, '')).toEqual({ kind: 'stop' })
})

test('a stop word follows the wake word rule', async () => {
  expect(planUtterance('stop', WAKE_WORD, '', ASLEEP, 0).action).toEqual({ kind: 'nothing' })
  expect(planUtterance('Claude, stop', WAKE_WORD, '', ASLEEP, 0).action).toEqual({ kind: 'stop' })
  expect(planUtterance('wait', WAKE_WORD, '', AWAKE, 1000)).toEqual({
    action: { kind: 'stop' },
    awake: { isAwake: true, lastHeardMs: 1000 },
  })
})

test('rulesFrom reads stop words, with the phone defaults when blank', async () => {
  expect(rulesFrom({ stopWords: 'halt, enough' }).stopWords).toEqual(['halt', 'enough'])
  expect(rulesFrom({}).stopWords).toEqual(['stop', 'cancel', 'wait', 'hold on', 'never mind'])
})

test('previewText leaves a stop word out of the box', async () => {
  expect(previewText('stop', WORD, 'list PRs', ASLEEP, 0)).toBeUndefined()
})


// ---- echo: the mic hearing its own read-aloud (voice-bridge voice_text.is_echo_of) ---

test('isEchoOf matches any whole run of words in what was said', async () => {
  const said = 'Yes, the tests pass. I pushed the fix to main.'
  expect(isEchoOf('the tests pass', said)).toBe(true)
  expect(isEchoOf('pushed the fix', said)).toBe(true)
  expect(isEchoOf('Yes the tests', said)).toBe(true)
  expect(isEchoOf('run the tests', said)).toBe(false)
})

test('isEchoOf never calls a short answer echo', async () => {
  expect(isEchoOf('yes', 'Yes, the tests pass.')).toBe(false)
  expect(isEchoOf('stop', 'Stop the server first.')).toBe(false)
  expect(isEchoOf('the t', 'the tests pass')).toBe(false)
})

test('isEchoOf lines up on word boundaries', async () => {
  expect(isEchoOf('run the', 'overrun theatre')).toBe(false)
  expect(isEchoOf('anything', '')).toBe(false)
})

test('wakeWordHeard finds the wake word at the start only', async () => {
  expect(wakeWordHeard('Claude, what time', WAKE_WORD)).toBe(true)
  expect(wakeWordHeard('claude', WAKE_WORD)).toBe(true)
  expect(wakeWordHeard('ask claude', WAKE_WORD)).toBe(false)
  expect(wakeWordHeard('Claude', WORD)).toBe(false)
})

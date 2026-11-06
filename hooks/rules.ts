// What desk-mic does with each sentence it hears: the send word, the wake
// word, and the listener's event lines. Pure functions, no `$`.

export type Mode = 'word' | 'pause'
export type Rules = { mode: Mode; sendWords: string[]; useWakeWord: boolean; wakeWords: string[] }
export type Awake = { isAwake: boolean; lastHeardMs: number }
export type Engine = 'deepgram' | 'whisper'

export type Action =
  | { kind: 'submit'; text: string }
  | { kind: 'fill'; text: string }
  | { kind: 'clear' }
  | { kind: 'nothing' }

export const ERROR_STAGES = ['device', 'mic', 'model', 'deepgram', 'mute_key', 'connection', 'takeover'] as const
export type ErrorStage = (typeof ERROR_STAGES)[number]

// One line of engine/listen.py's stdout. hooks/fixtures/listener-events.jsonl
// holds one of each; both sides test against it.
export type MicEvent =
  | { type: 'ready'; device: string; mute_key: string | null; pid: number }
  | { type: 'loading'; model: string }
  | { type: 'utterance'; text: string }
  | { type: 'state'; listening: boolean; source: string }
  | { type: 'speaking'; playing: boolean }
  | { type: 'takeover'; previous_pid: number }
  | { type: 'error'; stage: ErrorStage; message: string }

// Defaults from the settings screen (plugin.json); used when a list is blank.
const DEFAULT_SEND_WORDS = ['send it']
const DEFAULT_WAKE_WORDS = ['claude']
// Awake runs out after this much quiet (Ryan, 2026-11-06).
const AWAKE_FOR_MS = 30000

const CLEAR_WORDS = /^\s*(?:clear (?:that|it|the prompt)|scratch that)[.!]?\s*$/i

/** Splits streamed text into whole lines; returns the lines and the leftover. */
export function splitLines(buffer: string, chunk: string): { lines: string[]; rest: string } {
  const parts = (buffer + chunk).split(/\r?\n/)
  const rest = parts.pop() ?? ''
  return { lines: parts.filter(line => line.trim() !== ''), rest }
}

type Json = Record<string, unknown>
const isStr = (v: unknown): v is string => typeof v === 'string'
const isNum = (v: unknown): v is number => typeof v === 'number'
const isBool = (v: unknown): v is boolean => typeof v === 'boolean'

function isMicEvent(v: Json): boolean {
  switch (v.type) {
    case 'ready':
      return isStr(v.device) && (isStr(v.mute_key) || v.mute_key === null) && isNum(v.pid)
    case 'loading':
      return isStr(v.model)
    case 'utterance':
      return isStr(v.text)
    case 'state':
      return isBool(v.listening) && isStr(v.source)
    case 'speaking':
      return isBool(v.playing)
    case 'takeover':
      return isNum(v.previous_pid)
    case 'error':
      return isStr(v.message) && (ERROR_STAGES as readonly unknown[]).includes(v.stage)
    default:
      return false
  }
}

/** One stdout line from listen.py, or undefined if it isn't one of its events. */
export function parseEvent(line: string): MicEvent | undefined {
  try {
    const value: unknown = JSON.parse(line)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    return isMicEvent(value as Json) ? (value as MicEvent) : undefined
  } catch {
    return undefined
  }
}

/** A comma list, trimmed, blanks dropped. */
export function parseWords(input: string): string[] {
  return input
    .split(',')
    .map(word => word.trim())
    .filter(word => word !== '')
}

/** The rules from the settings screen. Blank lists fall back to the defaults
 *  where a blank would leave nothing to say. */
export function rulesFrom(options: Readonly<Record<string, unknown>>): Rules {
  const mode: Mode = options.sendMode === 'pause' ? 'pause' : 'word'
  const useWakeWord = options.useWakeWord !== false
  let sendWords = parseWords(isStr(options.sendWords) ? options.sendWords : '')
  if (mode === 'word' && sendWords.length === 0) sendWords = [...DEFAULT_SEND_WORDS]
  let wakeWords = parseWords(isStr(options.wakeWords) ? options.wakeWords : '')
  if (useWakeWord && wakeWords.length === 0) wakeWords = [...DEFAULT_WAKE_WORDS]
  return { mode, sendWords, useWakeWord, wakeWords }
}

/** Words the speech engine should listen hard for: wake words first (only
 *  when the wake word is on), then send words. */
export function keyterms(rules: Rules): string[] {
  return [...(rules.useWakeWord ? rules.wakeWords : []), ...rules.sendWords]
}

/** The pause setting as whole milliseconds, or the one-line reason it is out
 *  of range for the engine (Deepgram takes 1000-5000 ms; Whisper 1000 or more). */
export function pauseMsFor(engine: Engine, pauseSeconds: number): { ms: number } | { error: string } {
  const ms = Math.round(pauseSeconds * 1000)
  if (engine === 'deepgram') {
    if (!Number.isFinite(ms) || ms < 1000 || ms > 5000 || ms / 1000 !== pauseSeconds) {
      return { error: 'Pause must be 1 to 5 seconds, in whole milliseconds, for Deepgram (desk-mic settings).' }
    }
    return { ms }
  }
  if (!Number.isFinite(ms) || ms < 1000) return { error: 'Pause must be 1 second or more (desk-mic settings).' }
  return { ms }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function phrase(word: string): string {
  return word.trim().split(/\s+/).map(escapeRegExp).join('\\s+')
}

/** The send word at the very end of `text`, as whole words, ignoring case and end punctuation. */
function endingWord(words: readonly string[]): RegExp {
  return new RegExp(`(?:^|[\\s,;:.!?]+)(?:${words.map(phrase).join('|')})[\\s.!?]*$`, 'i')
}

/** Removes a trailing send word. Returns the rest and whether one was there. */
function cutSendWord(text: string, words: readonly string[]): { text: string; hadWord: boolean } {
  if (words.length === 0) return { text, hadWord: false }
  const match = endingWord(words).exec(text)
  if (!match) return { text, hadWord: false }
  return { text: text.slice(0, match.index).replace(/[\s,;:]+$/, ''), hadWord: true }
}

/** The text after a leading wake word (a whole word, then optionally one of
 *  , . ! ? :), or undefined when the sentence does not start with one. */
function afterWakeWord(text: string, words: readonly string[]): string | undefined {
  if (words.length === 0) return undefined
  const match = new RegExp(`^\\s*(?:${words.map(phrase).join('|')})(?=$|[\\s,.!?:])[,.!?:]?`, 'i').exec(text)
  return match ? text.slice(match[0].length).trim() : undefined
}

function join(draft: string, text: string): string {
  const head = draft.trim()
  const tail = text.trim()
  if (head === '') return tail
  if (tail === '') return head
  return `${head} ${tail}`
}

/** The send-word rules alone, as before the wake word existed. */
function plainAction(text: string, rules: Rules, draft: string): Action {
  if (CLEAR_WORDS.test(text)) return { kind: 'clear' }
  const cut = cutSendWord(text, rules.sendWords)
  const full = join(draft, cut.text)
  if (rules.mode === 'pause' || cut.hadWord) {
    return full === '' ? { kind: 'nothing' } : { kind: 'submit', text: full }
  }
  return { kind: 'fill', text: full }
}

/** What to do with one spoken sentence, given the rules, the current draft
 *  and whether the wake word was heard recently. Returns the new awake state. */
export function planUtterance(
  text: string,
  rules: Rules,
  draft: string,
  awake: Awake,
  nowMs: number,
): { action: Action; awake: Awake } {
  if (!rules.useWakeWord) return { action: plainAction(text, rules, draft), awake }

  const isAwake = awake.isAwake && nowMs - awake.lastHeardMs <= AWAKE_FOR_MS
  const rest = afterWakeWord(text, rules.wakeWords)
  if (!isAwake && rest === undefined) {
    return { action: { kind: 'nothing' }, awake: { isAwake: false, lastHeardMs: awake.lastHeardMs } }
  }
  const sentence = rest ?? text
  if (sentence === '') return { action: { kind: 'nothing' }, awake: { isAwake: true, lastHeardMs: nowMs } }

  const action = plainAction(sentence, rules, draft)
  // Sending or clearing ends the stretch; the next prompt needs the wake word again.
  const stillAwake = action.kind !== 'submit' && action.kind !== 'clear'
  return { action, awake: { isAwake: stillAwake, lastHeardMs: nowMs } }
}

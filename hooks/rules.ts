// What desk-mic does with each sentence it hears: the send word, the wake
// word, and the listener's event lines. Pure functions, no `$`.

export type Mode = 'word' | 'pause'
export type Rules = { mode: Mode; sendWords: string[]; stopWords: string[]; useWakeWord: boolean; wakeWords: string[] }
export type Awake = { isAwake: boolean; lastHeardMs: number }
export type Engine = 'deepgram' | 'whisper'

export type Action =
  | { kind: 'submit'; text: string }
  | { kind: 'fill'; text: string }
  | { kind: 'clear' }
  | { kind: 'stop' }
  | { kind: 'nothing' }

export const ERROR_STAGES = ['device', 'mic', 'model', 'deepgram', 'mute_key', 'connection', 'takeover'] as const
export type ErrorStage = (typeof ERROR_STAGES)[number]

// One line of engine/listen.py's stdout. hooks/fixtures/listener-events.jsonl
// holds one of each; both sides test against it.
export type MicEvent =
  | { type: 'ready'; device: string; mute_key: string | null; pid: number }
  | { type: 'loading'; model: string }
  | { type: 'partial'; text: string }
  | { type: 'utterance'; text: string }
  | { type: 'unsure'; text: string }
  | { type: 'state'; listening: boolean; source: string }
  | { type: 'speaking'; playing: boolean }
  | { type: 'takeover'; previous_pid: number }
  | { type: 'error'; stage: ErrorStage; message: string }

// Defaults from the settings screen (plugin.json); used when a list is blank.
const DEFAULT_SEND_WORDS = ['send it']
const DEFAULT_WAKE_WORDS = ['claude']
// The phone bridge's stop words (voice-bridge voice_settings.py DEFAULT_STOP_WORDS).
const DEFAULT_STOP_WORDS = ['stop', 'cancel', 'wait', 'hold on', 'never mind']
// Awake runs out after this much quiet (Ryan, 2026-11-06).
export const AWAKE_FOR_MS = 30000

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
    case 'partial':
    case 'utterance':
    case 'unsure':
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
  let stopWords = parseWords(isStr(options.stopWords) ? options.stopWords : '')
  if (stopWords.length === 0) stopWords = [...DEFAULT_STOP_WORDS]
  return { mode, sendWords, stopWords, useWakeWord, wakeWords }
}

/** Whether the sentence is a stop word on its own, with or without a wake
 *  word in front, whatever the awake state. */
export function stopWordSaid(text: string, rules: Rules): boolean {
  const rest = rules.useWakeWord ? afterWakeWord(text, rules.wakeWords) : undefined
  return isStopWord(rest ?? text, rules.stopWords)
}

/** True only when the whole sentence is a stop word ("Stop.", "hold on"), as
 *  on the phone bridge: "stop the server" is a request, not a stop. */
function isStopWord(text: string, words: readonly string[]): boolean {
  const said = text.toLowerCase().split(/\s+/).join(' ').replace(/^[\s,.!?;:]+|[\s,.!?;:]+$/g, '')
  return said !== '' && words.some(word => word.toLowerCase().split(/\s+/).join(' ') === said)
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
  if (isStopWord(text, rules.stopWords)) return { kind: 'stop' }
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

/** What the prompt box should show while a sentence is still being spoken:
 *  the draft, then the words so far, without the wake word or a trailing send
 *  word. Undefined when nothing should show (the wake word is needed and not
 *  heard, or the words are a clear command). Changes no awake state. */
export function previewText(text: string, rules: Rules, draft: string, awake: Awake, nowMs: number): string | undefined {
  let sentence = text
  if (rules.useWakeWord) {
    const isAwake = awake.isAwake && nowMs - awake.lastHeardMs <= AWAKE_FOR_MS
    const rest = afterWakeWord(text, rules.wakeWords)
    if (!isAwake && rest === undefined) return undefined
    sentence = rest ?? text
  }
  if (CLEAR_WORDS.test(sentence) || isStopWord(sentence, rules.stopWords)) return undefined
  return join(draft, cutSendWord(sentence, rules.sendWords).text)
}

/** Whether the sentence starts with a wake word (the wake word must be on). */
export function wakeWordHeard(text: string, rules: Rules): boolean {
  return rules.useWakeWord && afterWakeWord(text, rules.wakeWords) !== undefined
}

// Echo: the mic hearing desk-mic's own read-aloud. Ported from voice-bridge
// voice_text.py (normalize_for_echo, is_echo_of, MIN_ECHO_CHARS, MIN_ECHO_WORDS)
// and bridge.py (ECHO_MEMORY_SECONDS, ECHO_GUARD_MS defaults).
export const MIN_ECHO_CHARS = 6
export const MIN_ECHO_WORDS = 2
// What was read aloud stops counting as possible echo this long after.
export const ECHO_MEMORY_MS = 10000
// The piece before the current one counts only this long after reading ends.
export const ECHO_GUARD_MS = 1200

function normalizeForEcho(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ')
}

/** True when `text` is a whole run of words inside `spoken` (start, end or
 *  middle). Under MIN_ECHO_CHARS characters or MIN_ECHO_WORDS words it is never
 *  echo: "yes", "no", "stop" are answers even when the reply said them. */
export function isEchoOf(text: string, spoken: string): boolean {
  const heard = normalizeForEcho(text)
  const said = normalizeForEcho(spoken)
  if (said === '' || heard.length < MIN_ECHO_CHARS || heard.split(' ').length < MIN_ECHO_WORDS) return false
  return ` ${said} `.includes(` ${heard} `)
}

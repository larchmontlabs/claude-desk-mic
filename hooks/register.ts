import type { Register } from 'claude-code'

import { type Awake, type MicEvent, type Rules, parseEvent, planUtterance, rulesFrom, splitLines } from './rules'

// desk-mic: /mic runs voice-bridge's desk_mic.py in --emit-json mode and turns
// each thing you say into prompt text. desk_mic.py does the listening
// (Deepgram, filler stripping, Right Ctrl mute, TTS pause, one-mic-at-a-time
// lock); this mod does the delivery, so no window title or fake key presses.
//
// Every setting comes from the settings screen (plugin.json userConfig), read
// once from register(on, options). The events are the listener's, as rules.ts
// types them (hooks/fixtures/listener-events.jsonl); Task 8 switches the spawn
// over to engine/listen.py.
//
//   /mic                 toggle on/off (/mic on, /mic off)
//   /mic status          say what it's doing

const BRIDGE_DIR = '<path to your voice-bridge checkout>'
const PYTHON = `${BRIDGE_DIR}/venv/Scripts/python.exe`
// Where a user sets or changes the sensitive deepgramApiKey after install
// (it is not a row in /config). The command exists in `claude plugin --help`;
// the id form name@marketplace comes from the CLI's own error message.
export const KEY_HINT = 'run: claude plugin configure desk-mic@claude-desk-mic'

export function statusText(
  on: boolean,
  listening: boolean,
  speaking: boolean,
  rules: Rules,
  muteKey: string | null,
): string | undefined {
  if (!on) return undefined
  if (!listening) return muteKey ? `mic muted (${muteKey})` : 'mic muted'
  if (speaking) return 'mic paused while speaking'
  return rules.mode === 'pause' ? 'mic on - sends when you pause' : `mic on - say "${rules.sendWords[0]}"`
}

function describe(rules: Rules, pauseSeconds: number): string {
  const wake = rules.useWakeWord ? `starts on "${rules.wakeWords[0]}" and ` : ''
  if (rules.mode === 'pause') {
    return `${wake}sends each sentence after a ${pauseSeconds}s pause`
  }
  const words = rules.sendWords.map(word => `"${word}"`).join(' or ')
  return `${wake}fills the prompt box; say ${words} to send (end of a sentence works)`
}

export const register: Register = (on, options) => {
  const rules = rulesFrom(options)
  const pauseSeconds = typeof options.pauseSeconds === 'number' ? options.pauseSeconds : 3
  // Module variables reset on reload; the engine kills the child on unload too,
  // so "off" after a reload is the truth.
  let isOn = false
  let isStopping = false
  let pid: number | undefined
  let listening = true
  let speaking = false
  let muteKey: string | null = null
  let awake: Awake = { isAwake: false, lastHeardMs: 0 }
  let lastError = ''

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'mic',
      description: 'Desk mic: toggle, or on | off | status',
    })
    $.ui.status(undefined)
    return next(e)
  })

  on('command.run', { command: 'mic' }, async ($, e) => {
    const sub = (e.args.trim().split(/\s+/)[0] ?? '').toLowerCase()
    const refresh = () => $.ui.status(statusText(isOn, listening, speaking, rules, muteKey))

    if (sub === 'status') {
      if (!isOn) return { text: `Mic is off. When on, it ${describe(rules, pauseSeconds)}. Type /mic to turn it on.` }
      return { text: `Mic is on (${listening ? 'listening' : 'muted'}). It ${describe(rules, pauseSeconds)}.` }
    }

    const wantOn = sub === 'on' ? true : sub === 'off' ? false : sub === '' ? !isOn : undefined
    if (wantOn === undefined) {
      return { text: 'Use /mic, /mic on, /mic off or /mic status.' }
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
    speaking = false
    muteKey = null
    awake = { isAwake: false, lastHeardMs: 0 }
    pid = undefined
    lastError = ''
    $.ui.status('mic starting...')

    const child = $.process.spawn({
      argv: [PYTHON, '-u', 'desk_mic.py', '--emit-json'],
      cwd: BRIDGE_DIR,
      env: { UTTERANCE_END_MS: String(Math.round(pauseSeconds * 1000)) },
    })

    const handle = async (event: MicEvent) => {
      switch (event.type) {
        case 'ready':
          pid = event.pid
          muteKey = event.mute_key
          $.ui.toast(muteKey ? `Mic on (${event.device}). ${muteKey} mutes.` : 'Mic on (mute key unavailable)')
          break
        case 'state':
          listening = event.listening
          break
        case 'speaking':
          speaking = event.playing
          break
        case 'takeover':
          $.ui.toast('Took the mic over from another session.')
          break
        case 'error':
          lastError = event.message
          break
        case 'loading':
          break
        case 'utterance': {
          const box = await $.prompt.read()
          const plan = planUtterance(event.text, rules, box.text, awake, Date.now())
          awake = plan.awake
          if (plan.action.kind === 'fill') {
            const filled = await $.prompt.fill({ text: plan.action.text, mode: 'replace' })
            // A dialog can hold the prompt box; don't lose what was said.
            if (!filled.isFilled) $.ui.toast(`Mic heard (box busy): ${event.text}`)
          } else if (plan.action.kind === 'clear') {
            await $.prompt.fill({ text: '', mode: 'replace' })
          } else if (plan.action.kind === 'submit') {
            if (box.text.trim() !== '') await $.prompt.fill({ text: '', mode: 'replace' })
            void $.prompt.submit({ text: plan.action.text })
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
        lastError = `could not start the listener: ${String(err)}`
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

    return {
      text: `Mic starting. It ${describe(rules, pauseSeconds)}. "Scratch that" clears the box. /mic turns it off.`,
    }
  })
}

# desk-mic

Talk to Claude from your computer's microphone. `/mic` turns the mic on and off, puts what you say in the prompt box (or sends it), and can read Claude's replies back to you. Works on Windows 10/11 and macOS 13+. Speech comes from Deepgram (cloud) or a local Whisper model.

## Install

```
/plugin install desk-mic --marketplace ryangalea23/claude-desk-mic
```

All settings are on the install screen and in `/config`. `/mic` takes only `on`, `off`, `status`, or nothing (toggle).


## How it works

Say "Claude, what time is it, send it" and the prompt `what time is it` is sent. The wake word starts a prompt and the send word sends it. Both are settings: turn the wake word off, change either word, or switch to `pause` mode, where each sentence is sent when you stop talking. Say "stop listening" or "mic off" to mute and "start listening" or "mic on" to unmute. A mute key does the same from the keyboard.

With `speakBack` on, Claude's replies are read aloud while the mic is on. The voice is a natural one from edge-tts, and falls back to the system voice if it cannot be reached. Sending a new prompt stops the reply that is being read.

Dictated prompts queue until Claude is idle. They do not expand `@file` mentions or pasted images.

## Settings

<!-- settings:start -->
| Setting | What it does | Default |
|---|---|---|
| `engine` (Speech engine) | deepgram (cloud, needs an API key) or whisper (runs on this computer) Options: `deepgram`, `whisper`. | `deepgram` |
| `deepgramApiKey` (Deepgram API key) | Only needed for the deepgram engine | none (stored as a secret) |
| `whisperModel` (Whisper model) | Model size for the whisper engine Options: `tiny.en`, `base.en`, `small.en`, `medium.en`. | `base.en` |
| `vadLevel` (Whisper voice-detection level) | 0 to 3; higher ignores more background noise Range 0 to 3. | `2` |
| `sendMode` (How a sentence is sent) | word: build the prompt until you say a send word. pause: send each sentence when you pause. Options: `word`, `pause`. | `word` |
| `sendWords` (Send words) | Comma-separated words that send the prompt | `send it` |
| `useWakeWord` (Use a wake word) | Only act on speech that starts with the wake word | `true` |
| `wakeWords` (Wake words) | Comma-separated wake words | `claude` |
| `pauseSeconds` (Pause length (seconds)) | Quiet time that ends a sentence (minimum 1; deepgram accepts 1 to 5) Minimum 1. | `3` |
| `speakBack` (Speak replies back) | Read Claude's replies aloud while the mic is on | `false` |
| `voice` (Voice) | edge-tts voice name | `en-US-AriaNeural` |
| `muteKey` (Mute key) | auto = Right Ctrl on Windows, Right Option on Mac Options: `auto`, `right ctrl`, `left ctrl`, `right alt`, `right shift`, `f13`. | `auto` |
<!-- settings:end -->

This table is generated from `.claude-plugin/plugin.json` by `python scripts/settings_table.py`, and a test fails if it drifts.

## Mac notes

**Mac is untested.** The engine and the mod run in CI on macOS, but the live Mac checklist has not been run on a real Mac yet. This note stays until it has.

- Allow Microphone access for your terminal app (System Settings, Privacy and Security, Microphone).
- Allow Accessibility access for your terminal app too. It is needed only for the mute key (Right Option by default). Without it `/mic` still listens but reports that the mute key is unavailable.
- The natural voice plays through the built-in `afplay`, so no ffmpeg install is needed. If edge-tts cannot be reached, the built-in `say` command is used.

## Setting the Deepgram key

The key is a sensitive setting, so it is not a row in `/config`. Set or change it after install with:

```
claude plugin configure desk-mic@claude-desk-mic
```

(add `--values-stdin` to save values from a JSON object on stdin). The command is listed in `claude plugin --help`. The in-app screen path for the key is to be confirmed in the live run; this section will be updated with it.

## Developing

- Tests: `claude plugin test .`
- Manifest check: `claude plugin validate .`
- Type check: `npx -y -p typescript tsc -p . --noEmit`. The API types live in the git-ignored `.claude-plugin/types/`. There is no command to generate them: Claude Code writes them when it loads this folder as a hot-reloaded mod (for example synced into the session's dev-mods folder with `scripts/sync-dev.sh <dev-mods>/desk-mic`). Copy that folder's `.claude-plugin/types/` here to type-check offline.

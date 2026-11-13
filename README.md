# desk-mic

Talk to Claude from your computer's microphone. `/mic` turns the mic on and off, puts what you say in the prompt box (or sends it), and can read Claude's replies back to you. Works on Windows 10/11 and macOS 13+. Speech comes from Deepgram (cloud) or a local Whisper model.

## Before you install

- Python 3.10 or newer must be installed. On first `/mic`, desk-mic builds its own Python environment in `~/.claude-desk-mic/venv` and installs its packages there.
- On Windows the natural voice needs `ffplay` (part of ffmpeg) on your PATH. Without it, replies are read with the Windows system voice. On macOS the natural voice plays through the built-in `afplay`.

## Install

From a terminal:

```
claude plugin marketplace add ryangalea23/claude-desk-mic
claude plugin install desk-mic@claude-desk-mic
```

Or inside Claude Code:

```
/plugin marketplace add ryangalea23/claude-desk-mic
/plugin install desk-mic@claude-desk-mic
```

All settings are on the install screen and in `/config`. `/mic` takes only `on`, `off`, `status`, or nothing (toggle).

## Privacy

With the `deepgram` engine, desk-mic streams your mic audio to Deepgram's cloud while the mic is on. That is all audio, not only the sentences that start with the wake word. Muting stops it. The `whisper` engine keeps all audio on this computer.

desk-mic keeps two small files in `~/.claude-desk-mic`: `listen.log`, the listener's log from its last run, and `last-stop.txt`, why the mic last stopped. Neither holds what you said or your key: they record events, sentence lengths and confidence scores only.


## How it works

Say "Claude, what time is it, send it" and the prompt `what time is it` is sent. The wake word starts a prompt and the send word sends it. Both are settings: turn the wake word off, change either word, or switch to `pause` mode, where each sentence is sent when you stop talking. To mute, press the mute key, or say "stop listening" or "mic off" on its own, without the wake word in front. A muted mic hears nothing, so it cannot hear you ask it to unmute: press the mute key again, or run `/mic off` and then `/mic on`.

While you talk, the words show up in the prompt box. "Claude, scratch that" clears the box. Say a stop word on its own ("stop", "cancel", "wait", "hold on" or "never mind") to end Claude's running reply. Within 30 seconds of a prompt you dictated, a stop word on its own works; after that, say "Claude, stop". The mic does not listen while a reply is read aloud (so it does not hear itself), so a stop word cannot cut the reading short: press the mute key or run `/mic off` to stop it. With the wake word turned off, anyone near the mic who says a stop word on its own stops Claude's reply, so pick less common stop words if that is a risk. A stop cannot take back a dictated prompt that is waiting for Claude to finish; it is still sent. If the speech engine is not sure it heard you right, the sentence waits in the box unsent until you say the send word.

With `speakBack` on, Claude's replies are read aloud while the mic is on. The voice is a natural one from edge-tts, and falls back to the system voice if it cannot be reached. Sending a new prompt stops the reply that is being read.

Dictated prompts queue until Claude is idle. The prompt box clears as soon as one is sent, so you can dictate the next one while Claude works. If a prompt is not sent, a toast shows its text, and it goes back in the box if the box is empty. Dictated prompts do not expand `@file` mentions or pasted images.

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
| `stopWords` (Stop words) | Said alone, these end Claude's running reply and stop reading aloud (comma list) | `stop, cancel, wait, hold on, never mind` |
| `useWakeWord` (Use a wake word) | Only act on speech that starts with the wake word | `true` |
| `wakeWords` (Wake words) | Comma-separated wake words | `claude` |
| `pauseSeconds` (Pause length (seconds)) | Quiet time that ends a sentence (minimum 1; deepgram accepts 1 to 5) Minimum 1. | `3` |
| `speakBack` (Speak replies back) | Read Claude's replies aloud while the mic is on | `false` |
| `voice` (Voice) | edge-tts voice name | `en-US-AriaNeural` |
| `muteKey` (Mute key) | auto = Right Ctrl on Windows, Right Option on Mac Options: `auto`, `right ctrl`, `left ctrl`, `right alt`, `right shift`, `f13`. | `auto` |
<!-- settings:end -->

This table is generated from `.claude-plugin/plugin.json` by `python scripts/settings_table.py`, and a test fails if it drifts.

## Mac notes

**Mac is untested.** The engine's tests run in CI on macOS and Windows. The mod's tests (`claude plugin test .`) are run by hand, not in CI. The live Mac checklist has not been run on a real Mac yet. This note stays until it has.

- Allow Microphone access for your terminal app (System Settings, Privacy and Security, Microphone).
- Allow Accessibility access for your terminal app too. It is needed only for the mute key (Right Option by default). Without it `/mic` still listens but reports that the mute key is unavailable.
- The natural voice plays through the built-in `afplay`, so no ffmpeg install is needed. If edge-tts cannot be reached, the built-in `say` command is used.

## Setting the Deepgram key

The key is a sensitive setting, so it is not a row in `/config`. Set or change it after install inside Claude Code with:

```
/plugin configure desk-mic@claude-desk-mic
```

or from a terminal with:

```
claude plugin configure desk-mic@claude-desk-mic
```

(add `--values-stdin` to save values from a JSON object on stdin).

If the setting is blank, desk-mic uses the `DEEPGRAM_API_KEY` environment variable instead. Setting that once on your computer covers every Claude Code account or config folder you use, since each one keeps its own plugin settings. The setting wins when both are set.

## Developing

- Tests: `claude plugin test .`
- Manifest check: `claude plugin validate .`
- Type check: `npx -y -p typescript tsc -p . --noEmit`. The API types live in the git-ignored `.claude-plugin/types/`. There is no command to generate them: Claude Code writes them when it loads this folder as a hot-reloaded mod (for example synced into the session's dev-mods folder with `scripts/sync-dev.sh <dev-mods>/desk-mic`). Copy that folder's `.claude-plugin/types/` here to type-check offline.

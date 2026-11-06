# desk-mic

Talk to Claude from your computer's microphone. `/mic` turns the mic on and off, puts what you say in the prompt box (or sends it), and can read Claude's replies back to you. Works on Windows 10/11 and macOS 13+. Speech comes from Deepgram (cloud) or a local Whisper model.

## Install

```
/plugin install desk-mic --marketplace <owner>/claude-desk-mic
```

All settings are on the install screen and in `/config`. `/mic` takes only `on`, `off`, `status`, or nothing (toggle).

## Setting the Deepgram key

The key is a sensitive setting, so it is not a row in `/config`. Set or change it after install with:

```
claude plugin configure desk-mic@claude-desk-mic
```

(add `--values-stdin` to save values from a JSON object on stdin). The command is listed in `claude plugin --help`; the full in-app screen path was not verified in a live session.

## Developing

- Tests: `claude plugin test .`
- Manifest check: `claude plugin validate .`
- Type check: `npx -y -p typescript tsc -p . --noEmit`. The API types live in the git-ignored `.claude-plugin/types/`. There is no command to generate them: Claude Code writes them when it loads this folder as a hot-reloaded mod (for example synced into the session's dev-mods folder with `scripts/sync-dev.sh <dev-mods>/desk-mic`). Copy that folder's `.claude-plugin/types/` here to type-check offline.

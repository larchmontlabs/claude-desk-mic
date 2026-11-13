"""desk-mic listener: microphone -> speech-to-text -> JSON events on stdout.

The Claude Code mod runs this with --emit-json and decides what to do with
each event (fill the prompt box, submit, show status). Events, one JSON line
each (hooks/fixtures/listener-events.jsonl holds one of every kind):

  ready {device, mute_key, pid}   every startup stage succeeded
  loading {model}                 Whisper model about to load
  utterance {text}                a sentence that passed the filters
  state {listening, source}       muted / unmuted
  speaking {playing}              speak-back started / stopped playing
  takeover {previous_pid}         an older listener was stopped
  error {stage, message}          stage: device, mic, model, deepgram,
                                  mute_key, connection, takeover

Startup runs in stages, each with its own error: device, mic, model (Whisper)
or deepgram (Deepgram). A failed stage closes what is open, releases the mic
lock and exits non-zero. The Deepgram key comes only from DEEPGRAM_API_KEY.

With --parent-pid (the mod passes the Claude Code process), the listener
checks that process every few seconds and shuts down cleanly once it is gone,
so a crashed or killed session never leaves the mic recording.
"""
import argparse
import asyncio
import importlib
import logging
import os
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable

import numpy as np

import core
from core import MicState, Output, TakeoverTimeout, accept, mute_key_label, state_paths, voice_command
from text import strip_fillers

log = logging.getLogger("desk-mic.listen")

SAMPLE_RATE = 16000
CHANNELS = 1
# Audio comes in 100 ms blocks (1600 samples): few callbacks, still live enough
# for streaming speech to text.
BLOCK_SAMPLES = 1600
SPEAKING_CHECK_S = 0.2
# voice-bridge desk_mic.py DESK_MIC_MIN_CHARS / DESK_MIC_MIN_CONFIDENCE defaults.
MIN_CHARS = 4
MIN_CONFIDENCE = 0.6
# Deepgram utterance_end_ms accepts 1000-5000 ms (Deepgram utterance-end docs).
DEEPGRAM_PAUSE_MS = (1000, 5000)
MIN_PAUSE_MS = 1000
# How often the owner watch checks Claude Code is still running (final branch review, I4: "every 2 s").
PARENT_POLL_S = 2.0
_PARENT_GONE = object()


class _LockedOutput(Output):
    """Output shared by the event loop, the audio thread and the hotkey thread:
    one lock so two events never interleave on a line."""

    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self._write_lock = threading.Lock()

    def event(self, obj: dict) -> None:
        with self._write_lock:
            super().event(obj)

    def say(self, text: str) -> None:
        with self._write_lock:
            super().say(text)


class Listener:
    """What happens to each sentence and each block of audio."""

    def __init__(self, out: Output, state: MicState, flag, is_speaking=core.is_speaking, clock=None) -> None:
        self.out = out
        self.state = state
        self._flag = flag
        self._is_speaking = is_speaking
        # The speaking check reads a file and looks up a process; on every audio
        # block it made the callback fall behind (input overflow), so it runs at
        # most every SPEAKING_CHECK_S and the answer is reused in between.
        self._clock = clock or time.monotonic
        self._speaking = False
        self._checked_at = None
        # Keep sending audio while a reply is read aloud, so the person can
        # interrupt it; the mod tells its own voice apart from theirs.
        self.hear_while_speaking = False
        # Set once the speech engine has started; until then audio is dropped.
        self.send: Callable[[bytes], Any] | None = None

    async def on_utterance_full(self, text: str, confidence: float | None) -> None:
        if not self.state.listening:
            log.info("Muted, dropping a stray sentence (%d chars)", len(text))
            return
        if confidence is not None and confidence < MIN_CONFIDENCE:
            # Not sure it heard right: never sent as is, but the mod can show
            # it in the box (unsent) for the person to send or clear.
            unsure = accept(text, None, MIN_CHARS, MIN_CONFIDENCE)
            log.info("Unsure (confidence %.2f < %.2f, %d chars)", confidence, MIN_CONFIDENCE, len(text))
            command = voice_command(unsure) if unsure else None
            if command is not None:
                # Muting is safe to act on even when unsure.
                self.out.event({"type": "partial", "text": ""})
                self.state.set_listening(command == "on", "voice command")
                return
            self.out.event({"type": "unsure", "text": unsure} if unsure else {"type": "partial", "text": ""})
            return
        cleaned = accept(text, confidence, MIN_CHARS, MIN_CONFIDENCE)
        if cleaned is None:
            # Its live words may be showing in the prompt box; take them away.
            self.out.event({"type": "partial", "text": ""})
            return
        log.debug("Heard: %r", cleaned)
        command = voice_command(cleaned)
        if command is not None:
            self.out.event({"type": "partial", "text": ""})
            self.state.set_listening(command == "on", "voice command")
            return
        self.out.event({"type": "utterance", "text": cleaned})

    async def on_partial(self, text: str) -> None:
        """Words heard so far in a sentence that is not finished yet. Shown
        live in the prompt box; the finished sentence still goes through
        on_utterance_full."""
        if not self.state.listening:
            return
        cleaned = strip_fillers(text).strip()
        if cleaned:
            self.out.event({"type": "partial", "text": cleaned})

    def audio_callback(self, indata, frames, time_info, status) -> None:
        """sounddevice callback. Audio is captured all the time but only sent
        while listening and while speak-back is not playing."""
        if status:
            log.warning("Audio status: %s", status)
        now = self._clock()
        if self._checked_at is None or now - self._checked_at >= SPEAKING_CHECK_S - 1e-9:
            self._checked_at = now
            self._speaking = self._is_speaking(self._flag)
            self.state.set_speaking(self._speaking)
        speaking = self._speaking
        if (speaking and not self.hear_while_speaking) or not self.state.listening or self.send is None:
            return
        pcm = (np.clip(indata[:, 0], -1.0, 1.0) * 32767).astype(np.int16).tobytes()
        self.send(pcm)


@dataclass
class Deps:
    """Everything listen.py touches outside itself, so tests can swap it."""

    platform: str = sys.platform
    pid: int = field(default_factory=os.getpid)
    env: Any = field(default_factory=lambda: os.environ)
    stdout: Any = None
    stderr: Any = None
    sd: Any = None  # the sounddevice module; imported at the device stage
    deepgram_stt: Callable | None = None  # stt_deepgram.DeepgramSTT
    whisper_stt: Callable | None = None  # stt_whisper.WhisperSTT
    claim_mic: Callable = core.claim_mic
    release_mic: Callable = core.release_mic
    is_speaking: Callable = core.is_speaking
    resolve_mute_key: Callable = core.resolve_mute_key
    start_mute_key_listener: Callable = core.start_mute_key_listener
    watch_parent: Callable[[int], Callable[[], bool]] = core.process_watch
    parent_poll_s: float = PARENT_POLL_S
    # Also write the log to <state-dir>/listen.log. On for a real run only.
    log_file: bool = False
    # Tests only: awaited after `ready` in place of waiting for the stream to close.
    after_ready: Callable[[Listener], Awaitable[None]] | None = None


# -- Arguments ---------------------------------------------------------------------


def _vad_level(text: str) -> int:
    try:
        value = int(text)
    except ValueError:
        raise argparse.ArgumentTypeError(f"{text!r} is not a whole number")
    if not 0 <= value <= 3:
        raise argparse.ArgumentTypeError(f"{value} is outside 0 to 3")
    return value


def _parent_pid(text: str) -> int:
    try:
        value = int(text)
    except ValueError:
        raise argparse.ArgumentTypeError(f"{text!r} is not a whole number")
    if value <= 0:
        raise argparse.ArgumentTypeError(f"{value} is not a process id")
    return value


def _mute_key(text: str) -> str:
    try:
        mute_key_label(text, "win32")
    except ValueError as exc:
        raise argparse.ArgumentTypeError(str(exc))
    return text


def parse_args(argv=None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="desk-mic listener")
    parser.add_argument("--emit-json", action="store_true", help="write JSON events to stdout for the mod")
    parser.add_argument("--state-dir", type=Path, required=True, help="folder for the mic lock and speaking flag")
    parser.add_argument("--engine", choices=["deepgram", "whisper"], default="deepgram")
    parser.add_argument("--model", help="Whisper model name (required for whisper; Deepgram uses nova-2)")
    parser.add_argument("--pause-ms", type=int, default=3000, help="quiet time that ends a sentence")
    parser.add_argument("--mute-key", type=_mute_key, default="auto")
    parser.add_argument("--vad-level", type=_vad_level, default=2, help="Whisper voice detection, 0 to 3")
    parser.add_argument("--device", default="",
                        help="use the first microphone whose name contains this (any case); blank: the default")
    parser.add_argument("--hear-while-speaking", action="store_true",
                        help="keep listening while a reply is read aloud, so it can be interrupted")
    parser.add_argument("--send-word", action="append", default=[],
                        help="a send word: a sentence ending with it is sent at once (deepgram); repeatable")
    parser.add_argument("--keyterm", action="append", default=[], help="a word to listen hard for; repeatable")
    parser.add_argument("--parent-pid", type=_parent_pid, help="stop when this process (Claude Code) exits")
    args = parser.parse_args(argv)
    if args.engine == "deepgram":
        low, high = DEEPGRAM_PAUSE_MS
        if not low <= args.pause_ms <= high:
            parser.error(f"--pause-ms must be {low} to {high} for deepgram")
    elif args.pause_ms < MIN_PAUSE_MS:
        parser.error(f"--pause-ms must be {MIN_PAUSE_MS} or more")
    if args.engine == "whisper" and not args.model:
        parser.error("--model is required for whisper")
    return args


# -- Startup stages --------------------------------------------------------------------


class _StageError(Exception):
    def __init__(self, stage: str, message: str) -> None:
        super().__init__(message)
        self.stage = stage
        self.message = message


def _input_device(sd, wanted: str = ""):
    """(index, name) of the mic to open. `wanted` blank: the system default
    (index None). Otherwise the first input device whose name contains it, any
    case; none matching is an error that lists the mics, never the default."""
    try:
        devices = sd.query_devices()
        default_index = sd.default.device[0]
    except Exception as exc:
        raise _StageError(
            "device",
            f"Could not list audio devices ({exc}). Check that a microphone is connected, then turn the mic on again.",
        )
    wanted = wanted.strip()
    if wanted:
        inputs = [(i, d) for i, d in enumerate(devices) if d.get("max_input_channels", 1) > 0]
        for i, d in inputs:
            if wanted.lower() in str(d["name"]).lower():
                return i, str(d["name"])
        # Windows also lists driver-internal names ("@System32\...", "Input ()"); leave those out.
        readable = {str(d["name"]) for _, d in inputs if "@" not in str(d["name"]) and not str(d["name"]).endswith("()")}
        names = ", ".join(sorted(readable)) or "none"
        raise _StageError(
            "device",
            f"No microphone named {wanted!r}. Microphones found: {names}. Change the micDevice setting, "
            "or leave it blank for the default.",
        )
    if default_index is None or default_index < 0 or default_index >= len(devices):
        raise _StageError(
            "device",
            "No microphone found. Plug one in, or pick a default input device in your sound settings, "
            "then turn the mic on again.",
        )
    return None, str(devices[default_index]["name"])


def _mic_error(device: str, exc: Exception) -> _StageError:
    return _StageError(
        "mic",
        f"Could not open the microphone {device!r} ({exc}). Allow microphone access for your terminal app "
        "(Windows: Settings > Privacy & security > Microphone; macOS: System Settings > Privacy & Security > "
        "Microphone) and close any app that is holding the microphone, then turn the mic on again.",
    )


def _fail(out: Output, stage: str, message: str) -> int:
    log.error("%s: %s", stage, message)
    out.event({"type": "error", "stage": stage, "message": message})
    return 1


async def run(args: argparse.Namespace, deps: Deps) -> int:
    out = _LockedOutput(emit_json=args.emit_json, stdout=deps.stdout, stderr=deps.stderr)
    paths = state_paths(args.state_dir)
    lock, flag = paths["lock"], paths["flag"]

    try:
        previous = deps.claim_mic(lock, deps.pid)
    except TakeoverTimeout as exc:
        return _fail(out, "takeover", f"Another desk-mic listener (pid {exc.pid}) would not stop.")
    if previous is not None:
        out.event({"type": "takeover", "previous_pid": previous})

    state = MicState(out)
    listener = Listener(out, state, flag, is_speaking=deps.is_speaking)
    listener.hear_while_speaking = args.hear_while_speaking
    loop = asyncio.get_running_loop()
    closed: asyncio.Future = loop.create_future()

    async def on_closed(message: str) -> None:
        if not closed.done():
            closed.set_result(message)

    async def watch_parent(pid: int) -> None:
        alive = deps.watch_parent(pid)
        while alive():
            await asyncio.sleep(deps.parent_poll_s)
        if not closed.done():
            closed.set_result(_PARENT_GONE)

    watcher = None if args.parent_pid is None else asyncio.ensure_future(watch_parent(args.parent_pid))
    stream = None
    stt = None
    try:
        # (1) device
        try:
            sd = deps.sd if deps.sd is not None else importlib.import_module("sounddevice")
        except Exception as exc:
            raise _StageError("device", f"Could not load the audio library ({exc}). Reinstall desk-mic's engine.")
        device_index, device = _input_device(sd, args.device)

        # (2) mic
        try:
            stream = sd.InputStream(
                device=device_index,
                samplerate=SAMPLE_RATE,
                channels=CHANNELS,
                dtype="float32",
                blocksize=BLOCK_SAMPLES,
                callback=listener.audio_callback,
            )
            stream.start()
        except Exception as exc:
            raise _mic_error(device, exc)

        # (3) model, or (4) deepgram
        if args.engine == "whisper":
            try:
                factory = deps.whisper_stt or importlib.import_module("stt_whisper").WhisperSTT
                stt = factory(
                    on_utterance_full=listener.on_utterance_full,
                    model=args.model,
                    keyterms=list(args.keyterm),
                    pause_ms=args.pause_ms,
                    on_loading=lambda model: out.event({"type": "loading", "model": model}),
                    vad_level=args.vad_level,
                )
                await stt.start()
            except Exception as exc:
                raise _StageError(
                    "model",
                    f"Could not load the Whisper model {args.model} ({exc}). The model must be downloaded once "
                    "while online: connect to the internet and turn the mic on again.",
                )
        else:
            key = deps.env.get("DEEPGRAM_API_KEY", "")
            if not key:
                raise _StageError(
                    "deepgram", "No Deepgram API key. Set it in the desk-mic settings, or switch the engine to whisper."
                )
            try:
                factory = deps.deepgram_stt or importlib.import_module("stt_deepgram").DeepgramSTT
                model = {} if args.model is None else {"model": args.model}
                stt = factory(
                    on_utterance_full=listener.on_utterance_full,
                    on_partial=listener.on_partial,
                    on_closed=on_closed,
                    encoding="linear16",
                    sample_rate=SAMPLE_RATE,
                    channels=CHANNELS,
                    keyterms=list(args.keyterm),
                    flush_words=list(args.send_word),
                    utterance_end_ms=args.pause_ms,
                    **model,
                )
                await stt.start(key)
            except Exception as exc:
                raise _StageError(
                    "deepgram",
                    f"Could not connect to Deepgram ({exc}). Check the Deepgram API key in the desk-mic settings "
                    "and that this computer is online.",
                )
        started = stt
        listener.send = lambda pcm: asyncio.run_coroutine_threadsafe(started.send(pcm), loop)

        # Mute key: a failure is reported but the mic keeps working.
        label = mute_key_label(args.mute_key, deps.platform)
        try:
            key_obj = deps.resolve_mute_key(args.mute_key, deps.platform)
        except Exception as exc:
            out.event(
                {
                    "type": "error",
                    "stage": "mute_key",
                    "message": f"mute key unavailable: {exc}; on macOS allow Accessibility for this terminal app",
                }
            )
            key_ok = False
        else:
            key_ok = deps.start_mute_key_listener(
                key_obj, lambda: state.toggle(f"mute key ({label})"), out, deps.platform
            )

        out.say(
            "DESK MIC IS LIVE. Anything it hears with enough length and confidence goes to Claude. "
            "Say 'stop listening' to mute"
            + (f", or press {label}." if key_ok else ".")
        )
        out.event({"type": "ready", "device": device, "mute_key": label if key_ok else None, "pid": deps.pid})

        if deps.after_ready is not None:
            await deps.after_ready(listener)
            if not closed.done():
                return 0
        message = await closed
        if message is _PARENT_GONE:
            log.warning("Claude Code (pid %s) has exited; turning the mic off.", args.parent_pid)
            return 0
        return _fail(out, "connection", f"Deepgram connection closed: {message}")
    except _StageError as exc:
        return _fail(out, exc.stage, exc.message)
    finally:
        if watcher is not None:
            watcher.cancel()
        listener.send = None
        if stream is not None:
            for close in (stream.stop, stream.close):
                try:
                    close()
                except Exception as exc:
                    log.warning("Closing the microphone: %s", exc)
        if stt is not None:
            try:
                await stt.finish()
            except Exception as exc:
                log.warning("Closing the speech engine: %s", exc)
        deps.release_mic(lock, deps.pid)


def main(argv=None, deps: Deps | None = None) -> int:
    args = parse_args(argv)
    deps = deps or Deps(log_file=True)
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        stream=deps.stderr if deps.stderr is not None else sys.stderr,
    )
    if deps.log_file:
        _log_to_file(args.state_dir / "listen.log")
    log.info(
        "listen.py starting: engine=%s parent_pid=%s python=%s",
        args.engine,
        args.parent_pid,
        sys.executable,
    )
    try:
        return asyncio.run(run(args, deps))
    except BaseException:
        log.exception("listen.py stopped on an error")
        raise


def _log_to_file(path: Path) -> None:
    """Each run's log also goes to <state-dir>/listen.log (replaced each run),
    so a mic that stops can be looked into after the fact."""
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        handler = logging.FileHandler(path, mode="w", encoding="utf-8")
    except OSError as exc:
        log.warning("Could not open %s: %s", path, exc)
        return
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    # INFO and up only: what was said is logged at DEBUG, so it never lands here.
    handler.setLevel(logging.INFO)
    root = logging.getLogger()
    if root.level == logging.NOTSET or root.level > logging.INFO:
        root.setLevel(logging.INFO)
    root.addHandler(handler)


if __name__ == "__main__":
    sys.exit(main())

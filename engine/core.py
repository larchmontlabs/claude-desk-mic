"""Cross-platform core of the desk-mic listener: output, one-mic lock,
speaking flag, mic state, accept filter, voice commands and the mute key.

Nothing here imports a Windows-only or macOS-only module. pynput is imported
lazily, inside the mute-key functions, so the rest works without a display.
"""
import json
import logging
import os
import re
import sys
import threading
import time
from pathlib import Path

import psutil

from text import strip_fillers

log = logging.getLogger("desk-mic")

# Spoken mute/unmute commands. Whole sentence only.
_CMD_MIC_OFF = re.compile(r"^\s*(?:stop listening|mic off)\.?\s*$", re.IGNORECASE)
_CMD_MIC_ON = re.compile(r"^\s*(?:start listening|mic on)\.?\s*$", re.IGNORECASE)


# -- Output: JSON events for the mod, or plain lines for a person -------------

class Output:
    """Where the engine's words go.

    emit_json=True: event() writes one ASCII-escaped JSON line to stdout (the
    mod reads it through a pipe, so no code page surprises) and say() goes to
    stderr. emit_json=False: event() is a no-op and say() prints to stdout.
    """

    def __init__(self, emit_json: bool, stdout=None, stderr=None) -> None:
        self.emit_json = emit_json
        self._stdout = stdout if stdout is not None else sys.stdout
        self._stderr = stderr if stderr is not None else sys.stderr

    def event(self, obj: dict) -> None:
        if self.emit_json:
            self._stdout.write(json.dumps(obj, ensure_ascii=True) + "\n")
            self._stdout.flush()

    def say(self, text: str) -> None:
        stream = self._stderr if self.emit_json else self._stdout
        stream.write(text + "\n")
        stream.flush()


# -- State files ---------------------------------------------------------------

def state_paths(state_dir: Path) -> dict:
    """The one place the state file names are spelled."""
    state_dir = Path(state_dir)
    return {"flag": state_dir / "speaking", "lock": state_dir / "listen.pid"}


# -- One mic at a time ----------------------------------------------------------

class TakeoverTimeout(Exception):
    """The previous listener was still alive when the takeover wait ran out."""

    def __init__(self, pid: int) -> None:
        super().__init__(f"previous listener {pid} did not exit")
        self.pid = pid


def is_listener(pid: int) -> bool:
    """True only for a live process running a script named exactly listen.py
    (guards against pid reuse)."""
    try:
        proc = psutil.Process(pid)
        return any(
            part.replace("\\", "/").rsplit("/", 1)[-1] == "listen.py" for part in proc.cmdline()
        )
    except (psutil.Error, OSError):
        return False


def _kill_pid(pid: int) -> None:
    try:
        psutil.Process(pid).terminate()
    except psutil.Error:
        pass


def _process_gone(pid: int) -> bool:
    if not psutil.pid_exists(pid):
        return True
    try:
        return psutil.Process(pid).status() == psutil.STATUS_ZOMBIE
    except psutil.Error:
        return True


def _wait_gone(pid: int, wait_s: float, clock=time.monotonic) -> bool:
    """Poll until `pid` has exited. False if still alive after wait_s."""
    deadline = clock() + wait_s
    while True:
        if _process_gone(pid):
            return True
        if clock() >= deadline:
            return False
        time.sleep(0.05)


def _read_pid(path: Path) -> int | None:
    try:
        return int(path.read_text().strip())
    except (OSError, ValueError):
        return None


def _acquire_guard(guard: Path, my_pid: int, pid_alive) -> None:
    """Take the guard file. The pid is written before the file appears (temp
    file + hard link), so a reader never sees an empty guard. A guard whose
    owner is dead is stale and is taken over."""
    guard.parent.mkdir(parents=True, exist_ok=True)
    tmp = guard.with_name(f"{guard.name}.{my_pid}.tmp")
    tmp.write_text(str(my_pid))
    try:
        while True:
            try:
                os.link(tmp, guard)
                return
            except FileExistsError:
                pass
            owner = _read_pid(guard)
            if owner is None or owner == my_pid or not pid_alive(owner):
                # Stale. Re-read just before removing, to narrow the window in
                # which two claimants both clear the same stale guard.
                if _read_pid(guard) == owner:
                    try:
                        guard.unlink()
                    except FileNotFoundError:
                        pass
                continue
            time.sleep(0.02)
    finally:
        try:
            tmp.unlink()
        except FileNotFoundError:
            pass


def _release_guard(guard: Path, my_pid: int) -> None:
    if _read_pid(guard) == my_pid:
        try:
            guard.unlink()
        except FileNotFoundError:
            pass


def claim_mic(
    lock: Path,
    my_pid: int,
    is_listener=is_listener,
    kill=_kill_pid,
    wait_gone=_wait_gone,
    clock=time.monotonic,
    wait_s: float = 5,
    pid_alive=psutil.pid_exists,
) -> int | None:
    """Take the mic: stop the listener named in `lock` (if it still is one),
    wait until it is gone, then write our pid. Returns the pid that was
    stopped, or None. Raises TakeoverTimeout (lock untouched) if the old
    listener is still alive after wait_s.

    Serialized by a guard file `<lock>.guard`, so two listeners starting at the
    same moment cannot both end up owning the mic.
    """
    lock = Path(lock)
    guard = Path(str(lock) + ".guard")
    _acquire_guard(guard, my_pid, pid_alive)
    try:
        previous = None
        old = _read_pid(lock)
        if old is not None and old != my_pid and is_listener(old):
            kill(old)
            if not wait_gone(old, wait_s, clock):
                raise TakeoverTimeout(old)
            previous = old
        lock.parent.mkdir(parents=True, exist_ok=True)
        lock.write_text(str(my_pid))
        return previous
    finally:
        _release_guard(guard, my_pid)


def release_mic(lock: Path, my_pid: int) -> None:
    """Remove `lock` only if it still names us (a newer listener may own it)."""
    try:
        if int(Path(lock).read_text().strip()) == my_pid:
            Path(lock).unlink()
    except (FileNotFoundError, ValueError):
        pass


# -- Speaking flag ---------------------------------------------------------------

def is_speaking(flag: Path, pid_alive=psutil.pid_exists) -> bool:
    """True when the flag file names a live pid (the speak-back process)."""
    pid = _read_pid(Path(flag))
    if pid is None or pid <= 0:
        return False
    return bool(pid_alive(pid))


# -- Mic state, shared across threads ----------------------------------------------

class MicState:
    def __init__(self, out: Output) -> None:
        self._out = out
        self._lock = threading.Lock()
        self.listening = True
        self.speaking = False

    def set_listening(self, value: bool, source: str) -> bool:
        """Returns True if the state actually changed."""
        with self._lock:
            if self.listening == value:
                return False
            self.listening = value
        word = "LISTENING" if value else "MUTED"
        self._out.say(f"\n>>> MIC {word} (via {source})\n")
        self._out.event({"type": "state", "listening": value, "source": source})
        log.warning("Mic state -> %s (via %s)", word, source)
        return True

    def set_speaking(self, value: bool) -> bool:
        """Returns True if the value changed. The only emitter of `speaking`."""
        with self._lock:
            if self.speaking == value:
                return False
            self.speaking = value
        self._out.event({"type": "speaking", "playing": value})
        return True

    def toggle(self, source: str) -> None:
        self.set_listening(not self.listening, source)


# -- Accept filter, voice commands ----------------------------------------------------

def accept(text: str, confidence: float | None, min_chars: int, min_conf: float) -> str | None:
    """Return the cleaned text, or None when the utterance is dropped.
    confidence=None skips the confidence check (Whisper has none)."""
    if confidence is not None and confidence < min_conf:
        log.info("Dropped (confidence %.2f < %.2f): %r", confidence, min_conf, text)
        return None
    text = strip_fillers(text)
    if len(text) < min_chars:
        log.info("Dropped (too short, %d < %d chars): %r", len(text), min_chars, text)
        return None
    return text


def voice_command(text: str) -> str | None:
    if _CMD_MIC_OFF.match(text):
        return "off"
    if _CMD_MIC_ON.match(text):
        return "on"
    return None


# -- Mute key ---------------------------------------------------------------------------

# name -> (pynput Key attribute, label on win32, label on darwin)
_KEYS = {
    "right ctrl": ("ctrl_r", "Right Ctrl", "Right Ctrl"),
    "left ctrl": ("ctrl_l", "Left Ctrl", "Left Ctrl"),
    "right alt": ("alt_r", "Right Alt", "Right Option"),
    "right shift": ("shift_r", "Right Shift", "Right Shift"),
    "f13": ("f13", "F13", "F13"),
}


def _lookup(name: str, platform: str) -> tuple:
    key = name.strip().lower()
    if key == "auto":
        key = "right ctrl" if platform == "win32" else "right alt"
    if key not in _KEYS:
        raise ValueError(f"unknown mute key: {name!r}")
    return _KEYS[key]


def resolve_mute_key(name: str, platform: str):
    from pynput.keyboard import Key

    return getattr(Key, _lookup(name, platform)[0])


def mute_key_label(name: str, platform: str) -> str:
    _, win_label, mac_label = _lookup(name, platform)
    return win_label if platform == "win32" else mac_label


def make_toggle_handlers(key, on_toggle):
    """(on_press, on_release) that call on_toggle once per physical press:
    auto-repeat key-downs are ignored until the key is released."""
    down = [False]

    def on_press(k):
        if k == key and not down[0]:
            down[0] = True
            on_toggle()

    def on_release(k):
        if k == key:
            down[0] = False

    return on_press, on_release


def start_mute_key_listener(key, on_toggle, out: Output, platform: str, listener_factory=None) -> bool:
    """Start the global hotkey listener. True only when it is really running
    (on macOS, also trusted for Accessibility). On failure emits one `error`
    event with stage "mute_key" and returns False; the mic keeps working."""
    try:
        if listener_factory is None:
            from pynput.keyboard import Listener as listener_factory
        on_press, on_release = make_toggle_handlers(key, on_toggle)
        listener = listener_factory(on_press=on_press, on_release=on_release)
        listener.start()
        if platform == "darwin":
            if hasattr(listener, "wait"):
                listener.wait()
            if not getattr(listener, "IS_TRUSTED", False):
                raise RuntimeError("this process is not trusted for Accessibility")
        return True
    except Exception as exc:  # any failure means the key does not work
        out.event(
            {
                "type": "error",
                "stage": "mute_key",
                "message": f"mute key unavailable: {exc}; on macOS allow Accessibility for this terminal app",
            }
        )
        return False

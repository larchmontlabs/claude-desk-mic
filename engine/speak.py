"""Speak-back: read text from stdin (UTF-8), say it aloud, keep the speaking flag.

    python speak.py --voice en-US-AriaNeural --state-dir <dir>

First stdout line is {"type":"pid","pid":N} so the mod can kill the process tree.
Natural voice = edge-tts (rate +15%) played by ffplay, or afplay on macOS.
If edge-tts fails or gives no audio in 5 s, the OS voice is used: SAPI via
PowerShell on Windows, `say` on macOS (both use the OS default voice).
A long reply is made and played in pieces, so the first piece plays within the
wait while the rest is still being made (a 1,500-character reply takes edge-tts
about 13 s to make in one go). If a later piece fails, the OS voice reads the rest.
"""
import argparse
import asyncio
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

from core import state_paths
from text import speakable

RATE = "+15%"
EDGE_WAIT_S = 5.0
# Characters per piece: about 2 s of edge-tts work, so audio starts quickly.
PIECE_CHARS = 250

_child = None


def pick_player(platform, ffplay):
    if ffplay:
        return [ffplay, "-nodisp", "-autoexit", "-loglevel", "quiet"]
    if platform == "darwin":
        return ["afplay"]
    return None


def pick_backend(platform, ffplay, afplay):
    if ffplay or (platform == "darwin" and afplay):
        return "edge"
    return "sapi" if platform == "win32" else "say"


def os_backend(platform):
    return "sapi" if platform == "win32" else "say"


def sapi_command():
    return (
        "[Console]::InputEncoding = [Text.Encoding]::UTF8; "
        "$t = [Console]::In.ReadToEnd(); "
        "Add-Type -AssemblyName System.Speech; "
        "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; "
        "$s.Speak($t)"
    )


def say_argv():
    return ["say", "-f", "-"]


def read_stdin_text(stream):
    return stream.read().decode("utf-8")


class PlayerStopped(Exception):
    """The player was killed (the person said stop): read nothing more."""


def _run(argv, data=None):
    """Runs argv to the end; returns its exit code (negative: killed by a signal)."""
    global _child
    _child = subprocess.Popen(argv, stdin=subprocess.PIPE if data is not None else None)
    try:
        _child.communicate(data)
        return _child.returncode
    finally:
        _child = None


def _os_speak(backend, text):
    data = text.encode("utf-8")
    if backend == "sapi":
        _run(["powershell", "-NoProfile", "-Command", sapi_command()], data)
    else:
        _run(say_argv(), data)


def _edge_synth(text, voice, out_path):
    import edge_tts

    asyncio.run(edge_tts.Communicate(text=text, voice=voice, rate=RATE).save(out_path))


def _play(path):
    argv = pick_player(sys.platform, shutil.which("ffplay"))
    if argv is None:
        raise RuntimeError("no audio player")
    code = _run(argv + [path])
    # On macOS a stop kills the player, not this process: don't start the next piece.
    if code is not None and code < 0:
        raise PlayerStopped()


def split_pieces(text, max_chars=PIECE_CHARS):
    """Text in pieces of at most max_chars, broken after sentences where it can
    be and between words otherwise. Every word is kept, in order."""
    import re

    pieces, current = [], ""

    def add(part):
        nonlocal current
        if not current:
            current = part
        elif len(current) + 1 + len(part) <= max_chars:
            current = f"{current} {part}"
        else:
            pieces.append(current)
            current = part

    for sentence in re.split(r"(?<=[.!?])\s+", text.strip()):
        if not sentence:
            continue
        if len(sentence) <= max_chars:
            add(sentence)
            continue
        for word in sentence.split():
            while len(word) > max_chars:
                add(word[:max_chars])
                word = word[max_chars:]
            if word:
                add(word)
    if current:
        pieces.append(current)
    return pieces


def _synth_pieces(synth, pieces, voice, folder, stop):
    """Make each piece's audio in order on a thread, into files in `folder`.
    Returns (paths, ready): ready[i] is set once piece i is made; paths[i] is
    its file, or None if it failed (and nothing after it is made). Setting
    `stop` ends the work; a file made after that is removed at once."""
    paths = [None] * len(pieces)
    ready = [threading.Event() for _ in pieces]

    def work():
        for i, piece in enumerate(pieces):
            if stop.is_set():
                break
            try:
                fd, out_path = tempfile.mkstemp(suffix=".mp3", dir=folder)
            except OSError:
                break  # the reading ended and removed its folder
            os.close(fd)
            try:
                synth(piece, voice, out_path)
                if os.path.getsize(out_path) > 0:
                    paths[i] = out_path
            except Exception:
                pass
            if paths[i] is None or stop.is_set():
                paths[i] = None
                _remove(out_path)
                break
            ready[i].set()
        for event in ready:
            event.set()

    threading.Thread(target=work, daemon=True).start()
    return paths, ready


def _pid_alive(pid):
    from core import _process_gone

    return not _process_gone(pid)


def _sweep(parent):
    """Remove what killed readings left behind: each reading keeps its pieces in
    a folder named by its pid, so a folder whose process is gone is left over.
    A live reading's folder (another session's) is kept."""
    import shutil as _shutil

    for entry in Path(parent).iterdir():
        if entry.is_file():
            _remove(entry)
        elif entry.is_dir():
            if entry.name.isdigit() and int(entry.name) != os.getpid() and _pid_alive(int(entry.name)):
                continue
            _shutil.rmtree(entry, ignore_errors=True)


def _remove(path):
    try:
        os.unlink(path)
    except OSError:
        pass


def speak(text, voice, backend, flag, *, synth=None, player=None, os_speak=None,
          platform=None, wait_s=EDGE_WAIT_S, piece_chars=PIECE_CHARS, on_piece=None):
    text = speakable(text)
    if not text:
        return
    platform = platform or sys.platform
    synth = synth or _edge_synth
    player = player or _play
    os_speak = os_speak or _os_speak
    # What is about to be heard, so the mod can tell its own voice from the person's.
    tell = on_piece or (lambda piece: None)
    flag = Path(flag)
    flag.parent.mkdir(parents=True, exist_ok=True)
    flag.write_text(str(os.getpid()))
    try:
        if backend == "edge":
            pieces = split_pieces(text, piece_chars)
            parent = flag.parent / "speech"
            parent.mkdir(parents=True, exist_ok=True)
            _sweep(parent)
            folder = parent / str(os.getpid())
            folder.mkdir(exist_ok=True)
            stop = threading.Event()
            paths, ready = _synth_pieces(synth, pieces, voice, folder, stop)
            try:
                for i in range(len(pieces)):
                    # Each piece gets the wait: no audio within it means the OS voice.
                    if not ready[i].wait(wait_s) or paths[i] is None:
                        stop.set()
                        rest = " ".join(pieces[i:])
                        tell(rest)
                        os_speak(os_backend(platform), rest)
                        return
                    tell(pieces[i])
                    player(paths[i])
            except PlayerStopped:
                return
            finally:
                stop.set()
                for path in paths:
                    if path is not None:
                        _remove(path)
                try:
                    folder.rmdir()
                except OSError:
                    pass  # a piece still being made; the next reading sweeps it
        else:
            tell(text)
            os_speak(backend, text)
    finally:
        try:
            flag.unlink()
        except OSError:
            pass


def _on_sigterm(signum, frame):
    if _child is not None:
        try:
            _child.terminate()
        except OSError:
            pass
    raise SystemExit(143)


def main(argv=None, stdin=None, stdout=None, speak_fn=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--voice", default="en-US-AriaNeural")
    ap.add_argument("--state-dir", required=True)
    args = ap.parse_args(argv)
    stdout = stdout if stdout is not None else sys.stdout
    stdout.write(json.dumps({"type": "pid", "pid": os.getpid()}, ensure_ascii=True) + "\n")
    stdout.flush()
    if sys.platform == "darwin" and speak_fn is None:
        signal.signal(signal.SIGTERM, _on_sigterm)
    text = read_stdin_text(stdin if stdin is not None else sys.stdin.buffer)
    if not text.strip():
        return 0
    backend = pick_backend(sys.platform, shutil.which("ffplay"), shutil.which("afplay"))

    def on_piece(piece):
        stdout.write(json.dumps({"type": "piece", "text": piece}, ensure_ascii=True) + "\n")
        stdout.flush()

    (speak_fn or speak)(text, args.voice, backend, state_paths(Path(args.state_dir))["flag"], on_piece=on_piece)
    return 0


if __name__ == "__main__":
    sys.exit(main())

import io
import json
import os
import threading
from pathlib import Path

import pytest

import speak as sp


def test_pick_player_and_backend():
    ff = sp.pick_player("win32", "C:/ff/ffplay.exe")
    assert ff[0] == "C:/ff/ffplay.exe" and "-nodisp" in ff and "-autoexit" in ff
    assert sp.pick_backend("win32", "C:/ff/ffplay.exe", None) == "edge"
    assert sp.pick_player("win32", None) is None
    assert sp.pick_backend("win32", None, None) == "sapi"
    assert sp.pick_player("darwin", None)[0] == "afplay"
    assert sp.pick_backend("darwin", None, "/usr/bin/afplay") == "edge"
    assert sp.pick_player("darwin", "/opt/homebrew/bin/ffplay")[0] == "/opt/homebrew/bin/ffplay"
    assert sp.pick_backend("darwin", "/opt/homebrew/bin/ffplay", "/usr/bin/afplay") == "edge"
    assert sp.pick_backend("darwin", None, None) == "say"


def _ok_synth(text, voice, out_path):
    Path(out_path).write_bytes(b"mp3")


def test_flag_written_and_removed(tmp_path):
    flag = tmp_path / "speaking"
    seen = []

    def player(path):
        seen.append(flag.read_text().strip())

    sp.speak("hello there", "v", "edge", flag, synth=_ok_synth, player=player, platform="win32")
    assert seen == [str(os.getpid())]
    assert not flag.exists()

    def bad_player(path):
        assert flag.exists()
        raise RuntimeError("boom")

    with pytest.raises(RuntimeError):
        sp.speak("hello there", "v", "edge", flag, synth=_ok_synth, player=bad_player, platform="win32")
    assert not flag.exists()


@pytest.mark.parametrize("platform,backend", [("win32", "sapi"), ("darwin", "say")])
def test_edge_failure_falls_back(tmp_path, platform, backend):
    calls = []

    def synth(text, voice, out):
        raise OSError("offline")

    sp.speak("Read this.", "v", "edge", tmp_path / "f", synth=synth,
             player=lambda p: calls.append("play"),
             os_speak=lambda b, t: calls.append((b, t)), platform=platform)
    assert calls == [(backend, "Read this.")]


def test_edge_timeout_falls_back(tmp_path):
    release = threading.Event()
    calls = []

    def slow_synth(text, voice, out):
        release.wait(10)

    try:
        sp.speak("Read this.", "v", "edge", tmp_path / "f", synth=slow_synth,
                 player=lambda p: calls.append("play"),
                 os_speak=lambda b, t: calls.append((b, t)), platform="win32", wait_s=0.1)
    finally:
        release.set()
    assert calls == [("sapi", "Read this.")]


def test_text_is_cleaned_before_synthesis(tmp_path):
    got = []

    def synth(text, voice, out):
        got.append(text)
        Path(out).write_bytes(b"x")

    sp.speak("Done. **All** tests pass.", "v", "edge", tmp_path / "f", synth=synth,
             player=lambda p: None, platform="win32")
    assert got == ["Done. All tests pass."]


def test_stdin_is_read_as_utf8():
    s = "it\u2019s done \u2013 caf\u00e9"
    assert sp.read_stdin_text(io.BytesIO(s.encode("utf-8"))) == s


def test_sapi_command_sets_utf8_input():
    cmd = sp.sapi_command()
    assert cmd.index("[Console]::InputEncoding") < cmd.index("[Console]::In.ReadToEnd()")
    assert "UTF8" in cmd


def test_os_fallbacks_ignore_edge_voice_name():
    assert sp.say_argv() == ["say", "-f", "-"]
    assert "en-US-AriaNeural" not in sp.sapi_command()


def test_first_line_is_pid_event(tmp_path):
    out = io.StringIO()
    spoken = []
    rc = sp.main(["--voice", "en-US-AriaNeural", "--state-dir", str(tmp_path)],
                 stdin=io.BytesIO(b"hi there"), stdout=out,
                 speak_fn=lambda *a, **k: spoken.append(a))
    assert rc == 0
    assert json.loads(out.getvalue().splitlines()[0]) == {"type": "pid", "pid": os.getpid()}
    assert spoken

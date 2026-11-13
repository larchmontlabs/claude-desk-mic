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


# -- Long replies: played piece by piece, so audio starts within the wait -----------

def test_split_pieces_keeps_every_word_and_breaks_at_sentences():
    text = " ".join(f"Sentence number {i} is here." for i in range(40))
    pieces = sp.split_pieces(text, max_chars=120)
    assert len(pieces) > 1
    assert all(len(p) <= 120 for p in pieces)
    assert " ".join(pieces).split() == text.split()
    assert all(p.endswith(".") for p in pieces)
    assert sp.split_pieces("Short one.", max_chars=120) == ["Short one."]
    long_word_run = "word " * 100
    assert all(len(p) <= 120 for p in sp.split_pieces(long_word_run, max_chars=120))


def _timed_synth(per_piece_s, fail_on=None):
    import time

    def synth(text, voice, out):
        time.sleep(per_piece_s)
        if fail_on is not None and fail_on in text:
            raise OSError("offline")
        Path(out).write_text(text, encoding="utf-8")

    return synth


def test_long_reply_starts_within_the_wait_even_if_all_of_it_would_not(tmp_path):
    text = " ".join(f"Sentence number {i} is here." for i in range(60))
    played, fallback = [], []
    sp.speak(text, "v", "edge", tmp_path / "f", synth=_timed_synth(0.05),
             player=lambda p: played.append(Path(p).read_text(encoding="utf-8")),
             os_speak=lambda b, t: fallback.append(t), platform="win32", wait_s=0.3, piece_chars=120)
    assert fallback == []
    assert len(played) > 3
    assert " ".join(played).split() == text.split()


def test_a_later_piece_failing_reads_the_rest_with_the_os_voice(tmp_path):
    text = " ".join(f"Sentence number {i} is here." for i in range(20))
    played, fallback = [], []
    sp.speak(text, "v", "edge", tmp_path / "f", synth=_timed_synth(0.0, fail_on="number 10 "),
             player=lambda p: played.append(Path(p).read_text(encoding="utf-8")),
             os_speak=lambda b, t: fallback.append((b, t)), platform="win32", wait_s=1.0, piece_chars=60)
    assert played and fallback
    assert fallback[0][0] == "sapi"
    heard = " ".join(played + [fallback[0][1]])
    assert heard.split() == text.split()


def test_pieces_live_in_the_state_folder_and_are_removed_after_a_fallback(tmp_path):
    import time

    text = " ".join(f"Sentence number {i} is here." for i in range(20))
    sp.speak(text, "v", "edge", tmp_path / "f", synth=_timed_synth(0.0, fail_on="number 10 "),
             player=lambda p: None, os_speak=lambda b, t: None, platform="win32", wait_s=1.0, piece_chars=60)
    time.sleep(0.2)
    assert list((tmp_path / "speech").glob("*")) == []


def test_no_more_pieces_are_made_after_the_os_voice_takes_over(tmp_path):
    import time

    release = threading.Event()
    calls = []

    def synth(text, voice, out):
        calls.append(text)
        release.wait(5)
        Path(out).write_bytes(b"x")

    text = " ".join(f"Sentence number {i} is here." for i in range(20))
    try:
        sp.speak(text, "v", "edge", tmp_path / "f", synth=synth, player=lambda p: None,
                 os_speak=lambda b, t: None, platform="win32", wait_s=0.1, piece_chars=60)
    finally:
        release.set()
    time.sleep(0.3)
    assert len(calls) == 1
    assert list((tmp_path / "speech").glob("*")) == []


def test_old_pieces_are_swept_at_start(tmp_path):
    (tmp_path / "speech").mkdir()
    (tmp_path / "speech" / "old.mp3").write_bytes(b"x")
    sp.speak("Hi there.", "v", "edge", tmp_path / "f", synth=_ok_synth, player=lambda p: None, platform="win32")
    assert list((tmp_path / "speech").glob("*")) == []


def test_a_killed_player_ends_the_reading(tmp_path):
    played, fallback = [], []

    def player(path):
        played.append(path)
        raise sp.PlayerStopped()

    text = " ".join(f"Sentence number {i} is here." for i in range(20))
    sp.speak(text, "v", "edge", tmp_path / "f", synth=_timed_synth(0.0), player=player,
             os_speak=lambda b, t: fallback.append(t), platform="darwin", piece_chars=60)
    assert len(played) == 1 and fallback == []


def test_play_raises_when_the_player_was_killed(monkeypatch):
    monkeypatch.setattr(sp.shutil, "which", lambda name: "ffplay")
    monkeypatch.setattr(sp, "_run", lambda argv, data=None: -15)
    with pytest.raises(sp.PlayerStopped):
        sp._play("x.mp3")
    monkeypatch.setattr(sp, "_run", lambda argv, data=None: 0)
    sp._play("x.mp3")

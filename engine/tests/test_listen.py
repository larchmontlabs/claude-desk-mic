"""listen.py: the listener the mod runs. Fake mic, fake STT, events on StringIO.
Session cases ported from voice-bridge tests/test_desk_mic_emit.py."""
import asyncio
import io
import json

import pytest

import core
import listen
from listen_fakes import (
    FakeSD,
    Recorder,
    argv,
    audio,
    events,
    failing_mute_key_listener,
    make_deps,
    stt_factory,
)


def _listener(speaking=False, sent=None):
    stdout, stderr = io.StringIO(), io.StringIO()
    out = core.Output(emit_json=True, stdout=stdout, stderr=stderr)
    state = core.MicState(out)
    flag_value = [speaking]
    listener = listen.Listener(out, state, flag="flag", is_speaking=lambda flag: flag_value[0])
    if sent is not None:
        listener.send = sent.append
    return listener, state, stdout, flag_value


def _lines(stdout: io.StringIO) -> list[dict]:
    return [json.loads(line) for line in stdout.getvalue().splitlines() if line.strip()]


# -- Session: what happens to one sentence ---------------------------------------


def test_utterance_is_emitted():
    listener, _, stdout, _ = _listener()
    asyncio.run(listener.on_utterance_full("run the tests", 0.9))
    assert _lines(stdout) == [{"type": "utterance", "text": "run the tests"}]


def test_utterance_fillers_are_stripped():
    listener, _, stdout, _ = _listener()
    asyncio.run(listener.on_utterance_full("um, list the open pull requests", 0.95))
    assert _lines(stdout) == [{"type": "utterance", "text": "list the open pull requests"}]


def test_low_confidence_is_dropped():
    listener, _, stdout, _ = _listener()
    asyncio.run(listener.on_utterance_full("um, list the open pull requests", 0.3))
    assert _lines(stdout) == [{"type": "unsure", "text": "list the open pull requests"}]


def test_too_short_is_dropped_and_clears_live_words():
    listener, _, stdout, _ = _listener()
    asyncio.run(listener.on_utterance_full("um", 0.9))
    assert _lines(stdout) == [{"type": "partial", "text": ""}]


def test_whisper_utterance_has_no_confidence_check():
    listener, _, stdout, _ = _listener()
    asyncio.run(listener.on_utterance_full("run the tests", None))
    assert _lines(stdout) == [{"type": "utterance", "text": "run the tests"}]


def test_mic_off_command_emits_state_and_no_utterance():
    listener, state, stdout, _ = _listener()
    asyncio.run(listener.on_utterance_full("mic off", 0.99))
    assert state.listening is False
    assert _lines(stdout) == [
        {"type": "partial", "text": ""},
        {"type": "state", "listening": False, "source": "voice command"},
    ]


def test_muted_utterance_is_dropped():
    listener, state, stdout, _ = _listener()
    state.listening = False
    asyncio.run(listener.on_utterance_full("run the tests", 0.9))
    assert _lines(stdout) == []


# -- The audio callback gate -------------------------------------------------------


def test_audio_not_sent_while_speaking():
    sent = []
    listener, _, _, flag = _listener(speaking=True, sent=sent)
    listener.audio_callback(audio(), 160, None, None)
    assert sent == []
    flag[0] = False  # stale flag: the speaker is gone
    listener.audio_callback(audio(), 160, None, None)
    assert len(sent) == 1
    assert sent[0] == bytes(320)  # 160 samples of int16 silence


def test_audio_not_sent_while_muted():
    sent = []
    listener, state, _, _ = _listener(sent=sent)
    state.set_listening(False, "test")
    listener.audio_callback(audio(), 160, None, None)
    assert sent == []
    state.set_listening(True, "test")
    listener.audio_callback(audio(), 160, None, None)
    assert len(sent) == 1


def test_audio_not_sent_before_the_engine_started():
    listener, _, _, _ = _listener()
    listener.audio_callback(audio(), 160, None, None)  # send is None: must not raise


def test_speaking_event_follows_the_flag():
    sent = []
    listener, _, stdout, flag = _listener(sent=sent)
    listener.audio_callback(audio(), 160, None, None)
    assert _lines(stdout) == []
    flag[0] = True
    listener.audio_callback(audio(), 160, None, None)
    listener.audio_callback(audio(), 160, None, None)
    flag[0] = False
    listener.audio_callback(audio(), 160, None, None)
    listener.audio_callback(audio(), 160, None, None)
    assert _lines(stdout) == [
        {"type": "speaking", "playing": True},
        {"type": "speaking", "playing": False},
    ]


# -- Startup -----------------------------------------------------------------------------


async def _stop(listener):
    """after_ready hook: stop as soon as the listener is ready."""
    return None


def test_ready_event_shape(tmp_path):
    rec = Recorder()
    deps = make_deps(rec, after_ready=_stop)
    code = listen.main(argv(tmp_path, "--engine", "deepgram", "--mute-key", "auto"), deps)
    assert code == 0
    ready = [e for e in events(deps) if e["type"] == "ready"]
    assert ready == [{"type": "ready", "device": "Desk Mic", "mute_key": "Right Ctrl", "pid": 1234}]


def test_ready_mute_key_label_on_mac(tmp_path):
    rec = Recorder()
    deps = make_deps(rec, platform="darwin", after_ready=_stop)
    listen.main(argv(tmp_path, "--engine", "deepgram", "--mute-key", "auto"), deps)
    assert [e["mute_key"] for e in events(deps) if e["type"] == "ready"] == ["Right Option"]


def test_args_reach_the_engine(tmp_path):
    rec = Recorder()
    made = []
    deps = make_deps(rec, deepgram=stt_factory(rec, made), after_ready=_stop)
    code = listen.main(
        argv(tmp_path, "--engine", "deepgram", "--pause-ms", "2000", "--keyterm", "claude", "--keyterm", "send it"),
        deps,
    )
    assert code == 0
    (stt,) = made
    assert stt.kwargs["utterance_end_ms"] == 2000
    assert stt.kwargs["keyterms"] == ["claude", "send it"]
    assert stt.kwargs["sample_rate"] == 16000
    assert "model" not in stt.kwargs  # Deepgram keeps its own default, nova-2
    assert stt.started_with == ("test-key",)

    rec = Recorder()
    made = []
    deps = make_deps(rec, whisper=stt_factory(rec, made), after_ready=_stop)
    code = listen.main(
        argv(tmp_path, "--engine", "whisper", "--model", "base.en", "--vad-level", "3", "--pause-ms", "2500",
             "--keyterm", "claude"),
        deps,
    )
    assert code == 0
    (stt,) = made
    assert stt.kwargs["vad_level"] == 3
    assert stt.kwargs["model"] == "base.en"
    assert stt.kwargs["pause_ms"] == 2500
    assert stt.kwargs["keyterms"] == ["claude"]
    assert [e for e in events(deps) if e["type"] == "loading"] == [{"type": "loading", "model": "base.en"}]


def test_audio_reaches_the_engine_after_start(tmp_path):
    rec = Recorder()
    made = []
    sd = FakeSD(rec)

    async def talk(listener):
        sd.streams[0].callback(audio(), 160, None, None)
        await asyncio.sleep(0.01)

    deps = make_deps(rec, sd=sd, deepgram=stt_factory(rec, made), after_ready=talk)
    assert listen.main(argv(tmp_path, "--engine", "deepgram"), deps) == 0
    assert made[0].sent == [bytes(320)]


@pytest.mark.parametrize("level", ["4", "-1", "x"])
def test_vad_level_outside_0_to_3_is_rejected(tmp_path, level):
    rec = Recorder()
    deps = make_deps(rec)
    with pytest.raises(SystemExit) as exc:
        listen.main(argv(tmp_path, "--engine", "whisper", "--model", "base.en", f"--vad-level={level}"), deps)
    assert exc.value.code != 0
    assert rec.log == []
    assert events(deps) == []
    assert not (tmp_path / "listen.pid").exists()


@pytest.mark.parametrize("level", ["0", "3"])
def test_vad_level_0_and_3_are_accepted(tmp_path, level):
    rec = Recorder()
    deps = make_deps(rec, after_ready=_stop)
    assert listen.main(argv(tmp_path, "--engine", "whisper", "--model", "base.en", "--vad-level", level), deps) == 0


@pytest.mark.parametrize(
    "extra",
    [
        ["--engine", "deepgram", "--pause-ms", "999"],
        ["--engine", "deepgram", "--pause-ms", "5001"],
        ["--engine", "whisper", "--model", "base.en", "--pause-ms", "999"],
        ["--engine", "whisper"],  # no model
        ["--engine", "deepgram", "--mute-key", "caps lock"],
    ],
)
def test_bad_args_are_usage_errors(tmp_path, extra):
    rec = Recorder()
    deps = make_deps(rec)
    with pytest.raises(SystemExit) as exc:
        listen.main(argv(tmp_path, *extra), deps)
    assert exc.value.code != 0
    assert rec.log == []
    assert not (tmp_path / "listen.pid").exists()


def test_deepgram_pause_range_ends_are_accepted(tmp_path):
    for ms in ("1000", "5000"):
        deps = make_deps(Recorder(), after_ready=_stop)
        assert listen.main(argv(tmp_path, "--engine", "deepgram", "--pause-ms", ms), deps) == 0
    deps = make_deps(Recorder(), after_ready=_stop)
    assert listen.main(argv(tmp_path, "--engine", "whisper", "--model", "base.en", "--pause-ms", "6000"), deps) == 0


def test_takeover_timeout_emits_error(tmp_path):
    rec = Recorder()

    def claim(lock, pid):
        raise core.TakeoverTimeout(4242)

    deps = make_deps(rec, claim_mic=claim)
    code = listen.main(argv(tmp_path, "--engine", "deepgram"), deps)
    assert code != 0
    assert events(deps) == [
        {"type": "error", "stage": "takeover", "message": "Another desk-mic listener (pid 4242) would not stop."}
    ]
    assert rec.log == []
    assert not (tmp_path / "listen.pid").exists()


def test_takeover_is_reported(tmp_path):
    deps = make_deps(Recorder(), claim_mic=lambda lock, pid: 777, after_ready=_stop)
    assert listen.main(argv(tmp_path, "--engine", "deepgram"), deps) == 0
    assert {"type": "takeover", "previous_pid": 777} in events(deps)


def test_closed_stream_exits_with_error(tmp_path):
    rec = Recorder()
    made = []
    deps = make_deps(rec, deepgram=stt_factory(rec, made, close_with="x"))
    code = listen.main(argv(tmp_path, "--engine", "deepgram"), deps)
    assert code != 0
    evs = events(deps)
    assert [e["type"] for e in evs] == ["ready", "error"]
    assert evs[-1] == {"type": "error", "stage": "connection", "message": "Deepgram connection closed: x"}
    assert made[0].finished
    assert not (tmp_path / "listen.pid").exists()


def test_ready_has_null_mute_key_when_hotkey_failed(tmp_path):
    rec = Recorder()
    sd = FakeSD(rec)
    made = []

    async def talk(listener):
        sd.streams[0].callback(audio(), 160, None, None)
        await asyncio.sleep(0.01)

    deps = make_deps(
        rec,
        sd=sd,
        deepgram=stt_factory(rec, made),
        start_mute_key_listener=failing_mute_key_listener,
        after_ready=talk,
    )
    assert listen.main(argv(tmp_path, "--engine", "deepgram"), deps) == 0
    evs = events(deps)
    errors = [e for e in evs if e["type"] == "error"]
    assert len(errors) == 1 and errors[0]["stage"] == "mute_key"
    assert [e["mute_key"] for e in evs if e["type"] == "ready"] == [None]
    assert made[0].sent  # the mic still runs


def test_mute_key_that_cannot_resolve_is_reported(tmp_path):
    def no_pynput(name, platform):
        raise ImportError("no pynput")

    deps = make_deps(Recorder(), resolve_mute_key=no_pynput, after_ready=_stop)
    assert listen.main(argv(tmp_path, "--engine", "deepgram"), deps) == 0
    evs = events(deps)
    assert [e["stage"] for e in evs if e["type"] == "error"] == ["mute_key"]
    assert [e["mute_key"] for e in evs if e["type"] == "ready"] == [None]


def test_mute_key_toggles_the_mic(tmp_path):
    toggles = []

    def start(key, on_toggle, out, platform):
        toggles.append(on_toggle)
        return True

    async def press(listener):
        toggles[0]()

    deps = make_deps(Recorder(), start_mute_key_listener=start, after_ready=press)
    listen.main(argv(tmp_path, "--engine", "deepgram"), deps)
    assert {"type": "state", "listening": False, "source": "mute key (Right Ctrl)"} in events(deps)


# -- One test per startup stage --------------------------------------------------------


def _assert_failed_at(stage, code, deps, tmp_path, sd=None, stts=()):
    evs = events(deps)
    assert code != 0
    assert [e for e in evs if e["type"] == "error"] == [e for e in evs if e.get("stage") == stage]
    assert len([e for e in evs if e["type"] == "error"]) == 1
    assert not [e for e in evs if e["type"] == "ready"]
    assert not (tmp_path / "listen.pid").exists()
    if sd is not None:
        assert all(s.closed for s in sd.streams)
    for stt in stts:
        assert stt.finished
    return next(e for e in evs if e["type"] == "error")


def test_stage_device_failure(tmp_path):
    rec = Recorder()
    sd = FakeSD(rec, default_in=-1)
    deps = make_deps(rec, sd=sd)
    code = listen.main(argv(tmp_path, "--engine", "deepgram"), deps)
    err = _assert_failed_at("device", code, deps, tmp_path, sd)
    assert "microphone" in err["message"].lower()
    assert sd.streams == []


def test_stage_device_failure_when_listing_raises(tmp_path):
    rec = Recorder()
    sd = FakeSD(rec)

    def broken():
        raise OSError("PortAudio not found")

    sd.query_devices = broken
    deps = make_deps(rec, sd=sd)
    code = listen.main(argv(tmp_path, "--engine", "deepgram"), deps)
    err = _assert_failed_at("device", code, deps, tmp_path, sd)
    assert "PortAudio not found" in err["message"]


def test_stage_mic_failure(tmp_path):
    rec = Recorder()
    sd = FakeSD(rec, open_error=OSError("Error opening InputStream: Unanticipated host error"))
    made = []
    deps = make_deps(rec, sd=sd, deepgram=stt_factory(rec, made))
    code = listen.main(argv(tmp_path, "--engine", "deepgram"), deps)
    err = _assert_failed_at("mic", code, deps, tmp_path, sd)
    assert "deepgram" not in err["message"].lower()
    assert "microphone" in err["message"].lower()
    assert made == []


def test_stage_mic_failure_on_start_closes_the_stream(tmp_path):
    rec = Recorder()
    sd = FakeSD(rec, start_error=OSError("device busy"))
    deps = make_deps(rec, sd=sd)
    code = listen.main(argv(tmp_path, "--engine", "deepgram"), deps)
    _assert_failed_at("mic", code, deps, tmp_path, sd)
    assert sd.streams and sd.streams[0].closed


def test_stage_model_failure(tmp_path, monkeypatch):
    import stt_whisper

    def no_model(*args, **kwargs):
        raise RuntimeError("cannot find the model in the local cache")

    monkeypatch.setattr(stt_whisper, "WhisperModel", no_model)
    rec = Recorder()
    sd = FakeSD(rec)
    deps = make_deps(rec, sd=sd, whisper=stt_whisper.WhisperSTT)
    code = listen.main(argv(tmp_path, "--engine", "whisper", "--model", "base.en"), deps)
    err = _assert_failed_at("model", code, deps, tmp_path, sd)
    assert "online" in err["message"]
    assert "base.en" in err["message"]
    assert {"type": "loading", "model": "base.en"} in events(deps)


def test_stage_deepgram_failure(tmp_path):
    rec = Recorder()
    sd = FakeSD(rec)
    made = []
    deps = make_deps(rec, sd=sd, deepgram=stt_factory(rec, made, start_error=RuntimeError("401 Unauthorized")))
    code = listen.main(argv(tmp_path, "--engine", "deepgram"), deps)
    err = _assert_failed_at("deepgram", code, deps, tmp_path, sd, made)
    assert "401 Unauthorized" in err["message"]


def test_stage_deepgram_failure_without_a_key(tmp_path):
    rec = Recorder()
    sd = FakeSD(rec)
    made = []
    deps = make_deps(rec, sd=sd, deepgram=stt_factory(rec, made), env={})
    code = listen.main(argv(tmp_path, "--engine", "deepgram"), deps)
    err = _assert_failed_at("deepgram", code, deps, tmp_path, sd)
    assert "key" in err["message"].lower()
    assert made == []


def test_ready_comes_last(tmp_path):
    rec = Recorder()
    seen = []

    async def note(listener):
        seen.append(list(rec.log))

    deps = make_deps(rec, after_ready=note)
    assert listen.main(argv(tmp_path, "--engine", "deepgram"), deps) == 0
    evs = events(deps)
    assert evs[-1]["type"] == "ready"
    assert seen == [["stream-open", "stream-start", "stt-start"]]
    assert rec.log[-3:] == ["stream-stop", "stream-close", "stt-finish"]
    assert not (tmp_path / "listen.pid").exists()


def test_lock_is_held_while_running(tmp_path):
    held = []

    async def look(listener):
        held.append((tmp_path / "listen.pid").read_text())

    deps = make_deps(Recorder(), after_ready=look)
    listen.main(argv(tmp_path, "--engine", "deepgram"), deps)
    assert held == ["1234"]
    assert not (tmp_path / "listen.pid").exists()


def test_stdout_has_only_json(tmp_path):
    deps = make_deps(Recorder(), after_ready=_stop)
    listen.main(argv(tmp_path, "--engine", "deepgram"), deps)
    for line in deps.stdout.getvalue().splitlines():
        json.loads(line)
    assert deps.stderr.getvalue() != ""


# -- The owner watch: the listener ends when Claude Code is gone ------------------------


def test_parent_pid_must_be_a_positive_whole_number(tmp_path):
    for bad in ("0", "-3", "abc"):
        with pytest.raises(SystemExit):
            listen.parse_args(argv(tmp_path, "--parent-pid", bad))
    assert listen.parse_args(argv(tmp_path, "--parent-pid", "4242")).parent_pid == 4242
    assert listen.parse_args(argv(tmp_path)).parent_pid is None


def test_listener_exits_when_the_parent_is_gone(tmp_path, caplog):
    rec = Recorder()
    made = []
    checks = []
    answers = iter([True, True, False])

    def watch(pid):
        checks.append(pid)
        return lambda: next(answers)

    deps = make_deps(rec, deepgram=stt_factory(rec, made), watch_parent=watch, parent_poll_s=0.01)
    code = listen.main(argv(tmp_path, "--engine", "deepgram", "--parent-pid", "4242"), deps)
    assert code == 0
    assert checks == [4242]
    assert [e["type"] for e in events(deps)] == ["ready"]
    assert made[0].finished
    assert rec.log[-3:] == ["stream-stop", "stream-close", "stt-finish"]
    assert not (tmp_path / "listen.pid").exists()
    assert "Claude Code (pid 4242) has exited" in caplog.text


def test_listener_without_a_parent_pid_does_not_watch(tmp_path):
    def watch(pid):
        raise AssertionError("no watch without --parent-pid")

    deps = make_deps(Recorder(), watch_parent=watch, after_ready=_stop)
    assert listen.main(argv(tmp_path, "--engine", "deepgram"), deps) == 0


def test_listener_exits_when_a_real_parent_process_exits(tmp_path):
    """The real watch, on a real short-lived process standing in for Claude Code."""
    import subprocess
    import sys
    import time

    parent = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(1.5)"])
    try:
        deps = make_deps(Recorder(), parent_poll_s=0.05)
        started = time.monotonic()
        code = listen.main(argv(tmp_path, "--engine", "deepgram", "--parent-pid", str(parent.pid)), deps)
        elapsed = time.monotonic() - started
    finally:
        parent.kill()
        parent.wait()
    assert code == 0
    assert 1.0 < elapsed < 15
    assert not (tmp_path / "listen.pid").exists()



def test_partial_is_sent_while_listening():
    listener, state, stdout, _ = _listener()
    asyncio.run(listener.on_partial("um, run the"))
    assert _lines(stdout) == [{"type": "partial", "text": "run the"}]


def test_partial_is_dropped_while_muted():
    listener, state, stdout, _ = _listener()
    state.set_listening(False, "test")
    before = len(_lines(stdout))
    asyncio.run(listener.on_partial("run the"))
    asyncio.run(listener.on_partial("   "))
    assert len(_lines(stdout)) == before


def test_a_voice_command_clears_the_live_words():
    listener, state, stdout, _ = _listener()
    asyncio.run(listener.on_utterance_full("mic off", 0.9))
    partials = [e for e in _lines(stdout) if e["type"] == "partial"]
    assert partials == [{"type": "partial", "text": ""}]

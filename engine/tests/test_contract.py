"""The listener's stdout matches hooks/fixtures/listener-events.jsonl, the file
the mod's tests (hooks/rules.test.ts) are pinned to as well."""
import asyncio
import json
import re
from pathlib import Path

import core
import listen
from listen_fakes import FakeSD, Recorder, argv, audio, failing_mute_key_listener, make_deps, stt_factory

HOOKS = Path(__file__).resolve().parents[2] / "hooks"
FIXTURE = HOOKS / "fixtures" / "listener-events.jsonl"
MIRROR = HOOKS / "fixtures" / "listener-events.ts"
STAGES = {"device", "mic", "model", "deepgram", "mute_key", "connection", "takeover"}


def _json_type(value) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, str):
        return "string"
    return type(value).__name__


def _shape_key(event: dict) -> tuple:
    return (event["type"], event.get("stage"))


def _fixture_shapes() -> dict:
    shapes = {}
    for line in FIXTURE.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        event = json.loads(line)
        shape = {key: {_json_type(value)} for key, value in event.items()}
        if event["type"] == "ready":
            shape["mute_key"] = {"string", "null"}
        shapes[_shape_key(event)] = shape
    return shapes


def _matches(event: dict, shapes: dict) -> bool:
    shape = shapes.get(_shape_key(event))
    if shape is None or set(shape) != set(event):
        return False
    return all(_json_type(value) in shape[key] for key, value in event.items())


def _run(tmp_path, extra, **deps_kwargs) -> list[str]:
    deps = make_deps(Recorder(), **deps_kwargs)
    try:
        listen.main(argv(tmp_path, *extra), deps)
    except SystemExit:
        pass
    return deps.stdout.getvalue().splitlines()


def _all_emit_paths(tmp_path, monkeypatch) -> list[str]:
    lines: list[str] = []
    rec = Recorder()
    sd = FakeSD(rec)
    speaking = [False]

    async def drive(listener):
        await listener.on_partial("run the")
        await listener.on_utterance_full("run the tests", 0.9)
        await listener.on_utterance_full("mic off", 0.9)
        speaking[0] = True
        sd.streams[0].callback(audio(), 160, None, None)

    # ready (mute key unavailable: null), loading, takeover, utterance, state,
    # speaking, error mute_key.
    lines += _run(
        tmp_path,
        ["--engine", "whisper", "--model", "base.en"],
        sd=sd,
        whisper=stt_factory(rec, []),
        claim_mic=lambda lock, pid: 4141,
        is_speaking=lambda flag: speaking[0],
        start_mute_key_listener=failing_mute_key_listener,
        after_ready=drive,
    )

    async def stop(listener):
        return None

    # ready with a string mute key.
    lines += _run(tmp_path, ["--engine", "deepgram"], after_ready=stop)
    # error: device
    lines += _run(tmp_path, ["--engine", "deepgram"], sd=FakeSD(Recorder(), default_in=-1))
    # error: mic
    lines += _run(tmp_path, ["--engine", "deepgram"], sd=FakeSD(Recorder(), open_error=OSError("denied")))
    # error: model
    lines += _run(
        tmp_path,
        ["--engine", "whisper", "--model", "base.en"],
        whisper=stt_factory(Recorder(), [], start_error=RuntimeError("offline")),
    )
    # error: deepgram
    lines += _run(
        tmp_path, ["--engine", "deepgram"], deepgram=stt_factory(Recorder(), [], start_error=RuntimeError("401"))
    )
    # error: connection
    lines += _run(tmp_path, ["--engine", "deepgram"], deepgram=stt_factory(Recorder(), [], close_with="x"))

    # error: takeover
    def stuck(lock, pid):
        raise core.TakeoverTimeout(4141)

    lines += _run(tmp_path, ["--engine", "deepgram"], claim_mic=stuck)
    return lines


def test_fixture_has_every_event_and_stage():
    keys = set(_fixture_shapes())
    assert {t for t, _ in keys} == {"ready", "loading", "partial", "utterance", "state", "speaking", "takeover", "error"}
    assert {s for t, s in keys if t == "error"} == STAGES


def test_emitted_events_match_fixture_shapes(tmp_path, monkeypatch):
    shapes = _fixture_shapes()
    lines = _all_emit_paths(tmp_path, monkeypatch)
    events = [json.loads(line) for line in lines]
    bad = [e for e in events if not _matches(e, shapes)]
    assert bad == []
    # Every shape in the fixture was really produced.
    assert {_shape_key(e) for e in events} == set(shapes)
    assert {e["mute_key"] is None for e in events if e["type"] == "ready"} == {True, False}


def test_ts_mirror_holds_the_same_lines():
    """The mod tests cannot read files, so they import a .ts copy of the
    fixture. It must hold exactly the .jsonl's lines."""
    match = re.search(r"`\n(.*)`", MIRROR.read_text(encoding="utf-8"), re.DOTALL)
    assert match is not None
    assert match.group(1) == FIXTURE.read_text(encoding="utf-8")

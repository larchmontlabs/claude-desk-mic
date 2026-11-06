import asyncio
import threading
import time

import numpy as np
import pytest

import stt_whisper
from stt_whisper import Segmenter, WhisperSTT, frames

F = b"\x01\x00" * 480  # one 30 ms frame
FB = 960


def _push_all(seg, seq):
    out = []
    for i, speech in enumerate(seq):
        r = seg.push(F, speech)
        if r is not None:
            out.append((i, r))
    return out


def test_segment_fires_after_pause():
    seg = Segmenter()
    seq = [True] * 10 + [False] * 100
    out = _push_all(seg, seq)
    assert [i for i, _ in out] == [109]


def test_short_gap_keeps_one_utterance():
    seg = Segmenter()
    seq = [True] * 5 + [False] * 20 + [True] * 5 + [False] * 100
    out = _push_all(seg, seq)
    assert len(out) == 1
    assert len(out[0][1]) >= 10 * FB


def test_leading_silence_dropped():
    assert _push_all(Segmenter(), [False] * 50) == []


def test_segment_cut_at_30_seconds():
    seg = Segmenter()
    out = _push_all(seg, [True] * 1000)
    assert [i for i, _ in out] == [999]
    assert seg.push(F, True) is None
    out2 = _push_all(seg, [False] * 100)
    assert len(out2) == 1
    assert len(out2[0][1]) == 101 * FB


class FakeVad:
    levels = []
    seen = []

    def __init__(self, level=None):
        FakeVad.levels.append(level)

    def is_speech(self, frame, rate):
        FakeVad.seen.append((len(frame), rate))
        return False


class FakeVadMod:
    Vad = FakeVad


class FakeModel:
    instances = 0
    prompts = []
    audios = []

    kwargs = []

    def __init__(self, name, compute_type=None, device=None):
        FakeModel.kwargs.append({"device": device, "compute_type": compute_type})
        FakeModel.instances += 1
        self.name = name

    def transcribe(self, audio, initial_prompt=None):
        FakeModel.prompts.append(initial_prompt)
        FakeModel.audios.append(audio)
        return iter([type("S", (), {"text": " hello "})()])


@pytest.fixture(autouse=True)
def fakes(monkeypatch):
    FakeVad.levels, FakeVad.seen = [], []
    FakeModel.instances, FakeModel.prompts, FakeModel.audios = 0, [], []
    monkeypatch.setattr(stt_whisper, "webrtcvad", FakeVadMod)
    monkeypatch.setattr(stt_whisper, "WhisperModel", FakeModel)


def make(**kw):
    got = []
    loading = []

    async def cb(text, conf):
        got.append((text, conf))

    args = dict(
        on_utterance_full=cb,
        model="base.en",
        keyterms=["claude", "send it"],
        pause_ms=3000,
        on_loading=loading.append,
    )
    args.update(kw)
    return WhisperSTT(**args), got, loading


def test_vad_level_reaches_webrtcvad():
    make(vad_level=3)
    make()
    assert FakeVad.levels == [3, 2]


def test_frames_rechunks_any_block():
    fr, carry = frames(b"a" * 1000, b"")
    assert len(fr) == 1 and carry == b"a" * 40
    fr2, carry2 = frames(b"b" * 920, carry)
    assert len(fr2) == 1 and carry2 == b""
    assert fr[0] + fr2[0] == b"a" * 1000 + b"b" * 920


def _stt_with_speech(stt, speech_flag):
    stt._vad = type("V", (), {"is_speech": lambda self, f, r: speech_flag[0]})()


async def _utter(stt, flag):
    flag[0] = True
    await stt.send(F * 10)
    flag[0] = False
    await stt.send(F * 100)


def test_keyterms_become_initial_prompt():
    async def run():
        stt, got, _ = make()
        flag = [False]
        _stt_with_speech(stt, flag)
        await stt.start()
        await _utter(stt, flag)
        await stt.finish()
        return got

    got = asyncio.run(run())
    assert FakeModel.prompts == ["claude, send it"]
    assert got == [("hello", None)]


def test_model_loads_once():
    order = []

    async def run():
        stt, got, loading = make(on_loading=lambda m: order.append(("load", m)))
        flag = [False]
        _stt_with_speech(stt, flag)
        await stt.start()
        await _utter(stt, flag)
        await _utter(stt, flag)
        await stt.finish()
        return got

    got = asyncio.run(run())
    assert FakeModel.instances == 1
    assert order == [("load", "base.en")]
    assert len(got) == 2


def test_transcripts_stay_in_order(monkeypatch):
    calls = []

    def transcribe(self, audio, initial_prompt=None):
        n = len(calls)
        calls.append(n)
        if n == 0:
            time.sleep(0.3)
        return iter([type("S", (), {"text": f"t{n}"})()])

    monkeypatch.setattr(FakeModel, "transcribe", transcribe)

    async def run():
        stt, got, _ = make()
        flag = [False]
        _stt_with_speech(stt, flag)
        await stt.start()
        await _utter(stt, flag)
        await _utter(stt, flag)
        await stt.finish()
        return got

    got = asyncio.run(run())
    assert [t for t, _ in got] == ["t0", "t1"]


def test_send_buffers_irregular_chunks():
    async def run():
        stt, _, _ = make()
        for n in (7, 1000, 333, 920):
            await stt.send(b"x" * n)
        a = (len(FakeVad.seen), len(stt._carry))
        await stt.send(b"x" * 620)
        return a, (len(FakeVad.seen), len(stt._carry))

    a, b = asyncio.run(run())
    assert a == (2, 340)
    assert b == (3, 0)
    assert all(s == (960, 16000) for s in FakeVad.seen)


def test_pcm16_becomes_float32():
    pcm = np.array([-32768, 0, 16384], "<i2").tobytes()
    audio = stt_whisper.pcm16_to_float32(pcm)
    assert audio.dtype == np.float32
    assert audio.tolist() == [-1.0, 0.0, 0.5]

    async def run():
        stt, _, _ = make()
        await stt.start()
        await stt._transcribe_now(pcm)
        await stt.finish()

    asyncio.run(run())
    assert FakeModel.audios[0].dtype == np.float32
    assert FakeModel.audios[0].tolist() == [-1.0, 0.0, 0.5]


def test_segments_are_consumed_in_the_worker_thread(monkeypatch):
    ids = {}

    def transcribe(self, audio, initial_prompt=None):
        ids["call"] = threading.get_ident()

        def gen():
            ids["iter"] = threading.get_ident()
            yield type("S", (), {"text": "a"})()
            yield type("S", (), {"text": "b"})()

        return gen()

    monkeypatch.setattr(FakeModel, "transcribe", transcribe)

    async def run():
        ids["loop"] = threading.get_ident()
        stt, got, _ = make()
        flag = [False]
        _stt_with_speech(stt, flag)
        await stt.start()
        await _utter(stt, flag)
        await stt.finish()
        return got

    got = asyncio.run(run())
    assert ids["call"] == ids["iter"] != ids["loop"]
    assert got == [("ab", None)]


def test_restart_after_finish():
    loads = []

    async def run():
        stt, got, _ = make(on_loading=loads.append)
        flag = [False]
        _stt_with_speech(stt, flag)
        for _ in range(2):
            await stt.start()
            await _utter(stt, flag)
            await stt.finish()
        return got

    got = asyncio.run(run())
    assert [t for t, _ in got] == ["hello", "hello"]
    assert FakeModel.instances == 1
    assert loads == ["base.en"]


def test_finish_flushes_pending_speech():
    async def run():
        stt, got, _ = make()
        flag = [True]
        _stt_with_speech(stt, flag)
        await stt.start()
        await stt.send(F * 10)
        await stt.finish()
        return got

    assert asyncio.run(run()) == [("hello", None)]


def test_model_loads_on_cpu_int8():
    async def run():
        stt, _, _ = make()
        await stt.start()
        await stt.finish()

    FakeModel.kwargs = []
    asyncio.run(run())
    assert FakeModel.kwargs == [{"device": "cpu", "compute_type": "int8"}]

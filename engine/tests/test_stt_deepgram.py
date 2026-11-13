import asyncio
from types import SimpleNamespace as NS

import pytest

from stt_deepgram import (
    DeepgramSTT,
    build_client_options,
    build_live_options,
    keyterm_options,
)


def test_nova2_uses_keywords():
    d = build_live_options("linear16", 16000, 1, ["Twilio", "Deepgram"]).to_dict()
    assert d["model"] == "nova-2"
    assert d["keywords"] == ["Twilio", "Deepgram"]
    assert "keyterm" not in d


def test_nova3_uses_keyterm():
    d = build_live_options("linear16", 16000, 1, ["Twilio"], model="nova-3").to_dict()
    assert d["keyterm"] == ["Twilio"]
    assert "keywords" not in d


def test_empty_keyterms_omitted():
    for empty in (None, [], (), [""]):
        d = build_live_options("linear16", 16000, 1, empty).to_dict()
        assert "keywords" not in d and "keyterm" not in d
    assert keyterm_options("nova-3", []) == {}


def test_utterance_end_ms_is_passed():
    opts = build_live_options("linear16", 16000, 1, utterance_end_ms=2000)
    assert opts.utterance_end_ms == "2000"


def test_default_model_is_nova_2():
    d = build_live_options("linear16", 16000, 1, ["x"]).to_dict()
    assert d["model"] == "nova-2"
    assert d["keywords"] == ["x"]


def test_keepalive_is_on():
    # deepgram-sdk 3.11 returns the string "true", not a bool
    assert build_client_options().is_keep_alive_enabled() in (True, "true")


# ---- transcript handling ----

def result(words, confidence=0.9, final=True):
    """words: list of (text, start, end)."""
    alt = NS(
        transcript=" ".join(w[0] for w in words),
        confidence=confidence,
        words=[NS(word=t, start=s, end=e) for t, s, e in words],
    )
    return NS(is_final=final, channel=NS(alternatives=[alt]))


class Harness:
    def __init__(self):
        self.calls = []
        self.closed = []
        self.partials = []

        async def full(text, conf):
            self.calls.append((text, conf))

        async def closed(reason):
            self.closed.append(reason)

        async def partial(text):
            self.partials.append(text)

        self.stt = DeepgramSTT(full, closed, on_partial=partial)


def run(coro):
    return asyncio.run(coro)


def test_two_finals_then_utterance_end_make_one_call():
    h = Harness()

    async def go():
        await h.stt.handle_transcript(result([("hello", 0.0, 0.5), ("there", 0.6, 1.0)], 0.95))
        await h.stt.handle_transcript(result([("how", 1.5, 1.7), ("are", 1.8, 2.0)], 0.7))
        await h.stt.handle_utterance_end(NS(last_word_end=2.0))

    run(go())
    assert h.calls == [("hello there how are", 0.7)]


def test_final_replaces_interim_inside_its_span():
    h = Harness()

    async def go():
        await h.stt.handle_transcript(result([("hell", 0.0, 0.4)], 0.3, final=False))
        await h.stt.handle_transcript(result([("hello", 0.0, 0.5)], 0.9))
        await h.stt.handle_utterance_end(NS(last_word_end=0.5))

    run(go())
    assert h.calls == [("hello", 0.9)]


def test_blank_transcript_ignored():
    h = Harness()

    async def go():
        await h.stt.handle_transcript(result([]))
        await h.stt.handle_utterance_end(NS(last_word_end=1.0))

    run(go())
    assert h.calls == []


def test_utterance_end_flushes_only_covered_words():
    h = Harness()

    async def go():
        await h.stt.handle_transcript(result([("first", 0.0, 1.0), ("one", 1.1, 2.0)], 0.9))
        await h.stt.handle_transcript(result([("second", 2.5, 3.0)], 0.8, final=False))
        await h.stt.handle_utterance_end(NS(last_word_end=2.0))
        assert h.calls == [("first one", 0.9)]
        await h.stt.handle_transcript(result([("second", 2.5, 3.0), ("one", 3.1, 3.5)], 0.8))
        await h.stt.handle_utterance_end(NS(last_word_end=3.5))

    run(go())
    assert h.calls == [("first one", 0.9), ("second one", 0.8)]


def test_utterance_end_minus_one_is_ignored():
    h = Harness()

    async def go():
        await h.stt.handle_transcript(result([("hello", 0.0, 0.5)], 0.9))
        await h.stt.handle_utterance_end(NS(last_word_end=-1))
        assert h.calls == []
        await h.stt.handle_utterance_end(NS(last_word_end=0.5))

    run(go())
    assert h.calls == [("hello", 0.9)]


# ---- closed stream ----

class FakeConn:
    def __init__(self):
        self.handlers = {}
        self.finished = False

    def on(self, event, fn):
        self.handlers[event] = fn

    async def finish(self):
        self.finished = True


def test_a_closed_stream_is_reported():
    from deepgram import LiveTranscriptionEvents as E

    h = Harness()
    conn = FakeConn()
    h.stt._wire(conn)
    h.stt._conn = conn

    async def go():
        await conn.handlers[E.Close](conn, "bye")
        await conn.handlers[E.Close](conn, "again")

    run(go())
    assert h.closed == ["bye"]


def test_a_requested_close_is_not_reported():
    from deepgram import LiveTranscriptionEvents as E

    h = Harness()
    conn = FakeConn()
    h.stt._wire(conn)
    h.stt._conn = conn

    async def go():
        await h.stt.finish()
        await conn.handlers[E.Close](conn, "bye")

    run(go())
    assert conn.finished and h.closed == []


def test_close_reason_carries_the_last_error():
    from deepgram import LiveTranscriptionEvents as E

    h = Harness()
    conn = FakeConn()
    h.stt._wire(conn)
    h.stt._conn = conn

    async def go():
        await conn.handlers[E.Error](conn, "bad auth")
        await conn.handlers[E.Close](conn, '{"type": "Close"}')

    run(go())
    assert len(h.closed) == 1 and "bad auth" in h.closed[0]


def test_flushed_interim_words_are_not_sent_again_by_the_final():
    h = Harness()

    async def go():
        await h.stt.handle_transcript(result([("hello", 0.0, 0.6)], 0.8, final=False))
        await h.stt.handle_utterance_end(NS(last_word_end=0.6))
        await h.stt.handle_transcript(result([("hello", 0.0, 0.6), ("next", 0.7, 0.9)], 0.9))
        await h.stt.handle_utterance_end(NS(last_word_end=0.9))

    run(go())
    assert [t for t, _ in h.calls] == ["hello", "next"]


def test_each_transcript_reports_the_words_so_far_as_a_partial():
    h = Harness()

    async def go():
        await h.stt.handle_transcript(result([("hell", 0.0, 0.4)], 0.3, final=False))
        await h.stt.handle_transcript(result([("hello", 0.0, 0.5)], 0.9))
        await h.stt.handle_transcript(result([("there", 0.6, 1.0)], 0.9, final=False))
        await h.stt.handle_utterance_end(NS(last_word_end=1.0))
        await h.stt.handle_transcript(result([("next", 1.5, 1.8)], 0.9, final=False))

    run(go())
    assert h.partials == ["hell", "hello", "hello there", "next"]
    assert h.calls == [("hello there", 0.9)]


def test_no_partial_callback_is_fine():
    async def full(text, conf):
        pass

    async def closed(reason):
        pass

    stt = DeepgramSTT(full, closed)
    run(stt.handle_transcript(result([("hello", 0.0, 0.5)], 0.9)))
    assert [w["text"] for w in stt._words] == ["hello"]


def test_no_speech_text_in_the_info_log(caplog):
    import logging

    caplog.set_level(logging.INFO)
    h = Harness()

    async def go():
        await h.stt.handle_transcript(result([("private", 0.0, 0.5)], 0.9))
        await h.stt.handle_utterance_end(NS(last_word_end=0.5))

    run(go())
    assert h.calls == [("private", 0.9)]
    assert not any("private" in r.getMessage() for r in caplog.records if r.levelno >= logging.INFO)

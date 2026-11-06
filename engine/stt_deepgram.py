"""Deepgram streaming speech-to-text for the desk mic.

Port of voice-bridge stt.py. Differences: the pause length is a parameter, the
client keeps the stream alive while audio is gated, an unrequested close is
reported, and UtteranceEnd flushes only the words it covers.
"""
import logging
from typing import Awaitable, Callable

from deepgram import (
    DeepgramClient,
    DeepgramClientOptions,
    LiveOptions,
    LiveTranscriptionEvents,
)

log = logging.getLogger(__name__)

MODEL = "nova-2"


def keyterm_options(model: str, keyterms) -> dict:
    """Deepgram boosts listed words under a different option per model:
    nova-3 takes `keyterm`, nova-2 and older take `keywords`."""
    terms = [t for t in (keyterms or []) if t]
    if not terms:
        return {}
    if model.startswith("nova-3"):
        return {"keyterm": terms}
    return {"keywords": terms}


def build_live_options(
    encoding: str,
    sample_rate: int,
    channels: int,
    keyterms=None,
    model: str = MODEL,
    utterance_end_ms: int = 3000,
) -> LiveOptions:
    return LiveOptions(
        model=model,
        language="en-US",
        encoding=encoding,
        sample_rate=sample_rate,
        channels=channels,
        interim_results=True,  # needed for utterance_end_ms buffering
        vad_events=True,  # enables SpeechStarted + UtteranceEnd
        utterance_end_ms=str(utterance_end_ms),
        endpointing=False,  # disable silence-based endpointing
        **keyterm_options(model, keyterms),
    )


def build_client_options() -> DeepgramClientOptions:
    """Keepalive on: gated audio (muted or paused) would otherwise leave the
    stream idle and Deepgram would close it."""
    return DeepgramClientOptions(options={"keepalive": "true"})


class DeepgramSTT:
    def __init__(
        self,
        on_utterance_full: Callable[[str, float | None], Awaitable[None]],
        on_closed: Callable[[str], Awaitable[None]],
        encoding: str = "linear16",
        sample_rate: int = 16000,
        channels: int = 1,
        keyterms: list[str] | None = None,
        utterance_end_ms: int = 3000,
        model: str = MODEL,
    ):
        self._on_utterance_full = on_utterance_full
        self._on_closed = on_closed
        self._encoding = encoding
        self._sample_rate = sample_rate
        self._channels = channels
        self._keyterms = list(keyterms or [])
        self._utterance_end_ms = utterance_end_ms
        self._model = model
        self._conn = None
        self._finishing = False
        # Pending words: dicts with start, end, text, confidence, final.
        self._words: list[dict] = []

    async def handle_transcript(self, result) -> None:
        """One Deepgram Transcript event. A final result replaces any pending
        words inside its span; an interim replaces the previous interim."""
        try:
            alt = result.channel.alternatives[0]
            if not alt.transcript.strip():
                return
            confidence = getattr(alt, "confidence", 1.0)
            new = [
                {
                    "start": w.start,
                    "end": w.end,
                    "text": getattr(w, "punctuated_word", None) or w.word,
                    "confidence": confidence,
                    "final": bool(result.is_final),
                }
                for w in (alt.words or [])
            ]
            if not new:
                return
            span_end = max(w["end"] for w in new)
            # Pending interim words are superseded: by a final inside its
            # span, or by any newer interim. Final words are kept.
            if result.is_final:
                self._words = [
                    w for w in self._words if w["final"] or w["start"] >= span_end
                ]
            else:
                self._words = [w for w in self._words if w["final"]]
            self._words.extend(new)
            self._words.sort(key=lambda w: w["start"])
        except Exception as exc:
            log.debug("STT message parse error: %s", exc)

    async def handle_utterance_end(self, utterance_end) -> None:
        last_word_end = getattr(utterance_end, "last_word_end", None)
        if last_word_end is None or last_word_end < 0:
            return
        flushed = [w for w in self._words if w["end"] <= last_word_end]
        if not flushed:
            return
        self._words = [w for w in self._words if w["end"] > last_word_end]
        text = " ".join(w["text"] for w in flushed).strip()
        if not text:
            return
        # Conservative: the weakest result sets the confidence.
        confidence = min(w["confidence"] for w in flushed)
        log.info("STT UtteranceEnd firing: %r (confidence=%.2f)", text, confidence)
        await self._on_utterance_full(text, confidence)

    async def handle_close(self, reason="") -> None:
        if self._finishing:
            return
        self._finishing = True  # report once
        await self._on_closed(str(reason) or "closed")

    def _wire(self, conn) -> None:
        async def _on_message(self_conn, result, **kwargs):
            await self.handle_transcript(result)

        async def _on_utterance_end(self_conn, utterance_end, **kwargs):
            await self.handle_utterance_end(utterance_end)

        async def _on_close(self_conn, close=None, **kwargs):
            await self.handle_close(close if close is not None else "")

        async def _on_error(self_conn, error, **kwargs):
            log.warning("Deepgram error: %s", error)

        conn.on(LiveTranscriptionEvents.Transcript, _on_message)
        conn.on(LiveTranscriptionEvents.UtteranceEnd, _on_utterance_end)
        conn.on(LiveTranscriptionEvents.Close, _on_close)
        conn.on(LiveTranscriptionEvents.Error, _on_error)

    async def start(self, api_key: str) -> None:
        client = DeepgramClient(api_key, build_client_options())
        self._conn = client.listen.asyncwebsocket.v("1")
        self._finishing = False
        self._wire(self._conn)
        opts = build_live_options(
            self._encoding,
            self._sample_rate,
            self._channels,
            self._keyterms,
            self._model,
            self._utterance_end_ms,
        )
        if not await self._conn.start(opts):
            raise RuntimeError("Deepgram connection failed to start")
        log.info("Deepgram connection open")

    async def send(self, pcm: bytes) -> None:
        if self._conn:
            await self._conn.send(pcm)

    async def finish(self) -> None:
        self._finishing = True
        if self._conn:
            await self._conn.finish()
            self._conn = None
            log.info("Deepgram connection closed")

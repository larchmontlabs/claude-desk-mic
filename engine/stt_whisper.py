"""Local speech-to-text with faster-whisper.

Audio comes in as mono PCM16 (little-endian, 16 kHz) of any length. It is cut
into exact 30 ms frames, a webrtcvad voice detector marks each frame, and a
Segmenter groups frames into utterances. Each utterance is transcribed by one
worker thread, one at a time and in order.
"""
import asyncio
import logging
from concurrent.futures import ThreadPoolExecutor
from typing import Awaitable, Callable

import numpy as np
import webrtcvad
from faster_whisper import WhisperModel

log = logging.getLogger("desk-mic.whisper")

SAMPLE_RATE = 16000
FRAME_MS = 30
FRAME_BYTES = 960  # 30 ms * 16 kHz * 2 bytes


def frames(pcm: bytes, carry: bytes, frame_bytes: int = FRAME_BYTES) -> tuple[list[bytes], bytes]:
    """Cut `carry + pcm` into exact frames; return (frames, leftover bytes)."""
    data = carry + pcm
    n = len(data) // frame_bytes
    out = [data[i * frame_bytes:(i + 1) * frame_bytes] for i in range(n)]
    return out, data[n * frame_bytes:]


def pcm16_to_float32(pcm: bytes) -> np.ndarray:
    return np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0


class Segmenter:
    """Groups voice-detected frames into utterances."""

    def __init__(self, frame_ms: int = 30, pause_ms: int = 3000, max_ms: int = 30000):
        self._pause_frames = max(1, pause_ms // frame_ms)
        self._max_frames = max(1, max_ms // frame_ms)
        self._buf: list[bytes] = []
        self._silence = 0
        self._heard_speech = False

    def push(self, frame: bytes, is_speech: bool) -> bytes | None:
        if not self._heard_speech:
            if not is_speech:
                return None  # leading silence is dropped
            self._heard_speech = True
        self._buf.append(frame)
        self._silence = 0 if is_speech else self._silence + 1
        if self._silence >= self._pause_frames or len(self._buf) >= self._max_frames:
            return self._take()
        return None

    def flush(self) -> bytes | None:
        """Whatever speech is pending, or None."""
        return self._take() if self._heard_speech else None

    def _take(self) -> bytes:
        audio = b"".join(self._buf)
        self._buf, self._silence, self._heard_speech = [], 0, False
        return audio


class WhisperSTT:
    def __init__(
        self,
        on_utterance_full: Callable[[str, float | None], Awaitable[None]],
        model: str,
        keyterms: list[str],
        pause_ms: int,
        on_loading: Callable[[str], None],
        vad_level: int = 2,
    ):
        self._on_utterance_full = on_utterance_full
        self._model_name = model
        self._prompt = ", ".join(keyterms)
        self._on_loading = on_loading
        self._vad = webrtcvad.Vad(vad_level)
        self._seg = Segmenter(FRAME_MS, pause_ms, 30000)
        self._carry = b""
        self._model = None
        self._queue: asyncio.Queue = asyncio.Queue()
        self._worker: asyncio.Task | None = None
        self._pool: ThreadPoolExecutor | None = None

    async def start(self) -> None:
        if self._model is None:
            self._on_loading(self._model_name)
            self._model = await asyncio.to_thread(
                WhisperModel, self._model_name, device="cpu", compute_type="int8"
            )
        self._pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="whisper")
        self._worker = asyncio.create_task(self._run())
        log.info("Whisper model %s ready", self._model_name)

    async def send(self, pcm: bytes) -> None:
        fr, self._carry = frames(pcm, self._carry)
        for f in fr:
            seg = self._seg.push(f, self._vad.is_speech(f, SAMPLE_RATE))
            if seg is not None:
                self._queue.put_nowait(seg)

    async def finish(self) -> None:
        tail = self._seg.flush()
        if tail is not None:
            self._queue.put_nowait(tail)
        self._queue.put_nowait(None)
        if self._worker is not None:
            await self._worker
            self._worker = None
        if self._pool is not None:
            self._pool.shutdown(wait=True)
            self._pool = None

    def _transcribe(self, pcm: bytes) -> str:
        # Runs in the worker thread: transcribe() is lazy, so the segments
        # must be consumed here too.
        segments, *_ = self._decode(pcm)
        return "".join(s.text for s in segments).strip()

    def _decode(self, pcm: bytes):
        result = self._model.transcribe(
            pcm16_to_float32(pcm), initial_prompt=self._prompt
        )
        # Real faster-whisper returns (segments, info); a bare iterable is fine too.
        if isinstance(result, tuple):
            return result
        return (result,)

    async def _transcribe_now(self, pcm: bytes) -> None:
        loop = asyncio.get_running_loop()
        text = await loop.run_in_executor(self._pool, self._transcribe, pcm)
        if text:
            await self._on_utterance_full(text, None)

    async def _run(self) -> None:
        while True:
            pcm = await self._queue.get()
            if pcm is None:
                return
            try:
                await self._transcribe_now(pcm)
            except Exception as exc:
                log.warning("Whisper transcription failed: %s", exc)

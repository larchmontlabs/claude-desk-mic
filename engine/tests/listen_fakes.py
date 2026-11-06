"""Fakes for driving listen.py without a microphone, a network or a model."""
import asyncio
import io
import json
from types import SimpleNamespace

import numpy as np

import core
import listen


class Recorder:
    """One ordered log shared by every fake, so tests can check what ran when."""

    def __init__(self) -> None:
        self.log: list[str] = []


class FakeStream:
    def __init__(self, rec: Recorder, start_error=None, **kwargs) -> None:
        self.rec = rec
        self.kwargs = kwargs
        self.callback = kwargs["callback"]
        self.start_error = start_error
        self.closed = False
        rec.log.append("stream-open")

    def start(self) -> None:
        if self.start_error is not None:
            raise self.start_error
        self.rec.log.append("stream-start")

    def stop(self) -> None:
        self.rec.log.append("stream-stop")

    def close(self) -> None:
        self.closed = True
        self.rec.log.append("stream-close")


class FakeSD:
    """Stands in for the sounddevice module."""

    def __init__(self, rec: Recorder, devices=None, default_in=0, open_error=None, start_error=None) -> None:
        self.rec = rec
        self.devices = devices if devices is not None else [{"name": "Desk Mic"}]
        self.default = SimpleNamespace(device=(default_in, 0))
        self.open_error = open_error
        self.start_error = start_error
        self.streams: list[FakeStream] = []

    def query_devices(self):
        return self.devices

    def InputStream(self, **kwargs):
        if self.open_error is not None:
            raise self.open_error
        stream = FakeStream(self.rec, start_error=self.start_error, **kwargs)
        self.streams.append(stream)
        return stream


class FakeSTT:
    """Stands in for DeepgramSTT and WhisperSTT: records how it was built."""

    def __init__(self, rec: Recorder, start_error=None, close_with=None, **kwargs) -> None:
        self.rec = rec
        self.kwargs = kwargs
        self.start_error = start_error
        self.close_with = close_with
        self.sent: list[bytes] = []
        self.finished = False
        self.started_with = None

    async def start(self, *args) -> None:
        self.rec.log.append("stt-start")
        self.started_with = args
        if "on_loading" in self.kwargs:
            self.kwargs["on_loading"](self.kwargs["model"])
        if self.start_error is not None:
            raise self.start_error
        if self.close_with is not None:
            asyncio.get_running_loop().call_soon(
                lambda: asyncio.ensure_future(self.kwargs["on_closed"](self.close_with))
            )

    async def send(self, pcm: bytes) -> None:
        self.sent.append(pcm)

    async def finish(self) -> None:
        self.finished = True
        self.rec.log.append("stt-finish")


def stt_factory(rec: Recorder, made: list, **behaviour):
    def make(**kwargs):
        stt = FakeSTT(rec, **behaviour, **kwargs)
        made.append(stt)
        return stt

    return make


def make_deps(rec: Recorder, sd=None, deepgram=None, whisper=None, **overrides) -> listen.Deps:
    stdout, stderr = io.StringIO(), io.StringIO()
    deps = listen.Deps(
        platform="win32",
        pid=1234,
        env={"DEEPGRAM_API_KEY": "test-key"},
        stdout=stdout,
        stderr=stderr,
        sd=sd if sd is not None else FakeSD(rec),
        deepgram_stt=deepgram if deepgram is not None else stt_factory(rec, []),
        whisper_stt=whisper if whisper is not None else stt_factory(rec, []),
        is_speaking=lambda flag: False,
        resolve_mute_key=lambda name, platform: "KEY",
        start_mute_key_listener=lambda key, on_toggle, out, platform: True,
    )
    for name, value in overrides.items():
        setattr(deps, name, value)
    return deps


def events(deps: listen.Deps) -> list[dict]:
    return [json.loads(line) for line in deps.stdout.getvalue().splitlines() if line.strip()]


def argv(state_dir, *extra) -> list[str]:
    return ["--emit-json", "--state-dir", str(state_dir), *extra]


def audio(n: int = 160) -> np.ndarray:
    return np.zeros((n, 1), dtype=np.float32)


def failing_mute_key_listener(key, on_toggle, out, platform):
    """The real start_mute_key_listener, with a hotkey backend that fails."""

    def boom(**kwargs):
        raise RuntimeError("no keyboard access")

    return core.start_mute_key_listener(key, on_toggle, out, platform, listener_factory=boom)

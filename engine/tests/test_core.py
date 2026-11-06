import io
import json
import os
import subprocess
import sys
import textwrap
import time
from pathlib import Path

import psutil
import pytest

import core

ENGINE_DIR = Path(__file__).resolve().parent.parent


def _events(stream: io.StringIO) -> list[dict]:
    return [json.loads(line) for line in stream.getvalue().splitlines() if line.strip()]


def _out():
    stdout, stderr = io.StringIO(), io.StringIO()
    return core.Output(emit_json=True, stdout=stdout, stderr=stderr), stdout, stderr


# -- Output ------------------------------------------------------------------

def test_human_chatter_stays_off_stdout():
    out, stdout, stderr = _out()
    out.say("DESK MIC IS LIVE")
    assert stdout.getvalue() == ""
    assert "DESK MIC IS LIVE" in stderr.getvalue()


def test_say_goes_to_stdout_when_not_json():
    stdout, stderr = io.StringIO(), io.StringIO()
    out = core.Output(emit_json=False, stdout=stdout, stderr=stderr)
    out.say("hi")
    out.event({"type": "x"})
    assert stdout.getvalue() == "hi\n"
    assert stderr.getvalue() == ""


def test_non_ascii_text_is_escaped_for_windows_pipes():
    out, stdout, _ = _out()
    out.event({"type": "utterance", "text": "caf\u00e9"})
    assert stdout.getvalue().isascii()
    assert _events(stdout)[0]["text"] == "caf\u00e9"


def test_state_paths_names():
    p = core.state_paths(Path("/s"))
    assert p["flag"] == Path("/s") / "speaking"
    assert p["lock"] == Path("/s") / "listen.pid"


# -- One mic at a time -------------------------------------------------------

def _gone(pid, wait_s, clock):
    return True


def test_claim_takes_over_from_live_listener(tmp_path):
    lock = tmp_path / "listen.pid"
    lock.write_text("4242")
    killed = []
    previous = core.claim_mic(
        lock, my_pid=777, is_listener=lambda pid: pid == 4242, kill=killed.append, wait_gone=_gone
    )
    assert previous == 4242
    assert killed == [4242]
    assert lock.read_text() == "777"
    assert not Path(str(lock) + ".guard").exists()


def test_claim_ignores_stale_pid(tmp_path):
    lock = tmp_path / "listen.pid"
    lock.write_text("4242")
    killed = []
    previous = core.claim_mic(
        lock, my_pid=777, is_listener=lambda pid: False, kill=killed.append, wait_gone=_gone
    )
    assert previous is None
    assert killed == []
    assert lock.read_text() == "777"


def test_claim_with_no_lock_file(tmp_path):
    lock = tmp_path / "listen.pid"
    previous = core.claim_mic(
        lock, my_pid=777, is_listener=lambda pid: True, kill=lambda pid: None, wait_gone=_gone
    )
    assert previous is None
    assert lock.read_text() == "777"


def test_release_only_removes_own_lock(tmp_path):
    lock = tmp_path / "listen.pid"
    lock.write_text("999")
    core.release_mic(lock, my_pid=777)
    assert lock.exists()
    lock.write_text("777")
    core.release_mic(lock, my_pid=777)
    assert not lock.exists()


def test_stale_guard_is_taken_over(tmp_path):
    lock = tmp_path / "listen.pid"
    Path(str(lock) + ".guard").write_text("4242")
    core.claim_mic(
        lock, my_pid=777, is_listener=lambda pid: False, kill=lambda pid: None,
        wait_gone=_gone, pid_alive=lambda pid: False,
    )
    assert lock.read_text() == "777"
    assert not Path(str(lock) + ".guard").exists()


def test_claim_checks_for_listen_py(monkeypatch):
    class FakeProc:
        def __init__(self, pid):
            pass

        def name(self):
            return "python"

        def cmdline(self):
            return ["python", "C:/x/desk_mic.py"]

    monkeypatch.setattr(core.psutil, "Process", FakeProc)
    assert core.is_listener(1234) is False


STUB = "import time\ntime.sleep(60)\n"


def _spawn(folder, name, body=STUB):
    folder.mkdir(parents=True, exist_ok=True)
    script = folder / name
    script.write_text(body)
    return subprocess.Popen([sys.executable, str(script)])


def _kill_tree(proc):
    """Kill a child and anything it spawned (a venv python.exe on Windows is a
    launcher that starts the real interpreter as its own child)."""
    try:
        victims = psutil.Process(proc.pid).children(recursive=True)
    except psutil.Error:
        victims = []
    proc.kill()
    for v in victims:
        try:
            v.kill()
        except psutil.Error:
            pass
    proc.wait()


def _wait_alive(pid):
    for _ in range(100):
        if psutil.pid_exists(pid):
            time.sleep(0.3)
            return
        time.sleep(0.05)


def _is_gone(pid):
    if not psutil.pid_exists(pid):
        return True
    try:
        return psutil.Process(pid).status() == psutil.STATUS_ZOMBIE
    except psutil.Error:
        return True


def test_is_listener_matches_real_listen_py(tmp_path):
    good = _spawn(tmp_path / "a", "listen.py")
    other = _spawn(tmp_path / "b", "other.py")
    try:
        _wait_alive(good.pid)
        _wait_alive(other.pid)
        assert core.is_listener(good.pid) is True
        assert core.is_listener(other.pid) is False
    finally:
        _kill_tree(good)
        _kill_tree(other)
    assert core.is_listener(good.pid) is False


def test_takeover_waits_for_old_listener_to_exit(tmp_path):
    lock = tmp_path / "listen.pid"
    old = _spawn(tmp_path / "old", "listen.py")
    try:
        _wait_alive(old.pid)
        lock.write_text(str(old.pid))
        previous = core.claim_mic(lock, my_pid=os.getpid())
        assert previous == old.pid
        assert _is_gone(old.pid)
        assert lock.read_text() == str(os.getpid())
    finally:
        _kill_tree(old)


CLAIMER = textwrap.dedent(
    """
    import os, sys, time
    sys.path.insert(0, {engine!r})
    import core
    from pathlib import Path
    go = Path({go!r})
    while not go.exists():
        time.sleep(0.005)
    Path({pidfile!r}).write_text(str(os.getpid()))
    try:
        core.claim_mic(Path({lock!r}), os.getpid())
    except core.TakeoverTimeout:
        sys.exit(3)
    time.sleep(60)
    """
)


def test_simultaneous_claims_leave_one_owner(tmp_path):
    lock = tmp_path / "listen.pid"
    go = tmp_path / "go"
    pidfiles = [tmp_path / "a.pid", tmp_path / "b.pid"]

    def body(pidfile):
        return CLAIMER.format(
            engine=str(ENGINE_DIR), go=str(go), lock=str(lock), pidfile=str(pidfile)
        )

    a = _spawn(tmp_path / "a", "listen.py", body(pidfiles[0]))
    b = _spawn(tmp_path / "b", "listen.py", body(pidfiles[1]))
    procs = [a, b]

    def alive_pids():
        pids = [int(f.read_text()) for f in pidfiles if f.exists() and f.read_text().strip()]
        return [pid for pid in pids if not _is_gone(pid)]
    try:
        time.sleep(2)  # both interpreters are up and polling for the go file
        go.write_text("go")
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if all(f.exists() for f in pidfiles) and len(alive_pids()) == 1:
                break
            time.sleep(0.1)
        time.sleep(0.5)
        alive = alive_pids()
        assert len(alive) == 1
        assert lock.read_text().strip() == str(alive[0])
    finally:
        for p in procs:
            _kill_tree(p)


def test_takeover_gives_up_after_5_seconds(tmp_path):
    lock = tmp_path / "listen.pid"
    lock.write_text("4242")
    now = [0.0]

    def clock():
        return now[0]

    def wait_gone(pid, wait_s, clk):
        start = clk()
        while clk() - start < wait_s:
            assert clk() - start < 5 + 1e-9
            now[0] += 0.5
        return False

    with pytest.raises(core.TakeoverTimeout) as exc:
        core.claim_mic(
            lock, my_pid=777, is_listener=lambda pid: True, kill=lambda pid: None,
            wait_gone=wait_gone, clock=clock,
        )
    assert exc.value.pid == 4242
    assert now[0] == 5
    assert lock.read_text() == "4242"
    assert not Path(str(lock) + ".guard").exists()


# -- Speaking flag -----------------------------------------------------------

def test_stale_speaking_flag_is_ignored(tmp_path):
    flag = tmp_path / "speaking"
    flag.write_text("4242")
    assert core.is_speaking(flag, pid_alive=lambda p: False) is False


def test_live_speaking_flag_counts(tmp_path):
    flag = tmp_path / "speaking"
    assert core.is_speaking(flag, pid_alive=lambda p: True) is False
    flag.write_text("4242")
    assert core.is_speaking(flag, pid_alive=lambda p: True) is True
    flag.write_text("not a pid")
    assert core.is_speaking(flag, pid_alive=lambda p: True) is False


# -- MicState ----------------------------------------------------------------

def test_set_speaking_emits_on_change():
    out, stdout, _ = _out()
    state = core.MicState(out)
    assert state.set_speaking(True) is True
    assert state.set_speaking(True) is False
    assert state.set_speaking(False) is True
    assert _events(stdout) == [
        {"type": "speaking", "playing": True},
        {"type": "speaking", "playing": False},
    ]


def test_set_listening_and_toggle_emit_state():
    out, stdout, _ = _out()
    state = core.MicState(out)
    assert state.set_listening(False, "voice command") is True
    assert state.set_listening(False, "voice command") is False
    state.toggle("mute key")
    assert state.listening is True
    assert _events(stdout) == [
        {"type": "state", "listening": False, "source": "voice command"},
        {"type": "state", "listening": True, "source": "mute key"},
    ]


# -- Accept filter, voice commands -------------------------------------------

def test_accept_drops_short_and_low_confidence():
    assert core.accept("um ok", 0.9, 4, 0.6) is None
    assert core.accept("run tests", 0.5, 4, 0.6) is None
    assert core.accept("um, run the tests", None, 4, 0.6) == "run the tests"


def test_voice_commands():
    assert core.voice_command("Mic off.") == "off"
    assert core.voice_command("stop listening") == "off"
    assert core.voice_command("start listening") == "on"
    assert core.voice_command("mic on") == "on"
    assert core.voice_command("turn the mic off in the config") is None


# -- Mute key ----------------------------------------------------------------

def test_mute_key_auto():
    from pynput.keyboard import Key

    assert core.resolve_mute_key("auto", "win32") == Key.ctrl_r
    assert core.resolve_mute_key("auto", "darwin") == Key.alt_r
    with pytest.raises(ValueError):
        core.resolve_mute_key("banana", "win32")


def test_mute_key_label():
    assert core.mute_key_label("auto", "win32") == "Right Ctrl"
    assert core.mute_key_label("auto", "darwin") == "Right Option"
    assert core.mute_key_label("right alt", "win32") == "Right Alt"
    assert core.mute_key_label("right alt", "darwin") == "Right Option"
    assert core.mute_key_label("left ctrl", "win32") == "Left Ctrl"
    assert core.mute_key_label("right shift", "win32") == "Right Shift"
    assert core.mute_key_label("f13", "win32") == "F13"
    with pytest.raises(ValueError):
        core.mute_key_label("banana", "win32")


def _factory(raise_on_start=False, trusted=True):
    class FakeListener:
        IS_TRUSTED = trusted

        def __init__(self, on_press=None, on_release=None):
            self.on_press, self.on_release = on_press, on_release

        def start(self):
            if raise_on_start:
                raise RuntimeError("no display")

        def wait(self):
            pass

    return FakeListener


def test_failed_hotkey_listener_reports_error():
    from pynput.keyboard import Key

    out, stdout, _ = _out()
    assert core.start_mute_key_listener(
        Key.ctrl_r, lambda: None, out, "win32", listener_factory=_factory(raise_on_start=True)
    ) is False
    ev = _events(stdout)
    assert len(ev) == 1 and ev[0]["type"] == "error" and ev[0]["stage"] == "mute_key"
    assert "mute key unavailable" in ev[0]["message"]

    out, stdout, _ = _out()
    assert core.start_mute_key_listener(
        Key.alt_r, lambda: None, out, "darwin", listener_factory=_factory(trusted=False)
    ) is False
    ev = _events(stdout)
    assert len(ev) == 1 and ev[0]["stage"] == "mute_key"
    assert "Accessibility" in ev[0]["message"]

    out, stdout, _ = _out()
    assert core.start_mute_key_listener(
        Key.alt_r, lambda: None, out, "darwin", listener_factory=_factory()
    ) is True
    assert _events(stdout) == []


def test_mute_key_toggles_once_per_press():
    from pynput.keyboard import Key

    calls = []
    on_press, on_release = core.make_toggle_handlers(Key.ctrl_r, lambda: calls.append(1))
    on_press(Key.ctrl_r)
    on_press(Key.ctrl_r)  # auto-repeat
    on_release(Key.ctrl_r)
    on_press(Key.ctrl_r)
    on_press(Key.shift)  # other keys ignored
    assert len(calls) == 2

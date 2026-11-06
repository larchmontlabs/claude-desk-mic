"""The Python probes the mod runs (hooks/engine.ts), run here for real.

The mod passes the Claude Code pid to listen.py as --parent-pid, learned as
os.getppid() of the interpreter it resolved. A venv python.exe on Windows is a
launcher that runs the base interpreter as its child, so the probe must resolve
past it, or the "parent" would be the launcher, which exits at once.
"""
import os
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]


def _resolve_probe() -> str:
    source = (ROOT / "hooks" / "engine.ts").read_text(encoding="utf-8")
    match = re.search(r"export const RESOLVE =\s*'([^']*)'", source)
    assert match, "RESOLVE not found in hooks/engine.ts"
    return match.group(1)


def test_resolved_interpreter_reports_its_real_parent():
    # This test runs under a venv (.venv-dev in development), the case that matters.
    resolved = subprocess.run(
        [sys.executable, "-c", _resolve_probe()], capture_output=True, text=True, check=True
    ).stdout.strip()
    assert resolved
    ppid = subprocess.run(
        [resolved, "-c", "import os; print(os.getppid())"], capture_output=True, text=True, check=True
    ).stdout.strip()
    assert int(ppid) == os.getpid()

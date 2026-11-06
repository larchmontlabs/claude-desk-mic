"""The engine must run on Windows and macOS: no Windows-only imports, and no
personal paths in shipped code."""
import re
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
BANNED_IMPORT = re.compile(
    r"^\s*(?:import|from)\s+(?:win32\w*|msvcrt|pywinauto|winreg)\b", re.MULTILINE
)
PERSONAL = "C:/Users/" + "someone"


def _skip(p: Path) -> bool:
    return any(part in (".venv-dev", "__pycache__", "node_modules") for part in p.parts)


def test_no_windows_only_imports_in_engine():
    bad = [
        str(p)
        for p in (REPO / "engine").rglob("*.py")
        if not _skip(p) and BANNED_IMPORT.search(p.read_text(encoding="utf-8"))
    ]
    assert bad == []


@pytest.mark.xfail(
    strict=True,
    reason="hooks/register.ts still has the old personal path until Task 8 rewrites it; Task 8 removes this marker",
)
def test_no_personal_paths_in_engine_or_hooks():
    bad = []
    for folder in ("engine", "hooks"):
        root = REPO / folder
        if not root.exists():
            continue
        for p in root.rglob("*"):
            if p.is_file() and not _skip(p):
                try:
                    if PERSONAL in p.read_text(encoding="utf-8").replace("\\", "/"):
                        bad.append(str(p))
                except UnicodeDecodeError:
                    pass
    assert bad == []

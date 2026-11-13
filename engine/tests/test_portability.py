"""The engine must run on Windows and macOS: no Windows-only imports, and no
personal paths in shipped code."""
import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
BANNED_IMPORT = re.compile(
    r"^\s*(?:import|from)\s+(?:win32\w*|msvcrt|pywinauto|winreg)\b", re.MULTILINE
)
# A real person's home folder, Windows or macOS. The tests' made-up home is "t".
PERSONAL = re.compile(r"(?:[A-Za-z]:)?/Users/(?!t\b)[A-Za-z0-9._-]{2,}")


def _skip(p: Path) -> bool:
    return any(part in (".venv-dev", "__pycache__", "node_modules", "types") for part in p.parts)


def test_no_windows_only_imports_in_engine():
    bad = [
        str(p)
        for p in (REPO / "engine").rglob("*.py")
        if not _skip(p) and BANNED_IMPORT.search(p.read_text(encoding="utf-8"))
    ]
    assert bad == []


def test_no_personal_paths_in_shipped_files():
    bad = []
    for folder in ("engine", "hooks", "scripts", "docs", ".claude-plugin", ".github"):
        root = REPO / folder
        if not root.exists():
            continue
        for p in root.rglob("*"):
            if p.is_file() and not _skip(p):
                try:
                    if PERSONAL.search(p.read_text(encoding="utf-8").replace("\\", "/")):
                        bad.append(str(p))
                except UnicodeDecodeError:
                    pass
    assert bad == []


def test_no_personal_paths_in_top_level_files():
    bad = [p.name for p in REPO.glob("*.md") if PERSONAL.search(p.read_text(encoding="utf-8").replace("\\", "/"))]
    assert bad == []


def test_personal_path_check_catches_a_real_home_folder():
    assert PERSONAL.search("C:/Users/" + "somebody/x")
    assert PERSONAL.search("/Users/" + "somebody/x")
    assert not PERSONAL.search("C:/Users/t/.claude-desk-mic")

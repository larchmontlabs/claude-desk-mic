import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]


def test_readme_settings_table_matches_plugin_json():
    r = subprocess.run([sys.executable, str(ROOT / "scripts" / "settings_table.py"), "--check"])
    assert r.returncode == 0, "run: python scripts/settings_table.py"

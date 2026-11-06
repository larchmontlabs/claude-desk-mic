"""Build the README settings table from plugin.json userConfig.

python scripts/settings_table.py          rewrite the table inside README.md
python scripts/settings_table.py --check  exit 1 if README.md is out of date
"""
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
START, END = "<!-- settings:start -->", "<!-- settings:end -->"


def table() -> str:
    cfg = json.loads((ROOT / ".claude-plugin" / "plugin.json").read_text(encoding="utf-8"))["userConfig"]
    rows = ["| Setting | What it does | Default |", "|---|---|---|"]
    for key, f in cfg.items():
        desc = f["description"]
        if "options" in f:
            desc += " Options: " + ", ".join(f"`{o}`" for o in f["options"]) + "."
        if "min" in f and "max" in f:
            desc += f" Range {f['min']} to {f['max']}."
        elif "min" in f:
            desc += f" Minimum {f['min']}."
        if f.get("sensitive"):
            default = "none (stored as a secret)"
        else:
            d = f.get("default")
            default = "`true`" if d is True else "`false`" if d is False else f"`{d}`"
        rows.append(f"| `{key}` ({f['title']}) | {desc} | {default} |")
    return "\n".join(rows)


def render(readme: str) -> str:
    head, rest = readme.split(START, 1)
    _, tail = rest.split(END, 1)
    return f"{head}{START}\n{table()}\n{END}{tail}"


if __name__ == "__main__":
    path = ROOT / "README.md"
    text = path.read_text(encoding="utf-8")
    new = render(text)
    if "--check" in sys.argv:
        sys.exit(0 if new == text else 1)
    path.write_text(new, encoding="utf-8")

"""Text cleanup shared by the listener (input) and speak-back (output)."""
import re

FILLER_RE = re.compile(r"\b(um+|uh+|hmm+)\b[,.]?\s*", re.IGNORECASE)

MAX_CHARS = 8000


def strip_fillers(text: str) -> str:
    return FILLER_RE.sub(" ", text).strip()


def clean_markdown(text: str) -> str:
    """Strip markdown noise that reads poorly when spoken."""
    # Drop fenced code blocks entirely.
    text = re.sub(r"```.*?```", "", text, flags=re.DOTALL)
    # Drop inline code backticks but keep contents.
    text = re.sub(r"`([^`]+)`", r"\1", text)
    # Convert markdown tables to comma-separated speech-friendly lines.
    result_lines = []
    for line in text.splitlines():
        s = line.strip()
        if set(s) <= set("-|: "):  # separator row (or blank) - skip
            continue
        elif s.startswith("|"):  # data row - join cells with comma
            cells = [c.strip() for c in s.strip("|").split("|") if c.strip()]
            result_lines.append(", ".join(cells))
        else:
            result_lines.append(line)
    text = "\n".join(result_lines)
    # Headers: drop the leading hashes.
    text = re.sub(r"^#{1,6}\s+", "", text, flags=re.MULTILINE)
    # Bold/italic markers.
    text = re.sub(r"\*\*([^*]+)\*\*", r"\1", text)
    text = re.sub(r"\*([^*]+)\*", r"\1", text)
    text = re.sub(r"_([^_]+)_", r"\1", text)
    # Links: [label](url) -> label
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    # Bare URLs: drop entirely.
    text = re.sub(r"https?://\S+", "", text)
    # Bullet markers at start of line.
    text = re.sub(r"^\s*[-*]\s+", "", text, flags=re.MULTILINE)
    # Numbered list markers.
    text = re.sub(r"^\s*\d+\.\s+", "", text, flags=re.MULTILINE)
    # Collapse runs of blank lines.
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def speakable(text: str, max_chars: int = MAX_CHARS) -> str:
    """Markdown cleanup, then cut at the last space before max_chars."""
    text = clean_markdown(text)
    if len(text) > max_chars:
        text = text[:max_chars].rsplit(" ", 1)[0]
    return text

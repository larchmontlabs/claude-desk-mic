import text


def test_strip_fillers():
    assert text.strip_fillers("um, run the tests") == "run the tests"
    assert text.strip_fillers("hmm ok then") == "ok then"


def test_speakable():
    src = (
        "# Title\n\n```py\nprint(1)\n```\n\nSee [the docs](http://x.io/a) now.\n\n"
        "| a | b |\n|---|---|\n| c | d |\n"
    )
    out = text.speakable(src)
    assert "print" not in out
    assert "See the docs now." in out
    assert "http" not in out
    assert "a, b" in out
    assert "|" not in out


def test_speakable_cuts_on_word_boundary():
    words = "wordy " * 2000  # 12000 chars
    out = text.speakable(words)
    assert len(out) <= 8000
    assert out.endswith("wordy")

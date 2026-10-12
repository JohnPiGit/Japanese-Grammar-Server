"""
Static site builder for Japanese Grammar Study.
Processes prompts, pre-compute furigana for lessons, and bundles dist/.
"""

import json
import re
import shutil
import tomllib
from dataclasses import dataclass
from pathlib import Path
from typing import Final

import pykakasi

ROOT_DIR = Path(__file__).resolve().parent
DATA_DIR = ROOT_DIR / "data"
SRC_DIR = ROOT_DIR / "src"
DIST_DIR = ROOT_DIR / "dist"


KANJI_PATTERN: Final[re.Pattern[str]] = re.compile(r"[\u4e00-\u9faf々]")

# Lexer: Tokenize markdown elements with named capture groups
MARKDOWN_LEXER: Final[re.Pattern[str]] = re.compile(
    r"(?P<CODE_BLOCK>```[\s\S]*?```)"
    r"|(?P<INLINE_CODE>`[^`\n]+`)"
    r"|(?P<RUBY><ruby[\s\S]*?<\/ruby>)"
    r"|(?P<HTML_TAG><[^>]+>)"
    r"|(?P<LINK>\[(?P<link_text>[^\]]+)\]\((?P<link_url>[^)]+)\))"
)

# Matches continuous Japanese words containing at least one kanji
JA_KANJI_WORD: Final[re.Pattern[str]] = re.compile(
    r"[\u4e00-\u9faf々\u3040-\u309f\u30a0-\u30ff]*[\u4e00-\u9faf々]+[\u4e00-\u9faf々\u3040-\u309f\u30a0-\u30ff]*"
)

# Shared Kakasi converter instance
kakasi_converter: Final[pykakasi.kakasi] = pykakasi.kakasi()


# ---------------------------------------------------------------------------
# Data Models
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class RubySegment:
    """Represents a Japanese word split into base kanji, reading, and affixes."""

    prefix: str
    base: str
    reading: str
    suffix: str

    def to_html(self) -> str:
        """Renders the segment into semantic HTML <ruby> markup."""
        return (
            f"{self.prefix}<ruby>{self.base}<rt>{self.reading}</rt></ruby>{self.suffix}"
        )


# ---------------------------------------------------------------------------
# Okurigana Alignment Helpers
# ---------------------------------------------------------------------------


def _common_prefix_length(first: str, second: str) -> int:
    """Calculates the number of identical leading characters between two strings."""
    for index, (char_a, char_b) in enumerate(zip(first, second, strict=False)):
        if char_a != char_b:
            return index
    return min(len(first), len(second))


def _split_okurigana(orig: str, hira: str) -> RubySegment:
    """Extracts identical leading and trailing kana, isolating kanji for ruby generation."""
    # 1. Match leading kana (e.g., 'お' in 'お茶')
    pre_len = _common_prefix_length(orig, hira)
    prefix = orig[:pre_len]
    orig_body = orig[pre_len:]
    hira_body = hira[pre_len:]

    # 2. Match trailing kana (e.g., 'べる' in '食べる')
    suf_len = _common_prefix_length(orig_body[::-1], hira_body[::-1])

    base = orig_body[: len(orig_body) - suf_len]
    suffix = orig_body[len(orig_body) - suf_len :]
    reading = hira_body[: len(hira_body) - suf_len]

    return RubySegment(prefix=prefix, base=base, reading=reading, suffix=suffix)


def _token_to_ruby(orig: str, hira: str) -> str:
    """Converts a token into ruby HTML if it contains kanji."""
    if not KANJI_PATTERN.search(orig) or orig == hira:
        return orig

    return _split_okurigana(orig, hira).to_html()


# ---------------------------------------------------------------------------
# Plain Text Furigana Generator
# ---------------------------------------------------------------------------


def _convert_kanji_word(match: re.Match[str]) -> str:
    """Converts a single kanji-bearing word into ruby HTML."""
    tokens = kakasi_converter.convert(match.group(0))
    return "".join(_token_to_ruby(t["orig"], t["hira"]) for t in tokens)


def add_furigana_plain(text: str) -> str:
    """Annotates only Japanese kanji words, preserving all markdown syntax, spaces, and indentation."""
    return JA_KANJI_WORD.sub(_convert_kanji_word, text)


# ---------------------------------------------------------------------------
# Markdown Token Handler
# ---------------------------------------------------------------------------


def _handle_inline_code(match: re.Match[str]) -> str:
    """Converts Japanese inline code to <code> tags so the Markdown parser passes them safely."""
    raw_content = match.group(0)[1:-1]  # Strip enclosing backticks

    if KANJI_PATTERN.search(raw_content):
        return f"<code>{add_furigana_plain(raw_content)}</code>"

    # Standard code (e.g., `git commit`) remains backtick-fenced
    return match.group(0)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def add_furigana(text: str) -> str:
    """Scans and annotates Japanese text with furigana while respecting Markdown structure."""
    output_chunks: list[str] = []
    cursor = 0

    for match in MARKDOWN_LEXER.finditer(text):
        if match.start() > cursor:
            output_chunks.append(add_furigana_plain(text[cursor : match.start()]))

        if match.group("CODE_BLOCK"):
            output_chunks.append(match.group("CODE_BLOCK"))
        elif match.group("INLINE_CODE"):
            output_chunks.append(_handle_inline_code(match))
        elif match.group("RUBY"):
            output_chunks.append(
                match.group("RUBY")
            )  # Preserve existing ruby, prevent double wrapping
        elif match.group("HTML_TAG"):
            output_chunks.append(match.group("HTML_TAG"))
        elif match.group("LINK"):
            output_chunks.append(
                f"[{add_furigana_plain(match.group('link_text'))}]({match.group('link_url')})"
            )
        else:
            output_chunks.append(match.group(0))

        cursor = match.end()

    if cursor < len(text):
        output_chunks.append(add_furigana_plain(text[cursor:]))

    return "".join(output_chunks)


def transform_tree(node: object, transform_fn) -> object:
    """Recursively transforms string values inside nested dicts/lists."""
    if isinstance(node, dict):
        return {k: transform_tree(v, transform_fn) for k, v in node.items()}
    if isinstance(node, list):
        return [transform_tree(item, transform_fn) for item in node]
    if isinstance(node, str):
        return transform_fn(node)
    return node


def process_lessons(raw_lessons: dict) -> dict:
    """Generates a keyed structure containing 'normal' and 'furigana' variants."""
    output = {}
    for lesson_id, content in raw_lessons.items():
        output[lesson_id] = {
            "normal": content,  # Original text is already clean
            "furigana": transform_tree(content, add_furigana),
        }
    return output


def build_prompts(prompts_path: Path, dest_path: Path) -> None:
    """Converts system_prompts.toml into a browser-readable JS global."""
    with open(prompts_path, "rb") as f:
        prompts = tomllib.load(f)

    js_content = "// Generated by build.py - Do not edit manually\n"
    js_content += (
        f"window.SYSTEM_PROMPTS = Object.freeze({json.dumps(prompts, indent=2)});\n"
    )
    dest_path.write_text(js_content, encoding="utf-8")


def main() -> None:
    """Build pipeline entry point."""
    if DIST_DIR.exists():
        shutil.rmtree(DIST_DIR)
    DIST_DIR.mkdir(parents=True, exist_ok=True)

    # 1. Copy Frontend Assets
    shutil.copy2(SRC_DIR / "index.html", DIST_DIR / "index.html")
    shutil.copy2(SRC_DIR / "style.css", DIST_DIR / "style.css")
    shutil.copy2(SRC_DIR / "app.js", DIST_DIR / "app.js")

    # 2. Compile System Prompts TOML -> JS
    build_prompts(DATA_DIR / "system_prompts.toml", DIST_DIR / "prompts.js")

    # 3. Process Lessons JSON -> Normal + Furigana dist/lessons.json
    with open(DATA_DIR / "lessons.json", "r", encoding="utf-8") as f:
        raw_lessons = json.load(f)

    processed_lessons = process_lessons(raw_lessons)
    with open(DIST_DIR / "lessons.json", "w", encoding="utf-8") as f:
        json.dump(processed_lessons, f, ensure_ascii=False, indent=2)

    print("Build successful: dist/ generated.")


if __name__ == "__main__":
    main()

"""
Static site builder for Japanese Grammar Study.
Processes prompts, pre-compute furigana for lessons, and bundles dist/.
"""

import json
import re
import shutil
import tomllib
from collections.abc import Callable
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
    r"|(?P<LINK>\[(?P<link_text>[^\]]+)\]\((?P<link_url>[^)]+)\))"
    r"|(?P<HTML_TAG><[^>]+>)"
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


def add_furigana_plain(text: str) -> str:
    """Tokenizes raw Japanese text and injects furigana."""
    tokens = kakasi_converter.convert(text)
    return "".join(_token_to_ruby(t["orig"], t["hira"]) for t in tokens)


# ---------------------------------------------------------------------------
# Markdown Token Handlers (Strategy Pattern)
# ---------------------------------------------------------------------------


def _handle_code_block(match: re.Match[str]) -> str:
    """Leaves multi-line code blocks untouched."""
    return match.group(0)


def _handle_html_tag(match: re.Match[str]) -> str:
    """Leaves pre-existing HTML markup untouched."""
    return match.group(0)


def _handle_link(match: re.Match[str]) -> str:
    """Applies furigana strictly to the anchor text, preserving target URL."""
    anchor = match.group("link_text")
    url = match.group("link_url")
    return f"[{add_furigana_plain(anchor)}]({url})"


def _handle_inline_code(match: re.Match[str]) -> str:
    """Converts Japanese inline code to <code> tags so the Markdown parser passes them safely."""
    raw_content = match.group(0)[1:-1]  # Strip enclosing backticks

    if KANJI_PATTERN.search(raw_content):
        return f"<code>{add_furigana_plain(raw_content)}</code>"

    # Standard code (e.g., `git commit`) remains backtick-fenced
    return match.group(0)


TOKEN_HANDLERS: Final[dict[str, Callable[[re.Match[str]], str]]] = {
    "CODE_BLOCK": _handle_code_block,
    "INLINE_CODE": _handle_inline_code,
    "LINK": _handle_link,
    "HTML_TAG": _handle_html_tag,
}


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def add_furigana(text: str) -> str:
    """Scans and annotates Japanese text with furigana while respecting Markdown structure."""
    output_chunks: list[str] = []
    cursor = 0

    for match in MARKDOWN_LEXER.finditer(text):
        # 1. Process plain text before this match
        if match.start() > cursor:
            plain_slice = text[cursor : match.start()]
            output_chunks.append(add_furigana_plain(plain_slice))

        # 2. Dispatch the token to its specialized handler
        token_type = match.lastgroup
        if token_type and token_type in TOKEN_HANDLERS:
            output_chunks.append(TOKEN_HANDLERS[token_type](match))
        else:
            output_chunks.append(match.group(0))

        cursor = match.end()

    # 3. Process any remaining trailing plain text
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

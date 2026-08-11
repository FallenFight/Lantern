#!/usr/bin/env python3
"""
Check this project against mistakes it has already made.

Not a general linter — there is no dependency budget for one, and a generic rule
set would drown the real signal. Every check corresponds to something that
actually shipped broken, and is written up in NOTES.md. When a new trap costs
real time, add a check here.

    python3 tools/lint.py            # check the working tree
    python3 tools/lint.py <dir>      # check any extracted tree (used to prove
                                     # a check catches the commit that broke it)

Exits 1 if anything is flagged.
"""

from __future__ import annotations

import ast
import re
import sys
from pathlib import Path

# --------------------------------------------------------------------------
# code checks
# --------------------------------------------------------------------------

# Anything that changes appearance must go through applyVisual(), which mutates
# S.settings locally *before* repainting. patchSettings() only updates it once
# the server answers, so a repaint straight after paints the previous value.
VISUAL_KEYS = ("theme", "accent", "font_size", "density", "bubble_width")

LISTENER = re.compile(r"addEventListener\(\s*['\"](\w+)['\"]\s*,\s*([A-Za-z_$][\w$]*)\s*\)")


def declared_params(source: str, name: str):
    """The parameter list of `name`, or None when it cannot be found."""
    for pattern in (
        rf"(?:export\s+)?(?:async\s+)?function\s+{re.escape(name)}\s*\(([^)]*)\)",
        rf"(?:const|let|var)\s+{re.escape(name)}\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>",
    ):
        found = re.search(pattern, source)
        if found:
            return found.group(1).strip()
    return None


def check_js(root: Path) -> list:
    problems = []
    paths = sorted((root / "static" / "js").glob("*.js"))
    sources = {p: p.read_text(encoding="utf-8") for p in paths}
    combined = "\n".join(sources.values())

    for path, source in sources.items():
        # A listener is called with the Event as its first argument. Hand it a
        # function that declares a parameter and the Event *becomes* that
        # parameter — a default only applies to `undefined`. This is how the Stop
        # button silently did nothing: addEventListener('click', stopGeneration)
        # meant S.runs.get(MouseEvent).
        for event, fname in LISTENER.findall(source):
            params = declared_params(combined, fname)
            if params:
                problems.append(
                    f"{path.name}: addEventListener('{event}', {fname}) — "
                    f"{fname}({params}) takes a parameter, so the Event becomes it. "
                    f"Wrap it: () => {fname}()")

        for line_no, line in enumerate(source.split("\n"), 1):
            if "applyVisual" in line:
                continue
            match = re.search(r"patchSettings\(\{\s*(\w+)", line)
            if match and match.group(1) in VISUAL_KEYS:
                problems.append(
                    f"{path.name}:{line_no}: patchSettings({{ {match.group(1)} }}) — "
                    f"use applyVisual() so the repaint sees the new value")
    return problems


# --------------------------------------------------------------------------
# documentation checks
# --------------------------------------------------------------------------
#
# README has shipped wrong six times: a stale model name, a claim that Lantern
# never sent tools that survived a whole release, the line count three times, and
# an accent count that said nine when there had been twelve for months. A prose
# rule in CLAUDE.md did not stop any of it, because a prose rule only works if
# someone chooses to look. These fail loudly instead.
#
# The pattern is *countable things* — "N of X" in prose, with the real N in the
# code. Every check below is one of those.

COUNT_WORDS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6,
               "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11,
               "twelve": 12}
NUMBER_WORDS = {v: k for k, v in COUNT_WORDS.items()}

# `build-app.sh` and `lantern` were missing, so the count excluded ~280 lines of
# real shipping logic and the README could claim "under 10,000" while a reader
# counting the same way as `wc` got 10,044. If it ships, it counts.
COUNTED_SOURCES = ("server.py", "static/js", "static/css", "static/index.html",
                   "native", "tools", "build-app.sh", "lantern")


def server_literal(root: Path, name: str):
    """Pull a literal assignment out of server.py without importing it."""
    tree = ast.parse((root / "server.py").read_text(encoding="utf-8"))
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(
                isinstance(t, ast.Name) and t.id == name for t in node.targets):
            try:
                return ast.literal_eval(node.value)
            except ValueError:
                return None
    return None


def registered_tools(root: Path) -> list:
    """Top-level keys of the TOOLS registry, by position in the file."""
    source = (root / "server.py").read_text(encoding="utf-8")
    tree = ast.parse(source)
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(
                isinstance(t, ast.Name) and t.id == "TOOLS" for t in node.targets):
            return [k.value for k in node.value.keys if isinstance(k, ast.Constant)]
    return []


def theme_palette(root: Path):
    """
    What `theme.js` actually declares: accent count, theme labels, dark/light
    split. Regex rather than a parser because there is no JS parser in the
    stdlib, and these two arrays are hand-written literals that have never been
    anything more complicated.
    """
    path = root / "static" / "js" / "theme.js"
    if not path.is_file():
        return None
    source = path.read_text(encoding="utf-8")
    accents = re.search(r"ACCENTS\s*=\s*\[(.*?)\]", source, re.S)
    themes = re.search(r"THEMES\s*=\s*\[(.*?)\n\];", source, re.S)
    if not accents or not themes:
        return None
    flags = re.findall(r"dark:\s*(true|false)", themes.group(1))
    return {
        "accents": len(re.findall(r"['\"]([\w-]+)['\"]", accents.group(1))),
        "labels": re.findall(r"label:\s*['\"]([^'\"]+)['\"]", themes.group(1)),
        "dark": flags.count("true"),
        "light": flags.count("false"),
    }


def source_line_count(root: Path) -> int:
    total = 0
    for rel in COUNTED_SOURCES:
        target = root / rel
        if target.is_file():
            total += len(target.read_text(encoding="utf-8", errors="replace").split("\n"))
        elif target.is_dir():
            for path in sorted(target.rglob("*")):
                if path.is_file() and path.suffix in (".py", ".js", ".css", ".html", ".swift"):
                    total += len(path.read_text(encoding="utf-8", errors="replace").split("\n"))
    return total


def check_docs(root: Path) -> list:
    problems = []
    readme_path = root / "README.md"
    if not readme_path.is_file():
        return ["README.md is missing"]
    readme = readme_path.read_text(encoding="utf-8")

    # 1. Every registered tool must be named in the README, and the count word
    #    beside "ship" must match. README claimed one tool for a whole release
    #    after there were two.
    tools = registered_tools(root)
    for name in tools:
        if name not in readme:
            problems.append(f"README.md: tool `{name}` is registered in server.py "
                            f"but never mentioned")
    # Scope the count to the Tools section — "Five ship (Default, Terse, …)" in
    # the Personas section is a different, correct claim. Flatten whitespace
    # first: the claim wraps as "… cannot know. Three\nship so far", so anything
    # line-based misses it.
    tools_section = re.search(r"## Tools\n(.*?)(?=\n## )", readme, re.S)
    if tools_section and tools:
        flat = re.sub(r"\s+", " ", tools_section.group(1))
        for sentence in re.findall(r"[^.]*\bships?\b[^.]*", flat, re.I):
            for token in re.findall(r"\b([A-Za-z]+|\d+)\b", sentence):
                count = (int(token) if token.isdigit()
                         else COUNT_WORDS.get(token.lower()))
                if count is None:
                    continue
                if count != len(tools):
                    problems.append(
                        f"README.md: the Tools section says \"{token}\" but "
                        f"{len(tools)} tools are registered "
                        f"({', '.join(tools)})")
                break

    # 2. A default quoted in prose must equal the real default. num_ctx had five
    #    stale references when it changed from 8192.
    params = (server_literal(root, "DEFAULT_SETTINGS") or {}).get("default_params", {})
    num_ctx = params.get("num_ctx")
    if num_ctx:
        for rel in ("README.md", "static/js/modals.js"):
            target = root / rel
            if not target.is_file():
                continue
            text = target.read_text(encoding="utf-8")
            quoted = set(re.findall(r"default (\d{4,6})", text))
            quoted |= set(re.findall(r"(\d{4,6}) default", text))
            for value in quoted:
                if int(value) != num_ctx:
                    problems.append(f"{rel}: quotes a default of {value}, but "
                                    f"num_ctx is {num_ctx}")

    # 3. The line count has now gone stale three times, and the third was this
    #    check's own fault: the claim was reworded to "about 10,000 lines of
    #    source", which matches neither pattern below, so the check quietly
    #    passed on a sentence it could not see. A check that only fires on the
    #    exact phrasing it was written for is a check you will edit your way out
    #    of by accident. So the claim is now *required* to exist in a shape this
    #    can hold, must be true, and must be tight enough to mean something —
    #    "under 1,000,000 lines" is not a claim.
    actual = source_line_count(root)
    if re.search(r"~\s?[\d,]{4,7}\s+lines", readme):
        problems.append("README.md: states a precise line count, which goes stale "
                        "every release. Use a bound like \"under 11,000 lines\"")
    bound = re.search(r"[Uu]nder ([\d,]{3,7}) lines", readme)
    if not bound:
        problems.append(
            f"README.md: no line-count claim this can check. Write it as "
            f"\"under N lines\" — the source is {actual:,}. Any other wording "
            f"passes silently, which is how it went stale before. If the claim "
            f"is gone for good, delete this check rather than leaving it blind")
    else:
        limit = int(bound.group(1).replace(",", ""))
        if actual >= limit:
            problems.append(f"README.md: claims under {limit:,} lines, but the "
                            f"source is now {actual:,}")
        elif limit > actual * 1.3:
            problems.append(f"README.md: claims under {limit:,} lines while the "
                            f"source is {actual:,} — a bound that loose says "
                            f"nothing. Tighten it")

    # 4. Every internal doc link must resolve. Two docs were deleted this
    #    session and nothing but a manual grep checked for danglers.
    for path in sorted(root.glob("*.md")):
        text = path.read_text(encoding="utf-8")
        for target in re.findall(r"\]\(([^)#]+\.md)\)", text):
            if not (root / target).is_file():
                problems.append(f"{path.name}: links to {target}, which does not exist")

    # 5. Countable claims about the palette. The README said "nine accents"
    #    while there had been twelve for months, because nobody re-counts prose.
    #    Same shape as the tool count above, and the same failure.
    palette = theme_palette(root)
    appearance = re.search(r"## Appearance\n(.*?)(?=\n## |\n---)", readme, re.S)
    if palette and appearance:
        flat = re.sub(r"\s+", " ", appearance.group(1))
        for word, actual, noun in (
            ("accents", palette["accents"], "accents"),
            ("themes", palette["dark"] + palette["light"], "themes"),
            ("dark", palette["dark"], "dark themes"),
            ("light", palette["light"], "light themes"),
        ):
            found = re.search(rf"\b([A-Za-z]+|\d+)\s+{word}\b", flat)
            if not found:
                continue
            token = found.group(1)
            claimed = int(token) if token.isdigit() else COUNT_WORDS.get(token.lower())
            if claimed is not None and claimed != actual:
                problems.append(
                    f"README.md: the Appearance section says \"{token} {word}\" but "
                    f"theme.js declares {actual} {noun} "
                    f"({NUMBER_WORDS.get(actual, actual)})")
        # A renamed theme is the same class of drift as a renamed tool.
        for label in palette["labels"]:
            if label not in readme:
                problems.append(f"README.md: theme \"{label}\" is declared in "
                                f"theme.js but never named")

    # 6. A tracked source file nobody documented. Basenames only — the Layout
    #    block is an indented tree, not full paths.
    layout = re.search(r"## Layout\n+```\n(.*?)```", readme, re.S)
    if layout:
        listed = layout.group(1)
        for path in sorted((root / "static" / "js").glob("*.js")):
            if path.name not in listed:
                problems.append(f"README.md: {path.name} is not in the Layout block")
        for path in sorted((root / "tools").glob("*.py")):
            if path.name not in listed:
                problems.append(f"README.md: tools/{path.name} is not in the Layout block")
    return problems


def main() -> int:
    root = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else \
        Path(__file__).resolve().parent.parent
    problems = check_js(root) + check_docs(root)

    for problem in problems:
        print(f"  {problem}")
    if problems:
        print(f"\n{len(problems)} problem(s). See 'Before you ship' in NOTES.md.")
        return 1
    print(f"clean — code and docs consistent ({root.name})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""
Check the front end against traps this project has already been bitten by.

Not a general linter — there is no dependency budget for one, and a generic rule
set would drown the real signal. Every check here corresponds to a bug that
actually shipped, and is documented in NOTES.md. When a new trap costs real time,
add a check.

    python3 tools/lint.py            # exits 1 if anything is flagged
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

JS = sorted((Path(__file__).resolve().parent.parent / "static" / "js").glob("*.js"))

# Anything that changes appearance must go through applyVisual(), which mutates
# S.settings locally *before* repainting. patchSettings() only updates it once the
# server answers, so a repaint straight after paints the previous value.
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


def main() -> int:
    problems = []
    sources = {path: path.read_text(encoding="utf-8") for path in JS}
    combined = "\n".join(sources.values())

    for path, source in sources.items():
        # 1. A listener is called with the Event as its first argument. Hand it a
        #    function that declares a parameter and the Event *becomes* that
        #    parameter — a default value only applies to `undefined`. This is how
        #    the Stop button silently did nothing for months:
        #    addEventListener('click', stopGeneration) meant
        #    S.runs.get(MouseEvent).
        for event, fname in LISTENER.findall(source):
            params = declared_params(combined, fname)
            if params:
                problems.append(
                    f"{path.name}: addEventListener('{event}', {fname}) — "
                    f"{fname}({params}) takes a parameter, so the Event becomes it. "
                    f"Wrap it: () => {fname}()"
                )

        # 2. A visual setting persisted without the optimistic local update.
        for line_no, line in enumerate(source.split("\n"), 1):
            if "applyVisual" in line or "function applyVisual" in line:
                continue
            match = re.search(r"patchSettings\(\{\s*(\w+)", line)
            if match and match.group(1) in VISUAL_KEYS:
                problems.append(
                    f"{path.name}:{line_no}: patchSettings({{ {match.group(1)} }}) — "
                    f"use applyVisual() so the repaint sees the new value"
                )

    for problem in problems:
        print(f"  {problem}")
    if problems:
        print(f"\n{len(problems)} problem(s). See 'Before you ship' in NOTES.md.")
        return 1
    print(f"clean — {len(sources)} files, {len(LISTENER.findall(combined))} bare listeners checked")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

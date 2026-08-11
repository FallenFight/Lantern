# Lantern — working notes for Claude

A local chat interface for Ollama: Python 3 stdlib server, vanilla ES modules, no
build step. **`NOTES.md` holds the reasoning, the rejected approaches, and the
traps that cost real time — read it before changing anything structural.**
`README.md` is the user-facing manual and is kept accurate against the code.

## Hard constraints

- **Zero dependencies.** Python 3 standard library on the server, plain ES
  modules on the front end. No npm, no build step, no CDN, no libraries.
- **`server.py` stays Python 3.9-compatible**, so the app can fall back to the
  `/usr/bin/python3` that ships with macOS. No `match`, no `X | Y` at runtime.
- **Offline by default.** The only network call is to the local Ollama. Anything
  that changes that is opt-in and gets raised first. There is exactly one
  exception so far — the update check added in 1.0.3, off by default and gated
  **on the server** so the switch is the only thing that can produce a request.
  See `NOTES.md` → *The update check*. A second one needs the same conversation.
- **The same-origin guard in `server.py` stays.** Don't loosen it.

## Data safety

Real chats are plain JSON in `~/Library/Application Support/Lantern/chats/`.
They have gone missing twice.

- Back up before touching anything storage-related:
  `cp -R ~/Library/Application\ Support/Lantern ~/lantern-backup-$(date +%F)`
- Never run a cleanup that deletes by `message_count == 0` without showing what
  it matched first.
- `POST /api/restore` defaults to merge, which never overwrites. Keep it that way.

## How to work here

- **Verify by running things, not from memory.** If a measurement looks absurd,
  check the measurement before reporting it.
- **Verify the trigger, not just the mechanism.** If it has a button, click the
  button. Three bugs shipped because the code was read and the app was never
  operated — the abort path was traced and correct while the Stop button that
  called it had never once been clicked.
- Small, always-shippable increments: build, verify, install, then move on.
- Say plainly when something didn't work, or is reasoned rather than observed.
- **Every feature or major change includes a docs pass.** Re-read `README.md`,
  `NOTES.md` and this file and update whatever the change made untrue — it is part
  of the change, not follow-up work. `README.md` is a promise to users and has
  been wrong before (a stale model name, a line count off by 750, a claim that
  tools were never sent). If a change adds a trap or a rejected approach, it goes
  in `NOTES.md` while the reasoning is still fresh.
- Prefer fewer, better-targeted checks over exhaustive ones — but never fewer
  *verified* claims. One decisive test beats five exploratory ones.

## Before finishing

Both run automatically on every commit, once per clone:

```bash
git config core.hooksPath tools/hooks
```

To run them by hand:

```bash
python3 tools/lint.py                      # traps that have bitten us, plus
                                           # doc claims checked against the code
/usr/bin/python3 -m py_compile server.py   # the 3.9 fallback must keep working
```

`tools/lint.py` verifies what prose cannot be trusted to. **The pattern it exists
for is countable things** — "N of X" in prose with the real N in the code, which
is how README shipped wrong six times. It checks: every registered tool is named
in the README and the count matches; accent count, theme count, the dark/light
split and every theme name against `theme.js`; the line-count claim, which must
exist in a checkable shape, be true, and be tight; quoted defaults equal the real
ones; doc links resolve; and no file is missing from the Layout block.

**Anything you add to the README of the form "N of X" needs a check here, or it
should not be a number.** Softening the wording is not a fix — that is exactly
how the line count went stale a third time, by being reworded into a shape the
check could not see.

Then the click-through list in `NOTES.md` → **Before you ship**. It is two
minutes and it catches the class of bug that reading code does not.

## Picking up where the last session left off

`NOTES.md` → **Where things stand** has the current version, what shipped, and
the next release with its design already worked out. `NOTES.md` → **Still open**
is the ranked backlog, and **Decisions that were considered and rejected** exists
so nobody re-proposes something that was already ruled out — check it before
suggesting a feature.

## Running it

`./build-app.sh` then `open dist/Lantern.app`, or `python3 server.py --open` for
a browser at <http://127.0.0.1:8777>.

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
  that changes that is opt-in and gets raised first.
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
- Usage credits are a real constraint: fewer, better-targeted checks, not fewer
  verified claims.

## Before finishing

```bash
python3 tools/lint.py                      # traps that have already bitten us
/usr/bin/python3 -m py_compile server.py   # the 3.9 fallback must keep working
```

Then the click-through list in `NOTES.md` → **Before you ship**. It is two
minutes and it catches the class of bug that reading code does not.

## Running it

`./build-app.sh` then `open dist/Lantern.app`, or `python3 server.py --open` for
a browser at <http://127.0.0.1:8777>.

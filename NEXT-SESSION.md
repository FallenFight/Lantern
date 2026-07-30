# Starting a new session

Copy everything in the box below and paste it as your first message.

---

```
I'm continuing work on Lantern, a local chat interface for Ollama that lives in
this folder. Before doing anything, read NOTES.md and README.md — NOTES.md has
the design decisions, rejected approaches, and the traps that already cost time,
and README.md is the feature manual (verified accurate against the code).

Hard constraints, please don't break them:
- Zero dependencies. Python 3 standard library on the server, plain ES modules
  on the front end. No npm, no build step, no CDN, no libraries.
- server.py must stay Python 3.9-compatible so the app can fall back to the
  /usr/bin/python3 that ships with macOS. Check with
  `/usr/bin/python3 -m py_compile server.py` before you finish.
- Offline by default. The only network call is to my local Ollama. Anything
  that changes that needs to be opt-in and flagged to me first.
- Same-origin request guard in server.py stays. Don't loosen it.

Data safety — this matters, my chats went missing twice during development:
- Real chats live in ~/Library/Application Support/Lantern/chats/ as plain JSON.
- Take a backup before touching anything storage-related:
  curl -s http://127.0.0.1:PORT/api/backup > ~/lantern-backup.json
- Never run cleanup that deletes by message_count == 0 without showing me what
  it matched first.

How I like to work:
- Verify claims by running things, don't assert from memory. If you measure
  something and the number looks absurd, check the measurement before
  reporting it.
- Small, always-shippable increments. Build, verify, install, then move on.
- Tell me plainly when something didn't work or you're unsure.

To run it: ./build-app.sh then open dist/Lantern.app, or `python3 server.py
--open` for a browser at 127.0.0.1:8777.

Here's what I'd like to work on:
[ describe your task here ]
```

---

## What's on the list

Pick one and put it in the last line of the prompt.

**1. Tool calling** — the highest-value next feature. Build in this order:
- Tool registry + schema plumbing + a date tool *(shippable alone; the first
  tool is ~60% of the work for all three)*
- Chat-history search — `search_chats()` already exists in `server.py`, so this
  is close to free
- Calculator using `ast` with a node whitelist. **Never `eval()`** — that's
  arbitrary code execution driven by model output

Only `qwen3.5-9b` of the installed models advertises tools, so test there and
keep any manual-trigger path working for the gemmas.

**2. Web search** — start with a URL reader (fetch a page, extract readable
text, drop it into context). No key, no dependency, keeps the app offline until
you paste a link. Add SearXNG on localhost later if you want real querying; it
fits this project better than an API key.

**3. UI polish** — the ambient wash is weaker than the Gemini reference it was
based on; the Settings segmented controls still want the sliding lens treatment
the sidebar has; light themes have had far less attention than dark.

## Starting the session

```bash
cd ~/"LLM Project"
claude
```

Then paste the prompt.

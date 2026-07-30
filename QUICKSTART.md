# Quick start

Lantern is a local chat app for [Ollama](https://ollama.com). Nothing leaves
your machine.

## 1. Get Ollama and a model

```bash
brew install ollama          # or download from ollama.com
ollama pull qwen3.5:8b       # any model works; this one can reason
```

## 2. Run Lantern

**macOS — build the app once, then use it like any other app:**

```bash
./build-app.sh
cp -R dist/Lantern.app /Applications/
```

Launch it from Launchpad or Spotlight. It starts Ollama for you if it isn't
already running.

**Anything else — run it from a terminal:**

```bash
python3 server.py --open
```

Opens <http://127.0.0.1:8777>. Works in any browser.

That's it. No `npm install`, no build step, no dependencies — Python 3's
standard library and plain JavaScript.

## 3. First things to try

| | |
|---|---|
| **⌘K** | Command palette — everything lives here |
| **Think pill** | Extended reasoning, on models that support it |
| **Persona pill** | Swap system prompts. Try *Terse* |
| **⌘F** | Find in the current chat (**⌘⇧F** searches every chat) |
| **⌘,** | Settings — themes, accents, sampling |

Two worth turning on straight away, in **Settings → Performance**:

- **Keep models loaded** — otherwise Ollama drops the model after a few idle
  minutes and your next message waits ~6s for a reload.
- **Preload on launch** — loads your default model at startup.

## 4. Back up your chats

**Settings → Back up everything** writes one JSON with every chat, persona, and
setting. Restore offers *merge* (never overwrites) or *replace*.

Chats are plain JSON in `~/Library/Application Support/Lantern/chats/` — you can
read, diff, or copy them with ordinary tools.

## Troubleshooting

**"Can't reach Ollama"** — start it with `ollama serve`, then hit Retry in the
banner.

**No models listed** — `ollama pull <name>`, or use the Models panel to pull one.

**Replies are slow to start** — that's the model loading. Turn on *Keep models
loaded*.

**Answers are looping or dull** — open Parameters (⌘K → "Parameters"). Raise
temperature for writing, lower it for code. The built-in **settings guide**
(⌘K → "Settings guide") explains every value and whether it's worth changing.

**Context filling up** — the gauge under the composer turns red past 90%. Your
model probably supports far more than the 8192 default; Parameters → Context
window → **Max** reads its real limit.

---

Full documentation: [README.md](README.md).
Design decisions and gotchas: [NOTES.md](NOTES.md).

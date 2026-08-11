# Lantern

A lean local chat interface for [Ollama](https://ollama.com). One screen, no
account, no telemetry, no menus you'll never open.

- **Zero dependencies.** Python 3 standard library on the back, plain ES modules
  on the front. No `npm install`, no build step, no bundler, no Electron.
- **No browser.** The Mac app is a real `NSWindow` + `WKWebView` with a 144 KB
  native host. The whole bundle is about 1 MB, half of which is the icon.
- **Everything is a file.** Chats, personas, and settings are readable JSON.
  Back it up with `cp`, diff it with `git`, delete it with `rm`.
- **Offline.** Out of the box the only network call is to your local Ollama. No
  CDNs — the markdown renderer, syntax highlighter, and maths renderer are
  written from scratch. There is exactly one thing that can reach further, it is
  **off until you turn it on**, and it is named below.

See [`NOTES.md`](NOTES.md) for design decisions, rejected approaches, and traps.

---

## Install

**You build it yourself — there's no download, on purpose.** Signing a Mac app so
macOS trusts it off the internet needs a paid Apple Developer account. Without
one, a downloaded `.app` is quarantined and macOS calls it *"damaged"*, which is
both alarming and wrong. Building locally skips that entirely, and it's one
command.

Requirements: **macOS 11 or later**, the Xcode command line tools
(`xcode-select --install`) for the native window, and Python 3 — macOS already
ships one, and `server.py` is kept compatible with it.

You also need [Ollama](https://ollama.com) and at least one model:

```bash
brew install ollama    # or download from ollama.com
ollama pull <model>    # anything from ollama.com/library
```

A model supporting **tools** and **thinking** unlocks the most of Lantern. Don't
trust `ollama list` on capabilities — it under-reports both; the Models panel
(⌘M) shows what Lantern detects directly.

### As a Mac app (recommended)

```bash
./build-app.sh
cp -R dist/Lantern.app /Applications/
```

Then launch it from Launchpad or Spotlight. Own icon, own Dock entry.

**No browser is involved.** The bundle contains a native host (`native/main.swift`)
that puts a `WKWebView` in an `NSWindow` and runs `server.py` as a child process.
It links only system frameworks. Launching it starts Ollama if needed, has the
server bind an ephemeral port and report it back, and loads the UI.

Because a native webview has none of a browser's built-in behaviour, the host
wires up what the app actually uses: `confirm()` / `prompt()` dialogs, the
`<input type=file>` picker, downloads so **Export** works, and external links
routed to your real browser. The menu bar deliberately leaves ⌘M, ⌘R, ⌘P, ⌘F,
⌘S and ⌘, unbound so the web app keeps those shortcuts.

Quitting stops the server, enforced twice: the host kills the child on exit
(including on `SIGTERM`/`SIGINT`/`SIGHUP`), and the server independently exits
if it finds itself reparented — covering a crash or `SIGKILL`.

The bundle carries no Python of its own. It finds one on the machine, preferring
Homebrew or python.org and falling back to the `/usr/bin/python3` that ships
with macOS; `server.py` is kept 3.9-compatible so that fallback always works.

If `swiftc` is unavailable, `build-app.sh` falls back to a shell launcher that
opens a Chromium browser in `--app` mode, or your default browser.

App data lives in `~/Library/Application Support/Lantern`, so replacing the app
never touches your history. Logs go to `lantern.log` beside it.

### Updating

Same shape as installing — pull, rebuild, replace:

```bash
git pull
./build-app.sh
rm -rf /Applications/Lantern.app
cp -R dist/Lantern.app /Applications/
```

**The `rm -rf` matters.** `cp -R` onto an existing `.app` *merges* into it, so
files a newer version no longer ships stay behind inside the bundle. Removing it
first gives you exactly the new build. Quit Lantern before you swap it.

Your chats, personas and settings are untouched: they live in
`~/Library/Application Support/Lantern`, outside the bundle, and the build script
only seeds that folder when it does not already exist.

The version is shown under the sidebar buttons and in **Settings → About**. If
you want the app to tell you when a release has happened, turn on
[**Check for updates**](#the-one-call-that-leaves-your-machine) — it is off by
default, and it is the only thing in Lantern that talks to anything but your own
Ollama.

### From a terminal

```bash
./lantern
```

Starts Ollama if needed, then opens <http://127.0.0.1:8777>. It shares the app's
history rather than creating a second one. Or drive the server directly:

```bash
python3 server.py --port 8777 --open
```

| Environment variable | Default                  | Purpose                |
| -------------------- | ------------------------ | ---------------------- |
| `OLLAMA_HOST`        | `http://127.0.0.1:11434` | Where Ollama listens   |
| `LANTERN_DATA`       | `./data`                 | Where chats are stored |
| `LANTERN_PORT`       | `8777`                   | Default port           |
| `LANTERN_VERBOSE`    | unset                    | Log every HTTP request |

Nothing binds beyond localhost unless you pass `--host 0.0.0.0`.

### First things to try

| | |
|---|---|
| **⌘K** | Command palette — everything lives here |
| **Tools pill** | Lets the model read the real clock. Ask "what time is it in Tokyo?" |
| **Think pill** | Extended reasoning, on models that support it |
| **Persona pill** | Swap system prompts. Try *Terse* |
| **⌘F** | Find in this chat (**⌘⇧F** searches every chat) |
| **⌘,** | Settings — themes, accents, sampling |

Two worth turning on immediately, in **Settings → Performance**: **Keep models
loaded** (otherwise Ollama drops the model after a few idle minutes and your next
message waits ~6s for a reload) and **Preload on launch**.

---

## Chat

Token-by-token streaming. **Stop** actually aborts the run upstream rather than
just hiding output. Regenerate, regenerate **with a different model**, edit and
resend, delete a single message, branch a new chat from any point, duplicate a
chat, and retry a failed reply in place.

Chats run **independently** — start a long reply in one, switch away, start
another, and each writes only to its own conversation. A pulsing dot marks any
chat that's mid-reply.

## Comparing models

Any reply can be answered again by a different model **without losing the first**.
The turn grows a pager — `‹ 2/2 › qwen3.5-9b` — that switches which answer the
conversation actually uses, and each answer keeps its own metrics. So you see the
trade, not just the text: a 12B taking 8.9s to first token at 12.4 tok/s against a
9B at 4.3s and 13.8 tok/s.

Generation is **sequential**, one model at a time, and that is deliberate rather
than a limitation. Two loaded models is roughly 14.6 GB on a 16 GB machine —
running them at once would evict one mid-answer or drive the machine into swap.

**Tools and comparison don't mix, in both directions.** A turn that called tools
can't be compared — its results live in separate rows underneath, so swapping the
answer would leave the wrong ones there. And a comparison itself runs with **no
tools offered**, even in a chat that has them on: an answer lives inside one
message, while a tool exchange is an assistant turn plus a row per result, and
there is nowhere in a stored answer to keep them. Lantern says so with a toast
rather than quietly comparing two different kinds of reply.

A comparison that produces nothing — you stop it, or the model errors or returns
an empty reply — puts the previous answer back untouched and reports the failure.
The point of the feature is not losing the first answer.

## Thinking

The **Think** pill appears for models that can reason. Reasoning streams into a
collapsible, timed panel above the answer. A caret on the pill sets effort
(off / on / low / medium / high).

Capability detection is deliberately not naive, because Ollama under-reports it
in both directions — `/api/tags` claims `qwen3.5` is completion-only, and
`gemma-4` advertises no thinking yet honours `think` fully. So Lantern reads
`/api/show`, **omits** the `think` field for models that don't advertise it
(sending `think:false` would suppress the very output needed to find out), and
records any model it catches reasoning. Those show **`THINK*`** rather than
`THINK`. Full reasoning in [`NOTES.md`](NOTES.md).

Effort levels can't be detected per model — Ollama exposes nothing — so they're
offered for all of them. Models built for it honour the level; others treat any
level as plain on.

## Tools

The **Tools** pill lets a model call into Lantern for facts it cannot know. Three
ship so far:

- **`current_datetime`** — reads this machine's clock, in any IANA timezone. Ask
  for the time in Tokyo and you get the real answer, not a guess frozen at
  training time.
- **`search_chats`** — full-text search across your saved conversations, so
  "what did I conclude about X?" can be answered from what you actually said.
  It returns titles, dates and short excerpts, never whole conversations.
- **`calculate`** — exact arithmetic. Models get long multiplication and
  percentages subtly wrong; this evaluates the expression properly. It parses
  with Python's `ast` and walks the tree by hand against a whitelist — never
  `eval()`, which would be arbitrary code execution driven by model output.

**A tool answer is only as good as what the model asks it.** A model may still
state a figure it never computed — asked for `4871 × 3928 ÷ 7`, one model
calculated the whole expression correctly and then invented the intermediate
product in its prose. Every call is shown in the thread with its exact
expression and result, so you can check what was actually computed against what
was claimed. Expand the tool row when a number matters.

**`search_chats` lets the model read any saved chat, not just the open one.** It
only runs when you have Tools on and the model chooses to call it, every call is
visible in the thread with its exact arguments and results, and nothing leaves
your machine — but it is worth knowing before you switch tools on.

Off by default — the schemas cost prompt tokens on every turn. Turn it on per
chat from the pill, or for every new chat in Settings → Behaviour. The caret
lists what the model may call. On a new chat with a tools-capable model, the
empty screen offers it directly, since a feature that starts off is a feature
nobody finds.

Each call appears in the thread as a collapsed row: the tool, a one-line summary,
and how long it took. Expand it to see the exact arguments and the exact JSON
returned, so nothing the model was told is hidden from you.

Tools run **on this machine, in the server process, read-only** — no shell, no
file writes, no network. The client asks for tools by name and `server.py`
supplies the schema from its own registry, so the front end can never describe a
callable the server cannot run. A reply is capped at four rounds of calls; past
that the model is asked once more with no tools attached so the turn still ends
in an answer.

Capability detection has the same flaw as thinking: `/api/tags` claims none of
the installed models support tools while `/api/show` correctly reports all three.
Lantern reads `/api/show`. Details in [`NOTES.md`](NOTES.md).

## Prompt library

Prompts you reuse, saved and inserted in one action. **Not personas** — a persona
is the *system* prompt and shapes the whole conversation; a saved prompt is the
thing you type, for one turn. Use both together.

⌘K, type a few letters of the name, and it drops into the composer at the cursor.
Manage them from ⌘K → *Prompt library*. Four are seeded so the feature shows what
it is for; delete them if they are not yours.

## Personas

Named system prompts, switchable from the toolbar, ⌘P, or the palette. Each can
pin its own model, thinking setting, and sampling overrides. Five ship (Default,
Terse, Engineer, Socratic Tutor, Editor), all editable, with JSON import/export.

Precedence is **global defaults → persona → this chat**. Editing the system
prompt in Parameters overrides the persona for that chat only; *Reset overrides*
puts it back.

## Formatting

Tables with alignment, nested and ordered lists, task lists, blockquotes, inline
code, and fenced code blocks with per-language highlighting, a line count, copy,
and soft-wrap.

**Maths**: a LaTeX subset covering what models actually emit — `$…$`, `$$…$$`,
`\(…\)`, `\[…\]`, fractions, `^`/`_`, `\sqrt`, `\text`, and ~90 symbols. Unknown
commands render as literal text rather than vanishing. Currency like `$5 and $10`
is not mistaken for maths.

Raw HTML in a reply is escaped, never executed; `javascript:` and `data:` URLs
are neutralised.

Small quantised models sometimes emit a stray closing tag — a bare
`</blockquote>` at the end of an otherwise fine answer. Those are dropped **from
the display only**, and only when nothing opened them: markup inside code, and
any closing tag that has a matching opener, is left exactly as written. The
stored message is never altered, so turning off *Render markdown* shows precisely
what the model produced.

## Organisation

Auto-generated titles, pin to top, **archive**, date grouping, rename, duplicate.
**Find in chat** (⌘F) highlights every hit with ⏎/⇧⏎ to step; **search all chats**
(⌘⇧F) is full-text across every message on disk.

Export one chat as Markdown or JSON, or **back up everything** — all chats,
personas, and settings in a single file. Restore offers merge (never overwrites
an existing chat) or replace.

## Models

Pull with a live progress bar, delete, unload, and preload. Capability chips for
thinking, vision, and tool calling. Shows size, quantisation, context length, and
resident VRAM for loaded models.

**Keep models loaded** (Settings → Performance) stops Ollama evicting a model
after a few idle minutes, which otherwise makes the next message pay a full
reload — measured at ~6 seconds. **Preload on launch** does it at startup.

## Parameters

Temperature, top-p, top-k, **min-p**, repeat penalty, `num_ctx` (with a **Max**
button that reads the model's trained context), `num_predict`, seed, and **stop
sequences** — per chat, per persona, or globally. Advanced escape hatches for
`num_gpu` / `num_thread` / `num_batch`; blank means "let Ollama decide".

A built-in **settings guide** explains what each value does and whether it's
worth changing — ⌘K → "Settings guide", the `?` beside Sampling, or Settings →
About.

A live context gauge sits under the composer and turns red past 90%.

## Metrics

Tokens per second, **time to first token**, in/out token counts, wall time, and
thinking duration under each reply. Resident VRAM per loaded model.

## Appearance

Six themes — four dark (Lantern, Midnight, Cyber, Carbon), two light (Paper,
Mist) — or follow the system. Twelve accents, adjustable text size, message
width, and density. Every accent works on every theme. Translucency is limited to
the chrome so the message list stays at full frame rate;
`prefers-reduced-transparency` and `prefers-reduced-motion` are both honoured.

---

## Troubleshooting

**"Can't reach Ollama"** — start it with `ollama serve`, then hit Retry in the
banner.

**No models listed** — `ollama pull <name>`, or pull one from the Models panel.

**No Tools pill** — the model doesn't advertise tool calling; check for a `TOOLS`
chip in the Models panel (⌘M). Tools are off by default in a new chat: turn them
on from the pill, or for every new chat in Settings → Behaviour.

**Replies slow to start** — that's the model loading. Turn on *Keep models loaded*.

**Answers looping or dull** — open Parameters (⌘K → "Parameters"). Raise
temperature for writing, lower it for code. The built-in **settings guide**
(⌘K → "Settings guide") explains every value and whether it's worth changing.

**Context filling up** — the gauge under the composer turns red past 90%. Your
model probably supports far more than the 32768 default; Parameters → Context
window → **Max** reads its real limit.

---

## Security

The server refuses anything a browser on another site could forge. Without this,
a cross-origin `POST` with `Content-Type: text/plain` needs no CORS preflight and
went straight through — any site you visited while Lantern ran could have deleted
your Ollama models.

- Non-loopback `Host` rejected (DNS rebinding)
- `Sec-Fetch-Site: cross-site` / `same-site` rejected
- Non-loopback `Origin` rejected; requests with **no** Origin still pass, so curl
  and scripts work
- `OPTIONS` returns 403 with no CORS headers, so preflights fail correctly
- 64 MB request-body cap; allow-list on options forwarded to Ollama
- Tool schemas come from the server's own registry, never from the client, and
  only registered tools can run
- Settings writes are type-checked — a malformed value used to make the app fail
  to boot
- Path traversal returns 404; chat ids are regex-validated on every write path

Chats are stored unencrypted by design. FileVault already encrypts the disk, and
plain files are what allowed hand-recovery when things went wrong.

### The one call that leaves your machine

**Settings → About → Check for updates**, off by default. Switched on, Lantern
asks GitHub once per launch whether a newer release exists, and shows the answer
next to the version in the sidebar. Nothing else changes and nothing is sent —
it is an anonymous read of the public releases list, with no account, no token
and no identifier beyond a `Lantern/<version>` user agent.

Two details worth knowing, because "it only talks to GitHub" is a claim you
should be able to check:

- The switch is enforced **on the server**, not just in the interface. With it
  off, `GET /api/update` returns `{"enabled": false}` and makes no outbound
  request at all — so nothing driving the API can cause one either.
- Nothing in GitHub's reply is trusted beyond three integers. The release tag is
  matched against `v1.2.3` exactly, and the link you click is **rebuilt** from
  those numbers rather than taken from the response.

Leave it off and Lantern behaves exactly as it did before the feature existed:
the version still shows in the sidebar and in Settings, it just never asks
anyone whether it is current.

---

## Keyboard

| | | | |
|-|-|-|-|
| `⌘K` | Command palette | `⌘N` | New chat |
| `⌘F` | Find in this chat | `⌘⇧F` | Search all chats |
| `⌘P` | Personas | `⌘⇧P` | Switch persona |
| `⌘M` | Models | `⌘,` | Settings |
| `⌘⇧L` | Cycle theme | `⌘⇧T` | Toggle thinking |
| `⌘R` | Regenerate | `⌘⇧E` | Edit last message |
| `⌘S` | Export markdown | `⌘B` | Toggle sidebar |
| `⌘/` | Shortcut list | `Esc` | Stop / close |
| `Enter` | Send | `⇧Enter` | Newline |
| `/` | Focus composer | | |

On Linux and Windows, `Ctrl` replaces `⌘`.

---

## Layout

```
server.py            stdlib HTTP server: Ollama proxy, JSON storage, guard,
                     tool registry (add a tool = one entry in TOOLS)
native/main.swift    NSWindow + WKWebView host, runs the server as a child
lantern              terminal launcher (starts ollama if needed)
build-app.sh         assembles dist/Lantern.app
tools/make_icon.py   renders the app icon procedurally (no Pillow)
tools/lint.py        checks code and docs against traps that already bit us
tools/hooks/         git hooks — `git config core.hooksPath tools/hooks`
NOTES.md             design decisions, rejected approaches, traps
CLAUDE.md            standing constraints, for coding assistants
static/
  index.html
  css/app.css
  js/
    main.js          bootstrap, sidebar, toolbar, composer, find, backup
    store.js         state, per-chat runs, persistence, capability resolution
    chat.js          thread rendering, streaming loop
    markdown.js      markdown + syntax highlighting + LaTeX subset
    modals.js        settings, personas, models, parameters, guide
    palette.js       command palette
    theme.js         theme variables
    api.js           fetch + NDJSON streaming
    util.js          helpers
data/                created on first run (or ~/Library/Application Support/Lantern)
```

Under 11,000 lines of source. Chat writes are atomic (temp file + `os.replace`).

## Notes

- Streaming is NDJSON over chunked transfer, relayed straight from Ollama. Stop
  aborts the request; the proxy sees the broken pipe and closes the upstream
  socket, which is what tells Ollama to stop working.
- Thinking is not replayed to the model on later turns, matching how Ollama's
  chat templates expect history. Tool calls and their results *are* — a later
  turn would otherwise refer to an answer that isn't in the transcript.
- Titles are generated by the chat's own model with `think` forced off and a
  24-token cap, falling back to the first line of your message.
- The context gauge is a `chars / 3.7` approximation, not a real tokenizer.
  Treat it as a gauge.

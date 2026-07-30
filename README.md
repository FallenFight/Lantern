# Lantern

A lean local chat interface for [Ollama](https://ollama.com). One screen, no
account, no telemetry, no menus you'll never open.

- **Zero dependencies.** Python 3 standard library on the back, plain ES modules
  on the front. No `npm install`, no build step, no bundler, no Electron.
- **No browser.** The Mac app is a real `NSWindow` + `WKWebView` with a 144 KB
  native host. The whole bundle is ~800 KB.
- **Everything is a file.** Chats, personas, and settings are readable JSON.
  Back it up with `cp`, diff it with `git`, delete it with `rm`.
- **Offline.** The only network call is to your local Ollama. No CDNs — the
  markdown renderer, syntax highlighter, and maths renderer are written from
  scratch.

See [`NOTES.md`](NOTES.md) for design decisions, rejected approaches, and traps.

---

## Run it

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

---

## Chat

Token-by-token streaming. **Stop** actually aborts the run upstream rather than
just hiding output. Regenerate, regenerate **with a different model**, edit and
resend, delete a single message, branch a new chat from any point, duplicate a
chat, and retry a failed reply in place.

Chats run **independently** — start a long reply in one, switch away, start
another, and each writes only to its own conversation. A pulsing dot marks any
chat that's mid-reply.

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

## Organisation

Auto-generated titles, pin to top, **archive**, date grouping, rename, duplicate.
**Find in chat** (⌘F) highlights every hit with ⏎/⇧⏎ to step; **search all chats**
(⌘⇧F) is full-text across every message on disk.

Export one chat as Markdown or JSON, or **back up everything** — all chats,
personas, and settings in a single file. Restore offers merge (never overwrites
an existing chat) or replace.

## Models

Pull with a live progress bar, delete, unload, and preload. Capability chips for
thinking, vision, and tools. Shows size, quantisation, context length, and
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

Dark, light, or follow-the-system, nine accents, adjustable text size, message
width, and density. Translucency is limited to the chrome so the message list
stays at full frame rate; `prefers-reduced-transparency` and
`prefers-reduced-motion` are both honoured.

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
- Settings writes are type-checked — a malformed value used to make the app fail
  to boot
- Path traversal returns 404; chat ids are regex-validated on every write path

Chats are stored unencrypted by design. FileVault already encrypts the disk, and
plain files are what allowed hand-recovery when things went wrong.

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
server.py            stdlib HTTP server: Ollama proxy, JSON storage, guard
native/main.swift    NSWindow + WKWebView host, runs the server as a child
lantern              terminal launcher (starts ollama if needed)
build-app.sh         assembles dist/Lantern.app
tools/make_icon.py   renders the app icon procedurally (no Pillow)
NOTES.md             design decisions, rejected approaches, traps
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

~7,400 lines total. Chat writes are atomic (temp file + `os.replace`).

## Notes

- Streaming is NDJSON over chunked transfer, relayed straight from Ollama. Stop
  aborts the request; the proxy sees the broken pipe and closes the upstream
  socket, which is what tells Ollama to stop working.
- Thinking is not replayed to the model on later turns, matching how Ollama's
  chat templates expect history.
- Titles are generated by the chat's own model with `think` forced off and a
  24-token cap, falling back to the first line of your message.
- The context gauge is a `chars / 3.7` approximation, not a real tokenizer.
  Treat it as a gauge.

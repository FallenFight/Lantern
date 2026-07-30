# Lantern — project notes

Context that isn't derivable from the code: why things are the way they are, what
was tried and rejected, and the traps that cost real time. Read this before
changing anything structural.

`README.md` is the user-facing manual. This file is the reasoning behind it.

---

## Why the stack is what it is

**Python stdlib + vanilla ES modules, no dependencies, no build step.**

Node was not available in the OG enviroment

Consequences worth knowing:

- The markdown renderer, syntax highlighter, and LaTeX subset are all written
  from scratch in `static/js/markdown.js`. No CDN, no library. If you add one,
  you break the offline guarantee.
- `server.py` is deliberately kept **Python 3.9-compatible** so the app can fall
  back to the `/usr/bin/python3` that ships with macOS. Check with
  `/usr/bin/python3 -m py_compile server.py` before committing. No `match`,
  no `X | Y` at runtime (annotations are fine — `from __future__ import
  annotations` is on).
- The app icon is rendered procedurally by `tools/make_icon.py` — no Pillow.

## Naming

Named **Lantern** (was "Slate" for the first day). The rename touched the bundle
id, data folder, env vars, localStorage keys, and the icon. `LANTERN_DATA` falls
back to `SLATE_DATA`, and `migrate_legacy()` in `server.py` moves an old
`~/Library/Application Support/Slate` folder across on first run.

**Trap:** `build-app.sh` used to seed the data folder from `./data` on first
run, which created an empty `Lantern` folder *before* the app could migrate the
old one — orphaning the real history. The seed step is now guarded on the legacy
folder not existing. Don't remove that guard.

## Decisions that were considered and rejected

| Idea | Why not |
|---|---|
| Electron / Tauri | 150 MB+ and a toolchain, against the whole point |
| Bundling Python (PyInstaller) | ~20 MB vs 800 KB; macOS always has a usable python3 |
| Encrypted local storage | FileVault already encrypts the disk. App-level encryption means a password every launch and destroys "everything is a readable file" — which is exactly what allowed hand-recovery of chats twice |
| RAG / embeddings / vector store | A real subsystem. Without a library it means hand-writing chunking and a vector store, which is where the zero-dependency rule stops paying |
| Tool calling / MCP | Needs an execution loop plus sandboxing. The Models panel shows a `TOOLS` chip with a tooltip saying Lantern does **not** send tools — keep that honest or remove the chip |
| MLX / Vulkan backends | Ollama's domain, not ours |
| Browser `--app` window | Was the original approach. Replaced by the native host; it cost a 112 MB Brave profile for a cosmetic window |

## The thinking-capability trap (important)

Ollama under-reports which models can reason, in **both** directions:

- `/api/tags` claimed `qwen3.5-9b` was `["completion"]` only.
- `/api/show` correctly reports `['tools','thinking','completion']` for it.
- `gemma-4` reports only `["completion","vision"]` — yet honours `think`
  completely (verified: 997 characters of reasoning).

So Lantern does three things, all deliberate:

1. Reads capabilities from `/api/show`, never `/api/tags`.
2. For a model that does **not** advertise thinking, it **omits** the `think`
   field entirely rather than sending `think:false`. Sending `false` suppresses
   the very output needed to discover the model can reason.
3. When such a model emits `thinking` anyway, the name is recorded in
   `settings.observed_thinking` and the toggle appears from then on. Those
   models show `THINK*` instead of `THINK`.

Reasoning **effort** levels (low/medium/high) cannot be detected per model —
Ollama exposes nothing. They are offered for every thinking-capable model;
models built for it honour the string, others treat any level as plain "on".
This is stated in the in-app guide. Don't try to "fix" it with detection.

## Architecture notes

**Runs are bound to a chat object, never to the on-screen chat.** `S.runs` is a
`Map` keyed by chat id. This was a bug fix, not a design flourish: the original
code used a global `S.streaming` flag plus `S.chat`, so starting a reply in one
chat and then sending in another silently dropped the second message *and* wrote
the first chat's tokens and auto-title into the second. Anything touching
`runAssistant`, saving, or auto-titling must take an explicit `chat` argument.

**The streaming painter resolves its DOM node per frame** rather than capturing
it. Switching chats re-renders the thread, so a captured node goes stale and the
message stops updating. It also polls at 400 ms instead of every frame when its
chat is off-screen.

**Streaming markdown renders incrementally.** Re-parsing the whole buffer every
55 ms was O(n²) — a 20k-character reply did ~16M character operations. The
prefix up to the last blank line outside a code fence is cached; only the tail
is re-parsed. Measured 75.9% fewer character ops on a realistic 5.1k reply.
`renderThread()` does a full single-pass render with highlighting at the end,
which corrects any block a split happened to interrupt.

**Saves are debounced per chat id and the pending map holds the chat object.**
Resolving the chat later from `S.chat`/`liveChat` dropped writes for any chat
that was neither on screen nor streaming. Page teardown uses `sendBeacon` to
`POST /api/chats/{id}/save` — an async fetch cannot complete during unload.

**The server caches parsed chat files** keyed by `(mtime_ns, size)`.
`list_chats()` and `search_chats()` walk every file and run on bootstrap, on
every save, and on every search keystroke. ~7× faster warm.

## Security model

Everything is same-origin-guarded in `Handler.guard()`. This was added after
proving a real hole: a cross-origin `POST` with `Content-Type: text/plain` needs
no CORS preflight and went **straight through** — any website you visited while
Lantern ran could have deleted your Ollama models or pulled huge ones.

The guard rejects: a non-loopback `Host` (DNS rebinding), `Sec-Fetch-Site:
cross-site` or `same-site`, and a non-loopback `Origin`. Requests with **no**
Origin still pass, so curl and scripts keep working. `OPTIONS` returns 403 with
no CORS headers, so preflights correctly fail.

Also in place: a 64 MB request-body cap, an allow-list on the options forwarded
to Ollama (it used to pass anything through to the runner), `observed_thinking`
bounded to 64 entries, and type-checked settings writes.

**That last one was a real outage.** `PUT /api/settings` accepted any type;
writing `default_params: "nope"` made the *next read* throw, so `/api/bootstrap`
500'd and the app would not start until the file was repaired by hand. Writes
now type-check against the defaults and reads ignore a malformed value.

**Visual settings apply optimistically.** `patchSettings()` awaits the server
before updating `S.settings`, so calling `applyTheme()` straight after it
repainted with the *previous* value — every theme/accent/size pick appeared to
need a second click. `applyVisual()` in `modals.js` mutates the local copy
first, repaints, then persists. Use it for anything that changes appearance.

## Data safety — read this

Chats are plain JSON in `~/Library/Application Support/Lantern/chats/`. Writes
are atomic (temp file + `os.replace`).

**During development the chat folder was found empty once and had to be restored
from a backup.** The cause was never identified. Two separate incidents also
required hand-repair: the settings corruption above, and a probe that renamed a
real chat. Treat the data folder as precious:

- Take a backup before any session that touches storage — Settings →
  *Back up everything*, or `GET /api/backup`.
- `POST /api/restore` defaults to **merge**, which never overwrites an existing
  chat. `mode: "replace"` deletes everything first. Keep merge the default.
- Never run a cleanup that deletes by `message_count == 0` against real data
  without checking what it matched first.

## UI notes

The refresh is expressive shape and motion with **translucency limited to the
chrome**. Every `backdrop-filter` target (sidebar, topbar, composer, menus,
modals, toasts) sits *outside* the scrolling thread in normal flow, so nothing
moves behind them and the blur never recomposites while scrolling. The message
list is deliberately flat. Keep it that way.

### The send-button saga — four separate causes

Worth reading before touching the composer, because each looked like the same
symptom:

1. **Asymmetric padding** — `5px` right vs `5px + 2px margin` bottom.
2. **Height mismatch** — a 38px textarea against a 34px button meant their
   centres could never align when bottom-aligned. Both now derive from
   `--composer-line: calc(1.6 * var(--fs) + 10px)` so they track the text size.
3. **Non-concentric radii** — a 20px composer corner with a 7px button corner
   makes the gap swell from 7px at the edges to 10px on the diagonal. Inner
   radius must be `outer - gap`; that's `--composer-r`.
4. **The actual complaint** — the arrow sat 5px right of centre *inside its own
   square*. `.btn-send` inherited `padding: 9px 13px` from `.btn` and never
   reset it; with `box-sizing: border-box` that left an 8px content box for an
   18px icon, and **an overflowing grid item clamps to the start edge instead of
   centring**. `.btn-attach` had `padding: 0` all along, which is why it looked
   fine and the send button didn't.

Lesson: when a control uses `display: grid; place-items: center`, always reset
padding explicitly. And measure the *child inside the button*, not just the
button inside its parent.

Also fixed: `scrollbar-gutter: stable both-edges` on `.scroll`. Styling
`::-webkit-scrollbar` opts out of macOS overlay scrollbars, so on a Mac set to
"Show scroll bars: Always" the bar takes real width and shifts the centred
thread 5.5px against the composer. Not reproducible on this machine
(`AppleShowScrollBars = WhenScrolling`), so it is reasoned, not verified.

## LaTeX subset

Deliberately not a TeX engine. Covers what chat models actually emit:
variables, `\frac`, `^`/`_`, `\sqrt`, `\text`, and ~90 symbols. Unknown commands
render as their own literal text rather than vanishing, so a miss degrades to
"readable" instead of silent data loss.

`$...$` detection has a heuristic guard so `"It costs $5 and $10"` is not eaten
as maths: the body must contain a maths signal (`\ ^ _ { } = < >`) or be ≤3
characters. Escaped `\$` never reaches it — the backslash-escape pass runs
first.

## Testing notes

- The in-app browser pane frequently reports `viewport 0x0`, which makes every
  layout measurement meaningless (a message once measured 164,514px tall).
  **Open a fresh tab and call `resize_window` before measuring**, and sanity-check
  `window.innerWidth` first.
- Screenshots render at a real size even when JS reports 0×0, so a screenshot is
  a valid cross-check when measurements look absurd.
- The headless browser uses overlay scrollbars and will not produce a
  space-taking one even when forced — scrollbar-related layout can't be tested
  here.
- `sendMessage()` awaits the whole stream. Don't `await` it in a test unless you
  want to block.

## UI redesign — in progress

A second visual pass is **partially done**, driven by two references the user
supplied: an iOS "Liquid Glass" tab bar and the Gemini app.

Landed:

- **Ambient wash** (`.app::before`) — accent-hued colour bleeding from the top
  and falling to near-black, Gemini-style. Three static radials, painted once,
  no animation, no repaint cost.
- **The lens** (`.lens` + `moveLens()` in `main.js`) — a refractive slug that
  slides onto the active chat row instead of each row carrying its own
  background. `backdrop-filter` with raised brightness/saturation, plus paired
  cyan/magenta edge glows for the chromatic fringing, and inset highlights for
  the bevel. One blurred surface for the whole list, moved by transform.
  **Trap:** `renderSidebar()` clears the list with `textContent = ''`, which
  destroys the lens — `moveLens()` re-creates it if missing. Don't "optimise"
  that away.
- **Pill group + satellite** — toolbar controls ride in one capsule with the
  overflow menu detached as its own circle, mirroring the tab bar reference.
  The topbar itself is now transparent so the wash shows through.

Themes: `dark` (Lantern), `midnight`, `cyber`, `carbon` are dark; `light`
(Paper) and `mist` are light; plus `system`. Defined in `THEMES` in `theme.js`
and as `[data-theme=...]` blocks in the CSS. **A theme block must only set the
surface palette, never `--accent`** — that is what keeps all 12 accents working
on every theme. Verified: neon accent resolves on top of cyber.

Menus, modals, palette and toasts use `--panel` (97-98% opaque), not
`--glass-deep`. Blur alone did not make them readable over a busy thread, and
raising opacity let the blur drop from 28-34px to 14px, which is cheaper.

Still to do:

- The wash is weaker than the reference; it wants to be bolder near the top.
- Sliding lens for the segmented controls in Settings (same treatment as the
  sidebar) — currently a static `.on` background.
- The composer could take the same lens treatment on its send button.
- Light theme has had far less attention than dark on all of the above.

## Still open

Ranked by value, from the feature audit:

1. **RAG / document ingestion** — no PDF, DOCX, chunking, or vector store. Text
   files are inlined verbatim as code fences.
2. **Local embeddings** — `/api/embed` is never called.
3. **Tool calling / MCP** — detected but never sent.
4. Folders or tags for chats (date grouping + pinning only).
5. Global hotkey to summon the window (~20 lines of Swift in the native host).
6. Speech-to-text / TTS.
7. Context compaction when the window fills — note the default `num_ctx` is
   8192 while the installed models support 262,144, so raising that default is
   the cheaper half of the problem.

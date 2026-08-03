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
| MCP | Still rejected. A client means a subprocess transport, a handshake, and arbitrary third-party servers — the opposite of "one file you can read". Tool calling itself now ships; see below |
| Global hotkey to summon the window | Cut from the roadmap. It is Swift in the native host, macOS-only, and Spotlight and ⌘Tab already summon the app — a new native surface to maintain for something the OS does |
| **Parallel** multi-model comparison (the Msty / Open WebUI approach) | Not implementable on the target hardware. Measured: `qwen3.5-9b` is 7.29 GB resident at the 32k default, so two loaded models is ~14.6 GB on a 16 GB M4 — under 1.5 GB left for macOS and the app. Ollama would evict one mid-generation or the machine would swap. Comparison runs **sequentially** instead, which is a better fit, not a compromise |
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

## Tool calling

Three tools ship: `current_datetime`, `search_chats` and `calculate`. Adding one
is a single entry in `TOOLS` — the loop, the UI and the round cap need no
changes.

**The calculator is the one tool where a mistake is arbitrary code execution**,
because it evaluates a string the *model* wrote. Three rules hold it:

1. **Never `eval()`, and never `compile()` the parsed tree either.** `ast.parse`
   produces the tree; `_calc_eval` walks it by hand. There is no path from input
   to the interpreter at all.
2. **Whitelist node types.** Attributes, subscripts, lambdas, comprehensions and
   anything else are refused by default, so a future Python syntax feature cannot
   quietly become reachable. `(1).__class__` and
   `().__class__.__bases__[0].__subclasses__()` both die on the Attribute check.
3. **Bound the work.** Arbitrary-precision ints make `9**9**9` a hang rather than
   an error, so exponents are capped at 256 and nesting depth at 25.

Tested: 14 correctness cases and 19 hostile ones — `__import__`, `open`,
`__subclasses__` traversal, `exec`, `eval`, `globals`, comprehensions, lambdas,
huge powers, bare names, statements. Zero leaks. **Re-run those if the evaluator
is ever touched.**

**A verified tool does not make the model's prose true.** Asked for
`4871 × 3928 ÷ 7`, qwen called `calculate` with the whole expression, got the
right answer — and then stated the intermediate product as 19,135,088 when it is
19,133,288, a figure it never asked for and which contradicts its own tool
result. Adding "call it for every number you intend to state, including
intermediate steps" to the description improved the framing but did **not** stop
it. Tuning prompt text further against one model is not worth it; the real
mitigation is already in the design — every call is rendered with its exact
arguments and result, so a wrong claim is checkable against what actually ran.
Say so in the README rather than implying tools make answers trustworthy.

**`search_chats` needed different search semantics from the UI, and only an
end-to-end model test showed it.** The tool reuses `search_chats()`, which
matches the query as a **literal substring** — correct for ⌘⇧F, whose
highlighting depends on exact spans. But models ask in phrases. Given "what did
I conclude about ingress versus LoadBalancer", qwen searched
`"ingress LoadBalancer conclusion decision comparison"`, got nothing, retried
`"ingress LoadBalancer"`, got nothing, and told the user they had never discussed
it — while "ingress" alone matched two chats. A human adapts after one miss; a
model gives up and states a falsehood confidently.

The fix lives in the **tool**, not in `search_chats()`: try the phrase first,
then fall back to per-term search ranked by how many terms each chat hit, and
report `matched_on` so the model knows it got term matches rather than the phrase
it asked for. Stopwords are dropped or they would match everything and flatten
the ranking. Output is capped hard — 8 chats, 2 excerpts, 200 characters each —
because a tool result is replayed in the prompt on **every later turn**, so a
generous result quietly eats the context window it was meant to help with.

**Privacy shape worth keeping in mind:** this gives the model read access to
every saved chat, not just the open one. It is gated on tools being on, every
call is visible in the thread with its arguments, and nothing leaves the machine.
Any future tool touching stored data should hold that line.

**The same under-reporting trap as thinking, in the same direction.**
`/api/tags` reports `["completion"]` for `qwen3.5-9b` and
`["completion","vision"]` for both gemmas. `/api/show` reports **`tools` for all
three**, and `gemma-4-E4B` — which `/api/tags` says is completion+vision — called
the tool correctly on the first attempt. Lantern reads `/api/show`, so
`supports_tools` is already honest and no `observed_tools` list is needed:
unlike `think`, there is nothing to discover by guessing, because a model that
ignores a tools array just answers in prose.

**Protocol facts, measured against Ollama 0.32.5, not assumed:**

- `tool_calls` arrive **whole, on the final `done` chunk**, never as deltas.
  `mergeToolCalls()` merges by `function.index` anyway so a model that does
  stream them piecemeal still yields one entry per call.
- `arguments` is a real **object**, not a JSON string. Don't parse it.
- A result goes back as `{role:"tool", tool_name, content}`. The templates pair
  on `tool_name`, not on the `id` Ollama generates.
- A model will happily emit two calls in one round (verified: London and New
  York in a single turn, both executed, both fed back).

**The client sends tool *names*; the server owns the schemas.** `proxy_chat`
resolves them via `tool_specs()` and drops anything unknown, so a caller can never
describe a callable the server cannot run — the same reasoning as the options
allow-list. Tools are read-only, in-process, offline: no shell, no writes, no
network. `run_tool()` never raises; a failure returns as text the model can read
and correct from, because a 500 would kill an otherwise fine reply.

**The round cap is on rounds, not calls.** After `TOOL_ROUND_LIMIT` (4)
tool-executing rounds the loop asks **once more with no tools attached**, so the
turn ends in an answer instead of a dead stop. Verified by temporarily setting
the limit to 1.

**Two paths are reasoned, not observed.** Stop pressed *during* tool execution —
the signal is threaded into the tool fetch and the abort path truncates
unrecorded results, but the window is milliseconds wide and could not be hit
reliably. And the "model returned only calls we will not run" error, which needs
a model to emit structured `tool_calls` with no tools array present.

**Trap found doing that:** a model denied a tool it still wants writes the call
out as prose — qwen emitted a literal `<tool_call>` block into the answer text.
Lantern does **not** strip it. Chasing per-model call syntax is unwinnable, and
silently editing model output is worse than explaining it, so the round-limit
note says the syntax is literal text and nothing further ran.

**Storage.** A tool exchange is three messages: the assistant turn carrying
`tool_calls`, one `role:"tool"` message per result, then the answer. Each round
is its own assistant message with its own stats, which is why the thread shows
per-leg timings. Consequences that needed handling:

- `tool_calls` are recorded **only after** the results exist, so history can
  never hold a call with nothing under it. Stopping mid-execution truncates back
  to the assistant turn.
- Deleting an assistant turn takes its tool results with it, or the next request
  replays an answer to a call the model never made.
- Tool JSON is excluded from sidebar previews and from the auto-title
  transcript, in both `chat_summary()` and `summaryFor()`. It is left *in* search
  — matching a tool result is arguably useful.
- Anything that cuts history at a turn must keep a call and its results
  together. `toolTail()` is what **delete** and **branch** both use; without it,
  branching from a tool turn produced a chat whose first request replayed a call
  with no answer under it.

**Find-in-chat had to learn about collapsed panels.** `runFind()` walks every text
node under `#thread`, so it marked text inside collapsed tool bodies —
`display:none`, so the count was inflated and ⏎ scrolled to an invisible
highlight. It now rejects nodes inside a `.think-box`/`.tool-box` that is not
`.open`. **This was already broken for thinking panels** before tools existed.

**Rendering a tool round does not rebuild the thread.** `renderThread()` is
O(thread) and re-runs `wireCodeBlocks` over every code block, and a tool reply
adds messages two or three times. So the loop appends new nodes
(`appendMessagesFrom`) and rebuilds only the turn whose shape changed
(`replaceMessageNode` — it loses its bubble and header once it proves to be a
silent tool call). Both fall back to a full render unless the DOM holds exactly
the messages before the insertion point, and the turn still ends in one full
`renderThread()`: the fast path is never what correctness rests on.

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

**`route()`'s except clauses do not cover every connection error.** A client
hanging up mid-request raises `ConnectionResetError` inside
`handle_one_request` — while reading the request line, *before* the handler runs —
so socketserver's default `handle_error` printed a full traceback. The webview
drops keep-alive connections constantly, so `lantern.log` filled with stacks that
made a healthy app look like it was crashing. The `Server` subclass swallows
disconnect errors only; everything else still gets reported. Verified: ten abrupt
disconnects, zero tracebacks, server still serving.

**`VERSION` in `server.py` is the single source of truth.** `build-app.sh` `sed`s
it out to stamp `Info.plist`, and it is served by `/api/ping` and
`/api/bootstrap` for the About panel. It used to live only in `build-app.sh`,
which meant the shipped app could not tell you what version it was.

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

**`safeUrl()` had a real XSS.** It tested the scheme against the raw text, but
`escapeHtml()` has already turned `&` into `&amp;` — so
`[x](java&#9;script:alert(1))` did not read as `javascript:`, passed, and went
into the `href` intact. The HTML parser then decoded `&#9;` to a tab, and the URL
parser **strips** ASCII tab and newline before deciding the scheme:
`java<TAB>script:` becomes `javascript:`, running in Lantern's own origin, which
can read every chat through the API.

It now decodes one level of character references and drops what a URL parser
ignores *before* testing. One level is the right depth — it matches the HTML
parser, so `&amp;#9;` stays inert on both sides (verified: resolves as a relative
`http:` path). Tested against decimal, hex and named tab/newline entities, a
leading control character, mixed case, `data:` in an image, and double encoding;
query strings, relative paths and `mailto:` pass through untouched.

**The lesson: sanitise against the string the browser will act on, not the one
you are holding.**

**Micro-optimising the renderer is not worth it — measured.** `highlight()` now
caches its keyword `Set` and compiled regex per language, worth **0.009 ms per
code block (~0.27 ms on a 30-block thread)**. A single-pass `escapeHtml()` is
2.18× faster but saves **0.23 ms per 3,000 tokens**, so it was left alone — it is
the XSS boundary, and that is a bad trade for a fifth of a millisecond. The costs
that actually mattered (re-parsing the buffer while streaming, re-rendering per
tool round) are handled elsewhere. Don't come back here looking for speed.

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

### Known divergences, found by review and deliberately left

- **A blockquote swallows the block after it.** Lazy continuation in
  `renderMarkdown()` absorbs any non-blank line following a `>` line, so a code
  fence or heading written directly under a quote renders *inside* the quote.
  GFM ends the quote at the fence. The fix is a one-line guard on the break
  condition, but it changes how existing chats render, so it wants a test rather
  than a drive-by.
- Python decorators are not highlighted: the `\b` in `\b([A-Za-z_$@#][\w$]*)\b`
  cannot match before `@` at the start of a line.
- `codeBlock()` emits `data-code-id` and burns a `codeSeq` counter that nothing
  reads — copying uses `.code-raw`.
- `inline()` ends with a no-op `.replace(/\n/g, '\n')`, and its step comments
  number 1,2,3,4,3,4,5,6.

`$...$` detection has a heuristic guard so `"It costs $5 and $10"` is not eaten
as maths: the body must contain a maths signal (`\ ^ _ { } = < >`) or be ≤3
characters. Escaped `\$` never reaches it — the backslash-escape pass runs
first.

## Before you ship — click everything

Three bugs survived a code review *and* a targeted bug pass because every check
was aimed at newly-written code and nobody operated the app. All three are
visible within seconds of *using* it, and none look wrong when read:

- **Stop never worked; Esc always did.** Wired as `addEventListener('click',
  stopGeneration)`, and `stopGeneration(chatId = S.chat?.id)` takes a chat id — a
  listener passes the click Event, so the Event *was* the argument (a default only
  applies to `undefined`) and `S.runs.get(MouseEvent)` missed. Esc calls it with
  no arguments. **Never hand a function with optional parameters to
  `addEventListener`.**
- **The theme button was the one place bypassing `applyVisual()`**, so it
  repainted before `S.settings` updated: dark → light did nothing, and light
  arrived one click late, on the click selecting `system`.
- **A menu over the sidebar is a stacking-context problem, not a z-index one.**
  `.menu` had `z-index: 60`, but it lives in `.main` (`z-index: 1`) and
  `.sidebar` is a sibling at `2` — a child cannot escape its parent's stacking
  context, so no value would have worked. It now reparents to `<body>` while open
  (as `popupMenu()` in `chat.js` already did) and returns home on close, since the
  ⋮ button opens the same node as an anchored dropdown. Measure before clamping,
  and clear `right`: `#chat-menu` is `.menu-right`, so `left` *and* `right: 0`
  stretches it to the viewport edge.

So: before a build or a release, actually click these. Two minutes.

- [ ] **Send** a message; **Stop** mid-reply (button *and* Esc — they take
      different code paths)
- [ ] Theme button three times: dark → light → system, each changing immediately
- [ ] Right-click a chat row — menu appears **at the cursor and above** the
      sidebar
- [ ] ⋮ chat menu still opens anchored under the button
- [ ] Model picker, persona picker, Think pill, Tools pill — each opens and the
      caret menus work
- [ ] Tools on: ask the time in another timezone; expand the tool row
- [ ] ⌘K palette, ⌘F find (step with ⏎), ⌘⇧F search all chats
- [ ] New chat, rename, pin, archive, duplicate, branch, delete
- [ ] Regenerate, edit-and-resend, delete a message
- [ ] Settings: an accent, a theme, text size — each applies on the first click
- [ ] Export markdown + JSON, and **back up everything**
- [ ] `/usr/bin/python3 -m py_compile server.py`
- [ ] **Check `lantern.log` is empty.** A shipped app writing tracebacks looks
      broken even when it is fine — that is how the disconnect noise was found
- [ ] **Docs pass.** Does `README.md` still describe what the app does? Does this
      file have the new traps? Is anything in `CLAUDE.md` now untrue? Every
      feature or major change owns its documentation — README has shipped wrong
      three times (a stale model name, a line count off by 750, and a claim that
      Lantern never sent tools, which stayed for a whole release after it did)
- [ ] Reload with a reply in flight; switch chats mid-reply

Also run:

```bash
python3 tools/lint.py
```

**The lesson worth generalising:** verify the *trigger*, not just the mechanism.
The Stop abort path was traced and found correct; the button that called it was
never clicked. And this file already held the answer to the theme bug — a rule
written here is worth nothing if nothing checks the code against it. That is what
`tools/lint.py` is for: stdlib only, and every check in it maps to a bug that
really shipped. It knows two traps so far, and run against the commit before
these fixes it flags **both** the Stop button and the theme button. Add a check
whenever a new trap costs real time.

A first attempt at this was a plain `grep` for bare listeners. It matched all 20
of them, nearly all harmless, because a grep cannot see the target function's
signature — a check that cries wolf gets ignored, which is worse than no check.
The script correlates the listener with the function's parameter list instead.

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

**Going public at 1.0.** `v0.8.0`, `v0.8.1` and `v0.9.0` are tagged and released,
but **the repo is private by choice until 1.0** — so those releases are a private
record, not an announcement. Two consequences: the README already addresses
strangers (install steps, requirements, a clone URL) and is a promissory note
rather than a description of today; and **the stranger path cannot be tested
while private** — a fresh clone only worked because the author was authenticated.
Before 1.0, clone with credentials unset, or flip public briefly and back.

Distribution is settled: **source-only**, because `build-app.sh` ad-hoc signs
(`codesign --sign -`), so a downloaded `.app` is quarantined and reads as
*"Lantern is damaged"* — the worst possible message for something that is fine.
Notarising needs a $99/yr Apple Developer account. Building locally sidesteps
quarantine entirely and fits the zero-dependency story. Still missing for 1.0:
**README screenshots**, which for a UI app matter more than any prose in it.

Then, ranked by value, from the feature audit:

1. **RAG / document ingestion** — no PDF, DOCX, chunking, or vector store. Text
   files are inlined verbatim as code fences.
2. **Local embeddings** — `/api/embed` is never called.
3. **Web search** — start with a URL reader: fetch a page, extract readable text,
   drop it into context. No key, no dependency, and it keeps the app offline
   until you paste a link. SearXNG on localhost later if you want real querying;
   it fits this project better than an API key. Both are now tools, so they are
   one `TOOLS` entry each.
4. **Folders or tags for chats** — date grouping and pinning only today.
   Deferred to **1.0** deliberately; it is the last structural gap against apps
   like Msty, but it is not what 0.9.5 is about.
5. Speech-to-text / TTS.
6. Context compaction when the window fills. The cheap half is done — the default
   `num_ctx` went from 8192 to **32768** in 0.9.0, measured at **+0.83 GB
   resident on a 9B model, about 34 MB per 1k tokens**, for 4× the usable
   conversation. 65536 would have cost ~2 GB for headroom almost nobody reaches.
   What remains is the hard half: deciding what to drop when even 32k fills.
   **Note this only affects new installs** — `get_settings()` merges stored
   values over the defaults, so anyone with `num_ctx` already saved keeps 8192
   until they change it. That is deliberate; a silent memory jump on upgrade
   would be worse.

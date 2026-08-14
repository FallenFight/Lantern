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
  It is a cool ring around a warm core: the lantern reduced to light held in a
  housing. The earlier drawing had a handle, caps, tapered posts and a foot, and
  below ~48px those collapsed into a grey smudge — verified by rendering at 32px
  and magnifying, not by guessing. **Two shapes survive any size; seven do not.**
  The mark exists in three places that must change together — `make_icon.py`, the
  favicon data URI in `index.html`, and the empty-state `.empty-mark` SVG.
  Smooth gradients compress worse than flat black, so the `.icns` went from
  380 KB to 503 KB and is now half the bundle. That is the price of the glow;
  the alternative is banding.
- **The `tool` icon shipped broken from 0.9.0 to 1.0.1** and nobody noticed,
  because at 18px a wrong path still reads as *some* small grey mark. Magnified
  it was a blob with a stick out of one side and a slash floating beside it. Two
  causes, both worth knowing: `M14.5 6.5 17 4` is a moveto followed by an
  **implicit lineto** — a bare coordinate pair after `M` draws a line, it does
  not move again — and `M4 8l3 3` was simply a leftover subpath. It is one closed
  outline now. Like the app mark, it lives in **two** places that must change
  together: `ICON.tool` in `util.js`, and a hardcoded copy in the Tools pill in
  `index.html`. **Check an icon by rendering it at 48px, not by reading the
  path** — small marks hide their own defects.

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

`current_datetime`, `search_chats`, `calculate` and `read_url` ship. Adding one
is a single entry in `TOOLS` — the loop, the UI and the round cap need no
changes. A tool may carry a `gate` naming a setting, in which case it is invisible
until that setting is on; `read_url` is the only one so far, and *The URL reader*
below is why.

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

**Every `innerHTML` sink was audited before going public**, since a public repo
raises the cost of a hole. The result, and the shape to preserve:

- Message bodies go through `renderMarkdown()` or `escapeHtml()` — both paths
  sanitise, neither can be reached with raw text.
- Icon assignments are module constants (`svg(ICON.x)`), never data.
- **Every name a user or model controls is rendered with `text:`, not `html:`** —
  chat titles, persona names, tool names, and the prompt-library names added in
  0.9.5. `el()`'s `html:` option is only ever handed static markup.
- The one exception was the bootstrap failure screen, which interpolated
  `err.message` into `innerHTML`. Not realistically attacker-controlled, but it
  was the single place a dynamic string reached a sink unescaped, so it is built
  from nodes now.

**If you add a sink, the rule is: `text:` for anything a person or a model can
influence.**

**Micro-optimising the renderer is not worth it — measured.** `highlight()` now
caches its keyword `Set` and compiled regex per language, worth **0.009 ms per
code block (~0.27 ms on a 30-block thread)**. A single-pass `escapeHtml()` is
2.18× faster but saves **0.23 ms per 3,000 tokens**, so it was left alone — it is
the XSS boundary, and that is a bad trade for a fifth of a millisecond. The costs
that actually mattered (re-parsing the buffer while streaming, re-rendering per
tool round) are handled elsewhere. Don't come back here looking for speed.

**Frame callbacks do not fire on an occluded window, and that broke the sliding
lens.** The segmented controls in Settings place their indicator by measuring the
active button, which cannot happen before the control is in the document. The
first attempt deferred that to `requestAnimationFrame`, retrying until widths
existed — which on a window producing no frames is an unbounded loop that never
succeeds. The Density control opened with no indicator at all; Message width only
looked right because it had been clicked. A `ResizeObserver` fails the same way,
being equally frame-driven. `openModal()` now calls `placeLens()` once the dialog
is on screen: a synchronous layout read at the one moment the answer is knowable.
**If placement depends on layout, do it when you know layout exists — not on a
callback that assumes the window is visible.**

**`content-visibility: auto` on `.msg`** skips layout and paint for messages
scrolled out of view, with `contain-intrinsic-size` holding a placeholder height
so the scrollbar does not jump. The last message is exempted — it is the one
streaming, and skipping its paint would stall the tokens.

**It also makes `innerText` return empty for skipped messages**, which will
mislead anyone testing through the DOM: a thread of real messages reports 0
characters each. Nothing in the app is affected, because every consumer reads
`message.content` rather than the DOM — find-in-chat walks *text nodes*, which
are unaffected. But assert against the data model, not `innerText`, or you will
diagnose a bug that does not exist.

**Visual settings apply optimistically.** `patchSettings()` awaits the server
before updating `S.settings`, so calling `applyTheme()` straight after it
repainted with the *previous* value — every theme/accent/size pick appeared to
need a second click. `applyVisual()` in `modals.js` mutates the local copy
first, repaints, then persists. Use it for anything that changes appearance.

## The update check — the one call that leaves the machine

Added in 1.0.3. **Off by default**, because "offline unless you say otherwise" is
a promise in `CONTRIBUTING.md` and in the README, and this is the only thing in the app
that can break it. It was raised before it was built rather than after.

Why it exists at all: distribution is source-only, so there is no Sparkle-style
updater and no `.app` that refreshes itself. Nothing told you a release had
happened — you had to remember to look. The version now sits under the sidebar
buttons, and with the check on it says `v1.0.2 → v1.1.0` with an accent dot when
you are behind.

Decisions in it worth keeping:

- **The switch is enforced on the server, not the client.** `GET /api/update`
  returns `{"enabled": false}` and makes no outbound request when the setting is
  off. Gating it only in the front end would mean the guarantee held for the UI
  and not for anything driving the API — the same reasoning as the tool registry
  and the options allow-list.
- **It is not part of `/api/bootstrap`.** Folding it in would make a launch with
  no internet sit on a network timeout before the window appeared. It runs after
  the UI is up, and a failure is a line of text in Settings, never a dialog.
- **Nothing in GitHub's reply is trusted past three integers.** The tag is
  matched against `v?\d+\.\d+\.\d+` and the link is *rebuilt* from those numbers.
  The response's own `html_url` is ignored on purpose — it is attacker-shaped
  data in the sense that matters (it decides where a user's click goes), and a
  release can be named anything. Tested against a tag containing
  `javascript:alert(1)`, a tag that is itself a URL, a missing tag, and a
  non-JSON body: all four fall back to the hardcoded releases page, and an
  `html_url` pointing at `evil.example` is dropped.
- **Only a successful check is cached** (6 hours). Caching a failure would pin
  "could not reach GitHub" onto the rest of the session after one flaky moment.
- `check_update()` never raises. Being offline is the *normal* state for this
  app, so it is a message, not an error page.

**The README claim had to change and that is the point.** It said "The only
network call is to your local Ollama", flatly. That went from true to
conditionally false the moment this landed, and README has shipped wrong four
times before. It now says what is actually true — nothing reaches out until you
switch this on — and the Security section names the one call, where the gate is,
and what is not trusted in the reply. **If you ever add a second outbound call,
that section is the thing to update first.**

## Folders

Chosen over tags, and the reason is the sidebar rather than taste. It is ~260px
wide: tags want chips on every row and a filter bar above them, folders want one
label per group. And **one chat belongs to one folder**, which keeps
`renderSidebar()` a single flat pass where every chat is rendered exactly once.
Tags remain possible later — they would be a separate additive field, not a
replacement.

Single level. Nesting means a tree, drag-and-drop, and path rendering in a narrow
column, and the value falls off fast.

**A folder owns nothing.** Membership is `folder_id` on the chat; `folders.json`
is a list of `{id, name, order}` and no more. Losing or hand-editing that file
costs the grouping and never a conversation — the same instinct as keeping chats
as readable JSON, which is what allowed hand-recovery twice.

**Deleting a folder unfiles its chats, never deletes them.** The server clears
`folder_id` on each and reports how many, the confirm text says the chats will be
kept before you click, and the toast repeats it afterwards. A cascade here is
precisely the shape of the accident this data folder has already had twice.

Consequences that needed handling:

- **Pinned still wins.** A pinned chat appears under *Pinned* even when filed, so
  no chat is ever drawn twice. That is the existing behaviour with date groups,
  left alone rather than made clever.
- **An unknown `folder_id` falls back to unfiled** rather than vanishing. The
  sidebar filters on folders it knows about, so a chat pointing at a folder that
  no longer exists still appears — a row that silently disappears reads exactly
  like data loss.
- **Collapse state lives in `localStorage`, not on the folder.** It is a property
  of this window, and writing it to the folder file would mean a disk write on
  every disclosure triangle.
- **Backup and restore carry folders**, or the grouping would survive the backup
  and be lost by the restore. Restore *merges* the folder list, matching the rule
  that restore never destroys what is already there.
- Indentation for rows in a folder is a class on the row, not
  `.folder-head + .chat-row ~ .chat-row` — the sibling combinator also catches
  every unfiled row further down the list.

**Trap found doing this:** the writable-field whitelist for a chat was spelled
out twice, in the PUT route and in the `sendBeacon` `/save` route. Adding
`folder_id` to one and not the other would have made filing work everywhere
except page teardown — a bug that only shows up when you close the window. It is
one `CHAT_WRITABLE` constant now.

**Verified:** folders created, renamed, filed into and collapsed; collapse state
survives a reload; deleting a folder holding a chat leaves all chats present with
their messages, unfiled. And the compatibility promise both ways — **v1.0.3 run
against a data folder written by this build** lists every chat, opens a filed one
with its messages, and *preserves* `folder_id` through its own save, because it
round-trips the whole chat dict. Degraded, not broken, exactly as promised.

## The first-run flow

Three steps, because a new user has exactly three questions: is Ollama working,
which model, and what is this allowed to do. Skippable at every point — an
onboarding flow you cannot escape is worse than none, and skipping leaves every
default exactly as it ships.

**Detecting "first run" is the part that can go wrong.** The obvious signal is
`settings.onboarded`, and it is the wrong one: an existing install that has never
opened Settings has no `settings.json`, so it reads as un-onboarded and gets
greeted on upgrade. That is the "new code greets an old user" failure that makes
an update feel broken. `first_run()` requires **no settings file *and* no chats**
— someone who has used Lantern has history, whatever their settings look like.
Verified both ways: a fresh folder reports true, a folder with one chat reports
false.

**Two things the flow had to fix about itself**, both found by clicking it:

- Boot creates a blank chat *before* the flow runs, and that chat captured
  whichever model was default at the time. So picking a model in onboarding left
  the chat in front of you showing a different one. The flow now retargets the
  open chat when it is still empty; a chat with history keeps the model it was
  answered with.
- Turning *off* "read web pages" changed the setting but not the tool registry
  the front end holds, so the pill still counted `read_url` until a reload. It
  re-fetches now, the same way the Settings row does.

The permissions step is where a future web-search switch belongs, alongside the
reader — it is the one place a user is already being asked what this may reach.

## Think and Tools live under the composer

Moved there in 1.3.0. They change the **next message**; model and persona are
settings for the whole chat. Grouping by what a control affects rather than by
what it looks like puts the send-time controls with the box you type in, and
leaves the topbar holding chat-level state.

**The trap is the dropdown direction.** `.menu` is `position: absolute; top:
calc(100% + 8px)`, which opens downward — fine in a topbar, useless eight pixels
from the bottom of the window, where the menu would render off-screen entirely.
Both menus carry `.menu-up`, which flips to `bottom: calc(100% + 8px)` and moves
`transform-origin` so the open animation still grows from the anchored edge.
Verified by measuring: the menu's bottom sits above the pill's top and the whole
box is inside the viewport.

**Also caught by looking rather than reasoning:** `.pill-label` truncates with an
ellipsis, which exists for long model names in the topbar. At a narrow window
that rendered `Tools · a…`. The composer row opts out; its labels are short and
fixed.

## The URL reader ships enabled — and what "local-first" actually means

Changed in 1.3.0, deliberately, after shipping it off by default in 1.2.0.

The argument that won: **a user pasting a link and asking about it has already
said what they want.** Answering "I can't read that" until they hunt through
Settings is the wrong default — it fails the one case the feature exists for.

The argument it beat was the offline guarantee, and the honest version is that
the guarantee was drawn in the wrong place. Local-first here is about *inference
and data*: the model runs on your machine, the chats are files on your disk,
nothing is uploaded, there is no account and no telemetry. "Never resolves a
hostname" was a stricter promise that nobody actually needed, and it was
protecting against the wrong thing.

**What did not change is the part that matters.** The fence is identical: public
http(s) only, checked on the resolved IP so `localtest.me` and friends are
caught, re-checked at every redirect, bounded in time and size, refused for
anything on the machine or the private network. Turning it on by default does not
loosen a single one of those. **The fence is the invariant; its default is not.**

**The residual risk, stated rather than hidden:** the *model* picks the address.
It is told to use links the user provided, but that is prompt text, not an
enforced rule, so a model can in principle fetch something that was never pasted.
Every call is rendered in the thread with its exact URL, so it is visible, and
the tool can be switched off on its own. Enforcing it properly would mean
checking the requested URL against the conversation text, which the tool cannot
see today — `run_tool()` receives a name and arguments and nothing else. That is
the obvious next hardening if this ever feels too loose.

The update check stays **off** by default. It is not the same shape: nobody has
asked for it in the moment, so there is no request to honour.

## Tools: off and auto, with auto the default

"On" became **"Auto"**, and it is what new chats start with. The word is the
honest one: Lantern offers the tools and the *model* decides whether to call
anything. Nothing about the request changed — this is a rename plus a default
flip, not a new mode.

Two consequences worth knowing:

- **Existing installs flip too.** `get_settings()` merges stored values over the
  defaults, so anyone who never touched `tools_default` picks up the new default
  on upgrade. Their existing chats keep whatever `tools` value they were saved
  with; only new chats change. Settings → Behaviour turns it back off.
- **It does not enable the URL reader.** `read_url` is gated separately on
  `web_reader`, which stays off. Tools going auto by default must not quietly
  turn on the one tool that reaches off the machine, and it does not.

The cost this trades away is real and was the original reason for defaulting off:
tool schemas are sent on every turn, so auto costs prompt tokens even when no
tool is called. That is the trade the setting exists to let you undo.

## The URL reader

The second thing that can reach off this machine, and much sharper than the
update check, because **the model chooses the address**. That makes it a
server-side request forgery primitive unless it is fenced, and the fence is more
of the work than the feature.

The concrete danger is not abstract: Lantern's own API and Ollama's both listen
on localhost. `http://127.0.0.1:8777/api/chats` would put every saved
conversation into the model's context, and a page the user pasted is exactly the
sort of thing that could talk a model into fetching it.

So the fence, all of it on the server:

- **http(s) only**, and the check is on the **resolved IP**, not the hostname —
  `localtest.me` and friends resolve to 127.0.0.1, so a name blocklist waves them
  straight through. Loopback, private, link-local, multicast, reserved and
  unspecified are all refused.
- **Every redirect hop is re-checked.** A public URL redirecting to
  `169.254.169.254` is stopped at the redirect, verified against a local server
  that does exactly that.
- **Bounded everywhere**: a hard request timeout, a capped body read, a redirect
  limit, and a capped result — a tool result is replayed in the prompt on every
  later turn, the same reasoning as `search_chats`.
- **Gated in three places** — `tool_catalog()`, `tool_specs()` and `run_tool()`.
  The UI must not list it, the model must not be told it exists, and a direct API
  call must not reach it. Gating in one place leaves the other two as ways in.

**The tool contract was not what it looked like, and only testing found it.**
A tool's `run()` returns a *plain payload* that `run_tool()` JSON-encodes
wholesale; `_display` is popped for the row label; and `ok` means "the tool
executed", not "the outcome was good" — a `calculate` error is a normal result
with an `error` key. I wrote the first version returning `{"content": ...,
"ok": False}`, which was double-encoded into the payload and always marked
successful. Reading `run_tool` would have shown it; the SSRF suite showed it
instead, on case one. A fetch failure *should* read as failed in the thread, so
`_ok` now exists alongside `_display` — one line, and the only change to the
contract.

**Two bugs the hostile suite caught, both in the same place.** Testing for
`"://"` to decide whether to prepend a scheme mangled `data:text/html,...` into
`https://data:text/html,...`, whose "port" is not a number — and
`urllib.parse.SplitResult.port` *raises* on access rather than returning None.
So the tool raised instead of refusing. `run_tool` caught it, so nothing broke,
but a tool that raises is a tool whose failure text the model never sees. Match
a scheme properly, and never touch `.port` bare.

**Verified.** Seventeen hostile inputs — Lantern's own API, Ollama's, localhost
by name, private LAN, the cloud metadata address, IPv6 loopback, `0.0.0.0`,
`file:`/`ftp:`/`data:`/`mailto:`/`javascript:`, an invalid port, no host, garbage,
empty — all refused in under 30ms, none raising, none hanging. Then the fetch
path against a local server: a normal page extracts title and text with scripts
and styles stripped, plain text passes through, a 404 and a PDF and an oversized
page each come back as a readable message, a redirect is followed, a redirect to
the metadata IP is blocked, a redirect loop stops at the limit, and a host that
sleeps past the timeout returns "did not respond" at exactly the timeout.

**End to end with a real model**, which is the trigger rather than the mechanism:
asked to read an unreachable URL, qwen called `read_url`, got `unreachable`, and
told the user it could not access the page — the turn finished in 13 seconds with
the tool row styled as failed. Asked to read `http://127.0.0.1:.../api/chats` it
declined from the tool description alone without even calling it, which is a
pleasant second layer but not the control; the server block is.

**Two more bugs, found by a robustness pass *after* the first suite passed —
both of them ways to hang the reply, which is the one thing this must not do:**

- **`timeout=` is per socket operation, not per transfer.** A server dripping one
  byte a second resets it forever. Reproduced: it ran past 12 seconds against a
  2-second timeout. There is now a wall-clock `WEB_TOTAL_TIMEOUT` for the whole
  call, redirects included — which also stops three slow hops stacking to 24s.
- **`HTTPResponse.read(n)` blocks until it has all n bytes**, so the first
  attempt at a deadline never got a turn — the check sat in a loop that could not
  reach it. `read1()` returns whatever has arrived and keeps the clock alive.
  **A deadline is worthless if the call you are timing cannot yield.**

Also fixed there: undecoded **gzip** reached the model as mojibake and it read
that as the page, so `Accept-Encoding: identity` is requested *and* the body is
decompressed anyway (servers send it regardless). Decompression is bounded by
`max_length` — 200 KB of gzip expands to 200 MB otherwise, in the server process.
Verified: bomb bounded in 33ms, drip-feed ends at the deadline, and a connection
cut mid-body still yields the partial text.

**Known limitation, deliberately left: DNS rebinding.** The address is resolved
to check it, then urllib resolves again to connect, so a hostile name with a
one-second TTL could answer public for the check and `127.0.0.1` for the fetch.
Closing it means connecting to the checked IP by hand and carrying the original
host through TLS SNI and certificate validation — a real amount of socket code
for a threat that needs an attacker-controlled domain *and* the user pasting it.
It is written down rather than pretended away; if this ever guards something
sharper, that is the gap to close first.

**What it is not.** One page you point it at. No search engine, no crawling, no
following links found on the page. Search is a later conversation, and SearXNG on
localhost fits this project better than an API key.

## Windows and Linux — audited, not tested

**The app was already portable and nobody had noticed.** `server.py` is 2,200
lines with no macOS in it at all: no POSIX-only imports, no POSIX-only `os`
calls, no hardcoded Unix paths, every filesystem path through `pathlib`, and it
does not even start Ollama — it only reports whether it is reachable. The front
end has had `MOD = isMac ? '⌘' : 'Ctrl+'` since the beginning.

Everything macOS-only is **packaging**, about 785 lines of it: `main.swift`,
`build-app.sh` and the `lantern` bash launcher. None of it is the app.

So the browser path costs almost nothing, and `lantern.cmd` mirrors the bash
launcher — `%APPDATA%\Lantern` for history, start Ollama if nothing answers.

Two things the audit turned up:

- **An em-dash in a `print()`.** Only reachable with `--host` off loopback, but a
  legacy Windows code page can raise `UnicodeEncodeError` on it when stdout is
  redirected. That line is ASCII now.
- **`watch_parent()` is opt-in** via `LANTERN_WATCH_PARENT`, set only by the
  native host, so the reparenting watchdog never starts elsewhere. Just as well:
  Windows does not reparent orphans, so it would never fire anyway.

**The one real platform difference, and it is tested.** `static()` builds a
filesystem path from a URL path, and on Windows `pathlib` treats a **backslash**
as a separator — so `/..\..\..\Windows\win.ini` is a traversal shape that simply
does not exist on macOS, where a backslash is an ordinary filename character.

That did not need a Windows machine to check: `ntpath` and `PureWindowsPath`
import fine on macOS, so the whole of `static()`'s path handling was replayed
under Windows semantics. Backslash traversal, mixed traversal and a
`static\..\..` escape all resolve outside `STATIC` and are refused by the
existing `is_relative_to()` guard; normal assets still resolve inside. The guard
holds because it compares resolved path *objects* rather than strings.

**Simulating the semantics is not the same as running the platform**, and the
distinction is worth keeping straight: the traversal guard is verified, the app
launching on Windows is not.

**Why it says "untested" in the README rather than "supported".** The whole
discipline here is verify-by-running, and three bugs shipped because code was
read and the app was never operated. Claiming a platform nobody has launched
would be that failure at its largest — a promise to strangers on a machine we
have never seen. The README already carried an unqualified "On Linux and Windows,
`Ctrl` replaces `⌘`", written long before any of this; it is qualified now.

**There is nothing to separate, and that is the design.** Source-only
distribution means a release ships **zero binaries** — it is a git tag, and every
platform clones the same tree. So there is no "Windows build" sitting beside a
"Mac build" that could drift apart. There is one app, and per-platform *starting*:

| | how it starts | history lives in |
|---|---|---|
| macOS | `build-app.sh` → `Lantern.app`, or `./lantern` | `~/Library/Application Support/Lantern` |
| Linux | `./lantern` | `${XDG_DATA_HOME:-~/.local/share}/lantern` |
| Windows | `lantern.cmd` | `%APPDATA%\Lantern` |
| anywhere | `python3 server.py --open` | `./data` |

The asymmetry is the point: macOS has a *build*, everywhere else has no build
step at all. Resisting the urge to add one — a `platform/` directory, a
cross-platform build script, per-OS release assets — is what keeps this from
becoming a packaging project. Three launchers named after their platforms is
enough separation for three platforms; revisit it at ten.

**Trap found doing this:** `lantern` hardcoded
`$HOME/Library/Application Support/Lantern`. It is a *bash* script, so Linux
reaches it too, and it would have silently created a `~/Library` tree on a Linux
box — the sort of thing nobody notices until their chats are in two places. It
picks by `uname` now, and the macOS branch is byte-identical so no existing data
moves.

A native Windows window stays unbuilt until someone asks. It is a second native
surface to maintain — the reasoning that cut the global hotkey — and unsigned
Windows binaries hit SmartScreen, which is the same problem as macOS quarantine
and has the same answer: build it yourself.

## The 1.0 compatibility promise

1.0 is not "feature complete" — it is **"ready for strangers"**. The thing a
version number now commits to is not an API, because there is no public API. It
is **the chat JSON on disk**:

- **Add fields, never repurpose or remove them.** `tools`, `variants` and
  `variant` were all added after chats already existed, and old files keep
  loading because every consumer defaults when a field is absent. That is the
  pattern to keep.
- **Never require a migration for something a user could lose.** Chats have gone
  missing twice. A format change that needs a rewrite pass is a format change
  that can destroy history halfway through.
- A file written by a newer Lantern should still open in an older one, degraded
  rather than broken. Unknown fields are ignored, not fatal.

Everything else — the HTTP endpoints, the module layout, the CSS — is internal
and may change freely.

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

## `writingsuggestions="off"` on the composer

macOS Writing Tools puts an Apple Intelligence glyph inside editable fields, and
it appeared in the composer — the system drawing into our textarea, not anything
Lantern renders. The composer is the only `<textarea>` and the only field with
`spellcheck="true"`; search, find and the palette are single-line inputs with
spellcheck off, and were never affected.

The attribute suppresses it (WebKit, Safari 18+). **Don't delete it wondering
what it does.** The trade is deliberate: no Siri glyph and no inline prediction
ghosting over the prompt you are composing, at the cost of losing Writing Tools
inside Lantern. Anyone who wants it back has it system-wide in System Settings →
Apple Intelligence & Siri.

## LaTeX subset

Deliberately not a TeX engine. Covers what chat models actually emit:
variables, `\frac`, `^`/`_`, `\sqrt`, `\text`, and ~90 symbols. Unknown commands
render as their own literal text rather than vanishing, so a miss degrades to
"readable" instead of silent data loss.

**Blockquote lazy continuation — fixed in 1.0.** `renderMarkdown()` absorbed any
non-blank line after a `>` line, so a fence, heading or list written directly
under a quote rendered *inside* it. GFM ends the quote there, because lazy
continuation carries **paragraph text only**. `opensBlock()` is the guard.

It was deferred four times because it changes how existing chats render, so it
was landed with a test covering both directions: fence, heading and list under a
quote now render as siblings, while lazy paragraph continuation and multi-line
quotes are byte-for-byte unchanged. **Re-run those six cases if the blockquote
branch is ever touched** — the risk is not breaking the fix, it is silently
breaking continuation.

**Orphan closing tags are stripped at display time.** `gemma-4-E4B` at Q4_0 ended
a reply with a bare `</blockquote>`, which renders as visible literal text and
reads like a Lantern bug. It is not: reproduced against Ollama **directly**, with
none of this code in the path, appearing on one sample and not the next from an
identical prompt. Small heavily-quantised models emit junk tokens.

Two things worth keeping straight. The model, asked about it, confidently
explained it as "an artifact from the underlying templating process" — a
confabulation, since it cannot introspect its own sampling. **A model's account
of its own behaviour is not evidence**; the reproduction was. And the stripping
is display-only, deliberately narrow:

- It runs inside `inline()` *after* inline code is placeholdered, and fenced
  blocks never reach `inline()` at all — so `</div>` in code survives, which is
  where anyone legitimately discussing HTML puts it.
- A closer with a matching opener anywhere in the block is left alone.
- Stored content is never modified. Turning off *Render markdown* shows exactly
  what the model wrote.

Tested both directions: the stray closer goes; inline code, fenced code, balanced
markup, `a < b and b > c`, and a mixed case keeping `<b>bold</b>` while dropping a
lone `</em>` all behave. **Re-run those if this is touched** — the risk is not
failing to strip, it is eating something real.

### Known divergences, found by review and deliberately left

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
- [ ] Model and persona pickers in the topbar; Think and Tools **under the
      composer** — each opens, and both caret menus open *upward* and stay on
      screen. A bottom-anchored menu that opens downward is invisible
- [ ] Tools on: ask the time in another timezone; expand the tool row
- [ ] **URL reader** (Settings → Behaviour → *Let the model read web pages*):
      paste a real link and ask about it, then ask it to read a URL that does
      not resolve. The failure must end the turn with an answer, not a spinner
- [ ] ⌘K palette, ⌘F find (step with ⏎), ⌘⇧F search all chats
- [ ] New chat, rename, pin, archive, duplicate, branch, delete
- [ ] Regenerate, edit-and-resend, delete a message
- [ ] **Compare a reply that is *not* the last one**, page between the answers,
      open the side-by-side view — then compare it again and **Stop** before the
      first token. The turn must come back unchanged and the messages after it
      must still be there. Every comparison bug hid behind "compare the last
      reply", which is the only case anyone tests by hand
- [ ] Settings: an accent, a theme, text size — each applies on the first click
- [ ] Export markdown + JSON, and **back up everything**
- [ ] `/usr/bin/python3 -m py_compile server.py`
- [ ] **Check `lantern.log` is empty.** A shipped app writing tracebacks looks
      broken even when it is fine — that is how the disconnect noise was found
- [ ] **Docs pass.** Does `README.md` still describe what the app does? Does this
      file have the new traps? Is anything in `CONTRIBUTING.md` now untrue? Every
      feature or major change owns its documentation — README has shipped wrong
      **six** times: a stale model name, a claim that Lantern never sent tools
      which survived a whole release, the line count **three** times, and an
      accent count that said nine when there have been twelve for months.
      **The pattern is countable things.** Vague wording does not fix it — the
      line count was softened to "under N lines" and was wrong again at the next
      release, because nobody re-counts prose. Anything of the form *"N of X"* in
      the README either needs a check in `tools/lint.py` or should not be a
      number at all
- [ ] **First run**, against an empty `LANTERN_DATA`: the flow appears, the
      model you pick is the one the open chat uses, and it does *not* appear
      again on reload. Then point at a folder with chats and confirm it stays
      away — greeting an existing user is the failure that matters
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
really shipped. Run against the commit before those fixes it flags **both** the
Stop button and the theme button; run against `v1.0.3` it flags the "nine
accents" claim, five theme names the README never mentioned, and a line count
that was over its own stated bound. Add a check whenever a new trap costs real
time.

A first attempt at this was a plain `grep` for bare listeners. It matched all 20
of them, nearly all harmless, because a grep cannot see the target function's
signature — a check that cries wolf gets ignored, which is worse than no check.
The script correlates the listener with the function's parameter list instead.

**The best check for a fact is not writing it down twice.** This took two goes to
learn properly.

First attempt: check each count against its source. That caught the real "nine
accents" bug, but it had two holes. The line-count claim had been guarded since
0.9.5 and *still* went stale a third time, because the wording was softened from
"under 10,000 lines" to "about 10,000 lines of source" — which matched neither
pattern the check looked for, so it passed on a sentence it could not see. **A
check that matches one phrasing is a check you can edit your way out of by
accident.** And the count itself was wrong: `COUNTED_SOURCES` omitted
`build-app.sh` and `lantern`, hiding ~280 lines, so the README could claim "under
10,000" while `wc` said 10,044.

**It happened a third time, after that rule was written down.** The Layout-block
check required the code fence to sit immediately under `## Layout`. The README
rewrite put a sentence in between, the pattern stopped matching, and the check
went *silent* — taking a newly added `onboard.js` with it, which is exactly what
it exists to catch. Lint reported clean on a README missing a source file. It now
finds the fence anywhere in the section **and treats not finding it as a
failure**, the same fix as the line count. **When you write a check, ask what it
does when it matches nothing.** Twice now the answer has been "passes quietly".

Second attempt, and the one that ends it: **the README names things and never
counts them.** Every one of the six failures was a number restating something the
code already enumerates. Where the README lists the things, the list *is* the
count, so the number was pure redundancy carrying all of the risk. They are gone,
and `lint.py` now fails if one comes back — the ban is on the *number*, so unlike
a value check it cannot be beaten by rephrasing.

What stays: specs a reader acts on — the port, `num_ctx`, macOS 11, keyboard
keys. Those are not "how many X" claims, and the ones mirroring code are still
checked. Measurements stay too (the ~6s reload, the 14.6 GB two-model figure);
they are observations about a machine, not restatements of the source.

Names are the opposite case and are *encouraged*: every registered tool and every
theme label must appear in the README, checked for presence, so a rename is
caught. Naming is what a reader wanted from the number anyway.

Verified by reintroducing each retired claim against an extracted tree — accent,
theme, line, tool and persona counts all fail, the current README is clean, and
renaming a theme in `theme.js` is still caught. That is what the
`python3 tools/lint.py <dir>` argument is for. Deleting the count checks also
left `source_line_count()` and two constants dead, which were removed with them:
a lint script carrying code that can no longer fire is the same disease.

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

## UI redesign — landed, with optional polish left

A second visual pass, driven by two references the user supplied: an iOS "Liquid
Glass" tab bar and the Gemini app. The substance of it shipped in 0.9.5; what is
left is polish nothing depends on.

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
- **The segmented controls in Settings take the same lens** — one indicator moved
  by transform rather than a background on each button, so the travel is
  composited instead of repainted. `box.placeLens()` in `modals.js`, called by
  `openModal()` once the dialog is on screen; the frame-callback trap that cost
  real time getting there is under *Architecture notes*.

Themes: `dark` (Lantern), `midnight`, `cyber`, `carbon` are dark; `light`
(Paper) and `mist` are light; plus `system`. Defined in `THEMES` in `theme.js`
and as `[data-theme=...]` blocks in the CSS. **A theme block must only set the
surface palette, never `--accent`** — that is what keeps all 12 accents working
on every theme. Verified: neon accent resolves on top of cyber.

Menus, modals, palette and toasts use `--panel` (97-98% opaque), not
`--glass-deep`. Blur alone did not make them readable over a busy thread, and
raising opacity let the blur drop from 28-34px to 14px, which is cheaper.

Still to do, and none of it is blocking anything:

- The wash is weaker than the reference; it wants to be bolder near the top.
- The composer could take the same lens treatment on its send button.
- Light theme has had far less attention than dark on all of the above.

## Where things stand

**Shipped: `v1.2.2`, and the repo is public.**
<https://github.com/FallenFight/Lantern>

Tool calling is complete (`current_datetime`, `search_chats`, `calculate`),
model comparison ships with the side-by-side view, and there is a prompt library.
`num_ctx` defaults to 32768. The stranger path is verified: an anonymous clone
with credentials stripped from the environment builds and runs.

**1.0 means "ready for strangers", not feature complete.** The compatibility
promise it carries is above, under *The 1.0 compatibility promise* — it is about
the chat JSON on disk, not an API.

The three patch releases after it, oldest first:

- **`1.0.1`** — the only release so far that fixed something which *lost data*:
  the orphan-closing-tag strip, plus the comparison bug pass above, five bugs of
  which two destroyed messages. No new features, no format change. The 1.0
  compatibility promise holds: chats written by 1.0.0 open unchanged, and a
  message left with a single-entry `variants` array by the old failure path still
  loads.
- **`1.0.2`** — redraws the `tool` icon, malformed since 0.9.0. See the icon note
  near the top of this file for the two SVG mistakes and the lesson. Cosmetic
  only, and its own release because the Tools pill is on screen the whole time
  you use the app.
- **`1.0.3`** — puts the version under the sidebar buttons and adds the opt-in
  update check: the first thing in the app that can reach past your own machine.
  How it is gated is under *The update check* above.

Since then: **`1.1.0`** added folders for chats, **`1.2.0`** the opt-in
`read_url` tool, **`1.2.2`** the first-run flow and the default flips (tools on
auto, the URL reader enabled), and **`1.2.1`** a Windows/Linux browser path — audited rather
than tested, and labelled that way; see *Windows and Linux* above — the second thing that can reach off the machine, and the first
where the *model* picks the address. *The URL reader* above has the fence and the
two hang-the-reply bugs a robustness pass caught after the first suite passed.

**Still not done, and the biggest gap:** the README has **no screenshots**. For a
UI project that matters more than any prose in it. Three worth taking: the thread
mid-reply, an expanded tool call, and the compare view.

Everything else is optional — see *Still open* below, ranked. Folders was cut
from 1.0 deliberately: it is a feature, not a readiness gap.

### Comparison — built

Variants, the pager, sequential generation, per-variant metrics, and the
side-by-side compare view. The compare view is static text in columns with each
answer's tok/s, TTFT, output tokens and thinking time — showing *speed beside
quality* is the whole differentiator, since Msty and Open WebUI show only the
text. On the first real comparison qwen thought for 65s and emitted 926 tokens to
gemma's 32s and 428, for near-identical answers. That is the trade nobody else
surfaces.

**It reuses `runAssistant` rather than forking it.** Comparing streams *over* the
existing turn — the old answer is snapshotted into `variants[0]`, the message is
cleared and re-answered in place with the whole normal pipeline (painter, tool
loop, round cap), and the result is appended as another variant. Keeping the
message id means the DOM node, the painter's per-frame lookup and any open
find-marks all stay attached. Two things had to change for it:

- **`buildPayloadMessages(chat, limit)`** — the turn being re-answered sits
  *inside* the array, not at the end, so everything from it onward is cut. Without
  that the model is shown its own later replies.
- **The abort path must not splice.** Stopping a normal run deletes an empty
  placeholder; stopping a comparison must instead put the previous answer back,
  or the turn is left blank.

**The selected variant is mirrored onto the message.** `content`, `model`,
`stats` and the rest are copied up from `variants[variant]`, so saving, export,
search, and `buildPayloadMessages()` need no knowledge of variants at all. The
alternative — reading through an index everywhere — would have touched every
consumer.

**Verified:** two models answering one turn stores two variants and *does not*
append a message; the pager switches text, model, metrics and thinking together;
the choice survives a reload. Gemma-4 produced 1,854 characters of reasoning to
qwen's 4,027, and each stayed with its own variant — a useful accident, since it
re-confirms that gemma reasons despite not advertising it.

### The bug pass over it — five real ones, all from the same mistake

Every one of them came from a single unstated assumption: **`runAssistant` was
written for a run whose message is at the *end* of the array, and comparison put
one in the middle.** They were found by operating the app against a scratch
`LANTERN_DATA` seeded with a four-message chat, not by reading — the code reads
fine.

- **Stop during a comparison deleted the rest of the conversation.** The abort
  path ran `chat.messages.length = at + 1` to drop tool results whose call was
  never recorded. Correct when the turn is last; catastrophic when it is turn two
  of six. Observed: two messages left of four, saved to disk. It is now guarded on
  `placeholder !== target`.
- **A comparison in a chat with tools on corrupted the history.** Tool results are
  `push`ed to the end of the array while the compared turn sits in the middle, and
  the payload is cut at the compared turn — so the model never saw its own tool
  result, called `current_datetime` four times, hit the round limit and answered
  "I do not have access to a real-time clock". The chat went from 4 messages to
  12, the compared turn was left **blank**, and its original answer survived only
  inside `variants[0]` with no pager to reach it. Observed exactly as described.
- **Stopping a comparison before the first token duplicated the answer.** The
  restore put the old answer back on the message, and the `finally` block then
  snapshotted that same message into a *second* variant — a pager reading `2/2`
  with the identical text on both sides.
- **A comparison that failed lost the answer it was supposed to keep.** The
  restore lived in `catch`, so it only ran for something that *threw*. An empty
  reply and a round that ends in `placeholder.error` fail without throwing, and
  left the turn showing an error with the previous answer unreachable.
- **The pager was live while a further comparison streamed into the same turn.**
  Clicking ‹ mid-stream ran `applyVariant()` on the message the painter was
  appending to.

**The fix that mattered most was a design decision, not a patch: a comparison
runs with no tools.** A variant is one answer on one message; a tool exchange is
an assistant turn plus a `tool` row per result. There is nowhere inside a variant
to put them, and appending them beside a mid-thread turn is what corrupted the
history. Making it work would mean variants that own a message *list* — a format
change and a real feature, not a bug fix. The honest version is to refuse, and to
say so with a toast rather than quietly compare a tool-using answer against one
written without them.

**The restore rule now lives in one place, `finally`, and reads as one sentence:**
gained an answer → keep it beside the old one and select it; gained nothing → put
the turn back exactly as it was and toast why. Splitting it across `catch` and
`finally` is what let the non-throwing failures through. It also removes the
single-entry `variants` array it would otherwise leave behind, so a comparison
that produced nothing leaves no trace at all.

**`effectiveThink()` and `effectiveTools()` take the model being asked.** They
read `currentModel(chat)`, and a comparison deliberately does *not* change the
chat's model — so the request was built from the capabilities of a model that was
not the one answering. `regenerateWith` never hit this because it sets
`chat.model` first.

**Two optimisations, both small and both real.** `selectVariant()` rebuilt the
whole thread to change one message; it now uses `replaceMessageNode()` (which
returns a boolean and falls back to a full render), which also stops a long chat
jumping to the bottom when you page between answers. And the tok/s arithmetic was
written out twice, in the message footer and the compare columns — one `tokRate()`
now, because two copies of a formula drift.

**Left alone, deliberately:** a reply that is *entirely* thinking with no content
renders as an empty bubble. Seen with qwen3.5-9b answering a tool result inside
its reasoning — 26 tokens out, all of them thinking. It predates comparison and is
not part of it.

### The original design, kept as the record of why

**All of this shipped** — it is here because the reasoning is the useful part,
not because anything is outstanding. The one idea below that was never built is
the thumbs-up leaderboard, and it stays unbuilt until there is a reason to want
it. Generation is **sequential**, and the rejected-approaches table above has the
memory arithmetic for why parallel cannot work here. The rest:

- **Variants live on the assistant message**, not in a message tree. Open WebUI
  uses a tree (`groupedMessageIds` keyed by model index, `groupedMessageIdsIdx`
  for the visible one per model) because it runs many models at once. Lantern
  deliberately does not, so the flat `messages` array stays: the assistant
  message grows `variants: [{model, content, stats, ttftMs, …}]` plus a selected
  index, and top-level `content` mirrors the selection — so
  `buildPayloadMessages()` and history replay need no changes at all.
- **"Compare with…"** on a reply, shaped like the existing *Regenerate with
  another model*, **appends** a variant instead of replacing the answer.
  `S.runs` already allows only one run per chat, so sequencing is free.
- **A pager on the message** (`‹ 2/2 › gemma-4-12B`) switches which variant is
  live in the conversation.
- **A compare view** lays variants out in columns — static text, no streaming,
  so it costs nothing to render.
- **Show the metrics.** Lantern already measures TTFT, tok/s and token counts.
  Msty and Open WebUI show text side by side; showing *speed and length beside
  quality* is the differentiator, and on local models that trade is the actual
  decision. Open WebUI's thumbs-up leaderboard idea becomes nearly free once
  variants exist.

## Still open

**Going public is done.** The repo is public, `v1.0.0` through `v1.0.3` are
tagged and released, and the stranger path is verified — an anonymous clone with
credentials stripped from the environment builds and runs. The README describes
today rather than promising a future.

Distribution is settled: **source-only**, because `build-app.sh` ad-hoc signs
(`codesign --sign -`), so a downloaded `.app` is quarantined and reads as
*"Lantern is damaged"* — the worst possible message for something that is fine.
Notarising needs a $99/yr Apple Developer account. Building locally sidesteps
quarantine entirely and fits the zero-dependency story. The consequence is that
updating is manual, which is what the update check in 1.0.3 exists to make
visible; the README has the pull/rebuild/replace steps under *Updating*.

**Still missing: README screenshots**, which for a UI app matter more than any
prose in it. Three worth taking: the thread mid-reply, an expanded tool call, and
the compare view. Deliberately deferred, not forgotten.

Then, ranked by value, from the feature audit:

**Two of these are audit findings, not available work.** They describe real
gaps, and they are *also* in the rejected table above — which is the table that
exists so nobody re-proposes something already ruled out. Reading this list for
"what's next" walked straight into that once. They stay documented because
knowing your gaps is useful; they are not on the menu.

1. ~~RAG / document ingestion~~ — no PDF, DOCX, chunking, or vector store; text
   files are inlined verbatim as code fences. **Ruled out**: without a library it
   means hand-writing chunking and a vector store, which is where the
   zero-dependency rule stops paying. Reopen the decision before proposing it.
2. ~~Local embeddings~~ — `/api/embed` is never called. **Ruled out** with RAG,
   for the same reason; on its own it has nothing to feed.
3. **Web search** — the URL reader half is **built**; see *The URL reader* above
   for the fence around it. What remains is actual querying, and SearXNG on
   localhost still fits this project better than an API key. One `TOOLS` entry
   when it happens.
4. ~~Folders or tags for chats~~ — **built.** Folders, not tags; the reasoning
   and the traps are under *Folders* above. Tags are still possible as a separate
   additive field if per-chat labels ever earn their place.
5. **A native Windows window** — unbuilt on purpose. The browser path works
   (see *Windows and Linux* above); a WebView2 host is a second native surface to
   maintain, and unsigned Windows binaries hit SmartScreen exactly as unsigned
   Mac ones hit quarantine. Build-it-yourself answers both. Waiting for demand.
6. Speech-to-text / TTS.
7. **Documentation cleanup.** `NOTES.md` is past a thousand lines and is read
   front-to-back by whoever picks this up next, which is the wrong shape for it.
   It wants splitting by when you need it — the standing constraints, the traps
   worth reading before touching code, and the archive of decisions already made
   — rather than one scroll in the order things happened. `README.md` was cut to
   size already; this is the other half.
8. Context compaction when the window fills. The cheap half is done — the default
   `num_ctx` went from 8192 to **32768** in 0.9.0, measured at **+0.83 GB
   resident on a 9B model, about 34 MB per 1k tokens**, for 4× the usable
   conversation. 65536 would have cost ~2 GB for headroom almost nobody reaches.
   What remains is the hard half: deciding what to drop when even 32k fills.
   **Note this only affects new installs** — `get_settings()` merges stored
   values over the defaults, so anyone with `num_ctx` already saved keeps 8192
   until they change it. That is deliberate; a silent memory jump on upgrade
   would be worse.

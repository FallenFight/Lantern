# Lantern — project notes

Where the project stands, what is still open, and what has already been decided.
The reasoning behind the code lives in three files beside this one:

| | |
|---|---|
| [`docs/design.md`](docs/design.md) | How Lantern is built and why: the stack, architecture, platforms, UI, the markdown and LaTeX renderers |
| [`docs/tools.md`](docs/tools.md) | Tool calling, the URL reader, the update check, and the capability traps |
| [`docs/features.md`](docs/features.md) | Comparison, folders, first run, reset — and the traps inside each |
| [`docs/shipping.md`](docs/shipping.md) | The security model, data safety rules, and the click-through list to run before a release |

[`CONTRIBUTING.md`](CONTRIBUTING.md) has the standing constraints — read that
first if you are changing anything. [`README.md`](README.md) is the user-facing
manual and is kept accurate against the code.

---

## Where things stand

**Shipped: `v1.2.4`, and the repo is public.**
<https://github.com/FallenFight/Lantern>

Tool calling is complete (`current_datetime`, `search_chats`, `calculate`,
`read_url`), model comparison ships with the side-by-side view, and there is a
prompt library.
`num_ctx` defaults to 32768. The stranger path is verified: an anonymous clone
with credentials stripped from the environment builds and runs.

**1.0 means "ready for strangers", not feature complete.** The compatibility
promise it carries is in [`docs/design.md`](docs/design.md) → *The 1.0
compatibility promise* — it is about the chat JSON on disk, not an API.

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

**`1.2.4`** is a UI pass: three themes (Ember, Void, Sepia), the light-theme
override fix that Mist had been shipping without, an appearance step in first
run, and the last of the polish the notes had been carrying.

**`1.2.3`** adds a full reset, a first-run flow you can replay from the palette,
and splits these notes into `docs/`.

Since then: **`1.1.0`** added folders for chats, **`1.2.0`** the opt-in
`read_url` tool, **`1.2.2`** the first-run flow and the default flips (tools on
auto, the URL reader enabled), and **`1.2.1`** a Windows/Linux browser path — audited rather
than tested, and labelled that way; see *Windows and Linux* above — the second thing that can reach off the machine, and the first
where the *model* picks the address. *The URL reader* above has the fence and the
two hang-the-reply bugs a robustness pass caught after the first suite passed.

Everything remaining is optional — see *Still open* below, ranked. Folders was
cut from 1.0 deliberately: it is a feature, not a readiness gap.

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
7. ~~Documentation cleanup~~ — **done.** `NOTES.md` was 1,346 lines read
   front-to-back; it is an index now, with the reasoning split into `docs/` by
   when you need it. The README was cut to size in 1.2.2.
8. Context compaction when the window fills. The cheap half is done — the default
   `num_ctx` went from 8192 to **32768** in 0.9.0, measured at **+0.83 GB
   resident on a 9B model, about 34 MB per 1k tokens**, for 4× the usable
   conversation. 65536 would have cost ~2 GB for headroom almost nobody reaches.
   What remains is the hard half: deciding what to drop when even 32k fills.
   **Note this only affects new installs** — `get_settings()` merges stored
   values over the defaults, so anyone with `num_ctx` already saved keeps 8192
   until they change it. That is deliberate; a silent memory jump on upgrade
   would be worse.

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
| README screenshots | Owner's call: not happening for the foreseeable future. They would help a UI project on a public repo, and that argument has been made and declined. **Don't raise it again** — the rejected table is where things go so nobody re-proposes them |
| Browser `--app` window | Was the original approach. Replaced by the native host; it cost a 112 MB Brave profile for a cosmetic window |

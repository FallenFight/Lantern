# Lantern

A local chat interface for [Ollama](https://ollama.com). Inference runs on your
machine, chats are plain JSON files on your disk, and there are no accounts or
telemetry.

Built with the Python standard library and plain ES modules. No npm, no bundler,
no Electron. The Mac app is a native window around a webview and the whole bundle
is a couple of megabytes.

## Requirements

- [Ollama](https://ollama.com) with at least one model pulled
- Python 3.9 or later
- macOS 11 or later for the Mac app; Xcode command line tools
  (`xcode-select --install`) to build it

Models that support tool calling and extended thinking get the most out of
Lantern. Don't trust `ollama list` for capabilities, it under-reports them. The
Models panel shows what Lantern detects.

## Install

There is no download. You build it yourself, because signing a Mac app needs a
paid Apple Developer account, and an unsigned download is quarantined by macOS
and reported as damaged.

### Mac app

```bash
git clone https://github.com/FallenFight/Lantern.git
cd Lantern
./build-app.sh
cp -R dist/Lantern.app /Applications/
```

Launch it from Spotlight or Launchpad. The app runs `server.py` as a child
process and displays it in a `WKWebView`. It links only system frameworks and
carries no Python of its own, preferring Homebrew or python.org and falling back
to the `/usr/bin/python3` that ships with macOS.

Chats live in `~/Library/Application Support/Lantern`, so replacing the app never
touches them.

### Terminal

```bash
./lantern
```

Starts Ollama if it isn't running, then opens <http://127.0.0.1:8777>. It shares
history with the Mac app. To run the server directly:

```bash
python3 server.py --port 8777 --open
```

### Windows and Linux

Not tested. The server and interface contain no macOS-specific code, so Lantern
should run anywhere Python does, in a browser:

```bash
python3 server.py --open
```

Windows has a `lantern.cmd` that starts Ollama and stores history in
`%APPDATA%\Lantern`. Linux uses `./lantern` and `~/.local/share/lantern`.

Nobody has run either platform. The code has been audited for portability, but an
audit is not a test. If you try it, please open an issue with what happened.

## Updating

```bash
git pull
./build-app.sh
rm -rf /Applications/Lantern.app
cp -R dist/Lantern.app /Applications/
```

Remove the old bundle first. Copying over it merges the two, leaving stale files
behind. Quit Lantern before replacing it. Your chats are outside the bundle and
are not affected.

The version is shown under the sidebar buttons and in Settings. Lantern can check
GitHub for newer releases if you turn that on in Settings; it is off by default.

## Features

**First run.** A brand-new install opens a short setup flow: it checks Ollama is
reachable, lets you pick a default model, and shows what Lantern may do — tools,
reading web pages, checking for updates — each with a switch. Skippable, and it
only appears on a data folder with no history, so upgrading never triggers it.

**Chat.** Token-by-token streaming. Stop aborts the run upstream rather than
hiding the output. Regenerate, regenerate with a different model, edit and
resend, delete a message, branch a new chat from any point, duplicate, and retry
a failed reply. Conversations run independently, so you can start a long reply,
switch away, and start another.

**Compare models.** Answer any turn again with a different model without losing
the first. The turn gets a pager to switch between answers, and each keeps its
own metrics, so you can see the speed and length trade alongside the text.
Generation is sequential, since two loaded models will not fit in memory together
on most machines. Comparisons run without tools, and turns that called tools
can't be compared.

**Extended thinking.** Reasoning streams into a collapsible, timed panel above
the answer, with effort levels for models that support them. Capability detection
reads `/api/show` rather than `/api/tags`, which under-reports, and Lantern
records any model it catches reasoning so the toggle appears next time.

**Organisation.** Folders, pinning, archiving, date grouping, rename, duplicate.
Find in chat highlights every hit; search runs across every message on disk.
Deleting a folder moves its chats out rather than deleting them.

**Formatting.** Tables, nested and ordered lists, task lists, blockquotes, and
fenced code blocks with per-language highlighting, copy, and soft wrap. A LaTeX
subset covers what models actually emit: `$…$`, `$$…$$`, `\(…\)`, `\[…\]`,
fractions, superscripts and subscripts, `\sqrt`, `\text`, and a broad set of
symbols. The markdown renderer, syntax highlighter, and maths renderer are all
written from scratch, so nothing is fetched from a CDN.

**Personas and prompts.** Personas are named system prompts, each able to pin its
own model, thinking setting, and sampling overrides. Default, Terse, Engineer,
Socratic Tutor, and Editor ship, all editable. Saved prompts are the things you
retype, inserted from the command palette.

**Models and parameters.** Pull with a progress bar, delete, unload, preload.
Temperature, top-p, top-k, min-p, repeat penalty, context window, prediction
limit, seed, and stop sequences, set globally, per persona, or per chat. A
built-in guide explains what each value does.

**Appearance.** Dark themes (Lantern, Midnight, Cyber, Carbon), light themes
(Paper, Mist), or follow the system. Adjustable accent, text size, message width,
and density.

**Export.** Any chat as Markdown or JSON, or everything at once as a single
backup file. Restore offers merge, which never overwrites an existing chat, or
replace.

## Tools

The Tools pill, under the message box, lets a model call into Lantern for things
it cannot know. It has two settings: **off**, and **auto**, where the tools are
offered and the model decides whether to use any. Auto is the default for new
chats, and only applies to models that advertise tool support. Turn it off in
Settings if you would rather not pay the schema tokens until you ask.

| Tool | What it does |
|---|---|
| `current_datetime` | Reads this machine's clock, in any IANA timezone |
| `search_chats` | Full-text search across your saved conversations |
| `calculate` | Exact arithmetic, parsed and evaluated without `eval()` |
| `read_url` | Fetches a web page and reads its text |

Every call appears in the thread with its exact arguments and the exact result,
collapsed by default. A tool result is only as good as what the model asked it,
so the arguments are always visible for checking.

`search_chats` gives the model read access to every saved conversation, not just
the open one. `read_url` is the only tool that reaches the internet, and it can
be turned off on its own in Settings. See Security below.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Where Ollama listens |
| `LANTERN_DATA` | `./data` | Where chats are stored |
| `LANTERN_PORT` | `8777` | Default port |
| `LANTERN_VERBOSE` | unset | Log every HTTP request |

Nothing binds beyond localhost unless you pass `--host 0.0.0.0`.

## Keyboard

| Key | Action | Key | Action |
|-|-|-|-|
| `⌘K` | Command palette | `⌘N` | New chat |
| `⌘F` | Find in this chat | `⌘⇧F` | Search all chats |
| `⌘P` | Personas | `⌘⇧P` | Switch persona |
| `⌘M` | Models | `⌘,` | Settings |
| `⌘⇧L` | Cycle theme | `⌘⇧T` | Toggle thinking |
| `⌘R` | Regenerate | `⌘⇧E` | Edit last message |
| `⌘S` | Export markdown | `⌘B` | Toggle sidebar |
| `⌘/` | Shortcut list | `Esc` | Stop or close |
| `Enter` | Send | `⇧Enter` | Newline |

`Ctrl` replaces `⌘` on Windows and Linux, though see the note above about those
platforms.

## Troubleshooting

**Can't reach Ollama.** Start it with `ollama serve`, then press Retry in the
banner.

**No models listed.** Run `ollama pull <name>`, or pull one from the Models
panel.

**No Tools pill.** The model doesn't advertise tool calling. Check the Models
panel for a tools chip. The pill sits under the message box, beside Think.

**Replies slow to start.** The model is loading. Turn on *Keep models loaded* in
Settings to stop Ollama evicting it after a few idle minutes.

## Security and privacy

Chats are stored unencrypted, by design. Disk encryption already covers the disk,
and plain files are what makes the data recoverable by hand.

The server rejects anything another site could forge: non-loopback `Host` headers
(DNS rebinding), cross-site `Sec-Fetch-Site`, and non-loopback `Origin`. Requests
with no `Origin` still pass, so `curl` and scripts work. There is a request body
cap, an allow-list on the options forwarded to Ollama, type-checked settings
writes, and regex-validated chat IDs on every write path.

Tools run in the server process, read-only. No shell, no file writes, and no
network except `read_url`.

### Network access

Your conversations, your models, and your files never leave your machine. Two
features can make outbound requests, and both can be switched off.

**Reading web pages.** On by default. The `read_url` tool fetches a page so you
can paste a link and ask about it. It is restricted to public `http` and `https`
addresses, checked against the resolved IP rather than the hostname, so anything
on your machine or private network is refused. Every redirect is re-checked.
Requests are bounded in time and size, so a slow or hostile site cannot hang a
reply.

The model chooses the address it fetches. It is instructed to use links you
provide, but that is an instruction rather than an enforced rule, so a model may
in principle fetch something you did not paste. Every call is shown in the thread
with the exact URL, and you can turn the tool off in Settings.

**Update check.** Off by default. Asks GitHub once per launch whether a newer
release exists: an anonymous read of the public releases list, with no account,
token, or identifier beyond a version string in the user agent.

Both switches are enforced on the server, not just in the interface. Turn both
off and Lantern contacts nothing but your local Ollama.

## Layout

The app is one codebase and runs anywhere. Only packaging is platform-specific,
and nothing is built at all outside macOS.

```
server.py            HTTP server: Ollama proxy, JSON storage, same-origin
                     guard, tool registry (a tool is one entry in TOOLS)
static/
  index.html
  css/app.css
  js/
    main.js          bootstrap, sidebar, toolbar, composer, find, backup
    store.js         state, per-chat runs, persistence, capabilities
    chat.js          thread rendering, streaming loop
    markdown.js      markdown, syntax highlighting, LaTeX subset
    modals.js        settings, personas, models, parameters, guide
    palette.js       command palette
    onboard.js       first-run flow: Ollama check, model, permissions
    theme.js         theme variables
    api.js           fetch and NDJSON streaming
    util.js          helpers

lantern              launcher for macOS and Linux
lantern.cmd          launcher for Windows
build-app.sh         macOS: assembles dist/Lantern.app
native/main.swift    macOS: NSWindow and WKWebView host
tools/make_icon.py   macOS: renders the icon procedurally

tools/lint.py        checks the code and docs against past mistakes
tools/hooks/         git hooks: git config core.hooksPath tools/hooks
NOTES.md             design decisions and reasoning
CONTRIBUTING.md      standing constraints and working notes
data/                created on first run, unless a launcher points elsewhere
```

Chat writes are atomic, using a temporary file and a rename.

## Notes

- Streaming is NDJSON over chunked transfer, relayed from Ollama. Stopping aborts
  the request, and the closed socket is what tells Ollama to stop working.
- Thinking is not replayed to the model on later turns, matching how Ollama's
  chat templates expect history. Tool calls and their results are.
- Titles are generated by the chat's own model, falling back to the first line of
  your message.
- The context gauge under the composer is an approximation, not a real tokenizer.
- Context window: default 32768 tokens. Parameters has a button that reads the
  model's real limit.

[`NOTES.md`](NOTES.md) covers the design decisions, the approaches that were
tried and rejected, and the bugs worth remembering.

## Licence

MIT. See [`LICENSE`](LICENSE).

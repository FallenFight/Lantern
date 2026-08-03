#!/usr/bin/env python3
"""
Lantern - a lean local LLM interface backed by Ollama.

Stdlib only. No dependencies, no build step, no telemetry, no network access
beyond your local Ollama instance.

    python3 server.py            # http://127.0.0.1:8777
    python3 server.py --port 9000 --open

Environment:
    OLLAMA_HOST   base URL of Ollama        (default http://127.0.0.1:11434)
    LANTERN_DATA  where chats are stored    (default ./data)
    LANTERN_PORT  default port              (default 8777)
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
import secrets
import sys
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

try:
    # stdlib from 3.9; reads the system tz database, so no tzdata package
    from zoneinfo import ZoneInfo
except ImportError:      # exotic build with no zoneinfo — local time still works
    ZoneInfo = None

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
DATA = Path(os.environ.get("LANTERN_DATA") or os.environ.get("SLATE_DATA")
            or (ROOT / "data")).expanduser().resolve()
CHATS = DATA / "chats"
OLLAMA = (os.environ.get("OLLAMA_HOST") or "http://127.0.0.1:11434").rstrip("/")
if not OLLAMA.startswith(("http://", "https://")):
    OLLAMA = "http://" + OLLAMA

_LOCK = threading.RLock()

# Anti-DNS-rebinding: only these Host header values are served. A page on
# attacker.com that resolves its own name to 127.0.0.1 would otherwise reach
# this server with full read access to every conversation.
LOOPBACK = {"127.0.0.1", "localhost", "::1", "[::1]"}
ALLOWED_HOSTS = set(LOOPBACK)

DEFAULT_SETTINGS = {
    "theme": "dark",              # dark | light | system
    "accent": "indigo",
    "font_size": 15,
    "density": "comfortable",     # comfortable | compact
    "bubble_width": "normal",     # narrow | normal | wide | full
    "default_model": None,
    "default_persona": None,
    "send_on_enter": True,
    "show_stats": True,
    "auto_title": True,
    "render_markdown": True,
    "thinking_open": False,       # auto-expand thinking blocks while streaming
    "sidebar_collapsed": False,
    # Whether a new chat starts with tool calling on. Off by default: the tool
    # schemas cost prompt tokens on every turn and some models reach for a tool
    # when prose would do.
    "tools_default": False,
    # How long Ollama keeps a model in memory after a reply. "" uses Ollama's
    # own default (5m). Longer avoids paying a full reload after a pause.
    "keep_alive": "",
    "preload_default": False,
    # Models seen emitting a `thinking` field. /api/show under-reports the
    # capability (gemma-4 does not advertise it but honours `think` fully), so
    # we learn from what actually comes back and reveal the toggle for those.
    "observed_thinking": [],
    "default_params": {
        "temperature": 0.7,
        "top_p": 0.9,
        "top_k": 40,
        "min_p": 0.0,
        "repeat_penalty": 1.1,
        "num_ctx": 8192,
        "num_predict": -1,
        "seed": None,
        "stop": [],
        # blank means "let Ollama decide" — these are escape hatches, not knobs
        # to fiddle with, and wrong values degrade or break inference
        "num_gpu": None,
        "num_thread": None,
        "num_batch": None,
    },
}

SEED_PERSONAS = [
    {
        "name": "Default",
        "emoji": "✨",
        "prompt": "",
        "description": "No system prompt. Raw model behaviour.",
    },
    {
        "name": "Terse",
        "emoji": "⚡",
        "prompt": (
            "Answer with the minimum text required to be correct and useful. "
            "No preamble, no restating the question, no summary at the end. "
            "Use bullet points or code only when they genuinely help."
        ),
        "description": "Short, dense answers with no filler.",
    },
    {
        "name": "Engineer",
        "emoji": "\U0001f9ee",
        "prompt": (
            "You are a senior software engineer. Prefer working code over prose. "
            "State assumptions explicitly, call out edge cases and failure modes, "
            "and say plainly when something is a bad idea and why. "
            "Always specify the language in code fences."
        ),
        "description": "Code-first, blunt about trade-offs.",
    },
    {
        "name": "Socratic Tutor",
        "emoji": "\U0001f393",
        "prompt": (
            "You are a patient tutor. Break ideas into small steps and check "
            "understanding as you go. Ask a guiding question before giving the "
            "full answer, and use concrete analogies and worked examples."
        ),
        "description": "Teaches by guiding rather than telling.",
    },
    {
        "name": "Editor",
        "emoji": "✍️",
        "prompt": (
            "You are a sharp copy editor. Tighten prose without changing the "
            "author's voice. Cut hedging and redundancy. Return the edited text "
            "first, then a brief bulleted list of the substantive changes."
        ),
        "description": "Tightens writing, preserves voice.",
    },
]


# --------------------------------------------------------------------------
# storage
# --------------------------------------------------------------------------

def new_id(prefix: str) -> str:
    return f"{prefix}_{int(time.time() * 1000):x}{secrets.token_hex(3)}"


def migrate_legacy() -> None:
    """Carry a pre-rename "Slate" data folder over to the new name, once."""
    if DATA.exists():
        return
    legacy = DATA.parent / "Slate"
    if legacy.is_dir():
        try:
            legacy.rename(DATA)
            print(f"  Migrated   {legacy} -> {DATA}")
        except OSError:
            pass


def ensure_dirs() -> None:
    migrate_legacy()
    CHATS.mkdir(parents=True, exist_ok=True)


_PARSE_CACHE: dict = {}
_PARSE_LOCK = threading.Lock()
_PARSE_CACHE_MAX = 512


def read_chat_cached(path: Path):
    """
    Parse a chat file, reusing the last parse while its mtime and size are
    unchanged. list_chats() and search_chats() both walk every file, and they
    run on bootstrap, on every save, and on every keystroke of a search.
    """
    try:
        st = path.stat()
        key = str(path)
        stamp = (st.st_mtime_ns, st.st_size)
    except OSError:
        return None
    with _PARSE_LOCK:
        hit = _PARSE_CACHE.get(key)
        if hit and hit[0] == stamp:
            return hit[1]
    data = read_json(path, None)
    if not isinstance(data, dict):
        return None
    with _PARSE_LOCK:
        if len(_PARSE_CACHE) >= _PARSE_CACHE_MAX:
            _PARSE_CACHE.clear()
        _PARSE_CACHE[key] = (stamp, data)
    return data


def read_json(path: Path, fallback):
    try:
        with path.open("r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return fallback


def write_json(path: Path, payload) -> None:
    """Atomic write so a crash mid-save can't corrupt a chat."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + f".tmp{secrets.token_hex(4)}")
    try:
        with tmp.open("w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=1)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def settings_path() -> Path:
    return DATA / "settings.json"


def personas_path() -> Path:
    return DATA / "personas.json"


def get_settings() -> dict:
    with _LOCK:
        stored = read_json(settings_path(), {})
        merged = dict(DEFAULT_SETTINGS)
        merged.update({k: v for k, v in stored.items() if k in DEFAULT_SETTINGS})
        params = dict(DEFAULT_SETTINGS["default_params"])
        stored_params = stored.get("default_params")
        if isinstance(stored_params, dict):
            params.update(stored_params)        # anything else on disk is ignored
        merged["default_params"] = params
        return merged


def save_settings(patch: dict) -> dict:
    """
    Merge a settings patch, rejecting anything whose type does not match the
    default. A wrong type here is not cosmetic: writing a string into
    default_params made get_settings() raise on the next read, which took the
    whole app down until the file was repaired by hand.
    """
    if not isinstance(patch, dict):
        return get_settings()
    with _LOCK:
        current = get_settings()
        for key, value in patch.items():
            if key == "default_params":
                if isinstance(value, dict):
                    for pk, pv in value.items():
                        if pk == "stop":
                            if isinstance(pv, list):
                                current["default_params"]["stop"] = [
                                    str(x)[:80] for x in pv][:8]
                        elif pv is None or isinstance(pv, (int, float)) and not isinstance(pv, bool):
                            current["default_params"][pk] = pv
                continue
            if key == "observed_thinking":
                if isinstance(value, list):
                    current[key] = [str(v)[:200] for v in value][-64:]
                continue
            if key not in DEFAULT_SETTINGS:
                continue
            default = DEFAULT_SETTINGS[key]
            if default is None or value is None:
                current[key] = value            # nullable (default_model etc.)
            elif isinstance(default, bool):
                if isinstance(value, bool):
                    current[key] = value
            elif isinstance(default, int) and not isinstance(default, bool):
                if isinstance(value, int) and not isinstance(value, bool):
                    current[key] = value
            elif isinstance(value, type(default)):
                current[key] = value
        write_json(settings_path(), current)
        return current


def get_personas() -> list:
    with _LOCK:
        data = read_json(personas_path(), None)
        if not data or not data.get("personas"):
            now = time.time()
            seeded = []
            for item in SEED_PERSONAS:
                seeded.append({
                    "id": new_id("p"),
                    "name": item["name"],
                    "emoji": item["emoji"],
                    "prompt": item["prompt"],
                    "description": item.get("description", ""),
                    "model": None,
                    "params": {},
                    "think": None,
                    "created": now,
                    "updated": now,
                })
            write_json(personas_path(), {"personas": seeded})
            return seeded
        return data["personas"]


def save_personas(personas: list) -> list:
    with _LOCK:
        write_json(personas_path(), {"personas": personas})
        return personas


def chat_path(chat_id: str) -> Path:
    if not re.fullmatch(r"c_[A-Za-z0-9]+", chat_id or ""):
        raise ValueError("bad chat id")
    return CHATS / f"{chat_id}.json"


def load_chat(chat_id: str) -> dict | None:
    return read_json(chat_path(chat_id), None)


def save_chat(chat: dict) -> dict:
    with _LOCK:
        chat["updated"] = time.time()
        write_json(chat_path(chat["id"]), chat)
        return chat


def chat_summary(chat: dict) -> dict:
    messages = chat.get("messages") or []
    preview = ""
    for message in reversed(messages):
        # A tool result is raw JSON — never the sidebar preview for a chat.
        if message.get("role") == "tool":
            continue
        if message.get("content"):
            preview = " ".join(str(message["content"]).split())[:180]
            break
    return {
        "id": chat.get("id"),
        "title": chat.get("title") or "New chat",
        "created": chat.get("created"),
        "updated": chat.get("updated"),
        "pinned": bool(chat.get("pinned")),
        "archived": bool(chat.get("archived")),
        "model": chat.get("model"),
        "persona_id": chat.get("persona_id"),
        "message_count": len(messages),
        "preview": preview,
    }


def list_chats() -> list:
    ensure_dirs()
    out = []
    for path in CHATS.glob("c_*.json"):
        chat = read_chat_cached(path)
        if chat and chat.get("id"):
            out.append(chat_summary(chat))
    out.sort(key=lambda c: (not c["pinned"], -(c["updated"] or 0)))
    return out


def search_chats(query: str, limit: int = 60) -> list:
    needle = (query or "").strip().lower()
    if not needle:
        return []
    hits = []
    for path in CHATS.glob("c_*.json"):
        chat = read_chat_cached(path)
        if not chat:
            continue
        matches = []
        if needle in (chat.get("title") or "").lower():
            matches.append({"role": "title", "snippet": chat.get("title") or ""})
        for message in chat.get("messages") or []:
            body = str(message.get("content") or "")
            index = body.lower().find(needle)
            if index >= 0:
                start = max(0, index - 60)
                snippet = body[start:index + 140].replace("\n", " ")
                matches.append({
                    "role": message.get("role"),
                    "message_id": message.get("id"),
                    "snippet": ("…" if start else "") + snippet.strip(),
                })
            if len(matches) >= 4:
                break
        if matches:
            summary = chat_summary(chat)
            summary["matches"] = matches
            hits.append(summary)
    hits.sort(key=lambda c: -(c["updated"] or 0))
    return hits[:limit]


# --------------------------------------------------------------------------
# ollama
# --------------------------------------------------------------------------

_caps_cache: dict[str, dict] = {}
_caps_lock = threading.Lock()


def ollama_request(path: str, payload=None, method: str | None = None, timeout: int = 30):
    url = OLLAMA + path
    body = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(
        url, data=body, headers=headers, method=method or ("POST" if body else "GET")
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        raw = response.read()
    return json.loads(raw) if raw else {}


def model_details(name: str) -> dict:
    """Per-model capabilities. /api/tags under-reports these, so we ask /api/show."""
    with _caps_lock:
        cached = _caps_cache.get(name)
    if cached and time.time() - cached["at"] < 900:
        return cached["value"]
    value = {"capabilities": [], "context_length": None, "parameters": "", "system": ""}
    try:
        shown = ollama_request("/api/show", {"model": name}, timeout=20)
        info = shown.get("model_info") or {}
        ctx = None
        for key, val in info.items():
            if key.endswith(".context_length"):
                ctx = val
                break
        value = {
            "capabilities": shown.get("capabilities") or [],
            "context_length": ctx or (shown.get("details") or {}).get("context_length"),
            "parameters": shown.get("parameters") or "",
            "system": shown.get("system") or "",
        }
    except Exception:
        pass
    with _caps_lock:
        _caps_cache[name] = {"at": time.time(), "value": value}
    return value


def list_models() -> dict:
    tags = ollama_request("/api/tags", timeout=15)
    models = []
    for entry in tags.get("models") or []:
        name = entry.get("name") or entry.get("model")
        if not name:
            continue
        details = entry.get("details") or {}
        extra = model_details(name)
        caps = sorted(set((entry.get("capabilities") or []) + extra["capabilities"]))
        models.append({
            "name": name,
            "size": entry.get("size"),
            "modified_at": entry.get("modified_at"),
            "family": details.get("family"),
            "parameter_size": details.get("parameter_size"),
            "quantization": details.get("quantization_level"),
            "context_length": extra["context_length"] or details.get("context_length"),
            "capabilities": caps,
            "supports_thinking": "thinking" in caps,
            "supports_vision": "vision" in caps,
            "supports_tools": "tools" in caps,
            "default_system": extra["system"],
        })
    models.sort(key=lambda m: (m["name"] or "").lower())
    running = []
    try:
        for entry in (ollama_request("/api/ps", timeout=10).get("models") or []):
            running.append({
                "name": entry.get("name") or entry.get("model"),
                "size_vram": entry.get("size_vram"),
                "expires_at": entry.get("expires_at"),
            })
    except Exception:
        pass
    return {"models": models, "running": running, "host": OLLAMA}


def generate_title(model: str, transcript: str) -> str:
    prompt = (
        "Write a title for this conversation. Rules: 2 to 6 words, no quotes, "
        "no trailing punctuation, no the word 'chat'. Reply with the title only.\n\n"
        + transcript[:2000]
    )
    result = ollama_request(
        "/api/chat",
        {
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "stream": False,
            "think": False,
            "options": {"temperature": 0.2, "num_predict": 24},
        },
        timeout=120,
    )
    title = ((result.get("message") or {}).get("content") or "").strip()
    title = re.sub(r"<think>.*?</think>", "", title, flags=re.S).strip()
    title = title.splitlines()[0] if title else ""
    title = title.strip().strip("\"'*#").rstrip(".!,: ").strip()
    if len(title) > 60:
        title = title[:60].rsplit(" ", 1)[0] + "…"
    return title


# --------------------------------------------------------------------------
# tools
# --------------------------------------------------------------------------
#
# Tools run here, in this process, and only the ones in TOOLS can run at all.
# The client sends *names*, never schemas (see tool_specs), so a bug or an
# injected message in the front end cannot invent a callable. Each tool must be
# read-only, fast, and offline: no shell, no filesystem writes, no network. The
# execution loop lives in the client (chat.js) because it needs to stream each
# round into the thread; the round cap is advertised from here so both ends
# agree on it.

TOOL_ROUND_LIMIT = 4          # tool-executing rounds per reply, then answer only


def _tool_current_datetime(args: dict) -> dict:
    """Read this machine's clock. Optionally in another IANA timezone."""
    wanted = str(args.get("timezone") or "").strip()
    now = datetime.now().astimezone()
    note = ""
    if wanted:
        if ZoneInfo is None:
            note = "No timezone database on this machine; answered in local time."
        else:
            try:
                now = datetime.now(ZoneInfo(wanted))
            except Exception:
                note = f"Unknown timezone {wanted!r}; answered in local time instead."
    label = wanted if wanted and not note else (now.tzname() or "local")
    out = {
        "iso": now.isoformat(timespec="seconds"),
        "human": now.strftime("%A, %d %B %Y at %H:%M"),
        "date": now.strftime("%Y-%m-%d"),
        "time": now.strftime("%H:%M:%S"),
        "weekday": now.strftime("%A"),
        "timezone": label,
        "utc_offset": now.strftime("%z"),
        "unix": int(now.timestamp()),
        # popped by run_tool: the one-line summary the UI shows on the tool row
        "_display": f"{now.strftime('%a %d %b %Y, %H:%M')} ({label})",
    }
    if note:
        out["note"] = note
    return out


TOOLS = {
    "current_datetime": {
        "summary": "Reads the clock on this machine.",
        "spec": {
            "type": "function",
            "function": {
                "name": "current_datetime",
                "description": (
                    "Get the current date and time. Call this whenever the answer "
                    "depends on today's date, the current time, or the day of the "
                    "week — your own sense of 'now' is frozen at training time and "
                    "will be wrong."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "timezone": {
                            "type": "string",
                            "description": (
                                "IANA timezone name such as Europe/London or "
                                "Asia/Tokyo. Omit for this machine's local time."
                            ),
                        },
                    },
                    "required": [],
                },
            },
        },
        "run": _tool_current_datetime,
    },
}


def tool_catalog() -> list:
    """What the UI needs to describe the tools it can switch on."""
    out = []
    for name, tool in TOOLS.items():
        fn = tool["spec"]["function"]
        out.append({
            "name": name,
            "description": fn.get("description") or "",
            "summary": tool.get("summary") or "",
            "parameters": fn.get("parameters") or {},
        })
    return out


def tool_specs(names) -> list:
    """
    Resolve client-supplied tool names against the registry. Unknown names are
    dropped rather than errored — the point is that the client proposes and the
    server decides what the model is allowed to see.
    """
    specs = []
    seen = set()
    for name in (names if isinstance(names, list) else []):
        if not isinstance(name, str) or name in seen or name not in TOOLS:
            continue
        seen.add(name)
        specs.append(TOOLS[name]["spec"])
        if len(specs) >= 32:
            break
    return specs


def run_tool(name, arguments) -> dict:
    """
    Execute one registered tool.

    Never raises. A failure comes back as text for the model to read, because a
    model that is told what went wrong can correct itself on the next round,
    whereas a 500 here would kill an otherwise fine reply.
    """
    started = time.time()
    tool = TOOLS.get(name) if isinstance(name, str) else None
    if not tool:
        return {"ok": False, "name": str(name)[:80], "arguments": {},
                "content": f"Error: no tool named {name!r} is available.",
                "display": "unknown tool", "ms": 0}

    # Declared parameters only. Models pass stray keys often enough that
    # forwarding them into the implementation is not worth the surprise.
    props = ((tool["spec"]["function"].get("parameters") or {}).get("properties") or {})
    args = {}
    if isinstance(arguments, dict):
        for key, value in arguments.items():
            if key in props:
                args[key] = value

    try:
        result = tool["run"](args)
    except Exception as exc:
        return {"ok": False, "name": name, "arguments": args,
                "content": f"Error: {type(exc).__name__}: {exc}",
                "display": "failed", "ms": int((time.time() - started) * 1000)}

    display = ""
    if isinstance(result, dict):
        display = str(result.pop("_display", "") or "")
    return {"ok": True, "name": name, "arguments": args,
            "content": json.dumps(result, ensure_ascii=False),
            "display": display, "ms": int((time.time() - started) * 1000)}


# --------------------------------------------------------------------------
# http
# --------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "Lantern"
    sys_version = ""

    # -- plumbing ---------------------------------------------------------
    def log_message(self, fmt, *args):
        if os.environ.get("LANTERN_VERBOSE") or os.environ.get("SLATE_VERBOSE"):
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _send(self, code: int, body: bytes, ctype: str, extra: dict | None = None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def json_out(self, payload, code: int = 200):
        self._send(code, json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                   "application/json; charset=utf-8")

    def fail(self, code: int, message: str, hint: str = ""):
        self.json_out({"error": message, "hint": hint}, code)

    MAX_BODY = 64 * 1024 * 1024      # generous for base64 images, bounded

    def body_json(self) -> dict:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return {}
        if length <= 0:
            return {}
        if length > self.MAX_BODY:
            self.fail(413, "Request too large",
                      f"{length} bytes exceeds the {self.MAX_BODY} byte limit.")
            return {}
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, OSError):
            return {}

    def begin_stream(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
        self.send_header("Transfer-Encoding", "chunked")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()

    def stream_chunk(self, text: str):
        data = text.encode("utf-8")
        self.wfile.write(b"%x\r\n" % len(data) + data + b"\r\n")
        self.wfile.flush()

    def stream_json(self, obj):
        self.stream_chunk(json.dumps(obj, ensure_ascii=False) + "\n")

    def end_stream(self):
        try:
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        except OSError:
            pass

    # -- routing ----------------------------------------------------------
    def do_GET(self):
        self.route()

    def do_HEAD(self):
        self.route()

    def do_POST(self):
        self.route()

    def do_PUT(self):
        self.route()

    def do_DELETE(self):
        self.route()

    def guard(self) -> bool:
        """
        Reject requests a browser on another site could have forged.

        Without this, any page you visit while Lantern is running can issue a
        "simple" cross-origin POST (Content-Type: text/plain needs no CORS
        preflight) and hit /api/models/delete or /api/models/pull. Requests with
        no Origin at all are allowed so curl and scripts keep working.
        """
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0].strip().lower()
        if host and host not in ALLOWED_HOSTS:
            self.fail(403, "Refused: unexpected Host header",
                      f"{host!r} is not an allowed host for this server.")
            return False

        # Modern browsers state this outright; trust it when present.
        if (self.headers.get("Sec-Fetch-Site") or "").lower() in ("cross-site", "same-site"):
            self.fail(403, "Refused: cross-site request",
                      "Lantern only answers its own page.")
            return False

        origin = self.headers.get("Origin")
        if origin and origin.lower() != "null":
            try:
                hostname = (urllib.parse.urlparse(origin).hostname or "").lower()
            except ValueError:
                hostname = "?"
            if hostname not in LOOPBACK:
                self.fail(403, "Refused: cross-origin request",
                          f"Origin {origin} is not allowed.")
                return False
        return True

    def do_OPTIONS(self):
        # No CORS headers, deliberately: a failed preflight is the correct
        # answer for anything that is not our own page.
        self.fail(403, "Cross-origin requests are not supported")

    def route(self):
        if not self.guard():
            return
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)
        try:
            if path.startswith("/api/"):
                self.api(path, query)
            else:
                self.static(path)
        except BrokenPipeError:
            pass
        except ConnectionResetError:
            pass
        except Exception:
            traceback.print_exc()
            try:
                self.fail(500, "Internal error")
            except OSError:
                pass

    def static(self, path: str):
        rel = "index.html" if path in ("/", "") else path.lstrip("/")
        try:
            target = (STATIC / rel).resolve()
        except (OSError, ValueError):
            return self.fail(400, "Bad path")
        # Escaping static/ is a 404, never a fallback — falling back masked
        # traversal attempts behind a 200.
        if not target.is_relative_to(STATIC):
            return self.fail(404, "Not found")
        if not target.is_file():
            target = STATIC / "index.html"
            if not target.is_file():
                return self.fail(404, "static/ is missing")
        ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "image/svg+xml"):
            ctype += "; charset=utf-8"
        self._send(200, target.read_bytes(), ctype)

    def api(self, path: str, query: dict):
        method = self.command
        parts = [p for p in path.split("/") if p][1:]  # drop "api"

        # ---- identity ----------------------------------------------------
        # Cheap marker so a launcher can tell "Slate is already on this port"
        # apart from "something else owns this port".
        if parts == ["ping"] and method == "GET":
            return self.json_out({"app": "lantern", "data_dir": str(DATA), "ollama": OLLAMA})

        # ---- bootstrap ---------------------------------------------------
        if parts == ["bootstrap"] and method == "GET":
            payload = {
                "settings": get_settings(),
                "personas": get_personas(),
                "chats": list_chats(),
                "tools": tool_catalog(),
                "tool_round_limit": TOOL_ROUND_LIMIT,
                "host": OLLAMA,
                "data_dir": str(DATA),
            }
            try:
                payload.update(list_models())
                payload["ollama_ok"] = True
            except Exception as exc:
                payload["models"] = []
                payload["running"] = []
                payload["ollama_ok"] = False
                payload["ollama_error"] = str(exc)
            return self.json_out(payload)

        # ---- models ------------------------------------------------------
        if parts == ["models"] and method == "GET":
            try:
                return self.json_out(list_models())
            except Exception as exc:
                return self.fail(503, f"Cannot reach Ollama at {OLLAMA}", str(exc))

        if parts == ["models", "refresh"] and method == "POST":
            with _caps_lock:
                _caps_cache.clear()
            try:
                return self.json_out(list_models())
            except Exception as exc:
                return self.fail(503, f"Cannot reach Ollama at {OLLAMA}", str(exc))

        if parts == ["models", "pull"] and method == "POST":
            return self.pull_model(self.body_json())

        if parts == ["models", "delete"] and method == "POST":
            name = (self.body_json().get("model") or "").strip()
            if not name:
                return self.fail(400, "model required")
            try:
                ollama_request("/api/delete", {"model": name}, method="DELETE", timeout=60)
                with _caps_lock:
                    _caps_cache.pop(name, None)
                return self.json_out({"ok": True})
            except Exception as exc:
                return self.fail(502, "Delete failed", str(exc))

        if parts == ["models", "unload"] and method == "POST":
            name = (self.body_json().get("model") or "").strip()
            if not name:
                return self.fail(400, "model required")
            try:
                ollama_request("/api/generate", {"model": name, "keep_alive": 0}, timeout=30)
                return self.json_out({"ok": True})
            except Exception as exc:
                return self.fail(502, "Unload failed", str(exc))

        if parts == ["models", "load"] and method == "POST":
            # An empty /api/generate call just resident-loads the model, which
            # is what removes the stall on the first message after a pause.
            body = self.body_json()
            name = (body.get("model") or "").strip()
            if not name:
                return self.fail(400, "model required")
            payload = {"model": name}
            if body.get("keep_alive") not in (None, ""):
                payload["keep_alive"] = body["keep_alive"]
            try:
                ollama_request("/api/generate", payload, timeout=600)
                return self.json_out({"ok": True})
            except Exception as exc:
                return self.fail(502, "Preload failed", str(exc))

        # ---- tools -------------------------------------------------------
        if parts == ["tools"] and method == "GET":
            return self.json_out({"tools": tool_catalog(),
                                  "round_limit": TOOL_ROUND_LIMIT})

        if parts == ["tools", "call"] and method == "POST":
            body = self.body_json()
            return self.json_out(run_tool(body.get("name"), body.get("arguments")))

        # ---- chat streaming ----------------------------------------------
        if parts == ["chat"] and method == "POST":
            return self.proxy_chat(self.body_json())

        if parts == ["title"] and method == "POST":
            body = self.body_json()
            try:
                return self.json_out({"title": generate_title(
                    body.get("model") or "", body.get("transcript") or "")})
            except Exception as exc:
                return self.fail(502, "Title generation failed", str(exc))

        # ---- settings ----------------------------------------------------
        if parts == ["settings"]:
            if method == "GET":
                return self.json_out(get_settings())
            if method in ("PUT", "POST"):
                return self.json_out(save_settings(self.body_json()))

        # ---- personas ----------------------------------------------------
        if parts == ["personas"]:
            if method == "GET":
                return self.json_out({"personas": get_personas()})
            if method == "POST":
                body = self.body_json()
                now = time.time()
                persona = {
                    "id": new_id("p"),
                    "name": (body.get("name") or "Untitled").strip()[:80],
                    "emoji": (body.get("emoji") or "\U0001f4ac")[:8],
                    "prompt": body.get("prompt") or "",
                    "description": (body.get("description") or "")[:200],
                    "model": body.get("model"),
                    "params": body.get("params") or {},
                    "think": body.get("think"),
                    "created": now,
                    "updated": now,
                }
                personas = get_personas()
                personas.append(persona)
                save_personas(personas)
                return self.json_out(persona, 201)

        if len(parts) == 2 and parts[0] == "personas":
            pid = parts[1]
            personas = get_personas()
            index = next((i for i, p in enumerate(personas) if p["id"] == pid), None)
            if index is None:
                return self.fail(404, "No such persona")
            if method in ("PUT", "PATCH"):
                body = self.body_json()
                persona = personas[index]
                for key in ("name", "emoji", "prompt", "description", "model", "params", "think"):
                    if key in body:
                        persona[key] = body[key]
                persona["updated"] = time.time()
                save_personas(personas)
                return self.json_out(persona)
            if method == "DELETE":
                removed = personas.pop(index)
                save_personas(personas)
                settings = get_settings()
                if settings.get("default_persona") == pid:
                    save_settings({"default_persona": None})
                return self.json_out({"ok": True, "removed": removed["id"]})

        # ---- backup / restore --------------------------------------------
        if parts == ["backup"] and method == "GET":
            ensure_dirs()
            chats = []
            for path in sorted(CHATS.glob("c_*.json")):
                chat = read_chat_cached(path)
                if chat and chat.get("id"):
                    chats.append(chat)
            return self.json_out({
                "lantern_backup": 1,
                "exported": time.time(),
                "settings": get_settings(),
                "personas": get_personas(),
                "chats": chats,
            })

        if parts == ["restore"] and method == "POST":
            body = self.body_json()
            if body.get("lantern_backup") != 1:
                return self.fail(400, "Not a Lantern backup",
                                 "The file is missing the lantern_backup marker.")
            mode = body.get("mode") or "merge"        # merge | replace
            ensure_dirs()
            added = skipped = 0
            with _LOCK:
                if mode == "replace":
                    for path in CHATS.glob("c_*.json"):
                        path.unlink(missing_ok=True)
                    with _PARSE_LOCK:
                        _PARSE_CACHE.clear()
                incoming = body.get("chats")
                for chat in (incoming if isinstance(incoming, list) else []):
                    if not isinstance(chat, dict):
                        skipped += 1
                        continue
                    cid = chat.get("id") or ""
                    if not re.fullmatch(r"c_[A-Za-z0-9]+", cid):
                        skipped += 1
                        continue
                    target = CHATS / f"{cid}.json"
                    if target.exists() and mode != "replace":
                        skipped += 1        # never clobber an existing chat on merge
                        continue
                    write_json(target, chat)
                    added += 1
                if isinstance(body.get("personas"), list) and body["personas"]:
                    save_personas(body["personas"])
                if isinstance(body.get("settings"), dict):
                    save_settings(body["settings"])
            with _PARSE_LOCK:
                _PARSE_CACHE.clear()
            return self.json_out({"ok": True, "added": added, "skipped": skipped})

        # ---- chats -------------------------------------------------------
        if parts == ["chats"]:
            if method == "GET":
                return self.json_out({"chats": list_chats()})
            if method == "POST":
                body = self.body_json()
                if not isinstance(body, dict):
                    body = {}
                now = time.time()
                settings = get_settings()
                chat = {
                    "id": new_id("c"),
                    "title": body.get("title") or "",
                    "created": now,
                    "updated": now,
                    "pinned": False,
                    "archived": False,
                    "model": body.get("model") or settings.get("default_model"),
                    "persona_id": body.get("persona_id", settings.get("default_persona")),
                    "system_override": body.get("system_override"),
                    "think": body.get("think", False),
                    "tools": bool(body.get("tools")),
                    "params": body.get("params") if isinstance(body.get("params"), dict) else {},
                    "messages": body.get("messages") if isinstance(body.get("messages"), list) else [],
                }
                save_chat(chat)
                return self.json_out(chat, 201)

        if parts == ["chats", "search"] and method == "GET":
            return self.json_out({"results": search_chats((query.get("q") or [""])[0])})

        # sendBeacon can only issue POST, so page-teardown saves land here
        if len(parts) == 3 and parts[0] == "chats" and parts[2] == "save" and method == "POST":
            try:
                chat_path(parts[1])
            except ValueError:
                return self.fail(400, "Bad chat id")
            chat = load_chat(parts[1])
            if not chat:
                return self.fail(404, "No such chat")
            body = self.body_json()
            for key in ("title", "pinned", "archived", "model", "persona_id",
                        "system_override", "think", "tools", "params", "messages"):
                if key in body:
                    chat[key] = body[key]
            save_chat(chat)
            return self.json_out({"ok": True})

        if len(parts) == 2 and parts[0] == "chats":
            try:
                cid = parts[1]
                chat_path(cid)
            except ValueError:
                return self.fail(400, "Bad chat id")
            if method == "GET":
                chat = load_chat(cid)
                return self.json_out(chat) if chat else self.fail(404, "No such chat")
            if method in ("PUT", "PATCH"):
                chat = load_chat(cid)
                if not chat:
                    return self.fail(404, "No such chat")
                body = self.body_json()
                for key in ("title", "pinned", "archived", "model", "persona_id",
                            "system_override", "think", "tools", "params", "messages"):
                    if key in body:
                        chat[key] = body[key]
                return self.json_out(save_chat(chat))
            if method == "DELETE":
                path_obj = chat_path(cid)
                existed = path_obj.exists()
                path_obj.unlink(missing_ok=True)
                return self.json_out({"ok": True, "existed": existed})

        return self.fail(404, f"No route for {method} {path}")

    # -- streaming proxies ------------------------------------------------
    def proxy_chat(self, body: dict):
        """Forward to Ollama /api/chat and relay NDJSON straight through."""
        model = body.get("model")
        messages = body.get("messages")
        if not model or not isinstance(messages, list):
            return self.fail(400, "model and messages are required")

        payload: dict = {"model": model, "messages": messages, "stream": True}

        think = body.get("think")
        if think is not None and think is not False:
            payload["think"] = think
        elif think is False:
            payload["think"] = False

        # Whitelist: the client is same-origin, but an unbounded passthrough
        # means any future UI bug can send Ollama arbitrary runner options.
        allowed = {
            "temperature", "top_p", "top_k", "min_p", "typical_p", "repeat_penalty",
            "repeat_last_n", "presence_penalty", "frequency_penalty", "penalize_newline",
            "num_ctx", "num_predict", "num_keep", "seed", "stop", "num_gpu",
            "num_thread", "num_batch", "main_gpu", "use_mmap", "use_mlock", "mirostat",
            "mirostat_tau", "mirostat_eta",
        }
        options = {}
        for key, value in (body.get("options") or {}).items():
            if key not in allowed or value is None or value == "" or value == []:
                continue
            options[key] = value
        if options:
            payload["options"] = options
        if body.get("keep_alive") is not None:
            payload["keep_alive"] = body["keep_alive"]
        if body.get("format"):
            payload["format"] = body["format"]

        # The client asks for tools by name; the schema comes from our registry.
        # Never accept a caller-supplied schema — that would let the front end
        # describe callables the server has no implementation for.
        specs = tool_specs(body.get("tools"))
        if specs:
            payload["tools"] = specs

        request = urllib.request.Request(
            OLLAMA + "/api/chat",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )

        try:
            upstream = urllib.request.urlopen(request, timeout=600)
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:600]
            try:
                detail = json.loads(detail).get("error", detail)
            except ValueError:
                pass
            # A "does not support thinking" style error is worth retrying without it.
            if "think" in payload and "think" in detail.lower():
                payload.pop("think", None)
                try:
                    upstream = urllib.request.urlopen(
                        urllib.request.Request(
                            OLLAMA + "/api/chat",
                            data=json.dumps(payload).encode("utf-8"),
                            headers={"Content-Type": "application/json"},
                            method="POST",
                        ),
                        timeout=600,
                    )
                except Exception as exc2:
                    return self.fail(502, "Ollama rejected the request", str(exc2))
            else:
                return self.fail(exc.code if exc.code >= 400 else 502,
                                 "Ollama rejected the request", detail)
        except urllib.error.URLError as exc:
            return self.fail(503, f"Cannot reach Ollama at {OLLAMA}",
                             f"{exc.reason}. Is `ollama serve` running?")

        self.begin_stream()
        try:
            with upstream:
                for line in upstream:
                    if not line.strip():
                        continue
                    self.stream_chunk(line.decode("utf-8", "replace"))
        except (BrokenPipeError, ConnectionResetError):
            # Client hit Stop. Closing upstream tells Ollama to abandon the run.
            try:
                upstream.close()
            except Exception:
                pass
            return
        except Exception as exc:
            try:
                self.stream_json({"error": str(exc), "done": True})
            except OSError:
                pass
        self.end_stream()

    def pull_model(self, body: dict):
        name = (body.get("model") or "").strip()
        if not name:
            return self.fail(400, "model required")
        request = urllib.request.Request(
            OLLAMA + "/api/pull",
            data=json.dumps({"model": name, "stream": True}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            upstream = urllib.request.urlopen(request, timeout=30)
        except Exception as exc:
            return self.fail(502, "Pull failed to start", str(exc))
        self.begin_stream()
        try:
            with upstream:
                for line in upstream:
                    if line.strip():
                        self.stream_chunk(line.decode("utf-8", "replace"))
        except (BrokenPipeError, ConnectionResetError):
            return
        except Exception as exc:
            try:
                self.stream_json({"error": str(exc)})
            except OSError:
                pass
        with _caps_lock:
            _caps_cache.clear()
        self.end_stream()


def watch_parent() -> None:
    """
    Exit if whoever launched us goes away.

    The native host kills this process on quit, but that only covers a clean
    exit — a crash or SIGKILL would leave the server running and holding the
    port. When the parent dies we get reparented (to launchd), which is a
    reliable signal no matter how the parent died.
    """
    original = os.getppid()
    if original <= 1:
        return
    while True:
        time.sleep(2)
        if os.getppid() != original:
            os._exit(0)


def main() -> int:
    parser = argparse.ArgumentParser(description="Lantern - local LLM interface for Ollama")
    parser.add_argument("--port", type=int,
                    default=int(os.environ.get("LANTERN_PORT",
                                os.environ.get("SLATE_PORT", 8777))))
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--open", action="store_true", help="open a browser on start")
    args = parser.parse_args()

    ensure_dirs()
    get_personas()

    # Binding beyond loopback is opt-in; keep that host reachable but say so.
    if args.host not in LOOPBACK:
        ALLOWED_HOSTS.add(args.host.lower())
        print(f"  WARNING    bound to {args.host} — reachable off this machine")

    if os.environ.get("LANTERN_WATCH_PARENT"):
        threading.Thread(target=watch_parent, daemon=True).start()

    try:
        server = ThreadingHTTPServer((args.host, args.port), Handler)
    except OSError as exc:
        print(f"Cannot bind {args.host}:{args.port} - {exc}", file=sys.stderr)
        print("Try a different port:  python3 server.py --port 8888", file=sys.stderr)
        return 1
    server.daemon_threads = True

    # --port 0 lets the OS pick a free one; the native wrapper reads this line
    # rather than racing us to probe ports itself.
    port = server.server_address[1]
    print(f"LANTERN_PORT={port}", flush=True)

    url = f"http://{args.host}:{port}"
    reachable = True
    try:
        ollama_request("/api/tags", timeout=4)
    except Exception:
        reachable = False

    print(f"  Lantern    {url}")
    print(f"  Ollama     {OLLAMA}  {'ok' if reachable else 'UNREACHABLE - run `ollama serve`'}")
    print(f"  Data       {DATA}")
    print("  Ctrl+C to stop\n")

    if args.open:
        import webbrowser
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")
    finally:
        server.shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

// Thread rendering and the generation loop.

import {
  S, emit, on, msgId, queueSaveChat, queueSaveFor, saveNow, currentModel, currentPersona,
  effectiveSystem, effectiveParams, effectiveThink, modelInfo, newChat,
  noteThinkingObserved, isStreaming, beginRun, endRun, abortRun, thinkingSupported,
} from './store.js';
import { api, chatStream } from './api.js';
import { renderMarkdown, wireCodeBlocks } from './markdown.js';
import {
  $, el, svg, ICON, escapeHtml, copyText, toast, dur, num,
  shortModel, estTokens, download, autosize,
} from './util.js';

const scrollBox = () => $('#scroll');
const threadBox = () => $('#thread');

let stickToBottom = true;

/* ─────────────────────────── rendering ─────────────────────────── */

/**
 * @param {boolean} force  jump to the bottom regardless of where the user is.
 *   Chat switches force; a finishing reply must not — scrolling up to re-read
 *   while a reply streamed used to snap you back the instant it ended.
 */
export function renderThread(force = false) {
  const thread = threadBox();
  const empty = $('#empty');
  thread.textContent = '';

  const messages = S.chat?.messages || [];
  if (!messages.length) {
    empty.hidden = false;
    updateEmptyState();
    updateFoot();
    return;
  }
  empty.hidden = true;

  messages.forEach((message, index) => {
    thread.append(buildMessage(message, index));
  });
  wireCodeBlocks(thread);
  updateFoot();
  if (force || stickToBottom) scrollToBottom(true);
}

function updateEmptyState() {
  const persona = currentPersona();
  const model = currentModel();
  const info = modelInfo(model);
  const bits = [];
  if (model) bits.push(shortModel(model));
  if (persona && persona.prompt) bits.push(`${persona.emoji} ${persona.name}`);
  if (info?.supports_vision) bits.push('vision');
  $('#empty-sub').textContent = bits.length
    ? bits.join('  ·  ')
    : 'Local chat over Ollama.';

  const starters = $('#starters');
  starters.textContent = '';
  const suggestions = [
    ['Explain a concept', 'Explain how HTTP keep-alive works, with a diagram.'],
    ['Write code', 'Write a Python function that debounces another function.'],
    ['Review my text', 'Tighten this paragraph without changing my voice:\n\n'],
    ['Think it through', 'Three servers, one flaky. How would you find the bad one?'],
  ];
  for (const [label, prompt] of suggestions) {
    starters.append(el('button', {
      class: 'starter',
      onclick: () => {
        const input = $('#input');
        input.value = prompt;
        input.focus();
        input.setSelectionRange(prompt.length, prompt.length);
        autosize(input);
      },
    }, el('b', { text: label }), el('span', { text: prompt.split('\n')[0].slice(0, 62) })));
  }
}

function buildMessage(message, index) {
  const isUser = message.role === 'user';
  const wrap = el('div', {
    class: `msg msg-${message.role}`,
    dataset: { id: message.id, index: String(index) },
  });

  if (!isUser) {
    const info = modelInfo(message.model);
    wrap.append(el('div', { class: 'msg-head' },
      el('span', { text: 'Assistant' }),
      message.model ? el('span', { class: 'mh-model', text: shortModel(message.model) }) : null,
      message.persona_name ? el('span', { text: `· ${message.persona_name}` }) : null,
    ));
  }

  if (message.images?.length) {
    const imgs = el('div', { class: 'msg-imgs' });
    for (const data of message.images) {
      imgs.append(el('img', { src: `data:image/*;base64,${data}`, alt: 'attachment' }));
    }
    wrap.append(imgs);
  }

  if (!isUser && (message.thinking || message.thinkingPending)) {
    wrap.append(buildThinkBox(message));
  }

  const bubble = el('div', { class: 'bubble' });
  if (isUser) {
    bubble.textContent = message.content || '';
  } else if (message.error) {
    bubble.append(el('div', { class: 'msg-err' },
      el('div', { text: message.error }),
      el('button', {
        class: 'btn btn-ghost', style: 'margin-top:9px',
        html: `${svg(ICON.redo, 'ic')}<span>Retry</span>`,
        onclick: () => regenerate(index),
      })));
  } else if (!message.content && message.pending) {
    bubble.append(el('div', { class: 'dots' }, el('i'), el('i'), el('i')));
  } else {
    const body = el('div', { class: 'md' });
    body.innerHTML = S.settings?.render_markdown === false
      ? `<p>${escapeHtml(message.content || '')}</p>`
      : renderMarkdown(message.content || '');
    bubble.append(body);
  }
  wrap.append(bubble);
  wrap.append(buildActions(message, index));
  return wrap;
}

function buildThinkBox(message) {
  const live = !!message.thinkingPending;
  const open = live ? (S.settings?.thinking_open ?? false) : false;
  const box = el('div', {
    class: `think-box${live ? ' live' : ''}${open ? ' open' : ''}`,
    dataset: { role: 'think' },
  });
  const head = el('button', { class: 'think-head' },
    el('span', { class: 'caret', html: svg(ICON.caret, 'ic ic-sm') }),
    el('span', { html: svg(ICON.brain, 'ic ic-sm') }),
    el('span', {
      class: live ? 'shimmer' : '',
      text: live ? 'Thinking…' : 'Thought process',
      dataset: { role: 'think-label' },
    }),
    el('span', {
      class: 'dur',
      dataset: { role: 'think-dur' },
      text: message.thinkMs ? formatMs(message.thinkMs) : '',
    }),
  );
  head.addEventListener('click', () => box.classList.toggle('open'));
  const body = el('div', { class: 'think-body', dataset: { role: 'think-body' } });
  body.textContent = message.thinking || '';
  box.append(head, body);
  return box;
}

const formatMs = (ms) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

function buildActions(message, index) {
  const acts = el('div', { class: 'msg-acts' });
  const add = (icon, label, title, fn) => {
    acts.append(el('button', { class: 'act', title, onclick: fn },
      el('span', { html: svg(icon, 'ic') }), label ? el('span', { text: label }) : null));
  };

  add(ICON.copy, '', 'Copy message', async (event) => {
    const ok = await copyText(message.content || '');
    const button = event.currentTarget;
    button.innerHTML = svg(ICON.check, 'ic');
    toast(ok ? 'Copied' : 'Copy failed', ok ? '' : 'bad');
    setTimeout(() => { button.innerHTML = svg(ICON.copy, 'ic'); }, 1200);
  });

  if (message.role === 'user') {
    add(ICON.edit, '', 'Edit and resend', () => startEdit(message, index));
  } else {
    add(ICON.redo, '', 'Regenerate', () => regenerate(index));
    add(ICON.swap, '', 'Regenerate with another model…',
      (event) => regenerateWith(index, event.currentTarget));
    add(ICON.branch, '', 'Branch a new chat from here', () => branchFrom(index));
  }
  add(ICON.trash, '', 'Delete message', () => deleteMessage(index));

  if (message.stats && S.settings?.show_stats !== false) {
    const { eval_count: tokens, eval_duration: ns, prompt_eval_count: promptTokens } = message.stats;
    const rate = tokens && ns ? (tokens / (ns / 1e9)).toFixed(1) : null;
    const parts = [];
    if (rate) parts.push(`${rate} tok/s`);
    if (message.ttftMs != null) parts.push(`${formatMs(message.ttftMs)} to first token`);
    if (tokens) parts.push(`${num(tokens)} out`);
    if (promptTokens) parts.push(`${num(promptTokens)} in`);
    if (message.stats.total_duration) parts.push(dur(message.stats.total_duration));
    if (parts.length) acts.append(el('span', { class: 'msg-stats', text: parts.join(' · ') }));
  }
  return acts;
}

/* ─────────────────────────── message actions ─────────────────────────── */

/** Small menu anchored under a button. Used by "regenerate with another model". */
function popupMenu(anchor, items) {
  document.querySelectorAll('.floating-menu').forEach((m) => m.remove());
  const menu = el('div', { class: 'menu floating-menu' });
  // One close path for both routes. Removing the node without unbinding leaked
  // a document-level listener (and the menu it captured) on every use.
  let close = () => {};
  for (const item of items) {
    menu.append(el('button', {
      class: `menu-item${item.on ? ' on' : ''}`,
      onclick: () => { close(); item.run(); },
    },
      el('span', { class: 'mi-body' },
        el('span', { class: 'mi-title', text: item.title }),
        item.sub ? el('span', { class: 'mi-sub', text: item.sub }) : null)));
  }
  menu.style.position = 'fixed';
  menu.style.visibility = 'hidden';
  document.body.append(menu);
  const rect = anchor.getBoundingClientRect();
  const height = menu.offsetHeight;
  // flip above the button when there is no room below
  const top = rect.bottom + 6 + height > window.innerHeight ? rect.top - height - 6 : rect.bottom + 6;
  menu.style.top = `${Math.max(8, top)}px`;
  menu.style.left = `${Math.min(rect.left, window.innerWidth - menu.offsetWidth - 10)}px`;
  menu.style.visibility = '';
  const dismiss = (event) => { if (!menu.contains(event.target)) close(); };
  close = () => {
    menu.remove();
    document.removeEventListener('mousedown', dismiss, true);
    window.removeEventListener('resize', close);
  };
  setTimeout(() => {
    document.addEventListener('mousedown', dismiss, true);
    window.addEventListener('resize', close);
  }, 0);
}

/** Re-run this turn on a different model. The chat keeps that model afterwards. */
function regenerateWith(index, anchor) {
  const chat = S.chat;
  if (!chat || isStreaming(chat.id)) return;
  const current = currentModel(chat);
  popupMenu(anchor, S.models.map((m) => ({
    title: shortModel(m.name),
    sub: m.name === current ? 'current model' : (m.parameter_size || ''),
    on: m.name === current,
    run: async () => {
      chat.model = m.name;
      if (!thinkingSupported(m.name)) chat.think = false;
      emit('model-changed');
      await regenerate(index);
    },
  })));
}

function startEdit(message, index) {
  const node = threadBox().querySelector(`.msg[data-id="${message.id}"]`);
  if (!node) return;
  const box = el('div', { class: 'msg-edit', style: 'width:100%' });
  const ta = el('textarea');
  ta.value = message.content || '';
  const acts = el('div', { class: 'edit-acts' },
    el('button', { class: 'btn btn-ghost', text: 'Cancel', onclick: () => renderThread() }),
    el('button', {
      class: 'btn btn-primary',
      text: 'Save & resend',
      onclick: async () => {
        const text = ta.value.trim();
        if (!text) return;
        const chat = S.chat;
        if (isStreaming(chat.id)) return;
        message.content = text;
        chat.messages.length = index + 1;
        await queueSaveFor(chat, true);
        renderThread();
        runAssistant(chat);
      },
    }),
  );
  box.append(ta, acts);
  node.textContent = '';
  node.append(box);
  ta.focus();
  ta.style.height = `${Math.min(ta.scrollHeight, 400)}px`;
  ta.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') renderThread();
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) acts.lastChild.click();
  });
}

async function regenerate(index) {
  const chat = S.chat;
  if (!chat || isStreaming(chat.id)) return;
  chat.messages.length = index;   // drop this assistant turn and anything after
  await queueSaveFor(chat, true);
  renderThread();
  runAssistant(chat);
}

async function deleteMessage(index) {
  const chat = S.chat;
  // Removing a message while this chat streams would shift the indices the
  // in-flight run is writing against.
  if (!chat || isStreaming(chat.id)) {
    toast('Wait for the reply to finish', 'bad');
    return;
  }
  chat.messages.splice(index, 1);
  await queueSaveFor(chat, true);
  renderThread();
}

async function branchFrom(index) {
  const source = S.chat;
  const slice = source.messages.slice(0, index + 1).map((m) => ({ ...m }));
  const chat = await newChat({ model: source.model, personaId: source.persona_id, focus: false });
  chat.messages = slice;
  chat.title = `${source.title || 'Chat'} ↗`;
  chat.think = source.think;
  chat.params = { ...source.params };
  chat.system_override = source.system_override;
  await queueSaveChat(true);
  emit('chat', { focus: true });
  toast('Branched to a new chat');
}

/* ─────────────────────────── sending ─────────────────────────── */

export async function sendMessage(text) {
  const trimmed = (text || '').trim();
  const attachments = S.attachments.slice();
  if (!trimmed && !attachments.length) return;

  if (!S.chat) await newChat({ focus: false });
  const chat = S.chat;
  // Only this conversation being busy blocks a send; other chats may stream.
  if (isStreaming(chat.id)) {
    toast('This chat is still replying', 'bad');
    return;
  }

  let content = trimmed;
  const images = [];
  for (const att of attachments) {
    if (att.kind === 'image') images.push(att.data);
    else content += `\n\n${att.name}:\n\`\`\`${att.lang || ''}\n${att.text}\n\`\`\``;
  }

  const message = {
    id: msgId(),
    role: 'user',
    content: content.trim(),
    ts: Date.now() / 1000,
  };
  if (images.length) message.images = images;

  chat.messages.push(message);
  S.attachments = [];
  emit('attachments');
  renderThread();
  await queueSaveFor(chat);
  await runAssistant(chat);
}

/** Build the message array Ollama receives. */
function buildPayloadMessages(chat) {
  const messages = [];
  const system = effectiveSystem(chat);
  if (system && system.trim()) messages.push({ role: 'system', content: system });
  for (const message of chat.messages) {
    if (message.error && !message.content) continue;
    if (message.role === 'assistant' && !message.content) continue;
    const out = { role: message.role, content: message.content || '' };
    if (message.images?.length) out.images = message.images;
    messages.push(out);
  }
  return messages;
}

export async function runAssistant(chat = S.chat) {
  if (!chat || isStreaming(chat.id)) return;
  const model = currentModel(chat);
  if (!model) {
    toast('No model selected — pull one from the Models panel', 'bad');
    return;
  }
  const visible = () => S.chat?.id === chat.id;

  const persona = currentPersona(chat);
  const placeholder = {
    id: msgId(),
    role: 'assistant',
    content: '',
    thinking: '',
    ts: Date.now() / 1000,
    model,
    persona_name: persona && persona.prompt ? persona.name : null,
    pending: true,
  };
  const think = effectiveThink(chat);
  if (think) placeholder.thinkingPending = true;

  chat.messages.push(placeholder);
  if (visible()) renderThread();

  const abort = new AbortController();
  beginRun(chat, placeholder.id, abort);

  const painter = makePainter(chat, placeholder);
  const started = performance.now();
  let firstTokenAt = null;      // real TTFT: request sent -> first output of any kind
  let firstThinkAt = null;
  let lastThinkAt = null;
  let stats = null;
  let sawContent = false;

  try {
    const body = {
      model,
      messages: buildPayloadMessages(chat),
      options: effectiveParams(chat),
    };
    if (S.settings?.keep_alive) body.keep_alive = S.settings.keep_alive;
    // null means "don't send the field at all" — see effectiveThink().
    if (think !== null) body.think = think;

    for await (const chunk of chatStream(body, abort.signal)) {
      if (chunk.error) throw new Error(chunk.error);
      const part = chunk.message || {};

      if ((part.thinking || part.content) && firstTokenAt === null) {
        firstTokenAt = performance.now();
        placeholder.ttftMs = Math.round(firstTokenAt - started);
      }
      if (part.thinking) {
        if (firstThinkAt === null) {
          firstThinkAt = performance.now();
          // First time we have seen this model reason: remember it so the
          // toggle appears, and keep it on so behaviour stays consistent.
          if (noteThinkingObserved(model)) {
            chat.think = true;
            queueSaveFor(chat);
            if (visible()) emit('model-changed');
          }
        }
        lastThinkAt = performance.now();
        placeholder.thinking += part.thinking;
        placeholder.thinkingPending = true;
        painter.think();
      }
      if (part.content) {
        if (!sawContent) {
          sawContent = true;
          placeholder.pending = false;
          if (placeholder.thinkingPending) {
            placeholder.thinkingPending = false;
            placeholder.thinkMs = firstThinkAt !== null
              ? Math.round((lastThinkAt || performance.now()) - firstThinkAt) : 0;
            painter.finishThink();
          }
        }
        placeholder.content += part.content;
        painter.body();
      }
      if (chunk.done) {
        stats = {
          eval_count: chunk.eval_count,
          eval_duration: chunk.eval_duration,
          prompt_eval_count: chunk.prompt_eval_count,
          prompt_eval_duration: chunk.prompt_eval_duration,
          total_duration: chunk.total_duration,
          done_reason: chunk.done_reason,
        };
      }
    }

    placeholder.pending = false;
    placeholder.thinkingPending = false;
    if (placeholder.thinking && !placeholder.thinkMs) {
      placeholder.thinkMs = firstThinkAt !== null
        ? Math.round((lastThinkAt || performance.now()) - firstThinkAt) : 0;
    }
    placeholder.stats = stats || { total_duration: (performance.now() - started) * 1e6 };
    if (!placeholder.content && !placeholder.thinking) {
      placeholder.error = 'The model returned an empty response.';
    }
  } catch (err) {
    placeholder.pending = false;
    placeholder.thinkingPending = false;
    if (err.name === 'AbortError') {
      placeholder.stopped = true;
      if (!placeholder.content && !placeholder.thinking) {
        // splice in place — other code holds a reference to this array
        const at = chat.messages.indexOf(placeholder);
        if (at >= 0) chat.messages.splice(at, 1);
      }
    } else {
      placeholder.error = err.hint ? `${err.message} — ${err.hint}` : err.message;
      console.error(err);
    }
  } finally {
    painter.stop();
    endRun(chat.id);
    if (visible()) renderThread();
    else emit('chats');
    await saveNow(chat);
    maybeAutoTitle(chat);
  }
}

export function stopGeneration(chatId = S.chat?.id) {
  if (abortRun(chatId)) toast('Stopped');
}

/**
 * Throttled incremental DOM updates. Markdown is re-rendered without syntax
 * highlighting while tokens stream (highlighting the whole buffer on every
 * chunk gets expensive fast); the final pass in renderThread() adds it back.
 */
function makePainter(chat, message) {
  let raf = null;
  let lastPaint = 0;
  let bodyDirty = false;
  let thinkDirty = false;
  const INTERVAL = 55;

  // Re-rendering the whole buffer each frame is O(n) per paint and so O(n²)
  // over a reply — a 20k-character answer was ~16M character operations. The
  // prefix up to the last blank line outside a code fence is stable, so render
  // it once, cache the HTML, and re-parse only the tail. renderThread() does a
  // full single-pass render with highlighting at the end, which corrects any
  // block that a split happened to interrupt.
  let prefixLen = 0;
  let prefixHtml = '';

  function fenceParityEven(text, upto) {
    let count = 0;
    for (let i = text.indexOf('```'); i >= 0 && i < upto; i = text.indexOf('```', i + 3)) count++;
    return count % 2 === 0;
  }

  function renderStreaming(content) {
    if (S.settings?.render_markdown === false) return `<p>${escapeHtml(content)}</p>`;
    const cut = content.lastIndexOf('\n\n', content.length - 1);
    if (cut > prefixLen && fenceParityEven(content, cut)) {
      const end = cut + 2;
      prefixHtml = renderMarkdown(content.slice(0, end), { highlight: false });
      prefixLen = end;
    }
    // join with a newline so the concatenation matches a single-pass render
    return prefixLen
      ? `${prefixHtml}\n${renderMarkdown(content.slice(prefixLen), { highlight: false })}`
      : renderMarkdown(content, { highlight: false });
  }

  // Resolved per paint, not captured: the thread is re-rendered on chat switch,
  // so a captured node would go stale and the message would stop updating.
  const findNode = () => (S.chat?.id === chat.id
    ? threadBox().querySelector(`.msg[data-id="${message.id}"]`) : null);

  function paint(now) {
    raf = null;
    const node = findNode();
    if (!node) { schedule(); return; }   // off-screen: keep polling cheaply
    const bubble = () => node.querySelector('.bubble');
    if (now - lastPaint < INTERVAL) { schedule(); return; }
    lastPaint = now;

    if (thinkDirty) {
      thinkDirty = false;
      let box = node.querySelector('[data-role="think"]');
      if (!box) {
        box = buildThinkBox(message);
        node.insertBefore(box, bubble());
      }
      const body = box.querySelector('[data-role="think-body"]');
      if (body) {
        const pinned = box.classList.contains('open');
        body.textContent = message.thinking;
        if (pinned) body.scrollTop = body.scrollHeight;
      }
    }

    if (bodyDirty) {
      bodyDirty = false;
      const target = bubble();
      if (target) {
        let md = target.querySelector('.md');
        if (!md) {
          target.textContent = '';
          md = el('div', { class: 'md' });
          target.append(md);
        }
        md.innerHTML = renderStreaming(message.content);
      }
    }
    autoScroll();
    updateLiveStats(message);
  }

  function schedule() {
    if (raf !== null) return;
    if (S.chat?.id !== chat.id) {
      // not on screen — check back occasionally instead of every frame
      raf = -1;
      setTimeout(() => { raf = null; schedule(); }, 400);
      return;
    }
    raf = requestAnimationFrame(paint);
  }

  return {
    body() { bodyDirty = true; schedule(); },
    think() { thinkDirty = true; schedule(); },
    finishThink() {
      const box = findNode()?.querySelector('[data-role="think"]');
      if (!box) return;
      box.classList.remove('live');
      const label = box.querySelector('[data-role="think-label"]');
      if (label) { label.classList.remove('shimmer'); label.textContent = 'Thought process'; }
      const stamp = box.querySelector('[data-role="think-dur"]');
      if (stamp && message.thinkMs) stamp.textContent = formatMs(message.thinkMs);
      if (!S.settings?.thinking_open) box.classList.remove('open');
    },
    stop() { if (raf !== null && raf !== -1) cancelAnimationFrame(raf); raf = null; },
  };
}

function updateLiveStats(message) {
  const box = $('#live-stats');
  if (!box) return;
  const chars = (message.content || '').length;
  const secs = (Date.now() / 1000) - message.ts;
  const approx = estTokens(message.content);
  box.textContent = secs > 0.4 && approx
    ? `~${(approx / secs).toFixed(1)} tok/s · ${chars} chars`
    : '';
}

async function maybeAutoTitle(chat) {
  if (!S.settings?.auto_title || !chat) return;
  if (chat.title && chat.title !== 'New chat') return;
  const messages = chat.messages.filter((m) => m.content);
  if (messages.length < 2) return;

  // Fall back to a trimmed first line if the model can't produce a title.
  const first = messages[0].content.replace(/\s+/g, ' ').trim();
  const fallback = first.length > 52 ? `${first.slice(0, 52).trimEnd()}…` : first;

  const transcript = messages.slice(0, 2)
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 700)}`)
    .join('\n\n');
  try {
    const { title } = await api.title(chat.model || currentModel(chat), transcript);
    chat.title = (title && title.length > 2 ? title : fallback) || fallback;
  } catch {
    chat.title = fallback;
  }
  emit('chat-title');
  await saveNow(chat);
}

/* ─────────────────────────── scroll & footer ─────────────────────────── */

function autoScroll() {
  if (!stickToBottom) return;
  const box = scrollBox();
  box.scrollTop = box.scrollHeight;
}

export function scrollToBottom(instant = false) {
  const box = scrollBox();
  stickToBottom = true;
  if (instant) {
    const previous = box.style.scrollBehavior;
    box.style.scrollBehavior = 'auto';
    box.scrollTop = box.scrollHeight;
    box.style.scrollBehavior = previous;
  } else {
    box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' });
  }
  $('#jump-btn').hidden = true;
}

export function wireScroll() {
  const box = scrollBox();
  box.addEventListener('scroll', () => {
    const distance = box.scrollHeight - box.scrollTop - box.clientHeight;
    stickToBottom = distance < 90;
    $('#jump-btn').hidden = distance < 220;
  }, { passive: true });
  $('#jump-btn').addEventListener('click', () => scrollToBottom());
}

/** Context-usage hint under the composer. */
export function updateFoot() {
  const hint = $('#ctx-hint');
  if (!hint) return;
  const info = modelInfo(currentModel());
  const limit = effectiveParams().num_ctx || info?.context_length || 0;
  if (!S.chat) { hint.textContent = ''; return; }

  let used = estTokens(effectiveSystem());
  for (const message of S.chat.messages) used += estTokens(message.content) + 4;
  const parts = [`~${num(used)} tok`];
  if (limit) {
    const pct = Math.min(100, Math.round((used / limit) * 100));
    parts.push(`${pct}% of ${num(limit)}`);
    hint.style.color = pct > 90 ? '#f87171' : '';
  } else {
    hint.style.color = '';
  }
  const count = S.chat.messages.length;
  if (count) parts.push(`${count} msg`);
  hint.textContent = parts.join(' · ');
}

export function exportChat(format = 'md') {
  const chat = S.chat;
  if (!chat) return;
  const stamp = new Date().toISOString().slice(0, 10);
  const slug = (chat.title || 'chat').replace(/[^\w -]+/g, '').trim().replace(/\s+/g, '-').slice(0, 50) || 'chat';

  if (format === 'json') {
    download(`${slug}-${stamp}.json`, JSON.stringify(chat, null, 2), 'application/json');
    return;
  }
  const lines = [
    `# ${chat.title || 'Chat'}`,
    '',
    `- Model: \`${chat.model || '—'}\``,
    `- Exported: ${new Date().toLocaleString()}`,
  ];
  const system = effectiveSystem();
  if (system) lines.push('', '## System prompt', '', '```', system, '```');
  lines.push('', '---', '');
  for (const message of chat.messages) {
    lines.push(`## ${message.role === 'user' ? 'You' : 'Assistant'}`, '');
    if (message.thinking) {
      lines.push('<details><summary>Thinking</summary>', '', '```', message.thinking, '```', '', '</details>', '');
    }
    lines.push(message.content || '', '');
  }
  download(`${slug}-${stamp}.md`, lines.join('\n'), 'text/markdown');
  toast('Exported');
}

/* ─────────────────────────── wiring ─────────────────────────── */

on('chat', () => renderThread(true));
on('models', () => { if (!S.chat?.messages?.length) updateEmptyState(); updateFoot(); });
on('streaming', (busy) => {
  $('#btn-send').hidden = busy;
  $('#btn-stop').hidden = !busy;
  $('#status-dot').classList.toggle('busy', busy);
  if (!busy) $('#live-stats').textContent = '';
});

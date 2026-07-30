// Small DOM + formatting helpers.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, value);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

export function svg(path, cls = 'ic') {
  return `<svg viewBox="0 0 24 24" class="${cls}">${path}</svg>`;
}

export const ICON = {
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 012-2h8"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  redo: '<path d="M21 12a9 9 0 11-3.2-6.9M21 4v5h-5"/>',
  edit: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4 12.5-12.5z"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/>',
  pin: '<path d="M12 17v5M9 3h6l-1 8 3 3H7l3-3-1-8z"/>',
  branch: '<path d="M6 3v12M6 21a3 3 0 100-6 3 3 0 000 6zM18 9a3 3 0 100-6 3 3 0 000 6zM18 9c0 5-6 3-6 9"/>',
  caret: '<path d="M9 6l6 6-6 6"/>',
  brain: '<path d="M9.5 3.5a5 5 0 00-4 8 4 4 0 001.5 6.5V21h6v-3a4 4 0 001.5-6.5 5 5 0 00-4-8zM10 21v-4"/>',
  down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  download: '<path d="M12 3v12M7 11l5 5 5-5M4 20h16"/>',
  wrap: '<path d="M4 6h16M4 12h12a3 3 0 110 6h-3M9 15l-2 3 2 3"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  msg: '<path d="M21 12a8 8 0 01-8 8H8l-5 3 1.5-5A8 8 0 1121 12z"/>',
  archive: '<path d="M3 7h18v3H3zM5 10v10h14V10M9 14h6"/>',
  up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  swap: '<path d="M4 8h13l-3-3M20 16H7l3 3"/>',
};

export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function bytes(n) {
  if (!n || n < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

export function num(n) {
  if (n == null) return '—';
  return n.toLocaleString();
}

export function relTime(ts) {
  if (!ts) return '';
  const secs = Date.now() / 1000 - ts;
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  if (secs < 172800) return 'yesterday';
  if (secs < 604800) return `${Math.floor(secs / 86400)}d ago`;
  return new Date(ts * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function dayBucket(ts) {
  if (!ts) return 'Older';
  const then = new Date(ts * 1000);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const diff = startOfToday - new Date(then.getFullYear(), then.getMonth(), then.getDate()).getTime();
  const days = Math.round(diff / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return 'This week';
  if (days < 30) return 'This month';
  return 'Older';
}

export function shortModel(name) {
  if (!name) return '—';
  return name.replace(/^hf\.co\//, '').replace(/^([^/]+\/)+/, '').replace(/:latest$/, '');
}

/** Wall-clock duration from Ollama nanoseconds. */
export function dur(ns) {
  if (!ns) return '';
  const s = ns / 1e9;
  if (s < 1) return `${Math.round(s * 1000)}ms`;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

let toastTimer = new Map();
export function toast(message, kind = '') {
  const box = $('#toasts');
  const node = el('div', { class: `toast ${kind}`, text: message });
  box.append(node);
  const id = Symbol();
  toastTimer.set(id, setTimeout(() => {
    node.style.transition = 'opacity .2s, transform .2s';
    node.style.opacity = '0';
    node.style.transform = 'translateY(6px)';
    setTimeout(() => node.remove(), 220);
    toastTimer.delete(id);
  }, kind === 'bad' ? 4200 : 2000));
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API needs a secure context; fall back to a hidden textarea.
    const ta = el('textarea', { style: 'position:fixed;opacity:0;top:0' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

export function download(name, text, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export function debounce(fn, ms = 200) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export const isMac = navigator.platform.toLowerCase().includes('mac')
  || /Mac|iPhone|iPad/.test(navigator.userAgent);
export const MOD = isMac ? '⌘' : 'Ctrl+';

export function autosize(ta, max = 0.44) {
  ta.style.height = 'auto';
  const cap = window.innerHeight * max;
  ta.style.height = `${Math.min(ta.scrollHeight, cap)}px`;
  ta.style.overflowY = ta.scrollHeight > cap ? 'auto' : 'hidden';
}

/** Rough token estimate — good enough for a context-usage hint. */
export function estTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 3.7);
}

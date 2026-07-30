// ⌘K command palette: commands, personas, models, and chat search in one list.

import { S, openChat } from './store.js';
import { $, el, svg, ICON, shortModel, relTime } from './util.js';

let cursor = 0;
let items = [];
let commands = [];

export function registerCommands(list) {
  commands = list;
}

export const paletteOpen = () => !$('#palette').hidden;

export function openPalette(prefill = '') {
  const input = $('#palette-input');
  $('#palette').hidden = false;
  $('#overlay').hidden = false;
  input.value = prefill;
  input.focus();
  input.select();
  refresh();
}

export function closePalette() {
  $('#palette').hidden = true;
  if ($('#modal').hidden) $('#overlay').hidden = true;
}

function score(text, query) {
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  if (!needle) return 1;
  const index = haystack.indexOf(needle);
  if (index === 0) return 100;
  if (index > 0) return 60 - Math.min(index, 30);
  // fuzzy: every character in order
  let pos = 0;
  for (const ch of needle) {
    pos = haystack.indexOf(ch, pos);
    if (pos < 0) return 0;
    pos++;
  }
  return 20;
}

function build(query) {
  const results = [];
  const q = query.trim();

  for (const cmd of commands) {
    if (cmd.when && !cmd.when()) continue;
    const s = score(`${cmd.title} ${cmd.keywords || ''}`, q);
    if (s > 0) results.push({ ...cmd, kind: 'cmd', _s: s + 6 });
  }

  for (const persona of S.personas) {
    const s = score(`persona ${persona.name} ${persona.description || ''}`, q);
    if (s > 0) {
      results.push({
        kind: 'persona', _s: s,
        title: persona.name,
        sub: persona.description || 'Persona',
        icon: persona.emoji || '💬',
        run: async () => {
          const { applyPersona } = await import('./modals.js');
          applyPersona(persona.id);
        },
      });
    }
  }

  for (const model of S.models) {
    const s = score(`model ${model.name}`, q);
    if (s > 0) {
      results.push({
        kind: 'model', _s: s - 2,
        title: shortModel(model.name),
        sub: [model.parameter_size, model.supports_thinking ? 'thinking' : null,
          model.supports_vision ? 'vision' : null].filter(Boolean).join(' · ') || 'Model',
        iconHtml: svg('<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z"/>', 'ic'),
        run: async () => {
          const { pickModel } = await import('./modals.js');
          pickModel(model.name);
        },
      });
    }
  }

  for (const chat of S.chats) {
    const s = score(`${chat.title} ${chat.preview || ''}`, q);
    if (s > 0 && q) {
      results.push({
        kind: 'chat', _s: s - 4,
        title: chat.title || 'New chat',
        sub: `${relTime(chat.updated)} · ${chat.message_count} msg`,
        iconHtml: svg(ICON.msg, 'ic'),
        run: () => openChat(chat.id),
      });
    }
  }

  results.sort((a, b) => b._s - a._s);
  return results.slice(0, 40);
}

function render() {
  const list = $('#palette-list');
  list.textContent = '';
  if (!items.length) {
    list.append(el('div', { class: 'p-none', text: 'Nothing matches.' }));
    return;
  }
  items.forEach((item, index) => {
    const node = el('button', {
      class: `p-item${index === cursor ? ' cursor' : ''}`,
      onclick: () => choose(index),
      onmousemove: () => {
        if (cursor === index) return;
        cursor = index;
        [...list.children].forEach((c, i) => c.classList.toggle('cursor', i === index));
      },
    },
      item.icon
        ? el('span', { text: item.icon, style: 'width:18px;text-align:center' })
        : el('span', { html: item.iconHtml || svg(ICON.caret, 'ic') }),
      el('span', { class: 'pi-body' },
        el('span', { class: 'pi-title', text: item.title }),
        item.sub ? el('span', { class: 'pi-sub', text: item.sub }) : null),
      item.keys ? el('span', { class: 'kbd', text: item.keys }) : null,
    );
    list.append(node);
  });
  const active = list.children[cursor];
  if (active) active.scrollIntoView({ block: 'nearest' });
}

function refresh() {
  items = build($('#palette-input').value);
  cursor = 0;
  render();
}

async function choose(index) {
  const item = items[index];
  if (!item) return;
  closePalette();
  try { await item.run(); } catch (err) { console.error(err); }
}

export function wirePalette() {
  const input = $('#palette-input');
  input.addEventListener('input', refresh);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || (event.key === 'n' && event.ctrlKey)) {
      event.preventDefault();
      cursor = Math.min(cursor + 1, items.length - 1);
      render();
    } else if (event.key === 'ArrowUp' || (event.key === 'p' && event.ctrlKey)) {
      event.preventDefault();
      cursor = Math.max(cursor - 1, 0);
      render();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(cursor);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closePalette();
    } else if (event.key === 'Tab') {
      event.preventDefault();
      cursor = (cursor + (event.shiftKey ? -1 : 1) + items.length) % items.length;
      render();
    }
  });
  $('#palette').addEventListener('mousedown', (event) => {
    if (event.target.id === 'palette') closePalette();
  });
}

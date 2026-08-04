// Self-contained Markdown renderer + lightweight syntax highlighter.
// No external libraries — everything here runs offline.

import { escapeHtml, copyText } from './util.js';

/* ─────────────────────────── syntax highlighting ─────────────────────────── */

const KEYWORDS = {
  js: 'as async await break case catch class const continue debugger default delete do else export extends finally for from function get if implements import in instanceof interface let new of return set static super switch this throw try typeof var void while with yield null true false undefined NaN',
  py: 'and as assert async await break class continue def del elif else except finally for from global if import in is lambda match case nonlocal not or pass raise return try while with yield None True False self cls print',
  rust: 'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while',
  go: 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false',
  c: 'auto break case char const continue default do double else enum extern float for goto if inline int long register return short signed sizeof static struct switch typedef union unsigned void volatile while class public private protected virtual template namespace using new delete this true false nullptr bool',
  java: 'abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while var true false null record sealed',
  sh: 'if then else elif fi for while do done case esac in function return exit local export readonly declare source alias unset shift echo cd set trap eval',
  sql: 'select from where insert into values update set delete create table drop alter add index join left right inner outer full on group by order having limit offset union all as distinct and or not null primary key foreign references default unique constraint case when then else end exists between like in asc desc with returning',
  css: 'important media supports keyframes import from to and not only',
  ruby: 'alias and begin break case class def defined do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield require attr_accessor puts',
  php: 'abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile extends final finally fn for foreach function global goto if implements include include_once instanceof insteadof interface isset list namespace new or print private protected public require require_once return static switch throw trait try unset use var while xor yield true false null',
};

const LANG_ALIAS = {
  javascript: 'js', jsx: 'js', mjs: 'js', cjs: 'js', node: 'js',
  typescript: 'ts', ts: 'ts', tsx: 'ts',
  python: 'py', py3: 'py', python3: 'py',
  rs: 'rust', golang: 'go',
  'c++': 'cpp', cxx: 'cpp', cc: 'cpp', h: 'c', hpp: 'cpp',
  bash: 'sh', zsh: 'sh', shell: 'sh', console: 'sh', fish: 'sh',
  postgres: 'sql', postgresql: 'sql', mysql: 'sql', sqlite: 'sql',
  yml: 'yaml', htm: 'html', xhtml: 'html', vue: 'html', svelte: 'html',
  scss: 'css', sass: 'css', less: 'css',
  rb: 'ruby', kt: 'java', kotlin: 'java', cs: 'java', csharp: 'java', swift: 'java', scala: 'java', dart: 'java',
};

const FAMILY = {
  js: 'js', ts: 'js', py: 'py', rust: 'rust', go: 'go', c: 'c', cpp: 'c',
  java: 'java', sh: 'sh', sql: 'sql', css: 'css', ruby: 'ruby', php: 'php',
};

// Both of these are pure functions of the language, and renderThread()
// re-highlights every code block in the conversation on every full render — so
// a thread with 30 blocks was splitting keyword strings into 30 fresh Sets and
// compiling 30 identical regexes each time. Built once per language instead.
const KEYWORD_CACHE = new Map();
const PATTERN_CACHE = new Map();

function keywordSet(lang) {
  if (KEYWORD_CACHE.has(lang)) return KEYWORD_CACHE.get(lang);
  const family = FAMILY[lang];
  const extra = lang === 'ts'
    ? ' type namespace declare abstract readonly enum public private protected any unknown never string number boolean object symbol keyof infer satisfies'
    : '';
  const set = family
    ? new Set(((KEYWORDS[family] || '') + extra).split(/\s+/).filter(Boolean))
    : null;
  KEYWORD_CACHE.set(lang, set);
  return set;
}

export function normalizeLang(raw) {
  const key = (raw || '').trim().toLowerCase().split(/[\s:,]/)[0];
  return LANG_ALIAS[key] || key;
}

/** Tokenise `code` into highlighted HTML. Falls back to plain escaping. */
export function highlight(code, rawLang) {
  const lang = normalizeLang(rawLang);
  if (!lang || lang === 'text' || lang === 'txt' || lang === 'plain') return escapeHtml(code);
  if (lang === 'json') return highlightJson(code);
  if (lang === 'html' || lang === 'xml' || lang === 'svg') return highlightMarkup(code);
  if (lang === 'yaml' || lang === 'toml' || lang === 'ini') return highlightConfig(code);
  if (lang === 'diff' || lang === 'patch') return highlightDiff(code);

  const keywords = keywordSet(lang);
  if (!keywords) return escapeHtml(code);

  const pattern = tokenPattern(lang);
  // Cached and /g, so it carries lastIndex. An exec loop that runs to null
  // resets it, but a throw part-way through would not — start from a known
  // position rather than trusting the last caller.
  pattern.lastIndex = 0;

  const parts = [];
  let last = 0;
  let match;
  while ((match = pattern.exec(code)) !== null) {
    if (match.index > last) parts.push(escapeHtml(code.slice(last, match.index)));
    const [full, pyDoc, block, line, str, number, fn, type, word, op] = match;
    if (pyDoc) parts.push(span('str', pyDoc));
    else if (block) parts.push(span('com', block));
    else if (line) parts.push(span('com', line));
    else if (str) parts.push(span('str', str));
    else if (number) parts.push(span('num', number));
    else if (fn) parts.push(keywords.has(fn) ? span('kw', fn) : span('fn', fn));
    else if (type) parts.push(keywords.has(type) ? span('kw', type) : span('typ', type));
    else if (word) parts.push(keywords.has(word) ? span('kw', word) : escapeHtml(word));
    else if (op) parts.push(span('op', op));
    else parts.push(escapeHtml(full));
    last = match.index + full.length;
  }
  parts.push(escapeHtml(code.slice(last)));
  return parts.join('');
}

const span = (cls, text) => `<span class="tk-${cls}">${escapeHtml(text)}</span>`;

/** One pass, ordered so that comments and strings win over everything else. */
function tokenPattern(lang) {
  const hit = PATTERN_CACHE.get(lang);
  if (hit) return hit;
  const lineComment = lang === 'py' || lang === 'sh' || lang === 'ruby'
    ? '#' : (lang === 'sql' ? '--' : '//');
  const blockComment = !['py', 'sh', 'ruby', 'sql'].includes(lang);
  const pattern = new RegExp([
    lang === 'py' ? String.raw`("""[\s\S]*?"""|'''[\s\S]*?''')` : '(\\u0000)',
    blockComment ? String.raw`(/\*[\s\S]*?\*/)` : '(\\u0000)',
    String.raw`(${lineComment.replace(/[/*+.]/g, '\\$&')}[^\n]*)`,
    String.raw`("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|\`(?:\\.|[^\\\`])*\`)`,
    String.raw`\b(0[xXbBoO][0-9a-fA-F_]+|\d[\d_]*\.?[\d_]*(?:[eE][+-]?\d+)?)\b`,
    String.raw`\b([A-Za-z_$][\w$]*)\s*(?=\()`,
    String.raw`\b([A-Z][A-Za-z0-9_]*)\b`,
    String.raw`\b([A-Za-z_$@#][\w$]*)\b`,
    String.raw`([+\-*/%=<>!&|^~?:]+)`,
  ].join('|'), 'g');
  PATTERN_CACHE.set(lang, pattern);
  return pattern;
}

function highlightJson(code) {
  return escapeHtml(code)
    .replace(/(&quot;(?:\\.|[^&\\]|&(?!quot;))*?&quot;)(\s*:)/g,
      (_, key, colon) => `<span class="tk-attr">${key}</span>${colon}`)
    .replace(/(&quot;(?:\\.|[^&\\]|&(?!quot;))*?&quot;)(?!\s*<\/span>)/g,
      (m) => (m.includes('tk-attr') ? m : `<span class="tk-str">${m}</span>`))
    .replace(/\b(-?\d+\.?\d*(?:[eE][+-]?\d+)?)\b/g, '<span class="tk-num">$1</span>')
    .replace(/\b(true|false|null)\b/g, '<span class="tk-kw">$1</span>');
}

function highlightMarkup(code) {
  return escapeHtml(code)
    .replace(/(&lt;!--[\s\S]*?--&gt;)/g, '<span class="tk-com">$1</span>')
    .replace(/(&lt;\/?)([a-zA-Z][\w:-]*)/g, '$1<span class="tk-kw">$2</span>')
    .replace(/([a-zA-Z-]+)(=)(&quot;[^&]*?&quot;|&#39;[^&]*?&#39;)/g,
      '<span class="tk-attr">$1</span><span class="tk-op">$2</span><span class="tk-str">$3</span>');
}

function highlightConfig(code) {
  return escapeHtml(code)
    .replace(/^(\s*)(#[^\n]*)$/gm, '$1<span class="tk-com">$2</span>')
    .replace(/^(\s*)(\[[^\]\n]+\])$/gm, '$1<span class="tk-typ">$2</span>')
    .replace(/^(\s*(?:-\s+)?)([\w.$-]+)(\s*[:=])/gm,
      '$1<span class="tk-attr">$2</span><span class="tk-op">$3</span>')
    .replace(/(&quot;[^&\n]*?&quot;|&#39;[^&\n]*?&#39;)/g, '<span class="tk-str">$1</span>')
    .replace(/\b(true|false|null|yes|no|on|off)\b/gi, '<span class="tk-kw">$1</span>');
}

function highlightDiff(code) {
  return escapeHtml(code).split('\n').map((line) => {
    if (/^\+\+\+|^---|^diff |^index /.test(line)) return `<span class="tk-com">${line}</span>`;
    if (line.startsWith('@@')) return `<span class="tk-typ">${line}</span>`;
    if (line.startsWith('+')) return `<span class="tk-str">${line}</span>`;
    if (line.startsWith('-')) return `<span class="tk-op">${line}</span>`;
    return line;
  }).join('\n');
}


/* ─────────────────────────── math (LaTeX subset) ───────────────────────────
   Not a TeX engine — a pragmatic subset covering what chat models actually
   emit: variables, fractions, sub/superscripts, roots, and the common symbol
   set. Anything unrecognised falls through as its own literal text rather
   than disappearing, so a miss degrades to "readable" instead of "gone".
   ------------------------------------------------------------------------ */

const TEX_SYMBOLS = {
  alpha:'α', beta:'β', gamma:'γ', delta:'δ', epsilon:'ε', varepsilon:'ε', zeta:'ζ',
  eta:'η', theta:'θ', vartheta:'ϑ', iota:'ι', kappa:'κ', lambda:'λ', mu:'μ', nu:'ν',
  xi:'ξ', pi:'π', rho:'ρ', sigma:'σ', tau:'τ', upsilon:'υ', phi:'φ', varphi:'φ',
  chi:'χ', psi:'ψ', omega:'ω',
  Gamma:'Γ', Delta:'Δ', Theta:'Θ', Lambda:'Λ', Xi:'Ξ', Pi:'Π', Sigma:'Σ',
  Upsilon:'Υ', Phi:'Φ', Psi:'Ψ', Omega:'Ω',
  times:'×', div:'÷', pm:'±', mp:'∓', cdot:'·', ast:'∗', star:'⋆',
  leq:'≤', le:'≤', geq:'≥', ge:'≥', neq:'≠', ne:'≠', approx:'≈', equiv:'≡',
  sim:'∼', simeq:'≃', propto:'∝', ll:'≪', gg:'≫',
  infty:'∞', partial:'∂', nabla:'∇', forall:'∀', exists:'∃', neg:'¬',
  in:'∈', notin:'∉', subset:'⊂', subseteq:'⊆', supset:'⊃', supseteq:'⊇',
  cup:'∪', cap:'∩', emptyset:'∅', varnothing:'∅',
  sum:'∑', prod:'∏', int:'∫', oint:'∮', sqrt:'√',
  to:'→', rightarrow:'→', Rightarrow:'⇒', leftarrow:'←', Leftarrow:'⇐',
  leftrightarrow:'↔', Leftrightarrow:'⇔', mapsto:'↦',
  ldots:'…', cdots:'⋯', dots:'…', quad:' ', qquad:'  ', ',':' ', ';':' ', ':':' ',
  land:'∧', lor:'∨', therefore:'∴', because:'∵', angle:'∠', degree:'°',
  perp:'⊥', parallel:'∥', prime:'′', circ:'∘', bullet:'•',
};

/** Pull one {...} group (or a single token) starting at `i`. */
function texGroup(src, i) {
  if (src[i] === '{') {
    let depth = 1;
    let j = i + 1;
    while (j < src.length && depth > 0) {
      if (src[j] === '\\') { j += 2; continue; }
      if (src[j] === '{') depth++;
      else if (src[j] === '}') depth--;
      j++;
    }
    return [src.slice(i + 1, j - 1), j];
  }
  if (src[i] === '\\') {
    const m = /^\\[a-zA-Z]+/.exec(src.slice(i));
    if (m) return [m[0], i + m[0].length];
  }
  return [src[i] ?? '', i + 1];
}

function texToHtml(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];

    if (ch === '\\') {
      const cmd = /^\\([a-zA-Z]+|[,;:!{}%$&#_ ])/.exec(src.slice(i));
      if (!cmd) { out += escapeHtml(ch); i++; continue; }
      const name = cmd[1];
      i += cmd[0].length;

      if (name === 'frac' || name === 'dfrac' || name === 'tfrac') {
        const [a, i1] = texGroup(src, i);
        const [b, i2] = texGroup(src, i1);
        i = i2;
        out += `<span class="tex-frac"><span class="tex-num">${texToHtml(a)}</span>`
             + `<span class="tex-den">${texToHtml(b)}</span></span>`;
        continue;
      }
      if (name === 'sqrt') {
        const [a, i1] = texGroup(src, i);
        i = i1;
        out += `<span class="tex-sqrt">√<span class="tex-rad">${texToHtml(a)}</span></span>`;
        continue;
      }
      if (name === 'text' || name === 'mathrm' || name === 'mathbf'
          || name === 'operatorname' || name === 'mbox') {
        const [a, i1] = texGroup(src, i);
        i = i1;
        const cls = name === 'mathbf' ? ' style="font-weight:650"' : '';
        out += `<span class="tex-text"${cls}>${escapeHtml(a)}</span>`;
        continue;
      }
      if (name === 'left' || name === 'right') continue;   // just delimiters
      if (name === 'begin' || name === 'end') { const [, i1] = texGroup(src, i); i = i1; continue; }
      if (name === 'displaystyle' || name === 'limits' || name === 'nolimits') continue;
      if (Object.prototype.hasOwnProperty.call(TEX_SYMBOLS, name)) {
        out += escapeHtml(TEX_SYMBOLS[name]);
        continue;
      }
      // unknown command: show it rather than swallow it
      out += escapeHtml(`\\${name}`);
      continue;
    }

    if (ch === '^' || ch === '_') {
      const [a, i1] = texGroup(src, i + 1);
      i = i1;
      const tag = ch === '^' ? 'sup' : 'sub';
      out += `<${tag}>${texToHtml(a)}</${tag}>`;
      continue;
    }
    if (ch === '{' || ch === '}') { i++; continue; }   // bare grouping
    if (ch === '$') { i++; continue; }
    out += escapeHtml(ch);
    i++;
  }
  return out;
}

/**
 * Is this `$...$` span plausibly maths rather than currency or prose?
 * "$5 and $10" must not become a formula; "$B$" and "$L = 0.05$" must.
 */
function looksLikeMath(body) {
  if (!body || body.length > 200) return false;
  if (/^\s|\s$/.test(body)) return false;             // "$ x $" is rare in real maths
  if (/[\\^_{}=<>]|\\[a-zA-Z]/.test(body)) return true;
  return body.length <= 3 && /^[A-Za-z0-9'()+\-*/. ]+$/.test(body);
}

/* ─────────────────────────── markdown ─────────────────────────── */

let codeSeq = 0;

/**
 * Render markdown to HTML.
 * @param {string} src
 * @param {{highlight?: boolean}} opts  highlight:false skips tokenising (used while streaming)
 */
/** Does this line start a block of its own, rather than continue a paragraph? */
function opensBlock(line) {
  return /^\s{0,3}(?:```|~~~|#{1,6}\s|[-*+]\s|\d{1,9}[.)]\s)/.test(line)
    || /^\s{0,3}((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})\s*$/.test(line);
}

export function renderMarkdown(src, opts = {}) {
  const doHighlight = opts.highlight !== false;
  const text = String(src || '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // fenced code
    const fence = line.match(/^(\s{0,3})(`{3,}|~{3,})(.*)$/);
    if (fence) {
      const [, indent, marker, info] = fence;
      const closer = new RegExp(`^\\s{0,3}${marker[0]}{${marker.length},}\\s*$`);
      const body = [];
      i++;
      while (i < lines.length && !closer.test(lines[i])) {
        body.push(lines[i].startsWith(indent) ? lines[i].slice(indent.length) : lines[i]);
        i++;
      }
      const closed = i < lines.length;
      i++; // consume the closing fence (or run off the end while streaming)
      out.push(codeBlock(body.join('\n'), info.trim(), doHighlight, closed));
      continue;
    }

    // blank
    if (!line.trim()) { i++; continue; }

    // heading
    const heading = line.match(/^(\s{0,3})(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) {
      const level = heading[2].length;
      out.push(`<h${level}>${inline(heading[3])}</h${level}>`);
      i++;
      continue;
    }

    // thematic break
    if (/^\s{0,3}((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }

    // table — header row followed by a delimiter row
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])
        && lines[i + 1].includes('-')) {
      const head = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map((cell) => {
        const left = cell.trimStart().startsWith(':');
        const right = cell.trimEnd().endsWith(':');
        if (left && right) return 'center';
        if (right) return 'right';
        return left ? 'left' : '';
      });
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      const th = head.map((cell, index) =>
        `<th${aligns[index] ? ` style="text-align:${aligns[index]}"` : ''}>${inline(cell)}</th>`).join('');
      const tb = rows.map((row) => `<tr>${head.map((_, index) =>
        `<td${aligns[index] ? ` style="text-align:${aligns[index]}"` : ''}>${inline(row[index] || '')}</td>`
      ).join('')}</tr>`).join('');
      out.push(`<table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table>`);
      continue;
    }

    // blockquote
    if (/^\s{0,3}>/.test(line)) {
      const body = [];
      while (i < lines.length) {
        const current = lines[i];
        if (/^\s{0,3}>/.test(current)) {          // a real quote line
          body.push(current.replace(/^\s{0,3}>\s?/, ''));
          i++;
          continue;
        }
        // Lazy continuation carries *paragraph* text only. A line that would
        // open its own block ends the quote — without this, a fenced code block
        // written directly under a quote was swallowed into it, which is the one
        // place this renderer visibly disagreed with GFM.
        if (!current.trim() || !body.length || opensBlock(current)) break;
        body.push(current);
        i++;
      }
      out.push(`<blockquote>${renderMarkdown(body.join('\n'), opts)}</blockquote>`);
      continue;
    }

    // list
    if (/^\s*([-*+]|\d{1,9}[.)])\s+/.test(line)) {
      const [html, next] = renderList(lines, i, opts);
      out.push(html);
      i = next;
      continue;
    }

    // paragraph
    const para = [];
    while (i < lines.length && lines[i].trim()
           && !/^\s{0,3}(#{1,6}\s|>|```|~~~)/.test(lines[i])
           && !/^\s*([-*+]|\d{1,9}[.)])\s+/.test(lines[i])
           && !/^\s{0,3}((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/.test(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    if (para.length) out.push(`<p>${inline(para.join('\n'))}</p>`);
    else i++;
  }

  return out.join('\n');
}

function splitRow(row) {
  let trimmed = row.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|') && !trimmed.endsWith('\\|')) trimmed = trimmed.slice(0, -1);
  const cells = [];
  let current = '';
  for (let k = 0; k < trimmed.length; k++) {
    if (trimmed[k] === '\\' && trimmed[k + 1] === '|') { current += '|'; k++; continue; }
    if (trimmed[k] === '|') { cells.push(current.trim()); current = ''; continue; }
    current += trimmed[k];
  }
  cells.push(current.trim());
  return cells;
}

function renderList(lines, start, opts) {
  const first = lines[start].match(/^(\s*)([-*+]|\d{1,9}[.)])\s+/);
  const baseIndent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const startNum = ordered ? parseInt(first[2], 10) : 1;
  const items = [];
  let i = start;
  let checklist = false;

  while (i < lines.length) {
    const match = lines[i].match(/^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/);
    if (match && match[1].length <= baseIndent + 1) {
      if (match[1].length < baseIndent) break;
      if (ordered !== /\d/.test(match[2])) break;
      items.push([match[3]]);
      i++;
      // continuation + nested lines belong to the current item
      while (i < lines.length) {
        const blank = !lines[i].trim();
        const indent = lines[i].match(/^(\s*)/)[1].length;
        const isNewItem = /^\s*([-*+]|\d{1,9}[.)])\s+/.test(lines[i]) && indent <= baseIndent + 1;
        if (isNewItem) break;
        if (blank) {
          const following = lines[i + 1] || '';
          const followIndent = following.match(/^(\s*)/)[1].length;
          if (!following.trim() || followIndent <= baseIndent) break;
          items[items.length - 1].push('');
          i++;
          continue;
        }
        if (indent <= baseIndent && lines[i].trim()) {
          // lazy continuation of the paragraph
          items[items.length - 1].push(lines[i].trim());
          i++;
          continue;
        }
        items[items.length - 1].push(lines[i].slice(Math.min(indent, baseIndent + 2)));
        i++;
      }
      continue;
    }
    break;
  }

  const html = items.map((chunk) => {
    let body = chunk.join('\n');
    let prefix = '';
    const task = body.match(/^\[([ xX])\]\s+([\s\S]*)$/);
    if (task) {
      checklist = true;
      prefix = `<input type="checkbox" disabled${task[1].toLowerCase() === 'x' ? ' checked' : ''}> `;
      body = task[2];
    }
    const multi = /\n\s*\n/.test(body) || /^\s*([-*+]|\d{1,9}[.)])\s+/m.test(body)
      || /^\s{0,3}(```|~~~|>|#{1,6}\s)/m.test(body);
    const inner = multi
      ? renderMarkdown(body, opts).replace(/^<p>([\s\S]*?)<\/p>/, '$1')
      : inline(body);
    return `<li>${prefix}${inner}</li>`;
  }).join('');

  const tag = ordered ? 'ol' : 'ul';
  const attrs = [
    ordered && startNum !== 1 ? ` start="${startNum}"` : '',
    checklist ? ' class="task"' : '',
  ].join('');
  return [`<${tag}${attrs}>${html}</${tag}>`, i];
}

function codeBlock(code, info, doHighlight, closed) {
  const lang = info.split(/\s+/)[0] || '';
  const label = lang || 'text';
  const id = `cb${++codeSeq}`;
  const inner = doHighlight ? highlight(code, lang) : escapeHtml(code);
  const lineCount = code ? code.split('\n').length : 0;
  return `<div class="code-wrap" data-code-id="${id}"${closed ? '' : ' data-open="1"'}>`
    + `<div class="code-head"><span>${escapeHtml(label)}</span>`
    + `<span class="grow"></span>`
    + `<span style="opacity:.6">${lineCount} ln</span>`
    + `<button class="code-btn" data-act="wrap">wrap</button>`
    + `<button class="code-btn" data-act="copy-code">copy</button>`
    + `</div><pre><code class="lang-${escapeHtml(lang || 'text')}">${inner}</code></pre>`
    + `<script type="application/json" class="code-raw">${
        JSON.stringify(code).replace(/</g, '\\u003c')}</script></div>`;
}

/* ─────────────────────────── inline ─────────────────────────── */

function inline(src) {
  const codes = [];
  // 1. protect inline code so nothing else touches it
  let text = String(src).replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, ticks, body) => {
    codes.push(body.replace(/^ (.*) $/, '$1'));
    return `\u0000C${codes.length - 1}\u0000`;
  });

  // 2. maths, protected like code so emphasis and escaping cannot touch it
  const maths = [];
  const holdMath = (tex, display) => {
    maths.push(`<span class="tex${display ? ' tex-display' : ''}">${texToHtml(tex)}</span>`);
    return `\u0000M${maths.length - 1}\u0000`;
  };
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (_, body) => holdMath(body, true));
  text = text.replace(/\\\[([\s\S]+?)\\\]/g, (_, body) => holdMath(body, true));
  text = text.replace(/\\\(([\s\S]+?)\\\)/g, (_, body) => holdMath(body, false));
  text = text.replace(/\$([^$\n]+?)\$/g,
    (whole, body) => (looksLikeMath(body) ? holdMath(body, false) : whole));

  // 3. pull out backslash escapes before anything can act on the character
  // they protect. Models emit these constantly ("\$4.99", "\_name\_"). A
  // trailing backslash before a newline is a hard break, not an escape, so it
  // is deliberately left for step 5.
  const escapes = [];
  text = text.replace(/\\([!-/:-@[-`{-~])/g, (_, ch) => {
    escapes.push(ch);
    return `\u0000E${escapes.length - 1}\u0000`;
  });

  // 4. escape everything remaining
  text = escapeHtml(text);

  const links = [];
  const hold = (html) => {
    links.push(html);
    return `\u0000L${links.length - 1}\u0000`;
  };

  // 3. images, then links
  text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g,
    (_, alt, url, title) => hold(`<img src="${safeUrl(url)}" alt="${alt}"${
      title ? ` title="${title}"` : ''} loading="lazy">`));

  text = text.replace(/\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g,
    (_, label, url, title) => hold(`<a href="${safeUrl(url)}" target="_blank" rel="noopener noreferrer"${
      title ? ` title="${title}"` : ''}>${label}</a>`));

  // bare URLs and <autolinks>
  text = text.replace(/&lt;(https?:\/\/[^\s&]+)&gt;/g,
    (_, url) => hold(`<a href="${safeUrl(url)}" target="_blank" rel="noopener noreferrer">${url}</a>`));
  text = text.replace(/(^|[\s(])(https?:\/\/[^\s<>()[\]"']+)/g,
    (_, pre, url) => `${pre}${hold(
      `<a href="${safeUrl(url)}" target="_blank" rel="noopener noreferrer">${url}</a>`)}`);

  // 4. emphasis
  text = text
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>')
    .replace(/(\*\*\*|___)(?=\S)([\s\S]*?\S)\1/g, '<strong><em>$2</em></strong>')
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '<strong>$2</strong>')
    .replace(/(?<![\w*])\*(?=[^\s*])([\s\S]*?[^\s*])\*(?![\w*])/g, '<em>$1</em>')
    .replace(/(?<![\w_])_(?=[^\s_])([\s\S]*?[^\s_])_(?![\w_])/g, '<em>$1</em>')
    .replace(/==(?=\S)([\s\S]*?\S)==/g, '<mark>$1</mark>');

  // 5. hard breaks
  text = text.replace(/(  |\\)\n/g, '<br>\n').replace(/\n/g, '\n');

  // 6. restore
  text = text.replace(/\u0000L(\d+)\u0000/g, (_, index) => links[+index]);
  text = text.replace(/\u0000C(\d+)\u0000/g, (_, index) => `<code>${escapeHtml(codes[+index])}</code>`);
  text = text.replace(/\u0000E(\d+)\u0000/g, (_, index) => escapeHtml(escapes[+index]));
  text = text.replace(/\u0000M(\d+)\u0000/g, (_, index) => maths[+index]);
  return text;
}

const codePoint = (n) => (Number.isFinite(n) && n >= 0 && n <= 0x10ffff
  ? String.fromCodePoint(n) : '');

/**
 * Neutralise a URL out of model output.
 *
 * The scheme test has to run against what the *browser* will end up with, not
 * against this text. `escapeHtml()` has already turned `&` into `&amp;`, so a
 * link written as `[x](java&#9;script:alert(1))` reaches here looking innocent,
 * fails a literal "javascript:" test, and goes into the href intact — where the
 * HTML parser decodes `&#9;` to a tab and the URL parser *strips* ASCII tab and
 * newline before deciding the scheme. `java<TAB>script:` becomes
 * `javascript:` and runs in Lantern's own origin, which can read every chat.
 *
 * So: decode one level of character references and drop the characters a URL
 * parser ignores, and test *that*. One level is the right depth — it is exactly
 * what the HTML parser does, so `&amp;#9;` stays inert text on both sides.
 */
function safeUrl(url) {
  const decoded = url.replace(/&amp;/g, '&');
  const probe = decoded
    .replace(/&#x0*([0-9a-f]+);?/gi, (_, hex) => codePoint(parseInt(hex, 16)))
    .replace(/&#0*(\d+);?/g, (_, dec) => codePoint(Number(dec)))
    .replace(/&(tab|newline);/gi, '\t')
    .split('').filter((c) => c.charCodeAt(0) > 0x20).join('');
  if (/^(javascript|data|vbscript|file):/i.test(probe)) return '#';
  return decoded.replace(/"/g, '%22');
}

/** Attach copy/wrap handlers inside a rendered container. */
export function wireCodeBlocks(root) {
  root.querySelectorAll('.code-wrap').forEach((wrap) => {
    if (wrap.dataset.wired) return;
    wrap.dataset.wired = '1';
    wrap.addEventListener('click', async (event) => {
      const button = event.target.closest('.code-btn');
      if (!button) return;
      const act = button.dataset.act;
      if (act === 'wrap') {
        wrap.classList.toggle('wrapped');
        button.textContent = wrap.classList.contains('wrapped') ? 'nowrap' : 'wrap';
        return;
      }
      if (act === 'copy-code') {
        const raw = wrap.querySelector('.code-raw');
        let code = '';
        try { code = JSON.parse(raw.textContent); }
        catch { code = wrap.querySelector('pre code').textContent; }
        button.textContent = (await copyText(code)) ? 'copied' : 'failed';
        setTimeout(() => { button.textContent = 'copy'; }, 1300);
      }
    });
  });
}

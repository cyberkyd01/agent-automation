// Small, safe Markdown renderer for model output.
// The whole source is HTML-escaped before parsing, so the only markup in the result is
// what this file emits, and links are restricted to http(s) URLs.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ESC[c]);

const FENCE_RE = /^\s*(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/;
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const HR_RE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE_RE = /^\s{0,3}&gt;/;
const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])(?:\s+(.*))?$/;
const DELIM_RE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
// Bare URLs stop at whitespace and at escaped quotes/brackets.
const URL_RE = /\bhttps?:\/\/(?:(?!&(?:lt|gt|quot|#39);)[^\s\u0000])+/g;

export function md(src) {
  const text = escapeHtml(String(src ?? '').replace(/\r\n?/g, '\n').replace(/\u0000/g, ''));
  return render(text.split('\n'));
}

// Removes prompted tool-call markup, including an unterminated block or a half-streamed tag at the end.
export function stripToolCalls(text) {
  let s = String(text ?? '')
    .replace(/<tool_call>[\s\S]*?(?:<\/tool_call>|$)/g, '')
    .replace(/<\/tool_call>/g, '');
  const tail = /<[a-z_]*$/.exec(s);
  if (tail && tail[0].length > 1 && '<tool_call>'.startsWith(tail[0])) s = s.slice(0, tail.index);
  return s;
}

/* ---------- blocks (operate on already-escaped lines) ---------- */

function indentOf(line) {
  let n = 0;
  for (const c of line) {
    if (c === ' ') n++;
    else if (c === '\t') n += 4 - (n % 4);
    else break;
  }
  return n;
}

function dedent(line, cols) {
  let n = 0;
  let k = 0;
  while (k < line.length && n < cols) {
    if (line[k] === ' ') n++;
    else if (line[k] === '\t') n += 4 - (n % 4);
    else break;
    k++;
  }
  return line.slice(k);
}

const isTable = (lines, i) =>
  i + 1 < lines.length && lines[i].includes('|') && lines[i + 1].includes('|') && DELIM_RE.test(lines[i + 1]);

// Block starts that end a paragraph without a blank line (LLMs often omit it).
const interrupts = (lines, i) => {
  const l = lines[i];
  return (
    FENCE_RE.test(l) ||
    HEADING_RE.test(l) ||
    HR_RE.test(l) ||
    QUOTE_RE.test(l) ||
    isTable(lines, i) ||
    /^\s*(?:[-*+]|1[.)])\s+\S/.test(l)
  );
};

function closesFence(line, mark) {
  const t = line.trim();
  return t.length >= mark.length && t[0] === mark[0] && /^(?:`+|~+)$/.test(t);
}

function render(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    let m;
    if (!line.trim()) {
      i++;
    } else if ((m = FENCE_RE.exec(line))) {
      // An unterminated fence (mid-stream) simply runs to the end.
      const lang = m[2].replace(/[^\w#+.-]/g, '').slice(0, 24);
      const pad = indentOf(line);
      const code = [];
      for (i++; i < lines.length && !closesFence(lines[i], m[1]); i++) code.push(dedent(lines[i], pad));
      i++;
      out.push(`<pre${lang ? ` data-lang="${lang}"` : ''}><code>${code.join('\n')}</code></pre>`);
    } else if ((m = HEADING_RE.exec(line))) {
      const level = Math.min(6, m[1].length + 2); // narrow panel: # → h3 … #### → h6
      out.push(`<h${level}>${inline(m[2])}</h${level}>`);
      i++;
    } else if (HR_RE.test(line)) {
      out.push('<hr>');
      i++;
    } else if (isTable(lines, i)) {
      i = table(lines, i, out);
    } else if (QUOTE_RE.test(line)) {
      const inner = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) inner.push(lines[i++].replace(/^\s{0,3}&gt; ?/, ''));
      out.push(`<blockquote>${render(inner)}</blockquote>`);
    } else if (LIST_RE.test(line)) {
      i = list(lines, i, out);
    } else {
      const para = [line.trim()];
      for (i++; i < lines.length && lines[i].trim() && !interrupts(lines, i); i++) para.push(lines[i].trim());
      out.push(`<p>${inline(para.join('\n'))}</p>`);
    }
  }
  return out.join('\n');
}

function cells(line) {
  const s = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  const out = [];
  let cur = '';
  let code = false;
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (c === '\\' && s[k + 1] === '|') {
      cur += '|';
      k++;
      continue;
    }
    if (c === '`') code = !code;
    if (c === '|' && !code) {
      out.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

function table(lines, i, out) {
  const head = cells(lines[i]);
  const align = cells(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'c' : /-:$/.test(c) ? 'r' : ''));
  const cls = (k) => (align[k] ? ` class="al-${align[k]}"` : '');
  const rows = [];
  for (i += 2; i < lines.length && lines[i].trim() && lines[i].includes('|'); i++) rows.push(cells(lines[i]));
  let html = '<div class="table-wrap"><table><thead><tr>';
  html += head.map((c, k) => `<th${cls(k)}>${inline(c)}</th>`).join('') + '</tr></thead>';
  if (rows.length) {
    html += '<tbody>';
    html += rows.map((r) => '<tr>' + head.map((_, k) => `<td${cls(k)}>${inline(r[k] ?? '')}</td>`).join('') + '</tr>').join('');
    html += '</tbody>';
  }
  out.push(html + '</table></div>');
  return i;
}

function list(lines, i, out) {
  const first = LIST_RE.exec(lines[i]);
  const base = indentOf(lines[i]);
  const ordered = /\d/.test(first[2]);
  const start = ordered ? parseInt(first[2], 10) : 1;
  const sameLevel = (l) => {
    const m = LIST_RE.exec(l);
    return m && !HR_RE.test(l) && /\d/.test(m[2]) === ordered && Math.abs(indentOf(l) - base) <= 1 ? m : null;
  };
  const items = [];
  while (i < lines.length) {
    const line = lines[i];
    const m = sameLevel(line);
    if (m) {
      items.push({ pad: indentOf(line) + m[2].length + 1, lines: [m[3] || ''] });
      i++;
      continue;
    }
    const cur = items[items.length - 1];
    if (!line.trim()) {
      // A blank line continues the list only if more items or indented content follow.
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      if (j < lines.length && (sameLevel(lines[j]) || indentOf(lines[j]) > base + 1)) {
        for (; i < j; i++) cur.lines.push('');
        continue;
      }
      break;
    }
    if (indentOf(line) > base) cur.lines.push(dedent(line, cur.pad));
    else if (!interrupts(lines, i) && !LIST_RE.test(line)) cur.lines.push(line.trim()); // lazy continuation
    else break;
    i++;
  }
  const tag = ordered ? 'ol' : 'ul';
  const body = items.map((it) => listItem(it.lines)).join('');
  out.push(`<${tag}${ordered && start !== 1 ? ` start="${start}"` : ''}>${body}</${tag}>`);
  return i;
}

function listItem(ls) {
  const text = [];
  let k = 0;
  while (k < ls.length && ls[k].trim() && !FENCE_RE.test(ls[k]) && !(k > 0 && interrupts(ls, k))) text.push(ls[k++].trim());
  let html = '';
  let task = false;
  if (text.length) {
    let t = text.join('\n');
    const tm = /^\[([ xX])\]\s+/.exec(t);
    if (tm) {
      task = true;
      html = `<input type="checkbox" disabled${tm[1] === ' ' ? '' : ' checked'}> `;
      t = t.slice(tm[0].length);
    }
    html += inline(t);
  }
  const rest = ls.slice(k);
  if (rest.some((l) => l.trim())) html += render(rest);
  return `<li${task ? ' class="task"' : ''}>${html}</li>`;
}

/* ---------- inline ---------- */

function trimUrl(url) {
  let u = url;
  let tail = '';
  const count = (s, c) => s.split(c).length - 1;
  for (;;) {
    const c = u[u.length - 1];
    if (/[.,;:!?*_~]/.test(c) || (c === ')' && count(u, '(') < count(u, ')'))) {
      tail = c + tail;
      u = u.slice(0, -1);
    } else break;
  }
  return [/^https?:\/\/[^/]/.test(u) ? u : '', tail];
}

const emphasis = (s) =>
  s
    .replace(/\*\*\*(?=\S)([\s\S]*?\S)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, '$1<strong>$2</strong>')
    .replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![*\w])/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');

function inline(s) {
  // Code spans, escapes and links are parked in slots so later passes can't touch them.
  const slots = [];
  const hold = (html) => `\u0000${slots.push(html) - 1}\u0000`;
  const link = (url, label) => hold(`<a href="${url}" target="_blank" rel="noreferrer">${label}</a>`);
  s = s
    .replace(/``(.+?)``|`([^`\n]+)`/g, (_, a, b) => hold(`<code>${(a ?? b).replace(/^ (.+) $/, '$1')}</code>`))
    .replace(/\\(&(?:lt|gt|amp|quot|#39);|[\\`*_{}[\]()#+\-.!|~])/g, (_, c) => hold(c))
    .replace(
      /!?\[([^\]\n]+)\]\(\s*(https?:\/\/(?:[^\s()]|\([^\s()]*\))+)(?:\s+&quot;.*?&quot;)?\s*\)/g,
      (_, label, url) => link(url, emphasis(label))
    )
    .replace(/&lt;(https?:\/\/(?:(?!&gt;)\S)+?)&gt;/g, (_, url) => link(url, url))
    .replace(URL_RE, (url) => {
      const [u, tail] = trimUrl(url);
      return u ? link(u, u) + tail : url;
    });
  s = emphasis(s);
  const restore = (t) => t.replace(/\u0000(\d+)\u0000/g, (_, k) => restore(slots[+k]));
  return restore(s).replace(/\n/g, '<br>');
}

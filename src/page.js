// Functions in this file are serialized and injected into web pages with
// chrome.scripting.executeScript, so each one must be fully self-contained.

// Returns a text outline of the page with interactive elements marked as [id:kind "label" …].
export function pageRead(opts) {
  try {
    const { offset = 0, maxChars = 12000, filter = '', includeLinks = false } = opts || {};
    if (!document.body) return { error: 'This document has no readable body (it may be a PDF or still loading).' };

    const SKIP = new Set(['script', 'style', 'noscript', 'template', 'head', 'meta', 'link', 'svg', 'canvas', 'video', 'audio', 'object', 'embed', 'datalist']);
    const BLOCK = new Set(['address', 'article', 'aside', 'blockquote', 'details', 'dialog', 'dd', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'tr', 'ul', 'br', 'summary']);
    const ROLES = new Set(['button', 'link', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'checkbox', 'radio', 'switch', 'option', 'combobox', 'textbox', 'searchbox', 'slider', 'spinbutton', 'treeitem']);
    const NESTED = 'a[href],button,input,select,textarea,img,[role=button],[role=link],[onclick],[contenteditable=true],[contenteditable=""]';

    window.__aaNext = window.__aaNext || 1;
    const idFor = (el) => {
      let id = el.getAttribute('data-aa-id');
      if (!id) {
        id = String(window.__aaNext++);
        el.setAttribute('data-aa-id', id);
      }
      return id;
    };
    const clean = (s, n = 80) => {
      s = (s || '').replace(/\s+/g, ' ').trim();
      return s.length > n ? s.slice(0, n - 1) + '…' : s;
    };
    const q = (s, n) => JSON.stringify(clean(s, n));
    const visible = (el) => {
      try {
        if (el.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true })) return true;
        return getComputedStyle(el).display === 'contents';
      } catch {
        return true;
      }
    };
    const shadowOf = (el) => {
      try {
        return (globalThis.chrome?.dom?.openOrClosedShadowRoot && chrome.dom.openOrClosedShadowRoot(el)) || el.shadowRoot;
      } catch {
        return el.shadowRoot;
      }
    };

    const kindOf = (el, tag) => {
      if (tag === 'input') {
        const t = (el.type || 'text').toLowerCase();
        if (t === 'hidden') return null;
        return ['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'image', 'range'].includes(t) ? t : 'input';
      }
      if (tag === 'textarea') return 'textarea';
      if (tag === 'select') return 'select';
      if (tag === 'button' || tag === 'summary') return 'button';
      if (tag === 'a' && el.hasAttribute('href')) return 'link';
      if (el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable)) return 'editable';
      const role = el.getAttribute('role');
      if (role && ROLES.has(role)) return role;
      if (el.hasAttribute('onclick') || (el.hasAttribute('tabindex') && el.tabIndex >= 0)) return 'clickable';
      try {
        if (getComputedStyle(el).cursor === 'pointer' && !(el.parentElement && getComputedStyle(el.parentElement).cursor === 'pointer')) return 'clickable';
      } catch {}
      return null;
    };

    const flags = (el, parts) => {
      if (el.checked || el.getAttribute('aria-checked') === 'true') parts.push('checked');
      if (el.getAttribute('aria-selected') === 'true') parts.push('selected');
      if (el.getAttribute('aria-expanded') === 'true') parts.push('expanded');
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') parts.push('disabled');
    };

    // A label wrapping its control would otherwise include the control's own text (every <option>, say).
    const ownLabel = (el) => {
      const l = el.labels && el.labels[0];
      if (!l) return '';
      if (!l.contains(el)) return l.innerText;
      let t = '';
      for (const n of l.childNodes) if (n !== el && !(n.nodeType === 1 && n.contains(el))) t += n.textContent;
      return t;
    };

    const describe = (el, tag, kind) => {
      const parts = [`${idFor(el)}:${kind}`];
      const field = tag === 'input' || tag === 'textarea' || tag === 'select';
      const label = field
        ? el.getAttribute('aria-label') || ownLabel(el) || el.getAttribute('title') || ''
        : kind === 'editable'
        ? el.getAttribute('aria-label') || el.getAttribute('data-placeholder') || ''
        : el.getAttribute('aria-label') || el.innerText || el.getAttribute('title') || (el.querySelector('img[alt]') || {}).alt || '';
      if (clean(label)) parts.push(q(label));
      if (kind === 'input') parts.push(`type=${el.type}`);
      if (field && el.name) parts.push(`name=${el.name}`);
      if (el.placeholder) parts.push(`placeholder=${q(el.placeholder, 40)}`);
      if (kind === 'input' || kind === 'textarea') {
        parts.push(`value=${el.type === 'password' ? (el.value ? '"(hidden)"' : '""') : q(el.value, 60)}`);
      } else if (['button', 'submit', 'reset'].includes(kind) && tag === 'input' && el.value) {
        parts.push(q(el.value));
      } else if (kind === 'select') {
        const sel = el.selectedOptions && el.selectedOptions[0];
        parts.push(`value=${q(sel ? sel.text : '', 40)}`);
        const optsList = [...el.options].slice(0, 15).map((o) => clean(o.text, 30));
        parts.push(`options=${optsList.join('|')}${el.options.length > 15 ? '|…' : ''}`);
      } else if (kind === 'editable') {
        parts.push(`value=${q(el.innerText, 120)}`);
      }
      flags(el, parts);
      if (includeLinks && tag === 'a') parts.push(`href=${el.href}`);
      return `[${parts.join(' ')}]`;
    };

    const out = [];
    const walk = (node) => {
      if (node.nodeType === 3) {
        const t = node.nodeValue;
        if (t && t.trim()) out.push(t.replace(/\s+/g, ' '));
        return;
      }
      if (node.nodeType !== 1) return;
      const tag = node.localName;
      if (SKIP.has(tag) || node.id === '__aa_highlight') return;
      if (!visible(node)) return;
      if (tag === 'img') {
        const r = node.getBoundingClientRect();
        if (r.width >= 48 && r.height >= 48) out.push(` [${idFor(node)}:image ${q(node.alt, 60)} ${Math.round(r.width)}x${Math.round(r.height)}] `);
        else if (node.alt) out.push(' ' + clean(node.alt, 40) + ' ');
        return;
      }
      const block = BLOCK.has(tag);
      if (block) out.push('\n');
      if (/^h[1-6]$/.test(tag)) out.push('#'.repeat(+tag[1]) + ' ');
      const kind = kindOf(node, tag);
      let closer = '';
      if (kind) {
        const leaf = ['input', 'textarea', 'select'].includes(tag) || kind === 'editable' || !node.querySelector(NESTED);
        if (leaf) {
          out.push(' ' + describe(node, tag, kind) + ' ');
          if (block) out.push('\n');
          return;
        }
        // Clickable region that contains other controls/images: wrap its content.
        const id = idFor(node);
        const aria = node.getAttribute('aria-label');
        const href = includeLinks && tag === 'a' ? ' href=' + node.href : '';
        out.push(` [${id}:${kind}${aria ? ' ' + q(aria) : ''}${href}> `);
        closer = ` <${id}] `;
      }
      if (tag === 'iframe' || tag === 'frame') {
        try {
          const d = node.contentDocument;
          if (d && d.body) walk(d.body);
          else out.push(' [cross-origin iframe — content not readable; open its URL in a tab if needed] ');
        } catch {
          out.push(' [cross-origin iframe] ');
        }
      } else {
        const sr = shadowOf(node);
        if (sr) for (const c of sr.childNodes) walk(c);
        for (const c of node.childNodes) walk(c);
      }
      if (closer) out.push(closer);
      if (tag === 'td' || tag === 'th') out.push(' | ');
      if (block) out.push('\n');
    };
    walk(document.body);

    let lines = out
      .join('')
      .split('\n')
      .map((l) => l.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    if (filter) {
      const f = filter.toLowerCase();
      lines = lines.filter((l) => l.toLowerCase().includes(f));
    }
    const text = lines.join('\n');
    const se = document.scrollingElement || document.documentElement;
    return {
      url: location.href,
      title: document.title,
      total: text.length,
      offset,
      text: text.slice(offset, offset + maxChars),
      more: offset + maxChars < text.length,
      scrollY: Math.round(se.scrollTop),
      scrollMax: Math.max(0, Math.round(se.scrollHeight - se.clientHeight)),
    };
  } catch (e) {
    return { error: 'read_page failed: ' + (e && e.message ? e.message : e) };
  }
}

// Performs one action on the page. `a.type` selects the action; the target is a.id (from read_page),
// a.selector (CSS) or a.x/a.y (viewport coordinates).
export async function pageAct(a) {
  try {
    const shadowOf = (el) => {
      try {
        return (globalThis.chrome?.dom?.openOrClosedShadowRoot && chrome.dom.openOrClosedShadowRoot(el)) || el.shadowRoot;
      } catch {
        return el.shadowRoot;
      }
    };
    const deepFind = (root, sel) => {
      let el;
      try {
        el = root.querySelector(sel);
      } catch {
        throw new Error('Invalid CSS selector: ' + sel);
      }
      if (el) return el;
      for (const host of root.querySelectorAll('*')) {
        const sr = shadowOf(host);
        if (sr) {
          const r = deepFind(sr, sel);
          if (r) return r;
        }
        if (host.localName === 'iframe' || host.localName === 'frame') {
          try {
            const d = host.contentDocument;
            const r = d && deepFind(d, sel);
            if (r) return r;
          } catch {}
        }
      }
      return null;
    };

    if (a.type === 'check') {
      if (a.selector) return { found: !!deepFind(document, a.selector) };
      return { found: !!(document.body && document.body.innerText.toLowerCase().includes(String(a.text || '').toLowerCase())) };
    }

    const hasTarget = a.id != null || !!a.selector || (a.x != null && a.y != null);
    let el = null;
    if (a.id != null) el = deepFind(document, `[data-aa-id="${String(a.id).replace(/\D/g, '')}"]`);
    else if (a.selector) el = deepFind(document, a.selector);
    else if (a.x != null && a.y != null) el = document.elementFromPoint(a.x, a.y);
    if (hasTarget && !el) {
      return { error: `Element not found (${a.id != null ? 'id ' + a.id : a.selector || `${a.x},${a.y}`}). The page may have changed — call read_page again.` };
    }
    if (!hasTarget && !['scroll', 'key'].includes(a.type)) return { error: 'Provide an element id (from read_page) or a CSS selector.' };

    const desc = (e) => {
      if (!e) return 'page';
      const t = (e.getAttribute('aria-label') || e.innerText || e.value || e.getAttribute('placeholder') || e.getAttribute('alt') || '').replace(/\s+/g, ' ').trim().slice(0, 50);
      return `<${e.localName}>${t ? ' "' + t + '"' : ''}`;
    };
    const show = (e) => {
      try {
        e.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      } catch {}
    };
    // Center of the element in top-level viewport coordinates (accounts for same-origin iframes).
    const center = (e) => {
      const r = e.getBoundingClientRect();
      let x = r.left + r.width / 2;
      let y = r.top + r.height / 2;
      let w = e.ownerDocument.defaultView;
      try {
        while (w && w.frameElement) {
          const fr = w.frameElement.getBoundingClientRect();
          x += fr.left;
          y += fr.top;
          w = w.parent;
        }
      } catch {}
      return { x: Math.round(x), y: Math.round(y) };
    };
    const flash = (e) => {
      try {
        const r = e.getBoundingClientRect();
        const c = center(e);
        const d = document.createElement('div');
        d.id = '__aa_highlight';
        d.style.cssText = `position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #7c5cff;border-radius:4px;box-shadow:0 0 0 4px rgba(124,92,255,.3);left:${c.x - r.width / 2 - 2}px;top:${c.y - r.height / 2 - 2}px;width:${r.width}px;height:${r.height}px;transition:opacity .5s`;
        document.documentElement.appendChild(d);
        setTimeout(() => (d.style.opacity = '0'), 450);
        setTimeout(() => d.remove(), 1000);
      } catch {}
    };
    const mouse = (e, type, extra) => {
      const r = e.getBoundingClientRect();
      const o = { bubbles: true, cancelable: true, composed: true, view: e.ownerDocument.defaultView, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, ...extra };
      const Ctor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
      if (Ctor === PointerEvent) Object.assign(o, { pointerId: 1, isPrimary: true, pointerType: 'mouse' });
      e.dispatchEvent(new Ctor(type, o));
    };
    const fire = (e, type) => e.dispatchEvent(new Event(type, { bubbles: true, composed: true }));
    const selectAll = (e) => {
      if (typeof e.select === 'function') e.select();
      else if (e.isContentEditable) {
        const doc = e.ownerDocument;
        const range = doc.createRange();
        range.selectNodeContents(e);
        const sel = doc.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
    };
    const KEYCODES = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, PageUp: 33, PageDown: 34, Home: 36, End: 35, ' ': 32 };
    const pressKey = (t, key, mods) => {
      const kc = KEYCODES[key] || (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
      const code = key.length === 1 ? (/[a-z]/i.test(key) ? 'Key' + key.toUpperCase() : /\d/.test(key) ? 'Digit' + key : key === ' ' ? 'Space' : '') : key;
      const init = { key, code, keyCode: kc, which: kc, bubbles: true, cancelable: true, composed: true, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift, altKey: !!mods.alt, metaKey: !!mods.meta };
      const proceed = t.dispatchEvent(new KeyboardEvent('keydown', init));
      if (key === 'Enter' || key.length === 1) t.dispatchEvent(new KeyboardEvent('keypress', init));
      t.dispatchEvent(new KeyboardEvent('keyup', init));
      // Synthetic Enter does not trigger native form submission, so do it explicitly.
      if (proceed && key === 'Enter' && t.form && t.localName !== 'textarea') {
        if (t.form.requestSubmit) t.form.requestSubmit();
        else t.form.submit();
      }
    };
    const decode = (dataUrl) => {
      const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl);
      const bin = m[2] ? atob(m[3]) : decodeURIComponent(m[3]);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return { bytes, mime: m[1] || 'application/octet-stream' };
    };
    // A file sent ahead in chunks by pageChunk(). It is taken out of the buffer whatever happens next.
    const received = (t) => {
      const map = globalThis.__aaTransfers;
      const got = map && map.get(t.key);
      if (map) map.delete(t.key);
      if (!got) throw new Error('The file did not arrive in the page (it may have reloaded). Try again.');
      const file = new File(got.parts, t.name, { type: t.mime || '' });
      if (file.size !== t.size) throw new Error(`The file arrived incomplete (${file.size} of ${t.size} bytes). Try again.`);
      return file;
    };

    switch (a.type) {
      case 'locate': {
        show(el);
        flash(el);
        return { ok: true, desc: desc(el), ...center(el) };
      }
      case 'click': {
        if (el.localName === 'option' && el.parentElement && el.closest('select')) {
          const s = el.closest('select');
          s.value = el.value;
          fire(s, 'input');
          fire(s, 'change');
          return { ok: true, desc: desc(el) };
        }
        show(el);
        flash(el);
        mouse(el, 'pointerover');
        mouse(el, 'mouseover');
        mouse(el, 'pointerdown', { buttons: 1 });
        mouse(el, 'mousedown', { buttons: 1 });
        if (el.focus) el.focus({ preventScroll: true });
        mouse(el, 'pointerup');
        mouse(el, 'mouseup');
        if (typeof el.click === 'function') el.click();
        else mouse(el, 'click');
        if (a.double) mouse(el, 'dblclick', { detail: 2 });
        return { ok: true, desc: desc(el) };
      }
      case 'hover': {
        show(el);
        flash(el);
        for (const t of ['pointerover', 'mouseover', 'mouseenter', 'pointermove', 'mousemove']) mouse(el, t);
        return { ok: true, desc: desc(el) };
      }
      case 'focus': {
        show(el);
        flash(el);
        if (el.focus) el.focus({ preventScroll: true });
        if (a.clear !== false) selectAll(el);
        return { ok: true, desc: desc(el), ...center(el) };
      }
      case 'type': {
        show(el);
        flash(el);
        const tag = el.localName;
        const text = String(a.text ?? '');
        if (tag === 'input' || tag === 'textarea') {
          el.focus({ preventScroll: true });
          // Use the native setter so React/Vue controlled inputs notice the change.
          const proto = tag === 'input' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
          Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, a.clear === false ? el.value + text : text);
          el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
          fire(el, 'change');
        } else if (el.isContentEditable) {
          el.focus({ preventScroll: true });
          const doc = el.ownerDocument;
          const range = doc.createRange();
          range.selectNodeContents(el);
          if (a.clear === false) range.collapse(false);
          const sel = doc.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          const ok = text ? doc.execCommand('insertText', false, text) : doc.execCommand('delete');
          if (!ok) {
            el.textContent = (a.clear === false ? el.textContent : '') + text;
            el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
          }
        } else {
          return { error: `${desc(el)} is not a text field. Click it first, or target the input/textarea/editable element inside it.` };
        }
        if (a.enter) pressKey(el, 'Enter', {});
        return { ok: true, desc: desc(el) };
      }
      case 'select': {
        const s = el.localName === 'select' ? el : el.querySelector('select');
        if (!s) return { error: `${desc(el)} is not a <select>. For custom dropdowns, click it and then click the option.` };
        const want = String(a.value ?? '').trim().toLowerCase();
        const options = [...s.options];
        const opt =
          options.find((o) => o.value.toLowerCase() === want || o.text.trim().toLowerCase() === want) ||
          options.find((o) => o.text.toLowerCase().includes(want));
        if (!opt) return { error: 'Option not found. Available: ' + options.map((o) => o.text.trim()).slice(0, 40).join(' | ') };
        show(s);
        flash(s);
        s.value = opt.value;
        fire(s, 'input');
        fire(s, 'change');
        return { ok: true, desc: `${desc(s)} → "${opt.text.trim()}"` };
      }
      case 'key': {
        const t = el || document.activeElement || document.body;
        if (el && el.focus) el.focus({ preventScroll: true });
        pressKey(t, a.key, a.mods || {});
        return { ok: true, desc: desc(t) };
      }
      case 'scroll': {
        const se = document.scrollingElement || document.documentElement;
        let target = se;
        if (el) {
          if (!a.direction) {
            show(el);
            return { ok: true, desc: desc(el), scrollY: Math.round(se.scrollTop), scrollMax: Math.round(se.scrollHeight - se.clientHeight) };
          }
          for (let p = el; p && p !== document.body; p = p.parentElement) {
            const oy = getComputedStyle(p).overflowY;
            if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight + 4) {
              target = p;
              break;
            }
          }
        }
        const page = (target === se ? window.innerHeight : target.clientHeight) * 0.85;
        const amt = Number(a.amount) || page;
        const d = a.direction || 'down';
        if (d === 'top') target.scrollTo({ top: 0, behavior: 'instant' });
        else if (d === 'bottom') target.scrollTo({ top: target.scrollHeight, behavior: 'instant' });
        else target.scrollBy({ top: d === 'down' ? amt : d === 'up' ? -amt : 0, left: d === 'right' ? amt : d === 'left' ? -amt : 0, behavior: 'instant' });
        return { ok: true, desc: desc(target === se ? null : target), scrollY: Math.round(target.scrollTop), scrollMax: Math.max(0, Math.round(target.scrollHeight - target.clientHeight)) };
      }
      case 'upload': {
        const input = el.matches('input[type=file]') ? el : el.querySelector('input[type=file]') || (el.closest('label,form,div') || document).querySelector('input[type=file]');
        if (!input) {
          if (a.transfer) globalThis.__aaTransfers?.delete(a.transfer.key);
          return { error: 'No file input found at that element. Target the input[type=file] (it may be hidden — use a CSS selector).' };
        }
        if (a.probe) return { ok: true, desc: desc(input) };
        const dt = new DataTransfer();
        if (a.transfer) dt.items.add(received(a.transfer));
        for (const f of a.files || []) {
          const { bytes, mime } = decode(f.dataUrl);
          dt.items.add(new File([bytes], f.name, { type: f.mime || mime }));
        }
        input.files = dt.files;
        fire(input, 'input');
        fire(input, 'change');
        return { ok: true, desc: desc(input) };
      }
      case 'set_image': {
        let src = a.dataUrl;
        if (a.transfer) {
          // A large image came in chunks; as a data URL it behaves like a small one (same page CSP rules).
          const file = received(a.transfer);
          src = await new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(r.result);
            r.onerror = () => reject(r.error);
            r.readAsDataURL(file);
          });
        }
        show(el);
        flash(el);
        if (el.localName === 'img') {
          el.removeAttribute('srcset');
          const pic = el.closest('picture');
          if (pic) pic.querySelectorAll('source').forEach((s) => s.remove());
          el.src = src;
        } else {
          el.style.backgroundImage = `url("${src}")`;
        }
        return { ok: true, desc: desc(el) };
      }
      case 'image_src': {
        let src = el.localName === 'img' ? el.currentSrc || el.src : '';
        if (!src) {
          const inner = el.querySelector && el.querySelector('img');
          if (inner) src = inner.currentSrc || inner.src;
        }
        if (!src) {
          const m = /url\(["']?(.*?)["']?\)/.exec(getComputedStyle(el).backgroundImage || '');
          if (m) src = new URL(m[1], location.href).href;
        }
        if (!src) return { error: `${desc(el)} is not an image and has no background image.` };
        if (src.startsWith('blob:')) {
          const blob = await (await fetch(src)).blob();
          src = await new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(r.result);
            r.onerror = () => reject(r.error);
            r.readAsDataURL(blob);
          });
        }
        return { ok: true, src };
      }
      default:
        return { error: 'Unknown action: ' + a.type };
    }
  } catch (e) {
    return { error: String(e && e.message ? e.message : e) };
  }
}

// Receives a file in chunks (base64 of up to a few MB each), so no single executeScript message has to carry
// the whole file. The chunks wait in the extension's isolated world, keyed per transfer, until pageAct's
// upload / set_image takes them; op 'drop' discards a transfer that was cancelled.
export function pageChunk(a) {
  try {
    const map = (globalThis.__aaTransfers = globalThis.__aaTransfers || new Map());
    if (a.op === 'drop') {
      map.delete(a.key);
      return { ok: true, left: map.size };
    }
    if (a.index === 0) map.set(a.key, { parts: [], buf: null });
    const t = map.get(a.key);
    if (!t || t.parts.length !== a.index) {
      map.delete(a.key);
      return { error: 'The file transfer into the page was interrupted (the page may have reloaded). Try again.' };
    }
    let bytes;
    if (typeof Uint8Array.prototype.setFromBase64 === 'function') {
      // One decode buffer per transfer, reused for every chunk: the page allocates nothing per chunk but the Blob.
      const need = Math.ceil(a.b64.length / 4) * 3;
      if (!t.buf || t.buf.length < need) t.buf = new Uint8Array(need);
      bytes = t.buf.subarray(0, t.buf.setFromBase64(a.b64).written);
    } else if (typeof Uint8Array.fromBase64 === 'function') bytes = Uint8Array.fromBase64(a.b64);
    else {
      const bin = atob(a.b64);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    }
    // The Blob copies the bytes, and lets the browser keep them out of this page's JavaScript heap.
    t.parts.push(new Blob([bytes]));
    return { ok: true };
  } catch (e) {
    globalThis.__aaTransfers?.delete(a.key);
    return { error: 'The file could not be sent to the page: ' + (e && e.message ? e.message : e) };
  }
}

// Runs model-written JavaScript in the page's own (MAIN) world.
export async function mainEval(code) {
  const ser = (v) => {
    if (v === undefined) return 'undefined';
    if (typeof v === 'string') return v;
    if (v instanceof Element) return v.outerHTML.slice(0, 4000);
    try {
      const s = JSON.stringify(v, null, 2);
      return s === undefined ? String(v) : s;
    } catch {
      return String(v);
    }
  };
  let fn;
  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    try {
      fn = new AsyncFunction('return (' + code + '\n)');
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e;
      fn = new AsyncFunction(code);
    }
  } catch (e) {
    if (e instanceof EvalError || /Content Security Policy|unsafe-eval|Trusted/i.test(String(e && e.message))) return { csp: true };
    return { error: String(e) };
  }
  try {
    return { result: ser(await fn()) };
  } catch (e) {
    return { error: String((e && e.stack) || e) };
  }
}

// navigate back when chrome.tabs.goBack refuses (a tab whose first page nothing ever interacted with).
export function pageBack() {
  if (history.length <= 1) return false;
  history.back();
  return true;
}

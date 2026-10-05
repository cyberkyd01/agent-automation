// Turns attached files into text a model can read, and converts between data URLs and bytes.
// Pure ES module: no chrome.* and no DOM requirement, so it also imports in Node for tests.

export const MAX_ATTACH_BYTES = 30 * 1024 * 1024;

/* ---------- file types ---------- */

const MIME = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

// extension -> [kind, mime]. Anything not listed is sniffed (see extractText).
const TYPES = {};
const add = (kind, mime, exts) => {
  for (const e of exts.split(' ')) TYPES[e] = [kind, mime];
};
add('image', 'image/png', 'png');
add('image', 'image/jpeg', 'jpg jpeg jpe');
add('image', 'image/gif', 'gif');
add('image', 'image/webp', 'webp');
add('image', 'image/bmp', 'bmp');
add('image', 'image/avif', 'avif');
add('image', 'image/svg+xml', 'svg');
add('pdf', 'application/pdf', 'pdf');
add('docx', MIME.docx, 'docx docm dotx dotm');
add('xlsx', MIME.xlsx, 'xlsx xlsm xltx xltm');
add('pptx', MIME.pptx, 'pptx pptm potx potm ppsx ppsm');
// Plain text, data and markup.
add('text', 'text/plain', 'txt text log out lst nfo asc rst adoc org ini cfg conf config properties env editorconfig gitignore gitattributes npmrc nvmrc prettierrc eslintrc babelrc dockerignore');
add('text', 'text/markdown', 'md markdown mdx');
add('text', 'text/csv', 'csv');
add('text', 'text/tab-separated-values', 'tsv tab');
add('text', 'application/json', 'json map webmanifest');
add('text', 'application/x-ndjson', 'jsonl ndjson');
add('text', 'application/json5', 'json5');
add('text', 'application/geo+json', 'geojson');
add('text', 'application/xml', 'xml xsl xslt xsd dtd plist rdf opml kml gpx wsdl csproj vbproj resx xaml');
add('text', 'application/rss+xml', 'rss');
add('text', 'application/atom+xml', 'atom');
add('text', 'application/yaml', 'yaml yml');
add('text', 'application/toml', 'toml');
add('text', 'text/html', 'html htm xhtml');
add('text', 'text/css', 'css');
add('text', 'text/x-scss', 'scss sass less styl');
add('text', 'application/rtf', 'rtf');
add('text', 'text/calendar', 'ics');
add('text', 'text/vcard', 'vcf');
add('text', 'message/rfc822', 'eml');
add('text', 'text/vtt', 'vtt');
add('text', 'application/x-subrip', 'srt sub');
add('text', 'text/x-diff', 'diff patch');
add('text', 'application/x-tex', 'tex bib sty cls');
// Source code.
add('text', 'text/javascript', 'js mjs cjs jsx');
add('text', 'text/typescript', 'ts tsx mts cts');
add('text', 'text/x-python', 'py pyw pyi');
add('text', 'application/x-ipynb+json', 'ipynb');
add('text', 'application/x-sh', 'sh bash zsh fish ksh');
add('text', 'text/x-script', 'bat cmd ps1 psm1 vbs');
add('text', 'application/sql', 'sql');
add('text', 'application/graphql', 'graphql gql');
add('text', 'text/x-source', 'rb php java kt kts swift go rs c h cc cpp cxx hpp hh cs fs vb m mm scala lua pl pm r jl dart ex exs erl hs clj cljs lisp el vim vue svelte astro proto tf hcl gradle groovy cmake mk make dockerfile makefile gemfile rakefile procfile');
add('text', 'text/plain', 'license licence readme authors changelog notice copying codeowners');
// Binary formats the model cannot read, but which can be attached, uploaded and downloaded.
add('binary', 'application/msword', 'doc dot');
add('binary', 'application/vnd.ms-excel', 'xls xlt');
add('binary', 'application/vnd.ms-powerpoint', 'ppt pps pot');
add('binary', 'application/vnd.oasis.opendocument.text', 'odt');
add('binary', 'application/vnd.oasis.opendocument.spreadsheet', 'ods');
add('binary', 'application/vnd.oasis.opendocument.presentation', 'odp');
add('binary', 'application/epub+zip', 'epub');
add('binary', 'application/zip', 'zip');
add('binary', 'application/gzip', 'gz tgz');
add('binary', 'application/x-tar', 'tar');
add('binary', 'application/x-7z-compressed', '7z');
add('binary', 'application/vnd.rar', 'rar');
add('binary', 'application/x-bzip2', 'bz2');
add('binary', 'application/x-xz', 'xz');
add('binary', 'application/zstd', 'zst');
add('binary', 'application/x-apple-diskimage', 'dmg');
add('binary', 'application/x-iso9660-image', 'iso');
add('binary', 'application/java-archive', 'jar war');
add('binary', 'application/vnd.android.package-archive', 'apk');
add('binary', 'application/x-msdownload', 'exe dll msi');
add('binary', 'application/wasm', 'wasm');
add('binary', 'application/x-sqlite3', 'sqlite sqlite3 db');
add('binary', 'application/octet-stream', 'bin dat so dylib o a class pyc');
add('binary', 'image/vnd.microsoft.icon', 'ico');
add('binary', 'image/tiff', 'tif tiff');
add('binary', 'image/heic', 'heic');
add('binary', 'image/heif', 'heif');
add('binary', 'image/vnd.adobe.photoshop', 'psd');
add('binary', 'audio/mpeg', 'mp3');
add('binary', 'audio/wav', 'wav');
add('binary', 'audio/ogg', 'ogg oga');
add('binary', 'audio/mp4', 'm4a');
add('binary', 'audio/flac', 'flac');
add('binary', 'audio/aac', 'aac');
add('binary', 'audio/opus', 'opus');
add('binary', 'video/mp4', 'mp4 m4v');
add('binary', 'video/quicktime', 'mov');
add('binary', 'video/webm', 'webm');
add('binary', 'video/x-matroska', 'mkv');
add('binary', 'video/x-msvideo', 'avi');
add('binary', 'font/woff', 'woff');
add('binary', 'font/woff2', 'woff2');
add('binary', 'font/ttf', 'ttf');
add('binary', 'font/otf', 'otf');

// A few well-known files have no extension at all ('Makefile'); only those are looked up by whole name.
const NAMED = new Set(['makefile', 'dockerfile', 'gemfile', 'rakefile', 'procfile', 'license', 'licence', 'readme', 'authors', 'changelog', 'notice', 'copying', 'codeowners']);
const extOf = (name) => {
  const base = String(name || '').split(/[\\/]/).pop().toLowerCase();
  const i = base.lastIndexOf('.');
  if (i >= 0) return base.slice(i + 1);
  return NAMED.has(base) ? base : '';
};
const cleanMime = (m) => String(m || '').split(';')[0].trim().toLowerCase();

const DISPLAYABLE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/svg+xml', 'image/avif']);
const TEXT_APP = /^application\/(json|json5|xml|javascript|x-javascript|ecmascript|yaml|x-yaml|toml|x-sh|x-csh|x-httpd-php|sql|graphql|x-ndjson|ndjson|xhtml\+xml|rtf|x-latex|x-tex|x-subrip|x-www-form-urlencoded)$/;

// { kind, known }: `known` is false when we are only guessing (so the bytes get sniffed).
function classify(name, mime) {
  const hit = TYPES[extOf(name)];
  if (hit) return { kind: hit[0], known: true };
  const m = cleanMime(mime);
  if (DISPLAYABLE.has(m)) return { kind: 'image', known: true };
  if (m === 'application/pdf' || m === 'application/x-pdf') return { kind: 'pdf', known: true };
  if (/wordprocessingml|ms-word\.(document|template)\.macroenabled/.test(m)) return { kind: 'docx', known: true };
  if (/spreadsheetml|ms-excel\.(sheet|template)\.macroenabled/.test(m)) return { kind: 'xlsx', known: true };
  if (/presentationml|ms-powerpoint\.(presentation|slideshow|template)\.macroenabled/.test(m)) return { kind: 'pptx', known: true };
  if (m.startsWith('text/') || TEXT_APP.test(m) || /\+(json|xml|yaml)$/.test(m) || m === 'message/rfc822') return { kind: 'text', known: true };
  if (/^(audio|video|font)\//.test(m) || m.startsWith('image/')) return { kind: 'binary', known: true };
  if (m && m !== 'application/octet-stream') {
    if (/^application\/(zip|gzip|x-tar|x-7z|vnd\.rar|x-rar|java-archive|msword|vnd\.ms-|vnd\.oasis|x-msdownload|wasm|x-sqlite)/.test(m)) return { kind: 'binary', known: true };
  }
  return { kind: 'binary', known: false };
}

export function fileKind(name, mime) {
  return classify(name, mime).kind;
}

export function guessMime(name, fallback = 'application/octet-stream') {
  const hit = TYPES[extOf(name)];
  return hit ? hit[1] : fallback;
}

/* ---------- bytes and data URLs ---------- */

export function formatBytes(n) {
  n = Number(n);
  if (!Number.isFinite(n) || n < 0) n = 0;
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  let s = v >= 10 ? Math.round(v) : Math.round(v * 10) / 10;
  if (s >= 1024 && i < units.length - 1) {
    s = 1;
    i++;
  }
  return `${s} ${units[i]}`;
}

function parseDataUrl(dataUrl) {
  const s = String(dataUrl ?? '');
  const comma = s.indexOf(',');
  if (!s.startsWith('data:') || comma < 0) throw new Error('not a data URL');
  const header = s.slice(5, comma);
  const payload = s.slice(comma + 1);
  const base64 = /;\s*base64\s*$/i.test(header);
  const mime = cleanMime(header.split(';')[0]);
  let bytes;
  if (base64) {
    const clean = payload.replace(/\s+/g, '');
    if (typeof Uint8Array.fromBase64 === 'function') bytes = Uint8Array.fromBase64(clean);
    else {
      const bin = atob(clean);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    }
  } else {
    // Percent-encoded: decode %XX to raw bytes and encode everything else as UTF-8.
    const enc = new TextEncoder();
    const out = [];
    for (let i = 0; i < payload.length; ) {
      if (payload[i] === '%' && /^[0-9a-fA-F]{2}$/.test(payload.substr(i + 1, 2))) {
        out.push(parseInt(payload.substr(i + 1, 2), 16));
        i += 3;
      } else {
        const cp = payload.codePointAt(i);
        const ch = String.fromCodePoint(cp);
        for (const b of enc.encode(ch)) out.push(b);
        i += ch.length;
      }
    }
    bytes = Uint8Array.from(out);
  }
  return { bytes, mime };
}

export function dataUrlToBytes(dataUrl) {
  return parseDataUrl(dataUrl).bytes;
}

export function bytesToDataUrl(bytes, mime) {
  if (bytes instanceof ArrayBuffer) bytes = new Uint8Array(bytes);
  else if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes || 0);
  let b64;
  if (typeof bytes.toBase64 === 'function') b64 = bytes.toBase64();
  else {
    // btoa wants a string; build it in slices because spreading a big array overflows the stack.
    const parts = [];
    for (let i = 0; i < bytes.length; i += 0x8000) parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)));
    b64 = btoa(parts.join(''));
  }
  const m = String(mime || 'application/octet-stream').trim() || 'application/octet-stream';
  return `data:${m};base64,${b64}`;
}

function readAsDataUrl(file, mime) {
  if (typeof FileReader === 'function') {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => {
        // The browser labels the data URL with the blob's own type, which may be empty; use ours.
        const s = String(r.result);
        resolve(`data:${mime};base64,${s.slice(s.indexOf(',') + 1)}`);
      };
      r.onerror = () => reject(r.error || new Error('read failed'));
      r.readAsDataURL(file);
    });
  }
  return file.arrayBuffer().then((buf) => bytesToDataUrl(new Uint8Array(buf), mime));
}

const mbText = (n) => {
  const mb = n / 1048576;
  return mb >= 100 ? String(Math.round(mb)) : mb.toFixed(1).replace(/\.0$/, '');
};

export async function fileToAssetData(file, name) {
  if (!file || typeof file.size !== 'number') throw new Error('That is not a file that can be attached.');
  const fileName = String(name || file.name || 'file');
  if (file.size > MAX_ATTACH_BYTES) {
    throw new Error(`${fileName} is ${mbText(file.size)} MB — the limit is ${MAX_ATTACH_BYTES / 1048576} MB.`);
  }
  let mime = cleanMime(file.type);
  // Browsers mislabel some source files (.ts is reported as video/mp2t), so a known text extension wins.
  const byExt = TYPES[extOf(fileName)];
  if (!mime || mime === 'application/octet-stream' || (byExt && byExt[0] === 'text' && classify('', mime).kind !== 'text')) {
    mime = guessMime(fileName, mime || 'application/octet-stream');
  }
  let dataUrl;
  try {
    dataUrl = await readAsDataUrl(file, mime);
  } catch {
    throw new Error(`Could not read ${fileName}. It may have been moved or deleted — try attaching it again.`);
  }
  return { name: fileName, mime, size: file.size, dataUrl };
}

/* ---------- text ---------- */

const BINARY_NOTE = 'Binary file — it cannot be read as text, but it can be uploaded or downloaded.';

function binaryNote(name) {
  const ext = extOf(name);
  if (ext === 'doc' || ext === 'dot') return 'This is an old Word file (.doc). It cannot be read here — save it as .docx or PDF and attach that instead. It can still be uploaded or downloaded.';
  if (ext === 'xls' || ext === 'xlt') return 'This is an old Excel file (.xls). It cannot be read here — save it as .xlsx or CSV and attach that instead. It can still be uploaded or downloaded.';
  if (ext === 'ppt' || ext === 'pps' || ext === 'pot') return 'This is an old PowerPoint file (.ppt). It cannot be read here — save it as .pptx or PDF and attach that instead. It can still be uploaded or downloaded.';
  if (['odt', 'ods', 'odp'].includes(ext)) return 'OpenDocument files cannot be read here — export it as .docx, .xlsx, .pptx or PDF instead. It can still be uploaded or downloaded.';
  if (['zip', 'gz', 'tgz', 'tar', '7z', 'rar', 'bz2', 'xz', 'zst', 'jar', 'war', 'apk'].includes(ext)) return 'This is an archive — its contents are not unpacked, but it can be uploaded or downloaded.';
  const t = TYPES[ext];
  if (t && /^(audio|video)\//.test(t[1])) return 'Audio or video file — it cannot be read as text, but it can be uploaded or downloaded.';
  return BINARY_NOTE;
}

function decodeUtf8Strict(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function decodeUtf16(bytes, bigEndian) {
  try {
    return new TextDecoder(bigEndian ? 'utf-16be' : 'utf-16le').decode(bytes);
  } catch {
    // Runtime without utf-16be: swap the bytes ourselves.
    const n = bytes.length - (bytes.length % 2);
    let s = '';
    for (let i = 2; i < n; i += 2) {
      const hi = bigEndian ? bytes[i] : bytes[i + 1];
      const lo = bigEndian ? bytes[i + 1] : bytes[i];
      s += String.fromCharCode((hi << 8) | lo);
    }
    return s;
  }
}

const normalizeNewlines = (s) => s.replace(/\r\n?/g, '\n');

// Decode as text, honouring BOMs (TextDecoder drops a UTF-8 BOM itself). `strict` is false for XML parts, where a lossy decode beats giving up.
function decodeBytes(bytes, strict = false) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return decodeUtf16(bytes, false);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return decodeUtf16(bytes, true);
  const s = decodeUtf8Strict(bytes);
  if (s != null) return s;
  return strict ? null : new TextDecoder().decode(bytes);
}

function textResult(bytes, name, known) {
  const utf16 = (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff);
  const utf32 = bytes[0] === 0xff && bytes[1] === 0xfe && bytes[2] === 0 && bytes[3] === 0;
  if (utf32) return { kind: 'binary', text: '', note: 'This text file uses an unusual encoding (UTF-32) that cannot be read here. Re-save it as UTF-8.' };
  if (!utf16) {
    const head = bytes.subarray(0, 8192);
    if (head.indexOf(0) >= 0) return { kind: 'binary', text: '', note: binaryNote(name) };
  }
  const strict = decodeBytes(bytes, true);
  if (strict != null) return { kind: 'text', text: normalizeNewlines(strict) };
  // Not UTF-8. A file named like text (e.g. a CSV from Excel) is almost always Windows-1252.
  if (!known) return { kind: 'binary', text: '', note: binaryNote(name) };
  return {
    kind: 'text',
    text: normalizeNewlines(new TextDecoder('windows-1252').decode(bytes)),
    note: 'This file is not UTF-8, so it was read as Windows-1252. Some accented characters may look wrong.',
  };
}

/* ---------- XML ---------- */

const XML_ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
    }
    return XML_ENT[e] ?? m;
  });
}

// Spreadsheet strings escape control characters as _x000D_.
const unescapeXstring = (s) => (s.indexOf('_x') < 0 ? s : s.replace(/_x([0-9a-fA-F]{4})_/g, (m, h) => String.fromCharCode(parseInt(h, 16))));

// Tiny element tree with the same read-only surface we use on real DOM elements:
// localName, attributes (indexable, each with localName/value), children (elements only), textContent.
class XEl {
  constructor(name, attributes) {
    this.localName = name.slice(name.lastIndexOf(':') + 1);
    this.attributes = attributes;
    this.children = [];
    this.parts = [];
  }
  get textContent() {
    let s = '';
    for (const p of this.parts) s += typeof p === 'string' ? p : p.textContent;
    return s;
  }
}

const TAG_RE = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!(?:DOCTYPE|ENTITY)[^>]*>|<\/([^\s>]+)\s*>|<([^\s\/>!?]+)((?:\s+[^\s=\/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
const ATTR_RE = /([^\s=\/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

// Fallback for runtimes without DOMParser (Node, service workers). Tolerant: never throws on bad markup.
function parseXmlLite(xml) {
  const root = new XEl('#root', []);
  const stack = [root];
  let last = 0;
  const text = (raw) => {
    if (raw) stack[stack.length - 1].parts.push(decodeEntities(raw));
  };
  TAG_RE.lastIndex = 0;
  let m;
  while ((m = TAG_RE.exec(xml))) {
    if (m.index > last) text(xml.slice(last, m.index));
    last = TAG_RE.lastIndex;
    if (m[1] !== undefined) stack[stack.length - 1].parts.push(m[1]); // CDATA is literal
    else if (m[2] !== undefined) {
      const want = m[2].slice(m[2].lastIndexOf(':') + 1);
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].localName === want) {
          stack.length = i;
          break;
        }
      }
    } else if (m[3] !== undefined) {
      const attrs = [];
      ATTR_RE.lastIndex = 0;
      let a;
      while ((a = ATTR_RE.exec(m[4]))) attrs.push({ localName: a[1].slice(a[1].lastIndexOf(':') + 1), value: decodeEntities(a[2] ?? a[3] ?? '') });
      const el = new XEl(m[3], attrs);
      const top = stack[stack.length - 1];
      top.children.push(el);
      top.parts.push(el);
      if (!m[5]) stack.push(el);
    }
  }
  if (last < xml.length) text(xml.slice(last));
  return root.children[0] || root;
}

// Real DOMParser when there is one (fast, native); the tolerant parser above otherwise or on a parse error.
function parseXml(xml) {
  // Office parts never declare entities; if one does (entity-expansion tricks), skip the native parser.
  if (typeof DOMParser === 'function' && !xml.includes('<!ENTITY')) {
    try {
      const doc = new DOMParser().parseFromString(xml, 'application/xml');
      const root = doc.documentElement;
      if (root && ln(root) !== 'parsererror' && !doc.getElementsByTagName('parsererror').length) return root;
    } catch {}
  }
  return parseXmlLite(xml);
}

// Names are reduced to their local part by hand: some DOM implementations (linkedom) keep the 'w:' prefix in localName.
const localPart = (n) => {
  n = String(n || '');
  return n.slice(n.lastIndexOf(':') + 1);
};
const ln = (el) => localPart(el.localName);

function attr(el, local) {
  const a = el.attributes;
  if (!a) return null;
  for (let i = 0; i < a.length; i++) {
    if (localPart(a[i].localName || a[i].name) === local) return a[i].value;
  }
  return null;
}

// The r:id attribute of an element, found by value: its local name 'id' also matches a plain id="257" next to it.
function relIdOf(el, rels) {
  const a = el.attributes;
  for (let i = 0; i < a.length; i++) if (localPart(a[i].localName || a[i].name) === 'id' && rels.has(a[i].value)) return a[i].value;
  return null;
}

// Element children; mc:AlternateContent is replaced by one branch so text in it is not counted twice.
function kidsOf(el) {
  const out = [];
  for (const c of el.children) {
    if (ln(c) === 'AlternateContent') {
      let pick = null;
      for (const k of c.children) if (ln(k) === 'Choice') pick = pick || k;
      if (!pick) for (const k of c.children) if (ln(k) === 'Fallback') pick = pick || k;
      if (pick) out.push(...kidsOf(pick));
    } else out.push(c);
  }
  return out;
}

const findChild = (el, local) => {
  for (const c of el.children) if (ln(c) === local) return c;
  return null;
};

/* ---------- ZIP (Office files) ---------- */

class ZipError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const MAX_PART_BYTES = 128 * 1024 * 1024; // guards against decompression bombs

function readZipDirectory(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (dv.getUint32(i, true) === 0x06054b50 && i + 22 + dv.getUint16(i + 20, true) <= bytes.length) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError('notzip');
  const total = dv.getUint16(eocd + 10, true);
  const cdSize = dv.getUint32(eocd + 12, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  const hasLocator = eocd >= 20 && dv.getUint32(eocd - 20, true) === 0x07064b50;
  if (hasLocator || total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipError('zip64');
  if (cdOffset + cdSize > eocd) throw new ZipError('corrupt');

  const entries = new Map();
  const utf8 = new TextDecoder();
  let p = cdOffset;
  for (let n = 0; n < total; n++) {
    if (p + 46 > bytes.length || dv.getUint32(p, true) !== 0x02014b50) throw new ZipError('corrupt');
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const offset = dv.getUint32(p + 42, true);
    if (csize === 0xffffffff || usize === 0xffffffff || offset === 0xffffffff) throw new ZipError('zip64');
    const name = utf8.decode(bytes.subarray(p + 46, p + 46 + nameLen)).replace(/\\/g, '/');
    entries.set(name, { name, flags, method, csize, usize, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function inflateRaw(data, limit) {
  let ds = null;
  try {
    ds = new DecompressionStream('deflate-raw');
  } catch {}
  if (!ds) {
    // Older Node without 'deflate-raw'. Never taken in Chrome (supported since 103).
    const zlib = await import('node:zlib');
    const out = zlib.inflateRawSync(data, { maxOutputLength: limit });
    return new Uint8Array(out.buffer, out.byteOffset, out.length);
  }
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  // A failed write also errors the readable side, which is where we report it from.
  writer.write(data).catch(() => {});
  writer.close().catch(() => {});
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      reader.cancel().catch(() => {});
      throw new ZipError('toolarge');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

async function openZip(bytes) {
  // Password-protected Office files are not ZIPs at all: they are old-style compound files.
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) throw new ZipError('ole');
  const entries = readZipDirectory(bytes);
  const lower = new Map([...entries].map(([k, v]) => [k.toLowerCase(), v]));
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const find = (name) => entries.get(name) || lower.get(name.toLowerCase()) || null;
  const bytesOf = async (name) => {
    const e = find(name);
    if (!e) return null;
    if (e.flags & 1) throw new ZipError('encrypted');
    // Sizes come from the central directory: with the data-descriptor flag the local header's are zero.
    if (e.offset + 30 > bytes.length || dv.getUint32(e.offset, true) !== 0x04034b50) throw new ZipError('corrupt');
    const start = e.offset + 30 + dv.getUint16(e.offset + 26, true) + dv.getUint16(e.offset + 28, true);
    if (start + e.csize > bytes.length) throw new ZipError('corrupt');
    const raw = bytes.subarray(start, start + e.csize);
    if (e.method === 0) return raw;
    if (e.method === 8) {
      try {
        return await inflateRaw(raw, MAX_PART_BYTES);
      } catch (err) {
        throw err instanceof ZipError ? err : new ZipError('corrupt');
      }
    }
    throw new ZipError('method');
  };
  return {
    names: [...entries.keys()],
    has: (name) => !!find(name),
    bytes: bytesOf,
    async text(name) {
      const b = await bytesOf(name);
      return b ? decodeBytes(b) : null;
    },
    async xml(name) {
      const s = await this.text(name);
      return s == null ? null : parseXml(s);
    },
  };
}

// 'xl/workbook.xml' -> 'xl/'
const dirOf = (path) => path.slice(0, path.lastIndexOf('/') + 1);

function resolvePart(base, target) {
  if (target.startsWith('/')) return target.slice(1);
  const out = dirOf(base).split('/').filter(Boolean);
  for (const seg of target.split('/')) {
    if (seg === '..') out.pop();
    else if (seg && seg !== '.') out.push(seg);
  }
  return out.join('/');
}

// Relationships of a part: Map<Id, { type, target }> with targets resolved to zip paths.
async function readRels(zip, part) {
  const rels = new Map();
  const relsPath = `${dirOf(part)}_rels/${part.slice(part.lastIndexOf('/') + 1)}.rels`;
  const root = await zip.xml(relsPath).catch(() => null);
  if (!root) return rels;
  for (const r of root.children) {
    if (ln(r) !== 'Relationship' || attr(r, 'TargetMode') === 'External') continue;
    const id = attr(r, 'Id');
    const target = attr(r, 'Target');
    if (id && target) rels.set(id, { type: attr(r, 'Type') || '', target: resolvePart(part, target) });
  }
  return rels;
}

// The package's main part (document.xml / workbook.xml / presentation.xml), found via _rels/.rels.
async function mainPart(zip, fallback) {
  const root = await zip.xml('_rels/.rels').catch(() => null);
  for (const r of root ? root.children : []) {
    if (ln(r) === 'Relationship' && /\/officeDocument$/.test(attr(r, 'Type') || '')) {
      const path = (attr(r, 'Target') || '').replace(/^\//, '');
      if (path && zip.has(path)) return path;
    }
  }
  return zip.has(fallback) ? fallback : null;
}

const OFFICE = {
  docx: { label: 'Word document', main: 'word/document.xml' },
  xlsx: { label: 'Excel workbook', main: 'xl/workbook.xml' },
  pptx: { label: 'PowerPoint presentation', main: 'ppt/presentation.xml' },
};

function officeNote(kind, e) {
  const { label } = OFFICE[kind];
  switch (e?.code) {
    case 'ole':
      return `This ${label} is password-protected or saved in an old Office format, so it cannot be read here.`;
    case 'encrypted':
      return `This ${label} is password-protected, so it cannot be read here.`;
    case 'zip64':
      return `This ${label} uses a ZIP variant (ZIP64) that cannot be read here.`;
    case 'toolarge':
      return `This ${label} is too large to read as text.`;
    case 'method':
      return `This ${label} uses a compression method that cannot be read here.`;
    case 'nomain':
      return `This does not look like a real ${label}: its main content is missing.`;
    default:
      return `This ${label} is damaged or is not a real .${kind} file, so it cannot be read.`;
  }
}

/* ---------- DOCX ---------- */

const DOCX_SKIP = new Set(['pPr', 'rPr', 'sectPr', 'tblPr', 'trPr', 'tcPr', 'tblGrid', 'sdtPr', 'sdtEndPr', 'del', 'moveFrom', 'delText', 'instrText']);

// Text of one paragraph. Text boxes inside it are pushed to `extra` as separate lines.
function docxParagraph(p, extra) {
  let s = '';
  const walk = (el) => {
    for (const c of kidsOf(el)) {
      const n = ln(c);
      if (DOCX_SKIP.has(n)) continue;
      if (n === 't') s += c.textContent;
      else if (n === 'tab' || n === 'ptab') s += '\t';
      else if (n === 'br' || n === 'cr') s += '\n';
      else if (n === 'noBreakHyphen') s += '-';
      else if (n === 'txbxContent') docxBlocks(c, extra);
      else walk(c);
    }
  };
  walk(p);
  return s;
}

function docxTable(tbl) {
  const rows = [];
  for (const tr of kidsOf(tbl)) {
    if (ln(tr) !== 'tr') continue;
    const cells = [];
    for (const tc of kidsOf(tr)) {
      if (ln(tc) !== 'tc') continue;
      const inner = [];
      docxBlocks(tc, inner);
      cells.push(inner.join(' ').replace(/\s+/g, ' ').trim());
      // A merged cell spans several columns: pad so the columns of later cells still line up.
      const pr = findChild(tc, 'tcPr');
      const span = pr && findChild(pr, 'gridSpan');
      const n = span ? parseInt(attr(span, 'val') || '1', 10) : 1;
      for (let i = 1; i < n && i < 64; i++) cells.push('');
    }
    rows.push(cells.join('\t'));
  }
  return rows;
}

function docxBlocks(el, out) {
  for (const c of kidsOf(el)) {
    const n = ln(c);
    if (DOCX_SKIP.has(n)) continue;
    if (n === 'p') {
      const extra = [];
      out.push(docxParagraph(c, extra));
      out.push(...extra);
    } else if (n === 'tbl') out.push(...docxTable(c));
    else docxBlocks(c, out);
  }
}

function blocksToText(el) {
  const out = [];
  docxBlocks(el, out);
  return out.join('\n').replace(/ +\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function extractDocx(zip) {
  const main = await mainPart(zip, OFFICE.docx.main);
  if (!main) throw new ZipError('nomain');
  const root = await zip.xml(main);
  if (!root || ln(root) !== 'document') throw new ZipError('nomain');
  const body = findChild(root, 'body') || root;
  const parts = [];
  const side = async (re, label) => {
    const seen = new Set();
    for (const name of zip.names.filter((n) => re.test(n)).sort()) {
      const r = await zip.xml(name).catch(() => null);
      const t = r ? blocksToText(r).replace(/\n+/g, ' ').trim() : '';
      if (t && !seen.has(t)) {
        seen.add(t);
        parts.push(`[${label}] ${t}`);
      }
    }
  };
  await side(/^word\/header\d*\.xml$/i, 'Header');
  const text = blocksToText(body);
  if (text) parts.push(text);
  let notes = [];
  for (const name of ['word/footnotes.xml', 'word/endnotes.xml']) {
    const r = zip.has(name) ? await zip.xml(name).catch(() => null) : null;
    if (!r) continue;
    for (const f of r.children) {
      const type = attr(f, 'type');
      if (type === 'separator' || type === 'continuationSeparator' || type === 'continuationNotice') continue;
      const t = blocksToText(f).replace(/\n+/g, ' ').trim();
      if (t) notes.push(t);
    }
  }
  if (notes.length) parts.push(`--- Notes ---\n${notes.join('\n')}`);
  await side(/^word\/footer\d*\.xml$/i, 'Footer');
  const out = parts.join('\n\n').trim();
  return out ? { text: out } : { text: '', note: 'This Word document has no text in it.' };
}

/* ---------- XLSX ---------- */

const MAX_SHEET_ROWS = 5000;
const MAX_TOTAL_ROWS = 20000;
const MAX_COLS = 200;

// The sheet and string parts can be huge, so they are scanned with regexes instead of building a tree.
const SI_RE = /<(?:\w+:)?si\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?si>)/g;
const T_RE = /<(?:\w+:)?t\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?t>)/g;
const ROW_RE = /<(?:\w+:)?row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?row>)/g;
const CELL_RE = /<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g;
const V_RE = /<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/;
const IS_RE = /<(?:\w+:)?is\b[^>]*>([\s\S]*?)<\/(?:\w+:)?is>/;
const F_RE = /<(?:\w+:)?f\b[^>]*>([\s\S]*?)<\/(?:\w+:)?f>/;

function attrsOf(str) {
  const o = {};
  ATTR_RE.lastIndex = 0;
  let a;
  while ((a = ATTR_RE.exec(str))) o[a[1].slice(a[1].lastIndexOf(':') + 1)] = decodeEntities(a[2] ?? a[3] ?? '');
  return o;
}

function richText(inner) {
  // Skip phonetic runs (furigana): they repeat the text in another script.
  inner = inner.replace(/<(?:\w+:)?rPh\b[\s\S]*?<\/(?:\w+:)?rPh>/g, '');
  let s = '';
  T_RE.lastIndex = 0;
  let m;
  while ((m = T_RE.exec(inner))) s += m[1] ? unescapeXstring(decodeEntities(m[1])) : '';
  return s;
}

function parseSharedStrings(xml) {
  const out = [];
  SI_RE.lastIndex = 0;
  let m;
  while ((m = SI_RE.exec(xml))) out.push(m[1] ? richText(m[1]) : '');
  return out;
}

function colIndex(ref) {
  const m = /^([A-Za-z]+)/.exec(ref || '');
  if (!m) return -1;
  let n = 0;
  for (const ch of m[1].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// Is this number format a date/time? Built-in ids 14-22, 27-36, 45-47, 50-58, or a custom code with date/time letters.
function isDateFormat(id, codes) {
  if ((id >= 14 && id <= 22) || (id >= 27 && id <= 36) || (id >= 45 && id <= 47) || (id >= 50 && id <= 58)) return true;
  const code = codes.get(id);
  if (!code) return false;
  const stripped = code
    .replace(/\[(h+|m+|s+)\]/gi, '$1') // elapsed time
    .replace(/\[[^\]]*\]/g, '') // colours, conditions, locale
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/_./g, '');
  return /[dmyhs]/i.test(stripped);
}

function parseDateStyles(xml) {
  const codes = new Map();
  for (const m of xml.matchAll(/<(?:\w+:)?numFmt\b([^>]*?)\/?>/g)) {
    const a = attrsOf(m[1]);
    if (a.numFmtId != null && a.formatCode != null) codes.set(Number(a.numFmtId), a.formatCode);
  }
  const flags = [];
  const block = /<(?:\w+:)?cellXfs\b[^>]*>([\s\S]*?)<\/(?:\w+:)?cellXfs>/.exec(xml);
  if (block) {
    for (const m of block[1].matchAll(/<(?:\w+:)?xf\b([^>]*?)(?:\/>|>)/g)) {
      flags.push(isDateFormat(Number(attrsOf(m[1]).numFmtId || 0), codes));
    }
  }
  return flags;
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

// Excel serial number -> 'YYYY-MM-DD' / 'YYYY-MM-DD HH:MM[:SS]' / 'HH:MM[:SS]'. Null when out of range.
function serialToDate(serial, date1904) {
  if (!Number.isFinite(serial) || serial < 0 || serial >= 2958466) return null;
  let day = Math.floor(serial);
  let secs = Math.round((serial - day) * 86400);
  if (secs === 86400) {
    secs = 0;
    day++;
  }
  const hms = () => {
    const h = Math.floor(secs / 3600);
    const mi = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    return `${pad(h)}:${pad(mi)}${s ? ':' + pad(s) : ''}`;
  };
  if (!date1904 && day === 0) return hms(); // time only
  if (!date1904 && day === 60) return `1900-02-29${secs ? ' ' + hms() : ''}`; // Excel's phantom leap day
  // 1900 system: serial 1 = 1900-01-01, but Excel counts a leap day that never existed, so shift after day 60.
  const base = date1904 ? Date.UTC(1904, 0, 1) : day < 60 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30);
  const d = new Date(base + day * 86400000);
  const ymd = `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return secs ? `${ymd} ${hms()}` : ymd;
}

function cellValue(attrs, inner, sst, dateStyles, date1904) {
  const t = attrs.t || 'n';
  if (inner == null) return '';
  if (t === 'inlineStr') {
    const is = IS_RE.exec(inner);
    return is ? richText(is[1]) : '';
  }
  const vm = V_RE.exec(inner);
  if (!vm || vm[1] === '') {
    // A formula that was never calculated (files written by scripts) has no value: show the formula itself.
    const fm = F_RE.exec(inner);
    return fm && fm[1] ? `=${decodeEntities(fm[1])}` : '';
  }
  const raw = vm[1];
  switch (t) {
    case 's':
      return sst[parseInt(raw, 10)] ?? '';
    case 'str':
      return unescapeXstring(decodeEntities(raw));
    case 'b':
      return raw.trim() === '1' ? 'TRUE' : 'FALSE';
    case 'e':
    case 'd':
      return decodeEntities(raw);
    default: {
      const v = decodeEntities(raw).trim();
      if (dateStyles[Number(attrs.s)] && /^-?\d+(\.\d+)?$/.test(v)) return serialToDate(Number(v), date1904) ?? v;
      return v;
    }
  }
}

// Rows of one worksheet as TSV lines. `budget` is how many rows may still be emitted overall.
function sheetToLines(xml, ctx, budget) {
  const lines = [];
  let rows = 0;
  let more = false;
  let lastRow = 0;
  let gap = false;
  const limit = Math.min(MAX_SHEET_ROWS, budget);
  ROW_RE.lastIndex = 0;
  let rm;
  while ((rm = ROW_RE.exec(xml))) {
    const rowNo = Number(attrsOf(rm[1]).r) || lastRow + 1;
    if (rowNo - lastRow > 1) gap = true;
    lastRow = rowNo;
    const cells = [];
    let col = -1;
    let maxCol = -1;
    if (rm[2]) {
      CELL_RE.lastIndex = 0;
      let cm;
      while ((cm = CELL_RE.exec(rm[2]))) {
        const a = attrsOf(cm[1]);
        col = a.r ? colIndex(a.r) : col + 1;
        if (col < 0 || col >= MAX_COLS) continue;
        const v = cellValue(a, cm[2], ctx.sst, ctx.dateStyles, ctx.date1904).replace(/[\t\r\n]+/g, ' ');
        if (v !== '') {
          cells[col] = v;
          if (col > maxCol) maxCol = col;
        }
      }
    }
    if (maxCol < 0) {
      gap = true; // a blank row: keep one blank line so separate tables stay separate
      continue;
    }
    if (rows >= limit) {
      more = true;
      break;
    }
    if (gap && lines.length) lines.push('');
    gap = false;
    lines.push(Array.from({ length: maxCol + 1 }, (_, i) => cells[i] ?? '').join('\t'));
    rows++;
  }
  const dim = /<(?:\w+:)?dimension\b[^>]*\bref\s*=\s*"[A-Za-z]*\d*(?::[A-Za-z]*(\d+))?"/.exec(xml);
  return { lines, rows, more, total: dim ? Number(dim[1]) || 0 : 0 };
}

async function extractXlsx(zip) {
  const main = await mainPart(zip, OFFICE.xlsx.main);
  if (!main) throw new ZipError('nomain');
  const wb = await zip.xml(main);
  if (!wb || ln(wb) !== 'workbook') throw new ZipError('nomain');
  const rels = await readRels(zip, main);
  const date1904 = ['1', 'true'].includes(attr(findChild(wb, 'workbookPr') || wb, 'date1904') || '');

  let sheets = [];
  const list = findChild(wb, 'sheets');
  for (const s of list ? list.children : []) {
    if (ln(s) !== 'sheet') continue;
    const rel = rels.get(relIdOf(s, rels));
    if (!rel || !/\/worksheet$/.test(rel.type)) continue; // chart sheets etc. have no cells
    sheets.push({ name: attr(s, 'name') || '', path: rel.target });
  }
  if (!sheets.length) {
    sheets = zip.names
      .filter((n) => /^xl\/worksheets\/[^/]+\.xml$/i.test(n))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map((path, i) => ({ name: `Sheet${i + 1}`, path }));
  }

  const sstPath = [...rels.values()].find((r) => /\/sharedStrings$/.test(r.type))?.target || 'xl/sharedStrings.xml';
  const sstXml = await zip.text(sstPath).catch(() => null);
  const stylesPath = [...rels.values()].find((r) => /\/styles$/.test(r.type))?.target || 'xl/styles.xml';
  const stylesXml = await zip.text(stylesPath).catch(() => null);
  const ctx = {
    sst: sstXml ? parseSharedStrings(sstXml) : [],
    dateStyles: stylesXml ? parseDateStyles(stylesXml) : [],
    date1904,
  };

  const out = [];
  const notes = [];
  let budget = MAX_TOTAL_ROWS;
  let any = false;
  for (const sh of sheets) {
    out.push(`## Sheet: ${sh.name}`);
    if (budget <= 0) {
      out.push('[Not shown: the row limit for this file was reached.]', '');
      notes.push(`Sheet "${sh.name}" was skipped because the file is very large.`);
      continue;
    }
    const xml = await zip.text(sh.path);
    if (xml == null) {
      out.push('(this sheet could not be found in the file)', '');
      continue;
    }
    const { lines, rows, more, total } = sheetToLines(xml, ctx, budget);
    budget -= rows;
    if (!lines.length) out.push('(empty sheet)');
    else {
      any = true;
      out.push(...lines);
    }
    if (more) {
      const where = total ? ` — the sheet has about ${total} rows` : '';
      out.push(`[… more rows not shown${where}]`);
      notes.push(`Sheet "${sh.name}" is long, so only its first ${rows} rows are shown.`);
    }
    out.push('');
  }
  const text = out.join('\n').trim();
  if (!any) return { text: '', note: 'This Excel workbook has no data in it.' };
  return notes.length ? { text, note: notes.join(' ') } : { text };
}

/* ---------- PPTX ---------- */

const PPTX_SKIP = new Set(['pPr', 'endParaRPr', 'rPr', 'nvSpPr', 'nvGrpSpPr', 'nvGraphicFramePr', 'nvPicPr', 'spPr', 'grpSpPr', 'xfrm', 'pic']);

function pptxParagraph(p) {
  let s = '';
  const walk = (el) => {
    for (const c of kidsOf(el)) {
      const n = ln(c);
      if (PPTX_SKIP.has(n)) continue;
      if (n === 't') s += c.textContent;
      else if (n === 'br') s += '\n';
      else walk(c);
    }
  };
  walk(p);
  return s;
}

function placeholderType(sp) {
  const nv = findChild(sp, 'nvSpPr');
  const nvPr = nv && findChild(nv, 'nvPr');
  const ph = nvPr && findChild(nvPr, 'ph');
  return ph ? attr(ph, 'type') || 'body' : null; // a placeholder without a type is a body placeholder
}

// `only` limits shapes to those placeholder types (notes); otherwise slide-number/date/footer placeholders are skipped.
function pptxLines(el, lines, only) {
  for (const c of kidsOf(el)) {
    const n = ln(c);
    if (PPTX_SKIP.has(n)) continue;
    if (n === 'sp') {
      const ph = placeholderType(c);
      if (only ? !only.has(ph) : ['sldNum', 'dt', 'ftr', 'hdr'].includes(ph)) continue;
      pptxLines(c, lines, null);
    } else if (n === 'p') lines.push(pptxParagraph(c));
    else if (n === 'tbl') {
      for (const tr of kidsOf(c)) {
        if (ln(tr) !== 'tr') continue;
        const cells = kidsOf(tr)
          .filter((tc) => ln(tc) === 'tc')
          .map((tc) => {
            const inner = [];
            pptxLines(tc, inner, null);
            return inner.join(' ').replace(/\s+/g, ' ').trim();
          });
        lines.push(cells.join('\t'));
      }
    } else pptxLines(c, lines, only);
  }
}

const tidy = (lines) => lines.join('\n').replace(/ +\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

async function extractPptx(zip) {
  const main = await mainPart(zip, OFFICE.pptx.main);
  if (!main) throw new ZipError('nomain');
  const pres = await zip.xml(main);
  if (!pres || ln(pres) !== 'presentation') throw new ZipError('nomain');
  const rels = await readRels(zip, main);
  let slides = [];
  const list = findChild(pres, 'sldIdLst');
  for (const s of list ? list.children : []) {
    const rel = rels.get(relIdOf(s, rels));
    if (rel && zip.has(rel.target)) slides.push(rel.target);
  }
  if (!slides.length) {
    slides = zip.names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/i.test(n)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }
  const out = [];
  let any = false;
  let n = 0;
  for (const path of slides) {
    n++;
    const root = await zip.xml(path).catch(() => null);
    const lines = [];
    if (root) pptxLines(root, lines, null);
    let body = tidy(lines);
    // Speaker notes live in a separate part linked from the slide.
    const srel = [...(await readRels(zip, path)).values()].find((r) => /\/notesSlide$/.test(r.type));
    if (srel && zip.has(srel.target)) {
      const nroot = await zip.xml(srel.target).catch(() => null);
      const nl = [];
      if (nroot) pptxLines(nroot, nl, new Set(['body']));
      const notes = tidy(nl);
      if (notes) body += `${body ? '\n\n' : ''}Notes: ${notes}`;
    }
    if (body) any = true;
    out.push(`--- Slide ${n} ---${body ? '\n' + body : ''}`);
  }
  if (!any) return { text: '', note: 'This PowerPoint presentation has no text in it (it may contain only pictures).' };
  return { text: out.join('\n\n') };
}

async function extractOffice(kind, bytes) {
  try {
    const zip = await openZip(bytes);
    const r = await { docx: extractDocx, xlsx: extractXlsx, pptx: extractPptx }[kind](zip);
    return { kind, ...r };
  } catch (e) {
    return { kind, text: '', note: officeNote(kind, e) };
  }
}

/* ---------- PDF ---------- */

const MAX_PDF_PAGES = 500;
const PDF_TIMEOUT_MS = 120000;

let pdfjsPromise = null;
// pdf.js is large, so it is only loaded when a PDF is actually read. The legacy build is used
// because the modern one needs very new JavaScript features (the extension supports Chrome 116+).
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('../vendor/pdfjs/pdf.min.mjs').then((m) => {
      m.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
      return m;
    });
    pdfjsPromise.catch(() => {
      pdfjsPromise = null; // allow a retry
    });
  }
  return pdfjsPromise;
}

// Rebuild lines from pdf.js text items (stream order, using positions to find line and word breaks).
function pdfPageText(items) {
  const lines = [];
  let cur = null;
  let prev = null;
  const flush = () => {
    if (cur) lines.push(cur);
    cur = null;
  };
  for (const it of items) {
    if (typeof it.str !== 'string') continue;
    const t = it.transform || [1, 0, 0, 1, 0, 0];
    const vertical = Math.abs(t[1]) > Math.abs(t[0]) + 1e-6;
    const along = vertical ? t[5] : t[4];
    const across = vertical ? t[4] : t[5];
    const h = Math.abs(it.height) || Math.hypot(t[2], t[3]) || 0;
    if (!it.str.trim()) {
      // pdf.js emits gaps between words and columns as whitespace items whose width is the gap.
      if (cur && !/\s$/.test(cur.text)) cur.text += it.width > 2 * Math.max(prev?.h || 0, 1) ? '\t' : ' ';
      if (it.hasEOL) flush();
      continue;
    }
    if (cur && prev) {
      const size = Math.max(h, prev.h, 1);
      if (vertical !== prev.vertical || Math.abs(across - prev.across) > 0.5 * size) flush();
      else {
        const gap = along - (prev.along + (prev.width || 0));
        const sep = /\s$/.test(cur.text) || /^\s/.test(it.str) ? '' : gap > 2 * size ? '\t' : gap > 0.15 * size ? ' ' : '';
        cur.text += sep;
      }
    }
    if (!cur) cur = { text: '', y: across, h };
    cur.text += it.str;
    prev = { along, across, h, width: it.width, vertical };
    if (it.hasEOL) flush();
  }
  flush();
  const rows = lines.map((l) => ({ ...l, text: l.text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim() })).filter((l) => l.text);
  // Paragraph breaks: a vertical gap clearly larger than this page's normal line pitch.
  const pitches = [];
  for (let i = 1; i < rows.length; i++) {
    const d = rows[i - 1].y - rows[i].y;
    if (d > 0) pitches.push(d);
  }
  pitches.sort((a, b) => a - b);
  const median = pitches.length >= 3 ? pitches[pitches.length >> 1] : 0;
  const out = [];
  rows.forEach((r, i) => {
    if (median && i) {
      const d = rows[i - 1].y - r.y;
      if (d > 1.6 * median) out.push('');
    }
    out.push(r.text);
  });
  return out.join('\n');
}

function pdfNote(e) {
  switch (e?.name) {
    case 'PasswordException':
      return 'This PDF is password-protected, so it cannot be read.';
    case 'InvalidPDFException':
    case 'MissingPDFException':
      return 'This PDF is damaged or is not a real PDF file, so it cannot be read.';
    default:
      return `This PDF could not be read (${String(e?.message || e || 'unknown error').slice(0, 160)}).`;
  }
}

async function extractPdf(bytes) {
  // Cheap check first: a real PDF has '%PDF' near the start. This also avoids loading pdf.js for junk.
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  if (!head.includes('%PDF')) return { kind: 'pdf', text: '', note: 'This PDF is damaged or is not a real PDF file, so it cannot be read.' };
  let pdfjs;
  try {
    pdfjs = await loadPdfjs();
  } catch {
    return { kind: 'pdf', text: '', note: 'The PDF reader could not be loaded, so this PDF cannot be read right now.' };
  }
  let task;
  let timer;
  try {
    // pdf.js transfers the buffer to its worker, so hand it a copy.
    task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, useWorkerFetch: false, disableFontFace: true, verbosity: 0 });
    const read = (async () => {
      const doc = await task.promise;
      const pages = Math.min(doc.numPages, MAX_PDF_PAGES);
      const out = [];
      let empty = 0;
      for (let n = 1; n <= pages; n++) {
        const page = await doc.getPage(n);
        const tc = await page.getTextContent();
        const text = pdfPageText(tc.items);
        page.cleanup();
        if (!text) empty++;
        out.push(`--- Page ${n} ---${text ? '\n' + text : ''}`);
      }
      const notes = [];
      if (doc.numPages > pages) {
        out.push(`[… ${doc.numPages - pages} more pages not shown]`);
        notes.push(`Only the first ${pages} of ${doc.numPages} pages were read.`);
      }
      if (empty === pages) return { kind: 'pdf', text: '', note: 'This PDF has no text layer (it is probably a scan).' };
      if (empty) notes.push(`${empty} of ${pages} pages have no text (they may be scans or pictures).`);
      const r = { kind: 'pdf', text: out.join('\n\n') };
      if (notes.length) r.note = notes.join(' ');
      return r;
    })();
    read.catch(() => {}); // if the timeout wins, a late failure here must not surface as an unhandled rejection
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('it took too long')), PDF_TIMEOUT_MS);
    });
    return await Promise.race([read, timeout]);
  } catch (e) {
    return { kind: 'pdf', text: '', note: pdfNote(e) };
  } finally {
    clearTimeout(timer);
    try {
      await task?.destroy();
    } catch {}
  }
}

/* ---------- entry point ---------- */

export async function extractText(file) {
  let kind = 'binary';
  try {
    const { dataUrl, name = '', mime = '' } = file || {};
    const parsed = parseDataUrl(dataUrl);
    const { bytes } = parsed;
    const c = classify(name, mime || parsed.mime);
    kind = c.kind;
    const svg = extOf(name) === 'svg' || cleanMime(mime || parsed.mime) === 'image/svg+xml';
    if (!bytes.length) return { kind: svg ? 'text' : kind, text: '', note: 'The file is empty.' };
    if (kind === 'image' && !svg) return { kind, text: '', note: 'This is an image, so there is no text to extract.' };
    if (svg) return textResult(bytes, name, true);
    switch (kind) {
      case 'pdf':
        return await extractPdf(bytes);
      case 'docx':
      case 'xlsx':
      case 'pptx':
        return await extractOffice(kind, bytes);
      case 'text':
        return textResult(bytes, name, c.known);
      default:
        // Unknown type: if it holds no NUL bytes and is valid UTF-8 it is text after all.
        return c.known ? { kind, text: '', note: binaryNote(name) } : textResult(bytes, name, false);
    }
  } catch (e) {
    const why = /not a data URL/.test(e?.message) ? 'The attachment data is missing or damaged.' : `The file could not be read (${String(e?.message || e).slice(0, 160)}).`;
    return { kind, text: '', note: why };
  }
}

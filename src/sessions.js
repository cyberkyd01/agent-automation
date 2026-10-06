// IndexedDB persistence for chat sessions and their assets (attached and generated files).
// Three object stores: metadata (small, listed often), bodies (messages + queue) and assets (each holds its
// file as a Blob, which Chrome keeps on disk), so listing chats never loads message bodies. The goal is
// "no lost chats": writes are atomic and serialised per chat, and every failure surfaces as an Error a person can read.

import { assetBlob, formatBytes, isBlob, readZip, toBlob, writeZip, MAX_ZIP_BYTES } from './files.js';
import { api } from './host/api.js';

const DB_NAME = 'agent-automation';
const META = 'sessions';
const BODY = 'bodies';
const ASSET = 'assets';
const BLOCKED_MS = 8000;

const EXPORT_FORMAT = 'agent-automation-sessions';
// 1: one JSON file, assets inline as data URLs (still written when a chat has no files).
// 2: a ZIP with manifest.json (assets point at their entry) and each file's bytes as its own entry.
const EXPORT_VERSION = 2;
const MANIFEST = 'manifest.json';
const MAX_MANIFEST_BYTES = 256 * 1024 * 1024;
const MAX_IMPORT_FILE_BYTES = 1024 * 1024 * 1024; // per file inside an archive; guards against inflate bombs
const LEGACY_ID = 'legacy-chat-v1';

// One entry per schema version; add a function here to evolve the database. Each runs once, in order,
// inside the upgrade transaction, for databases that are older than its version.
const MIGRATIONS = [
  (db) => {
    db.createObjectStore(META, { keyPath: 'id' }).createIndex('updatedAt', 'updatedAt');
    db.createObjectStore(BODY, { keyPath: 'id' });
    db.createObjectStore(ASSET, { keyPath: ['sessionId', 'id'] }).createIndex('sessionId', 'sessionId');
  },
];
const DB_VERSION = MIGRATIONS.length;

/* ---------- small helpers ---------- */

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isMessage = (m) => isObj(m) && typeof m.role === 'string';
const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function uuid() {
  if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// Cut to n characters with an ellipsis, without splitting a surrogate pair.
function clip(s, n) {
  if (s.length <= n) return s;
  let c = s.slice(0, n - 1);
  if (/[\ud800-\udbff]$/.test(c)) c = c.slice(0, -1);
  return c.trimEnd() + '…';
}

const oneLine = (s) => str(s).replace(/\s+/g, ' ').trim();

// An Error whose message is meant for the person using the extension. `name` keeps the browser's own
// error name (e.g. 'QuotaExceededError') so callers can still branch on it.
function readable(message, cause) {
  const e = new Error(message);
  e.userFacing = true;
  if (cause) {
    e.cause = cause;
    if (cause.name && cause.name !== 'Error') e.name = cause.name;
  }
  return e;
}

function friendly(e, action) {
  if (e?.userFacing) return e;
  switch (e?.name) {
    case 'QuotaExceededError':
      return readable(`Could not ${action}: the browser has run out of storage space. Delete some old chats or large attachments and try again.`, e);
    case 'VersionError':
      return readable('The saved chats were written by a newer version of Agent Automation. Update the extension to open them.', e);
    case 'DataCloneError':
      return readable(`Could not ${action}: this chat contains something that cannot be stored.`, e);
    case 'InvalidStateError':
    case 'TransactionInactiveError':
    case 'AbortError':
      return readable(`Could not ${action}: the chat storage was interrupted. Try again.`, e);
    default:
      return readable(`Could not ${action}: ${e?.message || e?.name || 'unknown storage error'}.`.replace(/\.\.$/, '.'), e);
  }
}

/* ---------- database connection ---------- */

let dbPromise = null;

// Opened once and reused. If the browser closes the connection (or another window upgrades the
// database) the next call opens a fresh one.
function openDb() {
  if (dbPromise) return dbPromise;
  const p = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(readable('Chats cannot be saved here: this browser does not allow local storage for the extension.'));
      return;
    }
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (e) {
      reject(friendly(e, 'open the saved chats'));
      return;
    }
    let settled = false;
    let timer = null;
    req.onupgradeneeded = (ev) => {
      try {
        for (let v = ev.oldVersion; v < MIGRATIONS.length; v++) MIGRATIONS[v](req.result, req.transaction);
      } catch (e) {
        try {
          req.transaction.abort();
        } catch {}
      }
    };
    // Another window still holds an older connection. Ours closes itself on versionchange, so this normally
    // clears in milliseconds; if it does not, say what to do instead of hanging forever.
    req.onblocked = () => {
      timer ||= setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(readable('The saved chats are in use by another Agent Automation window. Close the other windows and try again.'));
      }, BLOCKED_MS);
    };
    req.onerror = () => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(friendly(req.error, 'open the saved chats'));
    };
    req.onsuccess = () => {
      clearTimeout(timer);
      const db = req.result;
      if (settled) {
        db.close(); // we already gave up waiting; do not leak the connection
        return;
      }
      settled = true;
      db.onversionchange = () => {
        db.close();
        if (dbPromise === p) dbPromise = null;
      };
      db.onclose = () => {
        if (dbPromise === p) dbPromise = null;
      };
      resolve(db);
    };
  });
  dbPromise = p;
  p.catch(() => {
    if (dbPromise === p) dbPromise = null;
  });
  return p;
}

const reqP = (r) =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

// Runs `work(tx)` inside one transaction. `work` may await request promises (reqP) and nothing else,
// otherwise the transaction would commit early. Resolves with work's result once the commit succeeded.
async function withTx(stores, mode, work) {
  let db;
  let tx;
  for (let attempt = 0; ; attempt++) {
    db = await openDb();
    try {
      tx = db.transaction(stores, mode);
      break;
    } catch (e) {
      // The connection was closed under us (e.g. a version change): reopen once.
      if (attempt === 0 && e?.name === 'InvalidStateError') {
        if (dbPromise) dbPromise = null;
        try {
          db.close();
        } catch {}
        continue;
      }
      throw e;
    }
  }
  return new Promise((resolve, reject) => {
    let out;
    let failure = null;
    tx.oncomplete = () => resolve(out);
    tx.onabort = () => reject(failure || tx.error || new DOMException('The operation was cancelled.', 'AbortError'));
    tx.onerror = () => {}; // the matching abort event reports it
    let running;
    try {
      running = Promise.resolve(work(tx));
    } catch (e) {
      running = Promise.reject(e);
    }
    running.then(
      (v) => {
        out = v;
      },
      (e) => {
        failure = e;
        try {
          tx.abort();
        } catch {}
      }
    );
  });
}

// Writes for one chat run strictly in call order, so overlapping saves cannot interleave
// and the last call always wins. A failed write does not block the ones behind it.
const chains = new Map();
function serial(id, fn) {
  const prev = chains.get(id) || Promise.resolve();
  const next = prev.then(fn);
  const tail = next.catch(() => {});
  chains.set(id, tail);
  tail.then(() => {
    if (chains.get(id) === tail) chains.delete(id);
  });
  return next;
}

/* ---------- records ---------- */

function messageText(m) {
  let t = '';
  if (typeof m._text === 'string') t = m._text;
  else if (typeof m.content === 'string') t = m.content;
  else if (Array.isArray(m.content)) t = m.content.filter((p) => p && p.type === 'text').map((p) => str(p.text)).join('\n');
  // The model-only context block that the agent appends to the user's words is not part of what they typed.
  return typeof m._text === 'string' ? t : t.replace(/\s*<context>[\s\S]*?<\/context>\s*$/, '');
}

function previewOf(messages) {
  const first = messages.find((m) => isObj(m) && m.role === 'user');
  return first ? clip(oneLine(messageText(first)), 140) : '';
}

function normMeta(r) {
  return {
    id: r.id,
    title: str(r.title) || 'New chat',
    createdAt: finite(r.createdAt) ?? 0,
    updatedAt: finite(r.updatedAt) ?? finite(r.createdAt) ?? 0,
    url: str(r.url),
    pageTitle: str(r.pageTitle),
    messageCount: finite(r.messageCount) ?? 0,
    preview: str(r.preview),
  };
}

const cleanTitle = (t) => clip(oneLine(t), 120);

function cleanQueue(queue) {
  if (!Array.isArray(queue)) return [];
  return queue
    .filter((q) => isObj(q) && typeof q.text === 'string')
    .map((q) => ({ ...q, id: str(q.id) || uuid(), text: q.text, attachmentIds: Array.isArray(q.attachmentIds) ? q.attachmentIds.filter((x) => x != null && x !== '').map(str) : [] }));
}

function metaFor(s, messages, createdAt, updatedAt) {
  return {
    id: s.id,
    title: cleanTitle(s.title) || 'New chat',
    createdAt,
    updatedAt,
    url: str(s.url),
    pageTitle: str(s.pageTitle),
    messageCount: messages.length,
    preview: previewOf(messages),
  };
}

const byNewest = (a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || (a.id < b.id ? -1 : 1);

const idNumber = (id) => Number(/(\d+)$/.exec(id)?.[1] ?? Infinity);
const assetOrder = (a, b) => (a.createdAt || 0) - (b.createdAt || 0) || idNumber(a.id) - idNumber(b.id) || (a.id < b.id ? -1 : 1);

// A stored record → an Asset. Records written before assets held Blobs carry a data URL instead: those are
// converted here (and rewritten later, see getAssets). null for a record whose data is unusable.
function toAsset(rec) {
  const { sessionId, dataUrl, ...asset } = rec;
  if (isBlob(asset.blob)) return asset;
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return null;
  try {
    asset.blob = toBlob(dataUrl, asset.mime);
  } catch {
    return null;
  }
  asset.size = finite(asset.size) ?? asset.blob.size;
  return asset;
}

const isLegacy = (rec) => !isBlob(rec?.blob) && typeof rec?.dataUrl === 'string';

// An Asset → what is stored: the Blob, never a data URL.
function toRecord(sessionId, asset) {
  const { dataUrl, sessionId: _, ...rest } = asset;
  const blob = assetBlob(asset);
  return { ...rest, blob, size: finite(asset.size) ?? blob.size, sessionId };
}

// Fill in anything an imported asset lacks, so the rest of the extension can rely on the full shape.
function cleanAsset(a, blob) {
  if (!isObj(a) || typeof a.id !== 'string' || !a.id || !isBlob(blob)) return null;
  const { dataUrl, entry, sessionId, ...rest } = a;
  const mime = str(a.mime) || str(blob.type).split(';')[0] || 'application/octet-stream';
  return {
    ...rest,
    id: a.id,
    kind: a.kind === 'image' || (a.kind !== 'file' && mime.startsWith('image/')) ? 'image' : 'file',
    name: str(a.name) || a.id,
    mime,
    size: blob.size,
    blob,
    label: str(a.label) || 'attached',
    createdAt: finite(a.createdAt) ?? Date.now(),
  };
}

const ZIP_MAGIC = [0x50, 0x4b];

// A ZIP export (by its first bytes, or by name for one too damaged to tell).
export async function isZipFile(blob) {
  if (!isBlob(blob)) return false;
  if (/\.zip$/i.test(str(blob.name))) return true;
  try {
    const b = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
    return b[0] === ZIP_MAGIC[0] && b[1] === ZIP_MAGIC[1] && (b[2] === 3 || b[2] === 5) && (b[3] === 4 || b[3] === 6);
  } catch {
    return false;
  }
}

function zipProblem(e) {
  if (e?.userFacing) return e;
  const file = e?.entry ? `"${e.entry.split('/').pop()}"` : 'a file';
  switch (e?.code) {
    case 'notzip':
    case 'ole':
      return readable('This file is not an Agent Automation export: it is not a valid ZIP archive (it may be incomplete or damaged).');
    case 'zip64':
      return readable('This ZIP archive uses ZIP64, which cannot be imported here. Import an export made by Agent Automation.');
    case 'encrypted':
      return readable('This ZIP archive is password-protected, so it cannot be imported.');
    case 'method':
      return readable('This ZIP archive uses a compression method that cannot be imported. Import an export made by Agent Automation.');
    case 'crc':
      return readable(`This export file is damaged: ${file} in it does not match its checksum.`);
    case 'toolarge':
      return readable(`This export file cannot be imported: ${file} in it is too large.`);
    case 'corrupt':
      return readable('This export file is damaged or incomplete.');
    default:
      if (e?.name === 'NotReadableError' || e?.name === 'NotFoundError') return readable('Could not read this file. It may have been moved or deleted — choose it again.');
      return readable(`This export file could not be read (${e?.message || e}).`);
  }
}

// The manifest of a ZIP export, plus the open archive for its files.
async function openExportZip(blob) {
  let zip;
  let text;
  try {
    zip = await readZip(blob);
    if (!zip.has(MANIFEST)) throw readable('This ZIP file is not an Agent Automation export: it has no manifest.json in it.');
    text = await (await zip.blob(MANIFEST, { limit: MAX_MANIFEST_BYTES, verify: true })).text();
  } catch (e) {
    throw zipProblem(e);
  }
  try {
    return { obj: JSON.parse(text), zip };
  } catch {
    throw readable('This export file is damaged: its manifest is not valid JSON.');
  }
}

// 'report 2026.pdf' stays readable inside the archive; path separators and control characters do not survive.
const entryName = (name) => str(name).replace(/[\\/\x00-\x1f:*?"<>|]+/g, '_').replace(/^\.+/, '_').slice(-120) || 'file';

/* ---------- store ---------- */

const gone = () => readable('That chat no longer exists.');

export const store = {
  // Newest first. Reads the metadata store only: message bodies and assets are never touched.
  async list() {
    try {
      const rows = await withTx([META], 'readonly', (t) => reqP(t.objectStore(META).getAll()));
      return rows.map(normMeta).sort(byNewest);
    } catch (e) {
      throw friendly(e, 'load your chats');
    }
  },

  async get(id) {
    if (typeof id !== 'string' || !id) return null;
    try {
      const [meta, body] = await withTx([META, BODY], 'readonly', (t) => Promise.all([reqP(t.objectStore(META).get(id)), reqP(t.objectStore(BODY).get(id))]));
      if (!meta) return null;
      return { ...normMeta(meta), messages: Array.isArray(body?.messages) ? body.messages : [], queue: Array.isArray(body?.queue) ? body.queue : [] };
    } catch (e) {
      throw friendly(e, 'open the chat');
    }
  },

  // Upsert. Metadata and body go in one transaction, so a chat is never half-saved. A caller-supplied
  // updatedAt is ignored here (it is only honoured by importFile).
  put(session) {
    if (!isObj(session) || typeof session.id !== 'string' || !session.id) return Promise.reject(readable('This chat cannot be saved because it has no id.'));
    // Snapshot the arrays now, so later changes by the caller cannot alter what this call saves.
    const messages = Array.isArray(session.messages) ? session.messages.slice() : [];
    const queue = cleanQueue(session.queue);
    const given = { id: session.id, title: session.title, url: session.url, pageTitle: session.pageTitle, createdAt: finite(session.createdAt) };
    return serial(session.id, () =>
      withTx([META, BODY], 'readwrite', async (t) => {
        const metaStore = t.objectStore(META);
        let createdAt = given.createdAt;
        if (createdAt == null) createdAt = finite((await reqP(metaStore.get(given.id)))?.createdAt) ?? Date.now();
        metaStore.put(metaFor(given, messages, createdAt, Date.now()));
        t.objectStore(BODY).put({ id: given.id, messages, queue });
      })
    ).catch((e) => {
      throw friendly(e, 'save the chat');
    });
  },

  rename(id, title) {
    const name = cleanTitle(title);
    if (!name) return Promise.reject(readable('The chat needs a name.'));
    return serial(id, () =>
      withTx([META], 'readwrite', async (t) => {
        const metas = t.objectStore(META);
        const meta = await reqP(metas.get(id));
        if (!meta) throw gone();
        metas.put({ ...meta, title: name });
      })
    ).catch((e) => {
      throw friendly(e, 'rename the chat');
    });
  },

  // Metadata, body and every asset of the chat, in one transaction.
  delete(id) {
    return serial(id, () =>
      withTx([META, BODY, ASSET], 'readwrite', async (t) => {
        t.objectStore(META).delete(id);
        t.objectStore(BODY).delete(id);
        const assets = t.objectStore(ASSET);
        for (const key of await reqP(assets.index('sessionId').getAllKeys(IDBKeyRange.only(id)))) assets.delete(key);
      })
    ).catch((e) => {
      throw friendly(e, 'delete the chat');
    });
  },

  // The asset's Blob is stored as is (Chrome writes it to disk); a data URL is never stored.
  putAsset(sessionId, asset) {
    if (typeof sessionId !== 'string' || !sessionId || !isObj(asset) || typeof asset.id !== 'string' || !asset.id) {
      return Promise.reject(readable('This file cannot be saved with the chat.'));
    }
    let rec;
    try {
      rec = toRecord(sessionId, asset);
    } catch {
      return Promise.reject(readable('This file cannot be saved with the chat: its data is missing.'));
    }
    return serial(sessionId, () => withTx([ASSET], 'readwrite', (t) => void t.objectStore(ASSET).put(rec))).catch((e) => {
      throw friendly(e, 'save the file');
    });
  },

  async getAssets(sessionId) {
    let rows;
    try {
      rows = await withTx([ASSET], 'readonly', (t) => reqP(t.objectStore(ASSET).index('sessionId').getAll(IDBKeyRange.only(sessionId))));
    } catch (e) {
      throw friendly(e, 'load the chat files');
    }
    const assets = [];
    const converted = [];
    for (const rec of rows) {
      const a = toAsset(rec);
      if (!a) {
        console.warn(`A saved file of this chat is damaged and was skipped: ${rec?.name || rec?.id}`);
        continue;
      }
      if (isLegacy(rec)) converted.push(a);
      assets.push(a);
    }
    if (converted.length) rewriteLegacy(sessionId, converted);
    return assets.sort(assetOrder);
  },

  // One asset (with its Blob), or null.
  async getAsset(sessionId, assetId) {
    let rec;
    try {
      rec = await withTx([ASSET], 'readonly', (t) => reqP(t.objectStore(ASSET).get([sessionId, assetId])));
    } catch (e) {
      throw friendly(e, 'load the file');
    }
    return rec ? toAsset(rec) : null;
  },

  deleteAsset(sessionId, assetId) {
    return serial(sessionId, () => withTx([ASSET], 'readwrite', (t) => void t.objectStore(ASSET).delete([sessionId, assetId]))).catch((e) => {
      throw friendly(e, 'delete the file');
    });
  },

  // → { blob, ext, title }: a .zip when the chat has files, plain .json (version 1) when it has none.
  async exportSession(id, { includeAssets = true } = {}) {
    try {
      const entry = await withTx([META, BODY, ASSET], 'readonly', async (t) => {
        const [meta, body, assets] = await Promise.all([
          reqP(t.objectStore(META).get(id)),
          reqP(t.objectStore(BODY).get(id)),
          includeAssets ? reqP(t.objectStore(ASSET).index('sessionId').getAll(IDBKeyRange.only(id))) : [],
        ]);
        if (!meta) throw gone();
        return exportEntry(meta, body, includeAssets ? assets : null);
      });
      return await exportBlob([entry], { zip: !!entry.assets?.length });
    } catch (e) {
      throw friendly(e, 'export the chat');
    }
  },

  // Every chat, always as a .zip.
  async exportAll({ includeAssets = true } = {}) {
    try {
      const entries = await withTx([META, BODY, ASSET], 'readonly', async (t) => {
        const [metas, bodies, assets] = await Promise.all([
          reqP(t.objectStore(META).getAll()),
          reqP(t.objectStore(BODY).getAll()),
          includeAssets ? reqP(t.objectStore(ASSET).getAll()) : [],
        ]);
        const bodyOf = new Map(bodies.map((b) => [b.id, b]));
        const assetsOf = new Map();
        for (const a of assets) {
          if (!assetsOf.has(a.sessionId)) assetsOf.set(a.sessionId, []);
          assetsOf.get(a.sessionId).push(a);
        }
        return metas
          .map(normMeta)
          .sort(byNewest)
          .map((m) => exportEntry(m, bodyOf.get(m.id), includeAssets ? assetsOf.get(m.id) || [] : null));
      });
      return await exportBlob(entries, { zip: true });
    } catch (e) {
      throw friendly(e, 'export your chats');
    }
  },

  // Accepts an export file (a .zip or .json File/Blob), JSON text, or a parsed v1/v2 export.
  // Every chat gets a fresh id, so nothing is ever overwritten.
  async importFile(input) {
    let obj = input;
    let zip = null;
    if (isBlob(input)) {
      if (await isZipFile(input)) ({ obj, zip } = await openExportZip(input));
      else {
        try {
          obj = await input.text();
        } catch (e) {
          throw zipProblem(e);
        }
      }
    }
    if (typeof obj === 'string') {
      try {
        obj = JSON.parse(obj);
      } catch {
        throw readable('This file is not an Agent Automation export. It is not valid JSON.');
      }
    }
    if (!isObj(obj) || obj.format !== EXPORT_FORMAT) throw readable('This file is not an Agent Automation export.');
    const version = finite(obj.version);
    if (version == null || version < 1) throw readable('This export file is damaged: its version is missing.');
    if (version > EXPORT_VERSION) throw readable('This export was made by a newer version of Agent Automation. Update the extension, then try again.');
    if (!Array.isArray(obj.sessions)) throw readable('This export file is damaged: it has no chats in it.');

    // Every file is read (and checked against its CRC) before anything is written, so a damaged archive
    // imports nothing at all.
    const prepared = [];
    for (const s of obj.sessions) {
      if (!isObj(s)) continue;
      const messages = Array.isArray(s.messages) ? s.messages.filter(isMessage) : [];
      const assets = new Map();
      for (const a of Array.isArray(s.assets) ? s.assets : []) {
        if (!isObj(a)) continue;
        let blob = null;
        if (typeof a.entry === 'string' && a.entry) {
          if (!zip) throw readable('This export lists files that are not in it. Import the .zip file it came in instead.');
          try {
            blob = await zip.blob(a.entry, { type: str(a.mime), limit: MAX_IMPORT_FILE_BYTES, verify: true });
          } catch (e) {
            throw zipProblem(e);
          }
          if (!blob) throw readable(`This export file is damaged: "${str(a.name) || a.entry}" is missing from it.`);
        } else if (typeof a.dataUrl === 'string' && a.dataUrl.startsWith('data:')) {
          try {
            blob = toBlob(a.dataUrl, a.mime);
          } catch {
            continue; // unreadable inline data: the chat imports without that file
          }
        }
        const clean = cleanAsset(a, blob);
        if (clean) assets.set(clean.id, clean);
      }
      prepared.push({ s, messages, queue: cleanQueue(s.queue), assets: [...assets.values()] });
    }
    if (!prepared.length) throw readable('This export file does not contain any chats.');

    try {
      return await withTx([META, BODY, ASSET], 'readwrite', async (t) => {
        const metas = t.objectStore(META);
        const taken = new Set((await reqP(metas.getAll())).map((m) => str(m.title)));
        const ids = [];
        const now = Date.now();
        for (const { s, messages, queue, assets } of prepared) {
          const id = uuid();
          const typed = previewOf(messages);
          let title = cleanTitle(s.title) || (typed ? titleFrom(typed) : 'Imported chat');
          if (taken.has(title)) title = `${title} (imported)`;
          taken.add(title);
          const createdAt = finite(s.createdAt) ?? finite(s.updatedAt) ?? now;
          const updatedAt = finite(s.updatedAt) ?? createdAt;
          metas.put(metaFor({ id, title, url: s.url, pageTitle: s.pageTitle }, messages, createdAt, updatedAt));
          t.objectStore(BODY).put({ id, messages, queue });
          for (const a of assets) t.objectStore(ASSET).put({ ...a, sessionId: id });
          ids.push(id);
        }
        return ids;
      });
    } catch (e) {
      throw friendly(e, 'import the chats');
    }
  },

  // A duplicate of a chat (messages, queue and files) under a new id, made inside the store: nothing is
  // serialised, so it is quick even with big files. Resolves with the new id.
  async copySession(id, { title } = {}) {
    try {
      return await withTx([META, BODY, ASSET], 'readwrite', async (t) => {
        const metas = t.objectStore(META);
        const [meta, body, rows] = await Promise.all([
          reqP(metas.get(id)),
          reqP(t.objectStore(BODY).get(id)),
          reqP(t.objectStore(ASSET).index('sessionId').getAll(IDBKeyRange.only(id))),
        ]);
        if (!meta) throw gone();
        const src = normMeta(meta);
        const nid = uuid();
        const messages = Array.isArray(body?.messages) ? body.messages : [];
        metas.put(metaFor({ id: nid, title: cleanTitle(title) || `${src.title} (copy)`, url: src.url, pageTitle: src.pageTitle }, messages, src.createdAt, src.updatedAt));
        t.objectStore(BODY).put({ id: nid, messages, queue: Array.isArray(body?.queue) ? body.queue : [] });
        for (const rec of rows) {
          const a = toAsset(rec);
          if (a) t.objectStore(ASSET).put({ ...a, sessionId: nid });
        }
        return nid;
      });
    } catch (e) {
      throw friendly(e, 'copy the chat');
    }
  },

  // v1.0 kept its single chat in chrome.storage.local under 'chat'. Move it into the new history once,
  // and only delete the old copy after the new one has been read back. Never rejects: on any problem the
  // old chat simply stays where it is and the move is tried again next time.
  async migrateLegacy() {
    // The offscreen engine has no chrome.storage of its own: there the service worker reads it (api rpc).
    const area = globalThis.chrome?.storage?.local || (api.mode === 'rpc' && globalThis.chrome?.runtime?.sendMessage ? api.storage.local : null);
    if (!area?.get) return null;
    try {
      const { chat } = await area.get('chat');
      if (!Array.isArray(chat)) return null;
      const messages = chat.filter(isMessage);
      let moved = null;
      if (messages.length && !(await store.get(LEGACY_ID))) {
        const first = messages.find((m) => m.role === 'user');
        const now = Date.now();
        await store.put({ id: LEGACY_ID, title: titleFrom(first ? messageText(first) : ''), createdAt: now, messages, queue: [] });
        const saved = await store.get(LEGACY_ID);
        if (saved?.messages.length !== messages.length) throw new Error('the copy could not be verified');
        moved = LEGACY_ID;
      }
      await area.remove('chat');
      return moved;
    } catch (e) {
      console.warn('Could not move the earlier chat into the new chat history', e);
      return null;
    }
  },
};

// Records written before assets held Blobs are rewritten once with the Blob, in the background. Each one is
// re-read first, so a file deleted in the meantime is not brought back.
function rewriteLegacy(sessionId, assets) {
  serial(sessionId, () =>
    withTx([ASSET], 'readwrite', async (t) => {
      const st = t.objectStore(ASSET);
      for (const a of assets) {
        const cur = await reqP(st.get([sessionId, a.id]));
        if (isLegacy(cur)) st.put(toRecord(sessionId, a));
      }
    })
  ).catch((e) => console.warn('Could not upgrade the saved files of a chat (they still work)', e));
}

function exportEntry(meta, body, assets) {
  const entry = { ...normMeta(meta), messages: Array.isArray(body?.messages) ? body.messages : [], queue: Array.isArray(body?.queue) ? body.queue : [] };
  if (assets) entry.assets = assets.map(toAsset).filter(Boolean).sort(assetOrder);
  return entry;
}

// Export entries → { blob, ext, title }. With files: a ZIP holding manifest.json (assets point at their entry)
// and each file's bytes, assembled from the stored Blobs (no file is turned into a string). Without: plain JSON.
async function exportBlob(entries, { zip }) {
  const exportedAt = Date.now();
  const title = entries[0]?.title || 'chat';
  if (!zip) {
    const sessions = entries.map(({ assets, ...rest }) => rest);
    const json = JSON.stringify({ format: EXPORT_FORMAT, version: 1, exportedAt, sessions });
    return { blob: new Blob([json], { type: 'application/json' }), ext: 'json', title };
  }
  const files = [];
  const sessions = entries.map((e, i) => {
    if (!e.assets) return e;
    const assets = e.assets.map(({ blob, dataUrl, ...a }) => {
      const entry = `files/${i + 1}/${a.id}/${entryName(a.name || a.id)}`;
      files.push({ name: entry, data: blob });
      return { ...a, size: blob.size, entry };
    });
    return { ...e, assets };
  });
  const manifest = new Blob([JSON.stringify({ format: EXPORT_FORMAT, version: EXPORT_VERSION, exportedAt, sessions })], { type: 'application/json' });
  const all = [{ name: MANIFEST, data: manifest }, ...files];
  const total = all.reduce((n, f) => n + f.data.size + 76 + 2 * new TextEncoder().encode(f.name).length, 22);
  if (total > MAX_ZIP_BYTES) {
    throw readable(`This export would be ${formatBytes(total)} — more than the 4 GB one export file can hold. Export the chats one at a time instead.`);
  }
  if (all.length >= 0xffff) throw readable(`This export would hold ${files.length} files — more than one export file can hold. Export the chats one at a time instead.`);
  return { blob: await writeZip(all, { date: new Date(exportedAt) }), ext: 'zip', title };
}

/* ---------- helpers for the panel ---------- */

export function newSession(partial = {}) {
  const now = Date.now();
  const s = { id: '', title: 'New chat', createdAt: now, updatedAt: now, url: '', pageTitle: '', ...partial };
  s.id = str(s.id) || uuid();
  s.title = str(s.title) || 'New chat';
  s.messages = Array.isArray(partial.messages) ? partial.messages : [];
  s.queue = Array.isArray(partial.queue) ? partial.queue : [];
  s.messageCount = s.messages.length;
  s.preview = previewOf(s.messages);
  return s;
}

// A short one-line title from the first prompt: whole words where possible, at most 48 characters.
export function titleFrom(text) {
  const t = oneLine(text);
  if (!t) return 'New chat';
  if (t.length <= 48) return t;
  const cut = t.slice(0, 47);
  const space = t[47] === ' ' ? 47 : cut.lastIndexOf(' ');
  // A long unbroken string (a URL, say) is cut hard rather than leaving a stub of a word.
  const base = (space >= 20 ? cut.slice(0, space) : cut).replace(/[\ud800-\udbff]$/, '');
  return clip(base.replace(/[\s,;:.\-–—(]+$/, '') + '…', 48);
}

/* ---------- Markdown transcript ---------- */

// Never let a transcript carry file contents: data URLs and long base64 runs are replaced.
function scrub(s) {
  return str(s)
    .replace(/data:[^\s,;]*(?:;[^\s,;]*)*;base64,[A-Za-z0-9+/_=-]*/gi, '[data omitted]')
    // A long run with many different characters is base64; a line of dashes or one repeated letter is not.
    .replace(/[A-Za-z0-9+/]{200,}={0,2}/g, (run) => (new Set(run).size >= 16 ? '[data omitted]' : run));
}

function argValue(v) {
  if (typeof v === 'string') return JSON.stringify(clip(oneLine(scrub(v)), 40));
  if (v !== null && typeof v === 'object') return clip(oneLine(scrub(JSON.stringify(v))), 40);
  return String(v);
}

function argsSummary(raw) {
  let o = raw;
  if (typeof raw === 'string') {
    try {
      o = JSON.parse(raw || '{}');
    } catch {
      return clip(oneLine(scrub(raw)), 80);
    }
  }
  if (!isObj(o)) return clip(oneLine(scrub(typeof o === 'string' ? o : JSON.stringify(o))), 80);
  let out = '';
  for (const [k, v] of Object.entries(o)) {
    const part = `${k}: ${argValue(v)}`;
    if (out.length + part.length + 2 > 100) return out ? `${out}, …` : clip(part, 100);
    out = out ? `${out}, ${part}` : part;
  }
  return out;
}

function firstLine(content) {
  let t = content;
  if (Array.isArray(t)) t = t.filter((p) => p && p.type === 'text').map((p) => str(p.text)).join('\n');
  const line = scrub(t).split('\n').map((l) => l.trim()).find(Boolean);
  return line ? clip(line, 120) : '(no output)';
}

function stamp(ms) {
  if (!ms || ms < 0) return ''; // a missing date is left out rather than shown as 1970
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function sessionToMarkdown(session) {
  const s = isObj(session) ? session : {};
  const messages = Array.isArray(s.messages) ? s.messages.filter(isObj) : [];
  const out = [`# ${oneLine(s.title) || 'Chat'}`];
  const facts = [];
  const when = stamp(finite(s.createdAt) ?? finite(s.updatedAt));
  if (when) facts.push(`- Date: ${when}`);
  if (s.url) facts.push(`- Source page: ${s.pageTitle ? `[${oneLine(s.pageTitle).replace(/[\[\]]/g, '')}](${s.url})` : s.url}`);
  else if (s.pageTitle) facts.push(`- Source page: ${oneLine(s.pageTitle)}`);
  if (facts.length) out.push('', ...facts);
  out.push('', '---', '');

  const results = new Map();
  for (const m of messages) if (m.role === 'tool' && m.tool_call_id != null) results.set(m.tool_call_id, m);
  const paired = new Set();
  let inAssistant = false;
  const heading = (name) => {
    out.push(`## ${name}`, '');
  };

  for (const m of messages) {
    if (m.role === 'user') {
      inAssistant = false;
      heading('You');
      const text = scrub(messageText(m)).trim();
      if (text) out.push(text, '');
      const files = (Array.isArray(m._attachments) ? m._attachments : []).map((a) => oneLine(a?.name || a?.id)).filter(Boolean);
      if (files.length) out.push(`*Attached: ${files.join(', ')}*`, '');
    } else if (m.role === 'assistant') {
      if (!inAssistant) heading('Assistant');
      inAssistant = true;
      const text = scrub(typeof m.content === 'string' ? m.content : messageText(m)).trim();
      if (text) out.push(text, '');
      for (const tc of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
        const res = results.get(tc?.id);
        if (res) paired.add(res);
        out.push(`> tool: ${oneLine(tc?.function?.name) || 'unknown'}(${argsSummary(tc?.function?.arguments)}) → ${res ? firstLine(res.content) : '(no result)'}`, '');
      }
    } else if (m.role === 'tool' && !paired.has(m)) {
      // A result whose call is not in this transcript.
      if (!inAssistant) heading('Assistant');
      inAssistant = true;
      out.push(`> tool: ${oneLine(m.name) || 'unknown'}() → ${firstLine(m.content)}`, '');
    }
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n') + '\n';
}

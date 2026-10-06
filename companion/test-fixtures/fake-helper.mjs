// A stand-in for desktop helper programs (xdotool, wmctrl, osascript, screencapture, powershell, pbcopy, …) used by
// companion/test.mjs. Started as: node fake-helper.mjs <helper name> <args…> through a shell wrapper named like the helper.
//   FAKE_HELPER_LOG    file to append one JSON line per call: { name, args, stdin? }
//   FAKE_HELPER_DIR    folder with canned answers: <key>.out (printed to stdout), <key>.err, <key>.code (exit code).
//                      The key is the helper name, or "<name>-<tag>" when the call carries an "aa:<tag>" marker (in an
//                      AppleScript comment or a PowerShell -EncodedCommand) and answers exist for that key.
//   FAKE_PNG           a PNG file that screenshot helpers copy to the path they are given
//   FAKE_EDITOR_STATE  a JSON file { doc, clip, cursor, sel, noCopy, events } modelling one text editor and the
//                      clipboard: pbcopy/pbpaste, xclip, xsel, wl-copy/wl-paste use "clip"; key presses sent through
//                      osascript or xdotool act on "doc" (select all, copy, paste, move to the end, Right arrow).
//                      noCopy: Copy does nothing (an app without a text selection).
// Nothing here touches the real desktop or clipboard.

import fs from 'node:fs';
import path from 'node:path';

const [name, ...args] = process.argv.slice(2);

function readStdin() {
  const chunks = [];
  const buf = Buffer.alloc(65536);
  for (;;) {
    let n;
    try {
      n = fs.readSync(0, buf, 0, buf.length, null);
    } catch (e) {
      if (e.code === 'EAGAIN') {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        continue;
      }
      break;
    }
    if (!n) break;
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

const stdin = process.stdin.isTTY ? '' : readStdin();
const entry = { name, args };
if (stdin) entry.stdin = stdin;
if (process.env.FAKE_HELPER_LOG) fs.appendFileSync(process.env.FAKE_HELPER_LOG, `${JSON.stringify(entry)}\n`);

const dir = process.env.FAKE_HELPER_DIR || '';
const read = (f) => {
  try {
    return fs.readFileSync(path.join(dir, f), 'utf8');
  } catch {
    return null;
  }
};

// PowerShell scripts arrive base64 (UTF-16LE) after -EncodedCommand; their data as base64 JSON on stdin.
const encIdx = args.findIndex((a) => /^-EncodedCommand$/i.test(a));
const script = encIdx >= 0 ? Buffer.from(args[encIdx + 1] || '', 'base64').toString('utf16le') : args.join('\n');
let data = null;
if (encIdx >= 0 && stdin.trim()) {
  try {
    data = JSON.parse(Buffer.from(stdin.trim(), 'base64').toString('utf8'));
  } catch {}
}
const tag = /aa:([\w-]+)/.exec(script)?.[1];

if (['screencapture', 'grim', 'scrot', 'maim', 'import', 'gnome-screenshot', 'spectacle'].includes(name) && process.env.FAKE_PNG) {
  fs.copyFileSync(process.env.FAKE_PNG, args[args.length - 1]);
}
if (/^(powershell|pwsh)/.test(name) && tag === 'desktop_screenshot' && data?.file && process.env.FAKE_PNG) fs.copyFileSync(process.env.FAKE_PNG, data.file);

// --- the editor model
const stateFile = process.env.FAKE_EDITOR_STATE;
if (stateFile) {
  const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  st.events ??= [];
  let handled = false;
  const key = (k, mods = []) => {
    const primary = mods.includes('command') || mods.includes('ctrl');
    if (primary && k === 'a') st.sel = 'all';
    else if (primary && k === 'c') {
      if (st.sel === 'all' && !st.noCopy) st.clip = st.doc;
    } else if (primary && k === 'v') {
      if (st.sel === 'all') st.doc = st.clip;
      else st.doc = st.doc.slice(0, st.cursor) + st.clip + st.doc.slice(st.cursor);
      st.cursor = st.sel === 'all' ? st.doc.length : st.cursor + st.clip.length;
      st.sel = null;
    } else if ((primary && (k === 'Down' || k === 'End')) || k === 'Right') {
      st.cursor = k === 'Right' && st.sel !== 'all' ? Math.min(st.doc.length, st.cursor + 1) : st.doc.length;
      st.sel = null;
    }
    st.events.push(`${mods.length ? `${mods.join('+')}+` : ''}${k}`);
  };
  if (['pbpaste', 'wl-paste'].includes(name) || (name === 'xclip' && args.includes('-o')) || (name === 'xsel' && args.includes('--output'))) {
    process.stdout.write(st.clip);
    handled = true;
  } else if (['pbcopy', 'wl-copy'].includes(name) || (name === 'xclip' && args.includes('-i')) || (name === 'xsel' && args.includes('--input'))) {
    st.clip = stdin;
    handled = true;
  } else if (name === 'osascript' && !tag && !script.includes('background only')) {
    const sep = args.indexOf('--');
    const argv = sep >= 0 ? args.slice(sep + 1) : [];
    const lines = args.slice(0, sep >= 0 ? sep : args.length).filter((a) => a !== '-e');
    const CODES = { 124: 'Right', 125: 'Down', 119: 'End', 36: 'Return' };
    for (const line of lines) {
      const mods = (/using \{([^}]*)\}/.exec(line)?.[1] || '').split(',').map((m) => m.trim().replace(/ down$/, '')).filter(Boolean);
      const ks = /^keystroke \(item (\d+) of argv\)/.exec(line);
      const kc = /^key code (\d+)/.exec(line);
      if (ks) key(argv[Number(ks[1]) - 1], mods);
      else if (kc) key(CODES[kc[1]] || `code${kc[1]}`, mods);
    }
  } else if (name === 'xdotool' && args[0] === 'key') {
    for (const chord of args.slice(1).filter((a) => !a.startsWith('--'))) {
      const parts = chord.split('+');
      key(parts.pop(), parts);
    }
  }
  fs.writeFileSync(stateFile, JSON.stringify(st));
  if (handled) process.exit(0);
}

let answerKey = name;
if (tag && (read(`${name}-${tag}.out`) !== null || read(`${name}-${tag}.code`) !== null || read(`${name}-${tag}.err`) !== null)) answerKey = `${name}-${tag}`;
// osascript: the window list script gets its own canned answer.
else if (name === 'osascript' && args.some((a) => a.includes('background only'))) answerKey = 'osascript-list';
const out = read(`${answerKey}.out`);
if (out !== null) process.stdout.write(out);
const err = read(`${answerKey}.err`);
if (err !== null) process.stderr.write(err);
process.exit(Number(read(`${answerKey}.code`) || 0));

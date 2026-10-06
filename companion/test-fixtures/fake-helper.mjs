// A stand-in for desktop helper programs (xdotool, wmctrl, osascript, screencapture, …) used by companion/test.mjs.
// Started as: node fake-helper.mjs <helper name> <args…> through a shell wrapper named like the helper.
//   FAKE_HELPER_LOG   file to append one JSON line per call: { name, args }
//   FAKE_HELPER_DIR   folder with canned answers: <name>.out (printed to stdout), <name>.err, <name>.code (exit code)
//   FAKE_PNG          a PNG file that screenshot helpers copy to the path they are given (their last argument)
// Nothing here touches the real desktop.

import fs from 'node:fs';
import path from 'node:path';

const [name, ...args] = process.argv.slice(2);
if (process.env.FAKE_HELPER_LOG) fs.appendFileSync(process.env.FAKE_HELPER_LOG, `${JSON.stringify({ name, args })}\n`);

const dir = process.env.FAKE_HELPER_DIR || '';
const read = (f) => {
  try {
    return fs.readFileSync(path.join(dir, f), 'utf8');
  } catch {
    return null;
  }
};

if (['screencapture', 'grim', 'scrot', 'maim', 'import', 'gnome-screenshot', 'spectacle'].includes(name) && process.env.FAKE_PNG) {
  fs.copyFileSync(process.env.FAKE_PNG, args[args.length - 1]);
}
// osascript: the window list script gets its own canned answer.
const key = name === 'osascript' && args.some((a) => a.includes('background only')) ? 'osascript-list' : name;
const out = read(`${key}.out`);
if (out !== null) process.stdout.write(out);
const err = read(`${key}.err`);
if (err !== null) process.stderr.write(err);
process.exit(Number(read(`${key}.code`) || 0));

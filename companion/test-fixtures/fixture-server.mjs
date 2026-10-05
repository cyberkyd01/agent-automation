// A tiny stdio MCP server used by companion/test.mjs. Newline-delimited JSON-RPC on stdin/stdout.
// Options: --slow-start <ms>   delay the initialize answer
//          --crash-on-start    print to stderr and exit 1 immediately
// Env:     FIXTURE_LOG=<file>  append "cancelled <requestId>" lines when a call is cancelled

import fs from 'node:fs';

const argv = process.argv.slice(2);
const slowStart = argv.includes('--slow-start') ? Number(argv[argv.indexOf('--slow-start') + 1]) : 0;
const logFile = process.env.FIXTURE_LOG;

process.stderr.write(`fixture started pid=${process.pid}\n`);
if (argv.includes('--crash-on-start')) {
  process.stderr.write('fixture: cannot start, missing FAKE_API_KEY\n');
  process.exit(1);
}

const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const text = (t) => ({ content: [{ type: 'text', text: t }] });

let tools = [
  { name: 'echo', description: 'Echo the text back.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, annotations: { readOnlyHint: true } },
  { name: 'add', description: 'Add two numbers.', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } } },
  { name: 'pid', description: 'Return the process id.', inputSchema: { type: 'object', properties: {} } },
  { name: 'ask_roots', description: 'Ask the client for its roots.', inputSchema: { type: 'object', properties: {} } },
  { name: 'ask_sampling', description: 'Send an unsupported request to the client.', inputSchema: { type: 'object', properties: {} } },
  { name: 'slow', description: 'Wait for ms milliseconds.', inputSchema: { type: 'object', properties: { ms: { type: 'number' } } } },
  { name: 'crash', description: 'Exit with an error.', inputSchema: { type: 'object', properties: {} } },
  { name: 'fail', description: 'Return an isError result.', inputSchema: { type: 'object', properties: {} } },
  { name: 'add_tool', description: 'Add a tool and announce tools/list_changed.', inputSchema: { type: 'object', properties: {} } },
  { name: 'dotted.name/with spaces', description: 'A tool whose name needs cleaning.', inputSchema: { type: 'object', properties: {} } },
  { name: 'a_really_long_tool_name_that_goes_on_and_on_and_on_forever', description: 'Long name.', inputSchema: { type: 'object', properties: {} } },
];

const waiting = new Map(); // our requests to the client
const running = new Map(); // calls in progress: id -> timer
let nextId = 1;

function ask(method, params) {
  const id = `srv-${nextId++}`;
  send({ jsonrpc: '2.0', id, method, params });
  return new Promise((resolve) => waiting.set(id, resolve));
}

async function call(id, name, args) {
  switch (name) {
    case 'echo':
      return text(String(args.text));
    case 'add':
      return text(String(Number(args.a) + Number(args.b)));
    case 'pid':
      return text(String(process.pid));
    case 'ask_roots':
      return text(JSON.stringify(await ask('roots/list')));
    case 'ask_sampling':
      return text(JSON.stringify(await ask('sampling/createMessage', { messages: [], maxTokens: 1 })));
    case 'slow':
      return new Promise((resolve) => {
        running.set(id, setTimeout(() => {
          running.delete(id);
          resolve(text('done'));
        }, Number(args.ms) || 1000));
      });
    case 'crash':
      process.stderr.write('fixture: about to crash on purpose\n');
      setTimeout(() => process.exit(7), 10);
      return new Promise(() => {});
    case 'fail':
      return { content: [{ type: 'text', text: 'the fixture failed on purpose' }], isError: true };
    case 'add_tool':
      tools = [...tools, { name: 'extra', description: 'Added later.', inputSchema: { type: 'object', properties: {} } }];
      setTimeout(() => send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }), 10);
      return text('added');
    default:
      return text(`called ${name}`);
  }
}

async function handle(m) {
  if (m.method === undefined) {
    const resolve = waiting.get(m.id);
    if (resolve) {
      waiting.delete(m.id);
      resolve(m.error ? { error: m.error } : m.result);
    }
    return;
  }
  if (m.method === 'notifications/cancelled') {
    const t = running.get(m.params?.requestId);
    clearTimeout(t);
    running.delete(m.params?.requestId);
    if (logFile) fs.appendFileSync(logFile, `cancelled ${m.params?.requestId}\n`);
    return;
  }
  if (m.id === undefined) return;
  if (m.method === 'initialize') {
    if (slowStart) await new Promise((r) => setTimeout(r, slowStart));
    return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'fixture', version: '0.0.1' } } });
  }
  if (m.method === 'tools/list') {
    // Two pages, to exercise nextCursor.
    const half = Math.ceil(tools.length / 2);
    if (!m.params?.cursor) return send({ jsonrpc: '2.0', id: m.id, result: { tools: tools.slice(0, half), nextCursor: 'page2' } });
    return send({ jsonrpc: '2.0', id: m.id, result: { tools: tools.slice(half) } });
  }
  if (m.method === 'tools/call') {
    const result = await call(m.id, m.params.name, m.params.arguments || {});
    if (result) send({ jsonrpc: '2.0', id: m.id, result });
    return;
  }
  if (m.method === 'ping') return send({ jsonrpc: '2.0', id: m.id, result: {} });
  send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'nope' } });
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch (e) {
      process.stderr.write(`fixture: bad line ${e.message}\n`);
    }
  }
});
process.stdin.on('end', () => process.exit(0));

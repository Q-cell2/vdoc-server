// Local log viewer for vdoc-server. No dependencies.
//   npm run logs               → http://localhost:8790
// Sources:
//   local       logs/local.jsonl, written by `npm run dev:logs` (tee'd stdout)
//   production  `wrangler tail vdoc-server --format json`, started from the page (live only)
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, statSync, openSync, readSync, closeSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.VDOC_LOG_VIEWER_PORT ?? 8790);
const SERVER_REPO = process.env.VDOC_SERVER_REPO ?? join(here, '..', '..');
const logsDir = join(here, 'logs');
mkdirSync(logsDir, { recursive: true });
const localFile = join(logsDir, 'local.jsonl');
const productionFile = join(logsDir, 'production.jsonl');

const MAX = 50_000;
const entries = [];
let seq = 0;
const listeners = new Set();
function add(source, record) {
  if (!record || typeof record !== 'object' || !record.message) return;
  const entry = { id: ++seq, source, ...record };
  entries.push(entry);
  if (entries.length > MAX) entries.splice(0, entries.length - MAX);
  for (const send of listeners) send(entry);
}
function parseLine(source, line) {
  const start = line.indexOf('{');
  if (start < 0) return;
  try { add(source, JSON.parse(line.slice(start))); } catch { /* not a log line */ }
}

// ── local: follow logs/local.jsonl ──────────────────────────────────────────
let offset = 0;
let partial = '';
function readLocal() {
  if (!existsSync(localFile)) return;
  const size = statSync(localFile).size;
  if (size < offset) { offset = 0; partial = ''; }
  if (size === offset) return;
  const fd = openSync(localFile, 'r');
  const buffer = Buffer.alloc(size - offset);
  readSync(fd, buffer, 0, buffer.length, offset);
  closeSync(fd);
  offset = size;
  const text = partial + buffer.toString('utf8');
  const lines = text.split('\n');
  partial = lines.pop() ?? '';
  for (const line of lines) parseLine('local', line);
}
readLocal();
setInterval(readLocal, 500);

// Earlier production captures survive restarts of this viewer.
if (existsSync(productionFile)) for (const line of readFileSync(productionFile, 'utf8').split('\n')) parseLine('production', line);

// ── production: wrangler tail ───────────────────────────────────────────────
let tail;
let tailStatus = 'stopped';
let tailError = '';
function startTail() {
  if (tail) return;
  tailStatus = 'starting'; tailError = '';
  tail = spawn('npx', ['wrangler', 'tail', 'vdoc-server', '--format', 'json'], { cwd: SERVER_REPO, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
  let buffer = '';
  tail.stdout.on('data', chunk => {
    tailStatus = 'running';
    buffer += chunk.toString('utf8');
    // wrangler prints one pretty-printed JSON object per invocation.
    let depth = 0, inString = false, escaped = false, begin = -1;
    let consumed = 0;
    for (let i = 0; i < buffer.length; i++) {
      const c = buffer[i];
      if (inString) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') inString = false; continue; }
      if (c === '"') inString = true;
      else if (c === '{') { if (depth++ === 0) begin = i; }
      else if (c === '}' && --depth === 0 && begin >= 0) {
        const raw = buffer.slice(begin, i + 1); consumed = i + 1; begin = -1;
        try {
          const event = JSON.parse(raw);
          for (const log of event.logs ?? []) {
            for (const part of log.message ?? []) {
              const line = typeof part === 'string' ? part : JSON.stringify(part);
              appendFileSync(productionFile, line + '\n');
              parseLine('production', line);
            }
          }
          for (const exception of event.exceptions ?? []) {
            const record = { time: new Date(exception.timestamp ?? Date.now()).toISOString(), level: 'error', message: 'worker exception', error: `${exception.name}: ${exception.message}` };
            appendFileSync(productionFile, JSON.stringify(record) + '\n');
            add('production', record);
          }
        } catch { /* partial or non-log output */ }
      }
    }
    if (consumed) buffer = buffer.slice(consumed);
    if (buffer.length > 5_000_000) buffer = '';
  });
  tail.stderr.on('data', chunk => { const text = chunk.toString('utf8'); if (/error/i.test(text)) tailError = text.slice(-500); });
  tail.on('exit', code => { tail = undefined; tailStatus = code === 0 || code === null ? 'stopped' : 'failed'; });
}
function stopTail() { tail?.kill(); tail = undefined; tailStatus = 'stopped'; }

// ── http ────────────────────────────────────────────────────────────────────
createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(readFileSync(join(here, 'index.html')));
  } else if (url.pathname === '/api/entries') {
    const since = Number(url.searchParams.get('since') ?? 0);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ entries: entries.filter(entry => entry.id > since), tail: { status: tailStatus, error: tailError } }));
  } else if (url.pathname === '/api/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const send = entry => res.write(`data: ${JSON.stringify(entry)}\n\n`);
    listeners.add(send);
    const status = setInterval(() => res.write(`event: tail\ndata: ${JSON.stringify({ status: tailStatus, error: tailError })}\n\n`), 2000);
    req.on('close', () => { listeners.delete(send); clearInterval(status); });
  } else if (url.pathname === '/api/production' && req.method === 'POST') {
    if (url.searchParams.get('action') === 'stop') stopTail(); else startTail();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: tailStatus }));
  } else {
    res.writeHead(404); res.end();
  }
}).listen(PORT, '127.0.0.1', () => console.log(`vdoc log viewer: http://localhost:${PORT}`));
process.on('SIGTERM', () => { stopTail(); process.exit(0); });

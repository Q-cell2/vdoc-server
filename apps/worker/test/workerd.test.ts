// Drives the Worker in workerd (`wrangler dev --local`), the runtime production
// uses: Durable Object storage, WebSocketPair upgrades, grant verification and
// session end. The Node e2e suite covers the same flows on the Node runtime.
// Fake model, throwaway keys: no network, no secrets.
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, type ClientSession } from '@vrealtime/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const CLIENT_KEY = 'workerd-test-client-key-0123456789';
const QUOTA_KEY = 'workerd-quota-client-key-0123456789';
const auth = { authorization: `Bearer ${CLIENT_KEY}` };
const workerDir = fileURLToPath(new URL('..', import.meta.url));
const wranglerBin = join(dirname(createRequire(import.meta.url).resolve('wrangler/package.json')), 'bin', 'wrangler.js');

let base = '';
let wsBase = '';
let worker: ChildProcess;
let scratch = '';
const logs: string[] = [];
const clients: ClientSession[] = [];
const grants: { documentId: string; sessionId: string; headers: Record<string, string> }[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(grants.splice(0).map(({ documentId, sessionId, headers }) => fetch(`${base}/v1/documents/${documentId}/voice-sessions/${sessionId}`, { method: 'DELETE', headers })));
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out\n--- worker log (tail) ---\n${logs.join('').slice(-4000)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Audit lines the Durable Object logged (one JSON object per line), for one session. */
function auditOf(sessionId: string): { message: string; [field: string]: unknown }[] {
  return logs.join('').split('\n')
    .map((line) => line.slice(line.indexOf('{')))
    .flatMap((line) => { try { return [JSON.parse(line) as { message: string; audit?: boolean; sessionId?: string }]; } catch { return []; } })
    .filter((entry) => entry.audit === true && entry.sessionId === sessionId);
}

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'vdoc-workerd-'));
  const envFile = join(scratch, '.env');
  writeFileSync(envFile, [
    'VDOC_SERVER_ENV=test',
    'VDOC_SERVER_MODEL=fake',
    `VDOC_SERVER_CLIENTS=vdoc-web:${CLIENT_KEY},quota:${QUOTA_KEY}`,
    'VDOC_SERVER_MAX_CONCURRENT_SESSIONS_PER_PRINCIPAL=2',
    'VDOC_SERVER_MAX_SESSIONS_PER_HOUR=10',
    'VDOC_SERVER_SIGNING_KEYS=test:worker-e2e-signing-secret-at-least-32-characters',
    'VDOC_SERVER_LOG_LEVEL=info',
  ].join('\n'));
  const port = await freePort();
  worker = spawn(process.execPath, [wranglerBin, 'dev', '--local', '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', String(await freePort()),
    '--env-file', envFile, '--persist-to', join(scratch, 'state'), '--show-interactive-dev-session=false'], {
    cwd: workerDir,
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  worker.stdout!.on('data', (data: Buffer) => logs.push(data.toString()));
  worker.stderr!.on('data', (data: Buffer) => logs.push(data.toString()));
  base = `http://127.0.0.1:${port}`;
  wsBase = `ws://127.0.0.1:${port}`;
  try {
    await until(async () => {
      if (worker.exitCode !== null) throw new Error(`wrangler dev exited with ${worker.exitCode}`);
      try { return (await fetch(`${base}/healthz`)).ok; } catch { return false; }
    }, 60_000);
  } catch (error) {
    throw new Error(`The Worker did not start: ${String(error)}\n${logs.join('')}`);
  }
}, 90_000);

afterAll(async () => {
  if (worker && worker.exitCode === null) {
    const exited = new Promise((resolve) => worker.once('exit', resolve));
    worker.kill('SIGTERM');
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
    if (worker.exitCode === null) worker.kill('SIGKILL');
  }
  // On Windows, killing wrangler orphans its workerd process, which keeps the
  // SQLite files in scratch open for a few more seconds before it exits.
  const deadline = Date.now() + 20_000;
  while (scratch) {
    try {
      rmSync(scratch, { recursive: true, force: true });
      break;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}, 30_000);

type Granted = { sessionId: string; grant: { token: string }; realtimePath: string };

async function grant(documentId: string): Promise<Granted> {
  const response = await fetch(`${base}/v1/documents/${documentId}/voice-sessions`, { method: 'POST', headers: auth });
  expect(response.status).toBe(201);
  const granted = await response.json() as Granted;
  grants.push({ documentId, sessionId: granted.sessionId, headers: auth });
  return granted;
}

async function renew(documentId: string, sessionId: string): Promise<string> {
  const response = await fetch(`${base}/v1/documents/${documentId}/voice-sessions/${sessionId}/grants`, { method: 'POST', headers: auth });
  expect(response.status).toBe(201);
  return ((await response.json()) as { token: string }).token;
}

async function status(documentId: string, sessionId: string): Promise<{ status: string; endReason: string | null }> {
  const response = await fetch(`${base}/v1/documents/${documentId}/voice-sessions/${sessionId}`, { headers: auth });
  return response.json() as Promise<{ status: string; endReason: string | null }>;
}

async function openRealtime(documentId: string, granted: Granted, calls: string[], token: string | (() => Promise<string>) = granted.grant.token): Promise<ClientSession> {
  const client = await connect(`${wsBase}${granted.realtimePath}`, {
    auth: token,
    reconnect: false,
    context: { documentId, title: 'Project plan', language: 'en' },
    tools: {
      read_document: { parameters: { type: 'object' }, run: () => { calls.push('read_document'); return { ok: true }; } },
    },
  });
  clients.push(client);
  return client;
}

describe('vdoc-server in workerd', () => {
  it('shares quota across document DOs, releases slots on DELETE, and retains the hourly count', async () => {
    const headers = { authorization: `Bearer ${QUOTA_KEY}` };
    const post = (documentId: string) => fetch(`${base}/v1/documents/${documentId}/voice-sessions`, { method: 'POST', headers });
    const created = await Promise.all(Array.from({ length: 8 }, async (_, index) => {
      const documentId = `quota-${index}`;
      const response = await post(documentId);
      if (response.status === 201) {
        const { sessionId } = await response.json() as Granted;
        const row = { documentId, sessionId, headers };
        grants.push(row);
        return row;
      }
      expect(response.status).toBe(429);
      expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(await response.json()).toMatchObject({ code: 'QUOTA_EXCEEDED' });
      return undefined;
    }));
    const admitted = created.filter((row) => row !== undefined);
    expect(admitted).toHaveLength(2);
    for (const { documentId, sessionId } of admitted) {
      expect((await fetch(`${base}/v1/documents/${documentId}/voice-sessions/${sessionId}`, { method: 'DELETE', headers })).status).toBe(204);
    }
    for (let index = 2; index < 10; index++) {
      const documentId = `quota-rate-${index}`;
      const response = await post(documentId);
      expect(response.status).toBe(201);
      const { sessionId } = await response.json() as Granted;
      grants.push({ documentId, sessionId, headers });
      expect((await fetch(`${base}/v1/documents/${documentId}/voice-sessions/${sessionId}`, { method: 'DELETE', headers })).status).toBe(204);
    }
    const limited = await post('quota-rate-blocked');
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(3500);
    expect(await limited.json()).toMatchObject({ code: 'QUOTA_EXCEEDED' });
  });
  it('answers health checks and unknown routes at the edge', async () => {
    expect(await (await fetch(`${base}/healthz`)).json()).toEqual({ status: 'ok' });
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    expect((await fetch(`${base}/v1/documents/doc-a/voice-sessions`, { method: 'POST' })).status).toBe(401);
  });

  it('keeps sessions in Durable Object storage', async () => {
    const granted = await grant('doc-storage');
    expect(granted.grant.token).toMatch(/^vg1\./);
    expect(await status('doc-storage', granted.sessionId)).toMatchObject({ status: 'granted' });
    const stranger = await fetch(`${base}/v1/documents/doc-other/voice-sessions/${granted.sessionId}`, { headers: auth });
    expect(stranger.status).toBe(404);
  });

  it('connects with a renewed grant, runs an app-side tool and audits it', async () => {
    const granted = await grant('doc-tools');
    const calls: string[] = [];
    const session = await openRealtime('doc-tools', granted, calls, () => renew('doc-tools', granted.sessionId));
    session.sendText('please read it');
    await until(() => calls.includes('read_document'));
    await until(() => auditOf(granted.sessionId).some((entry) => entry.message === 'ToolCallCompleted'));
    expect(auditOf(granted.sessionId).find((entry) => entry.message === 'ToolCallReviewed')).toMatchObject({ tool: 'read_document', decision: 'allow' });
    expect(await status('doc-tools', granted.sessionId)).toMatchObject({ status: 'active' });
    await session.close();
  });

  it('accepts microphone audio frames', async () => {
    // workerd delivers binary WebSocket messages as Blob unless the socket asks for ArrayBuffer.
    const granted = await grant('doc-audio');
    let frames = 0;
    const session = await connect(`${wsBase}${granted.realtimePath}`, {
      auth: granted.grant.token,
      reconnect: false,
      context: { documentId: 'doc-audio', title: 'Project plan', language: 'en' },
      audio: {
        input: async (_format, onFrame) => {
          const timer = setInterval(() => { frames++; onFrame(new Uint8Array(960)); }, 20);
          return { stop: async () => clearInterval(timer) };
        },
        output: { enqueue() {}, flush: async () => ({}), close: async () => {} },
      },
    });
    clients.push(session);
    const errors: string[] = [];
    session.on('error', (event) => errors.push(`${event.code}: ${event.message}`));
    await until(() => frames >= 10);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(errors).toEqual([]);
  });

  it('refuses a tampered grant', async () => {
    const granted = await grant('doc-tamper');
    await expect(openRealtime('doc-tamper', granted, [], `${granted.grant.token}x`)).rejects.toThrow();
    const other = await grant('doc-wrong-grant');
    await expect(openRealtime('doc-tamper', granted, [], other.grant.token)).rejects.toThrow();
  });

  it('ends a session on DELETE, hangs up, and refuses to reconnect with 4410', async () => {
    const granted = await grant('doc-end');
    const session = await openRealtime('doc-end', granted, []);
    const closed = new Promise((resolve) => session.on('closed', resolve));
    const response = await fetch(`${base}/v1/documents/doc-end/voice-sessions/${granted.sessionId}`, { method: 'DELETE', headers: auth });
    expect(response.status).toBe(204);
    await closed;
    expect(await status('doc-end', granted.sessionId)).toMatchObject({ status: 'ended', endReason: 'client' });
    const renewal = await fetch(`${base}/v1/documents/doc-end/voice-sessions/${granted.sessionId}/grants`, { method: 'POST', headers: auth });
    expect(renewal.status).toBe(410);
    await expect(openRealtime('doc-end', granted, [])).rejects.toThrow(/4410/);
  });
});

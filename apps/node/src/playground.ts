import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { build } from 'esbuild';

let bundle: Promise<string> | undefined;
let bundleVersion = '';
/** Development-only, same-origin and loopback-only. Never exposes provider credentials. */
export async function servePlayground(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const path = req.url?.split('?')[0];
  if (req.method !== 'GET' || (path !== '/' && path !== '/dev/playground.js')) return false;
  const address = req.socket.remoteAddress;
  const host = req.headers.host;
  let url: URL;
  try { url = new URL(`http://${host}`); } catch { return false; }
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address ?? '') || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return false;
  if (req.headers.origin && req.headers.origin !== url.origin) return false;
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  if (path === '/') {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(await readFile(new URL('./playground/index.html', import.meta.url), 'utf8'));
  } else {
    const times = await Promise.all(['client.ts', 'document.ts', 'microphone.ts', 'article-stream.ts', 'table.ts', 'generation-error.ts'].map(name => stat(new URL('./playground/' + name, import.meta.url))));
    const version = times.map(item => item.mtimeMs).join(':');
    if (version !== bundleVersion) { bundle = undefined; bundleVersion = version; }
    bundle ??= build({ entryPoints: [fileURLToPath(new URL('./playground/client.ts', import.meta.url))], bundle: true, write: false,
      format: 'esm', platform: 'browser', target: 'es2022' }).then(result => result.outputFiles[0]!.text).catch(error => { bundle = undefined; throw error; });
    res.setHeader('content-type', 'text/javascript; charset=utf-8');
    res.end(await bundle);
  }
  return true;
}

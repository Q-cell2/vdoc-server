import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

it('keeps root command discovery equivalent to the explicit Worker configuration', () => {
  function normalized(path: string) {
    const parsed = ts.parseConfigFileTextToJson(path, readFileSync(path, 'utf8'));
    expect(parsed.error).toBeUndefined();
    const { $schema, main, ...config } = parsed.config;
    return { ...config, main: resolve(dirname(path), main) };
  }
  const root = normalized('wrangler.jsonc');
  expect(root).toEqual(normalized('apps/worker/wrangler.jsonc'));
  expect(root.previews.durable_objects.bindings).toEqual([
    { name: 'VOICE_ROOMS', class_name: 'DocumentVoiceRoom' },
  ]);
  expect(root.durable_objects.bindings).toEqual(root.previews.durable_objects.bindings);
  expect(root.migrations.at(-1)).toEqual({ tag: 'v3', deleted_classes: ['PrincipalQuotaRoom'] });
  expect(root.previews.vars.VDOC_SERVER_ENV).toBe('production');
  expect(root.observability).toEqual({ logs: { enabled: true, invocation_logs: true } });
});

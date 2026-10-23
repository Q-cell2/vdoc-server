import { describe, expect, it } from 'vitest';
import { VDOC_RISK_TABLE } from '@vdoc-server/domain';
import { VDOC_TOOLS, editingAssistantProfile, loadConfig } from '../src';

const KEY = 'k'.repeat(40);

describe('loadConfig', () => {
  it('requires explicit legacy mode, rejects ambiguous flags and reserves the user namespace', () => {
    expect(loadConfig({})).toMatchObject({ ok: true, value: { allowClientOnly: true } });
    expect(loadConfig({ VDOC_SERVER_ALLOW_CLIENT_ONLY: 'false' })).toMatchObject({ ok: true, value: { allowClientOnly: false } });
    expect(loadConfig({ VDOC_SERVER_ALLOW_CLIENT_ONLY: '1' }).ok).toBe(false);
    expect(loadConfig({ VDOC_SERVER_CLIENTS: `usr_collision:${KEY}` }).ok).toBe(false);
  });

  it('no longer exposes cross-session quota configuration', () => {
    const config = loadConfig({ VDOC_SERVER_MAX_SESSIONS_PER_HOUR: '0' });
    expect(config.ok).toBe(true);
    if (config.ok) expect(config.value).not.toHaveProperty('quotas');
  });
  it('fills safe throwaway defaults in development and says so', () => {
    const config = loadConfig({});
    expect(config.ok).toBe(true);
    if (!config.ok) return;
    expect(config.value).toMatchObject({ environment: 'development', model: { provider: 'fake' }, concurrency: 'supersede' });
    expect(config.value.generated).toHaveLength(2);
  });

  it('requires every secret explicitly in production and reports all problems at once', () => {
    const config = loadConfig({ VDOC_SERVER_ENV: 'production', VDOC_SERVER_MODEL: 'fake', VDOC_SERVER_ALLOWED_ORIGINS: '*' });
    expect(config.ok).toBe(false);
    if (config.ok) return;
    expect(config.errors.join('\n')).toMatch(/SIGNING_KEYS[\s\S]*CLIENTS[\s\S]*ALLOWED_ORIGINS[\s\S]*fake model/);
  });

  it('parses a complete production configuration', () => {
    const config = loadConfig({
      VDOC_SERVER_ENV: 'production', VDOC_SERVER_SIGNING_KEYS: `k2:${KEY},k1:${KEY}`, VDOC_SERVER_CLIENTS: `vdoc-web:${KEY}`,
      VDOC_SERVER_ALLOWED_ORIGINS: 'https://vdoc.app', BOSON_API_KEY: 'b', VDOC_SERVER_MODEL: 'boson:higgs-realtime', VDOC_SERVER_MAX_SESSION_MINUTES: '10',
    });
    expect(config).toMatchObject({ ok: true, value: { allowClientOnly: false, model: { provider: 'boson', model: 'higgs-realtime' }, limits: { maxDurationMs: 600_000 }, signingKeys: [{ id: 'k2' }, { id: 'k1' }] } });
  });

  it('rejects a provider without its key and malformed numbers', () => {
    const config = loadConfig({ VDOC_SERVER_MODEL: 'openai', VDOC_SERVER_MAX_TURNS: '-1' });
    expect(config.ok).toBe(false);
    if (!config.ok) expect(config.errors.join('\n')).toMatch(/OPENAI_API_KEY[\s\S]*MAX_TURNS/);
  });

  it('runs cascade-claude only with both the Anthropic key and the OpenAI speech key', () => {
    const missing = loadConfig({ VDOC_SERVER_MODEL: 'cascade-claude' });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.errors.join('\n')).toMatch(/ANTHROPIC_API_KEY[\s\S]*OPENAI_API_KEY/);
    expect(loadConfig({ VDOC_SERVER_MODEL: 'cascade-claude', OPENAI_API_KEY: 'o' }).ok).toBe(false);
    expect(loadConfig({ VDOC_SERVER_MODEL: 'cascade-claude:claude-sonnet-5-5', ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' }))
      .toMatchObject({ ok: true, value: { model: { provider: 'cascade-claude', model: 'claude-sonnet-5-5' }, providerKeys: { anthropic: 'a', openai: 'o' } } });
  });
});

describe('editing assistant profile', () => {
  it('allows only vdoc tools and renders the document as quoted data', () => {
    const config = loadConfig({});
    if (!config.ok) throw new Error();
    const profile = editingAssistantProfile({ provider: 'boson' }, config.value.limits);
    expect(profile.voice).toBe('default');
    expect(profile.allowedTools.has('apply_document_operations')).toBe(true);
    expect(profile.allowedTools.has('run_shell')).toBe(false);
    expect(profile.instructionsFor({ language: 'zh-CN', documentTitle: 'Q3 "plan"' })).toContain(`titled "Q3 'plan'"`);
  });

  it('tells the agent to speak before calling tools, without claiming the edit or pre-empting a confirmation', () => {
    const config = loadConfig({});
    if (!config.ok) throw new Error();
    const instructions = editingAssistantProfile({ provider: 'boson' }, config.value.limits).instructionsFor({ language: 'zh-CN', documentTitle: 'Notes' });
    expect(instructions).toContain('Speak first, then act.');
    expect(instructions).toContain('call the tools in the same response without waiting for the user');
    expect(instructions).toContain('must never claim the edit is done');
    expect(instructions).toContain('may need the user\'s confirmation first');
  });

  it('lists exactly the tools vdoc declares, each with a risk level', () => {
    // vdoc's catalog: lib/usecases/document-tools.ts in Q-cell2/vdoc.
    expect([...VDOC_TOOLS].sort()).toEqual(['apply_document_operations', 'get_context', 'read_blocks', 'read_document', 'undo_turn']);
    expect(Object.keys(VDOC_RISK_TABLE.tools).sort()).toEqual([...VDOC_TOOLS].sort());
  });
});

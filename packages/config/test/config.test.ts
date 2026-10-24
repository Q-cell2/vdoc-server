import { describe, expect, it } from 'vitest';
import { VDOC_RISK_TABLE } from '@vdoc-server/domain';
import { ASK_ASSISTANT, DEFAULT_FAST_WORKER_MODEL, LATE_RESULT_PREFIX, VDOC_TOOLS, WORKER_INSTRUCTIONS, editingAssistantProfile, fastWorkerSpeakerProfile, loadConfig, webSearchAssistantProfile, workerSpeakerProfile } from '../src';

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

  it('takes an optional Claude model for the worker', () => {
    expect(loadConfig({ VDOC_SERVER_WORKER_MODEL: 'claude-sonnet-5-5' })).toMatchObject({ ok: true, value: { workerModel: 'claude-sonnet-5-5' } });
    expect(loadConfig({ VDOC_SERVER_WORKER_MODEL: 'gpt-5' }).ok).toBe(false);
    expect(loadConfig({ VDOC_SERVER_WORKER_FAST_MODEL: 'claude-haiku-5-5' })).toMatchObject({ ok: true, value: { fastWorkerModel: 'claude-haiku-5-5' } });
    expect(loadConfig({ VDOC_SERVER_WORKER_FAST_MODEL: 'fast' }).ok).toBe(false);
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
    expect([...VDOC_TOOLS].sort()).toEqual(['apply_document_operations', 'get_context', 'insert_structured_article', 'read_blocks', 'read_document', 'undo_turn']);
    expect(Object.keys(VDOC_RISK_TABLE.tools).sort()).toEqual([...VDOC_TOOLS].sort());
  });
});

describe('reasoning effort profiles', () => {
  const limits = (() => { const config = loadConfig({}); if (!config.ok) throw new Error(); return config.value.limits; })();

  it('low effort: the same editing agent, told to search, with its provider’s web search on', () => {
    const profile = webSearchAssistantProfile({ provider: 'boson', model: 'higgs' }, limits);
    expect(profile.id).toBe('editing-assistant-web-search');
    expect(profile.model).toEqual({ provider: 'boson', model: 'higgs', webSearch: true });
    expect([...profile.allowedTools].sort()).toEqual([...VDOC_TOOLS].sort());
    const instructions = profile.instructionsFor({ language: 'zh-CN', documentTitle: 'Notes' });
    expect(instructions).toContain('search the web, even for things you think you know');
    expect(instructions).toContain('Speak first, then act.');
  });

  it('high effort: the speaker only hands off, waits long enough, and the worker edits under the same rules', () => {
    const profile = workerSpeakerProfile({ provider: 'boson' }, limits);
    expect(profile).toMatchObject({ id: 'worker-speaker', handOffTool: ASK_ASSISTANT, clientToolTimeoutMs: 180_000 });
    expect(profile.allowedTools.has(ASK_ASSISTANT) && VDOC_TOOLS.every((tool) => profile.allowedTools.has(tool))).toBe(true);
    const instructions = profile.instructionsFor({ language: 'zh-CN', documentTitle: 'Notes' });
    expect(instructions).toContain(`call ${ASK_ASSISTANT} in the same response, with the user's request`);
    // Spoken words before the call can be cut off (echo, a cough), taking the call with them.
    expect(instructions).toContain(`call ${ASK_ASSISTANT} right away, as the first thing in your response, without saying anything before it`);
    expect(instructions).toContain(LATE_RESULT_PREFIX);
    expect(instructions).toContain('titled "Notes"');
    expect(WORKER_INSTRUCTIONS).toContain('Read before you edit');
    expect(WORKER_INSTRUCTIONS).toContain('Search the web before writing any facts');
    expect(WORKER_INSTRUCTIONS).not.toContain('{{');
  });

  it('medium effort: the same speaker, with a faster worker model', () => {
    const fast = fastWorkerSpeakerProfile({ provider: 'boson' }, limits);
    expect(fast).toMatchObject({ id: 'worker-speaker-fast', handOffTool: ASK_ASSISTANT, workerModel: DEFAULT_FAST_WORKER_MODEL });
    expect(DEFAULT_FAST_WORKER_MODEL).toBe('claude-sonnet-5-5');
    expect(fastWorkerSpeakerProfile({ provider: 'boson' }, limits, 'claude-haiku-5-5').workerModel).toBe('claude-haiku-5-5');
    expect(workerSpeakerProfile({ provider: 'boson' }, limits).workerModel).toBeUndefined();
    expect(fast.instructionsFor({ language: 'zh-CN', documentTitle: 'N' })).toBe(workerSpeakerProfile({ provider: 'boson' }, limits).instructionsFor({ language: 'zh-CN', documentTitle: 'N' }));
  });
});

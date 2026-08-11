/**
 * Environment resolution, which is the only thing this module does.
 *
 * A fake env object is passed in rather than mutating `process.env`, so these
 * tests cannot pass or fail because of what is in the developer's shell — which
 * is the whole failure mode this file exists to make legible.
 */

import { DEFAULT_PROVIDER, providerFromEnv } from './index';

describe('providerFromEnv', () => {
  it('defaults to the Anthropic adapter', () => {
    const { provider, model } = providerFromEnv({ MODEL: 'claude-opus-5', ANTHROPIC_API_KEY: 'k' });
    expect(provider.id).toBe(DEFAULT_PROVIDER);
    expect(provider.id).toBe('anthropic');
    expect(model).toBe('claude-opus-5');
  });

  it('selects bedrock, which needs no key here', () => {
    const { provider } = providerFromEnv({
      PROVIDER: 'bedrock',
      MODEL: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
      AWS_REGION: 'us-east-1',
    });
    expect(provider.id).toBe('bedrock');
  });

  // An exported-but-empty variable is the usual way a shell hands one over, and
  // treating '' as set turns a missing key into a 401 that reads like a revoked one.
  it('treats a blank variable as unset', () => {
    expect(() => providerFromEnv({ MODEL: 'claude-opus-5', ANTHROPIC_API_KEY: '   ' })).toThrow(
      /ANTHROPIC_API_KEY is not set/
    );
    expect(() => providerFromEnv({ MODEL: '', ANTHROPIC_API_KEY: 'k' })).toThrow(/MODEL is not set/);
  });

  it('names the variable, and says how a .env file gets read at all', () => {
    // Nothing in this repo loads .env, so a message that only says "not set"
    // sends the reader to look at a file that is already filled in.
    expect(() => providerFromEnv({ MODEL: 'claude-opus-5' })).toThrow(/--env-file/);
    expect(() => providerFromEnv({ ANTHROPIC_API_KEY: 'k' })).toThrow(/--env-file/);
  });

  it('lists the providers it has when PROVIDER is something else', () => {
    let message = '';
    try {
      providerFromEnv({ PROVIDER: 'openai', MODEL: 'gpt-4', ANTHROPIC_API_KEY: 'k' });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('anthropic, bedrock');
    expect(message).toContain('openai');
  });
});

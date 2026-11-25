import { describe, expect, it } from 'vitest';
import { loadMockConfig } from '../src/config.js';

describe('loadMockConfig', () => {
  it('has defaults for every static setting', () => {
    expect(loadMockConfig({})).toEqual({
      host: '0.0.0.0',
      port: 4010,
      worldPath: undefined,
      tokenExpiresInSeconds: 3599,
      tokenThrottleWindowMs: 60_000,
    });
  });

  it('reads overrides from env', () => {
    expect(
      loadMockConfig({
        MOCK_HOST: '127.0.0.1',
        MOCK_PORT: '5000',
        MOCK_WORLD_PATH: '/tmp/w.json',
        MOCK_TOKEN_EXPIRES_IN: '60',
        MOCK_TOKEN_THROTTLE_WINDOW_MS: '1000',
      }),
    ).toEqual({ host: '127.0.0.1', port: 5000, worldPath: '/tmp/w.json', tokenExpiresInSeconds: 60, tokenThrottleWindowMs: 1000 });
  });

  it('rejects a non-numeric setting', () => {
    expect(() => loadMockConfig({ MOCK_PORT: 'abc' })).toThrow(/MOCK_PORT/);
  });
});

import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { backendEnvironmentKey, resolveBackendProfile } from '../src/agent/profiles';
import type { AppConfig } from '../src/config/schema';

function config(env: Record<string, string>): Pick<AppConfig, 'backendProfiles'> {
  return { backendProfiles: { work: { backend: 'codex-appserver', env } } };
}

describe('命名后端配置', () => {
  it('解析允许的变量并生成与字段顺序无关的隔离键', () => {
    const home = resolve('codex-work');
    const env = resolveBackendProfile(
      config({ HTTPS_PROXY: 'http://127.0.0.1:7890', CODEX_HOME: home }),
      'work',
      'codex-appserver',
    );
    expect(env).toEqual({ HTTPS_PROXY: 'http://127.0.0.1:7890', CODEX_HOME: home });
    expect(backendEnvironmentKey(env)).toBe(
      backendEnvironmentKey({ CODEX_HOME: home, HTTPS_PROXY: 'http://127.0.0.1:7890' }),
    );
  });

  it('拒绝秘密或未知环境变量', () => {
    expect(() =>
      resolveBackendProfile(config({ OPENAI_API_KEY: 'secret' }), 'work', 'codex-appserver'),
    ).toThrow(/不允许环境变量 OPENAI_API_KEY/);
  });

  it('profile 不存在或后端不匹配时显式失败', () => {
    expect(() => resolveBackendProfile(config({ CODEX_HOME: resolve('x') }), 'missing', 'codex-appserver')).toThrow(
      /不存在/,
    );
    expect(() => resolveBackendProfile(config({ CODEX_HOME: resolve('x') }), 'work', 'claude-agent')).toThrow(
      /不能用于 claude-agent/,
    );
  });
});

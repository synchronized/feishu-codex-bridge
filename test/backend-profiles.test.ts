import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import {
  backendEnvironmentKey,
  backendForProfile,
  DEFAULT_CLAUDE_PROFILE,
  DEFAULT_CODEX_PROFILE,
  ensureDefaultBackendProfiles,
  initialBackendProfiles,
  resolveBackendProfile,
} from '../src/agent/profiles';
import type { AppConfig } from '../src/config/schema';

function config(env: Record<string, string>): Pick<AppConfig, 'backendProfiles'> {
  return { backendProfiles: { work: { backend: 'codex-appserver', env } } };
}

describe('命名后端配置', () => {
  it('初始化 Codex/Claude 默认 profile，并由 profile 唯一解析 backend', () => {
    const profiles = initialBackendProfiles();
    expect(profiles[DEFAULT_CODEX_PROFILE]?.backend).toBe('codex-appserver');
    expect(profiles[DEFAULT_CLAUDE_PROFILE]?.backend).toBe('claude-agent');
    expect(backendForProfile({ backendProfiles: profiles }, DEFAULT_CODEX_PROFILE)).toBe('codex-appserver');
    expect(backendForProfile({ backendProfiles: profiles }, DEFAULT_CLAUDE_PROFILE)).toBe('claude-agent');
  });

  it('旧配置补默认 profile 时不覆盖用户已有同名配置', () => {
    const cfg: AppConfig = {
      accounts: { app: { id: 'app', secret: 'secret', tenant: 'feishu' as const } },
      backendProfiles: {
        [DEFAULT_CODEX_PROFILE]: { backend: 'custom-codex', env: {} },
      },
    };
    expect(ensureDefaultBackendProfiles(cfg)).toBe(true);
    expect(cfg.backendProfiles?.[DEFAULT_CODEX_PROFILE]?.backend).toBe('custom-codex');
    expect(cfg.backendProfiles?.[DEFAULT_CLAUDE_PROFILE]?.backend).toBe('claude-agent');
    expect(ensureDefaultBackendProfiles(cfg)).toBe(false);
  });

  it('空环境的默认 profile 不生成多余环境覆盖', () => {
    expect(resolveBackendProfile({ backendProfiles: initialBackendProfiles() }, DEFAULT_CODEX_PROFILE, 'codex-appserver')).toBeUndefined();
  });

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

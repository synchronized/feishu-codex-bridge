import { describe, expect, it } from 'vitest';
import { shouldAdoptProjectProfile } from '../src/bot/handle-message';

describe('旧会话采用项目 Profile', () => {
  const projectRuntime = { backend: 'codex-appserver', profile: 'personal' };

  it('没有任何 Profile 快照的同后端旧会话应采用项目 Profile', () => {
    expect(shouldAdoptProjectProfile({ backend: 'codex-appserver' }, projectRuntime)).toBe(true);
  });

  it('已有 Profile 或环境快照的会话保持原运行环境', () => {
    expect(shouldAdoptProjectProfile({
      backend: 'codex-appserver',
      backendProfile: 'codex/默认',
    }, projectRuntime)).toBe(false);
    expect(shouldAdoptProjectProfile({
      backend: 'codex-appserver',
      backendEnv: { CODEX_HOME: 'C:/Users/sunday/.codex' },
    }, projectRuntime)).toBe(false);
  });

  it('后端不同或项目没有命名 Profile 时不迁移', () => {
    expect(shouldAdoptProjectProfile(
      { backend: 'claude-agent' },
      projectRuntime,
    )).toBe(false);
    expect(shouldAdoptProjectProfile(
      { backend: 'codex-appserver' },
      { backend: 'codex-appserver' },
    )).toBe(false);
  });
});

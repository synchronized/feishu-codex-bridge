import { describe, expect, it } from 'vitest';
import { initialBackendProfiles } from '../src/agent/profiles';
import { migrateProjectRecordsToBackendProfiles, type Project } from '../src/project/registry';

function project(name: string, patch: Partial<Project> = {}): Project {
  return { name, chatId: `oc_${name}`, cwd: `/work/${name}`, blank: false, createdAt: 1, ...patch };
}

describe('旧项目迁移为 profile-only', () => {
  const cfg = {
    backendProfiles: {
      ...initialBackendProfiles(),
      personal: { backend: 'codex-appserver', env: { CODEX_HOME: '/home/u/.codex-personal' } },
    },
  };

  it('backend-only 项目映射到对应默认 profile 并移除 backend', () => {
    const result = migrateProjectRecordsToBackendProfiles(
      [project('codex', { backend: 'codex-appserver' }), project('claude', { backend: 'claude-agent' })],
      cfg,
    );
    expect(result.changed).toBe(2);
    expect(result.projects).toEqual([
      expect.objectContaining({ name: 'codex', backendProfile: 'codex/默认' }),
      expect.objectContaining({ name: 'claude', backendProfile: 'claude/默认' }),
    ]);
    expect(result.projects.every((p) => !Object.hasOwn(p, 'backend'))).toBe(true);
  });

  it('已有命名 profile 保留，冗余 backend 被移除', () => {
    const result = migrateProjectRecordsToBackendProfiles(
      [project('personal', { backend: 'codex-appserver', backendProfile: 'personal' })],
      cfg,
    );
    expect(result.projects[0]?.backendProfile).toBe('personal');
    expect(Object.hasOwn(result.projects[0]!, 'backend')).toBe(false);
  });

  it('未知 profile/后端保持原样，避免破坏手工配置', () => {
    const original = project('unknown', { backend: 'custom', backendProfile: 'missing' });
    const result = migrateProjectRecordsToBackendProfiles([original], cfg);
    expect(result).toEqual({ projects: [original], changed: 0 });
  });
});

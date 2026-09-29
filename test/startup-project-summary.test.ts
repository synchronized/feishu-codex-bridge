import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/config/schema';
import type { Project } from '../src/project/registry';
import {
  formatStartupProjectSummary,
  summarizeStartupProject,
} from '../src/project/startup-summary';

function project(patch: Partial<Project> = {}): Project {
  return {
    name: 'demo',
    chatId: 'oc_demo',
    cwd: 'C:/work/demo',
    blank: false,
    createdAt: 1,
    ...patch,
  };
}

describe('启动项目摘要', () => {
  it('展示命名 profile 的 CODEX_HOME 和有效运行参数', () => {
    const cfg: Pick<AppConfig, 'backendProfiles'> = {
      backendProfiles: {
        personal: {
          backend: 'codex-appserver',
          env: {
            CODEX_HOME: 'C:/Users/sunday/.codex-sunday',
            HTTPS_PROXY: 'http://user:secret@127.0.0.1:7890',
          },
        },
      },
    };

    const summary = summarizeStartupProject(
      project({
        backendProfile: 'personal',
        mode: 'write',
        guestMode: 'qa',
        network: true,
        kind: 'single',
        noMention: false,
        autoCompact: false,
        defaultModel: 'gpt-test',
        defaultEffort: 'high',
      }),
      cfg,
      'C:/Users/sunday/.codex',
    );

    expect(summary).toMatchObject({
      project: 'demo',
      backend: 'codex-appserver',
      profile: 'personal',
      codexHome: 'C:/Users/sunday/.codex-sunday',
      mode: 'write',
      guestMode: 'qa',
      network: true,
      kind: 'single',
      noMention: false,
      autoCompact: false,
      model: 'gpt-test',
      effort: 'high',
    });
    const text = formatStartupProjectSummary(summary);
    expect(text).toBe([
      'demo',
      '    后端：backend=codex-appserver | profile=personal',
      '    环境：CODEX_HOME=C:/Users/sunday/.codex-sunday',
      '    权限：mode=write | guestMode=qa | network=on',
      '    会话：kind=single | noMention=off | autoCompact=off',
      '    模型：model=gpt-test | effort=high',
      '    路径：cwd=C:/work/demo',
    ].join('\n'));
    expect(text).not.toContain('secret');
    expect(text).not.toContain('HTTPS_PROXY');
  });

  it('未选择 profile 时展示 default，并继承 daemon 的 CODEX_HOME', () => {
    const summary = summarizeStartupProject(project(), {}, 'C:/Users/sunday/.codex');

    expect(summary.profile).toBe('default');
    expect(summary.codexHome).toBe('C:/Users/sunday/.codex');
    expect(summary.mode).toBe('full');
    expect(summary.guestMode).toBe('full');
    expect(summary.network).toBe(true);
    expect(summary.kind).toBe('multi');
    expect(summary.noMention).toBe(true);
    expect(summary.autoCompact).toBe(true);
    expect(summary.model).toBe('后端默认');
    expect(summary.effort).toBe('模型默认');
  });

  it('没有任何 CODEX_HOME 时明确显示 Codex 默认目录', () => {
    const summary = summarizeStartupProject(project(), {}, '');
    expect(summary.codexHome).toBe('Codex 默认目录');
  });
});

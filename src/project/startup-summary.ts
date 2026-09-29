import { DEFAULT_BACKEND_ID } from '../agent/types';
import { backendForProfile } from '../agent/profiles';
import type { AppConfig } from '../config/schema';
import {
  defaultNoMention,
  effectiveGuestMode,
  effectiveMode,
  type Project,
} from './registry';

/** 启动时输出的项目运行摘要。只包含可公开的运行参数，不展开代理等环境变量。 */
export interface StartupProjectSummary {
  project: string;
  backend: string;
  profile: string;
  codexHome: string;
  mode: string;
  guestMode: string;
  network: boolean;
  kind: string;
  noMention: boolean;
  autoCompact: boolean;
  model: string;
  effort: string;
  cwd: string;
}

/**
 * 计算项目在新会话中的有效启动参数。命名 profile 仅展示 CODEX_HOME；其它环境变量
 * 可能含代理认证信息，因此不得进入控制台或日志。
 */
export function summarizeStartupProject(
  project: Project,
  cfg: Pick<AppConfig, 'backendProfiles'>,
  inheritedCodexHome = process.env.CODEX_HOME,
): StartupProjectSummary {
  const profileName = project.backendProfile?.trim();
  const profile = profileName ? cfg.backendProfiles?.[profileName] : undefined;
  const mode = effectiveMode(project);

  return {
    project: project.name,
    backend: backendForProfile(cfg, profileName, project.backend ?? DEFAULT_BACKEND_ID),
    profile: profileName || 'default',
    codexHome: profile?.env?.CODEX_HOME || inheritedCodexHome || 'Codex 默认目录',
    mode,
    guestMode: effectiveGuestMode(project),
    network: mode === 'full' || (project.network ?? false),
    kind: project.kind ?? 'multi',
    noMention: project.noMention ?? defaultNoMention(project),
    autoCompact: project.autoCompact ?? true,
    model: project.defaultModel ?? '后端默认',
    effort: project.defaultEffort ?? '模型默认',
    cwd: project.cwd,
  };
}

/** 人类可读的多行启动摘要；结构化日志仍由调用方单独记录，便于检索。 */
export function formatStartupProjectSummary(summary: StartupProjectSummary): string {
  return [
    summary.project,
    `    后端：backend=${summary.backend} | profile=${summary.profile}`,
    `    环境：CODEX_HOME=${summary.codexHome}`,
    `    权限：mode=${summary.mode} | guestMode=${summary.guestMode} | network=${summary.network ? 'on' : 'off'}`,
    `    会话：kind=${summary.kind} | noMention=${summary.noMention ? 'on' : 'off'} | autoCompact=${summary.autoCompact ? 'on' : 'off'}`,
    `    模型：model=${summary.model} | effort=${summary.effort}`,
    `    路径：cwd=${summary.cwd}`,
  ].join('\n');
}

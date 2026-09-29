import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import type { AppConfig, BackendProfileConfig } from '../config/schema';
import type { BackendEnvironment } from './types';

/** config.json 可明文保存的后端环境变量。刻意不接受任何 token / API Key。 */
export const BACKEND_PROFILE_ENV_KEYS = [
  'CODEX_HOME',
  'CODEX_BIN',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
] as const;

const ALLOWED = new Set<string>(BACKEND_PROFILE_ENV_KEYS);

function expandHome(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return resolve(homedir(), value.slice(2));
  return value;
}

/** 校验并解析一个命名 profile。返回新对象，调用方可安全传给子进程。 */
export function resolveBackendProfile(
  cfg: Pick<AppConfig, 'backendProfiles'>,
  name: string | undefined,
  backend: string,
): BackendEnvironment | undefined {
  if (!name) return undefined;
  const cleanName = name.trim();
  if (!cleanName) return undefined;
  const profile: BackendProfileConfig | undefined = cfg.backendProfiles?.[cleanName];
  if (!profile) throw new Error(`后端配置「${cleanName}」不存在（请检查 config.json 的 backendProfiles）`);
  if (profile.backend !== backend) {
    throw new Error(`后端配置「${cleanName}」属于 ${profile.backend}，不能用于 ${backend}`);
  }

  const out: BackendEnvironment = {};
  for (const [rawKey, rawValue] of Object.entries(profile.env ?? {})) {
    const key = rawKey.toUpperCase();
    if (!ALLOWED.has(key)) {
      throw new Error(`后端配置「${cleanName}」不允许环境变量 ${rawKey}（仅允许：${BACKEND_PROFILE_ENV_KEYS.join('、')}）`);
    }
    if (typeof rawValue !== 'string' || !rawValue.trim()) {
      throw new Error(`后端配置「${cleanName}」的 ${rawKey} 必须是非空字符串`);
    }
    const value = key === 'CODEX_HOME' || key === 'CODEX_BIN' ? expandHome(rawValue.trim()) : rawValue.trim();
    if ((key === 'CODEX_HOME' || key === 'CODEX_BIN') && !isAbsolute(value)) {
      throw new Error(`后端配置「${cleanName}」的 ${key} 必须是绝对路径或以 ~ 开头`);
    }
    out[key] = value;
  }
  return out;
}

/** 稳定序列化，用作 Codex utility / 预热池的隔离键。 */
export function backendEnvironmentKey(env?: BackendEnvironment): string {
  if (!env || Object.keys(env).length === 0) return '';
  return JSON.stringify(Object.entries(env).sort(([a], [b]) => a.localeCompare(b)));
}

import { describe, expect, it } from 'vitest';
import {
  buildNewProjectDoneCard,
  buildNewProjectFormCard,
  buildProjectSettingsCard,
  type BackendProbeRow,
} from '../src/card/dm-cards';
import {
  backendProfileOptionsFor,
  probeBackends,
  safeBackendProfileName,
  validateBackendSwitch,
} from '../src/bot/handle-message';
import { createBackend } from '../src/agent';
import type { BackendProbe } from '../src/agent/types';
import type { AppConfig } from '../src/config/schema';


describe('probeBackends（并行 doctor + 单个超时兜底）', () => {
  const fast = (id: string, probe: BackendProbe) => ({
    id,
    displayName: id.toUpperCase(),
    supportedModes: undefined,
    doctor: async () => probe,
  });

  it('并行探测：每后端各成一行，带 id/displayName/supportedModes/probe，且 doctor 走 force（绕过缓存）', async () => {
    let seenForce: boolean | undefined;
    const be = {
      id: 'a',
      displayName: 'A',
      supportedModes: ['full'] as const,
      doctor: async (o?: { force?: boolean }) => {
        seenForce = o?.force;
        return { ok: true, version: '1.0' } satisfies BackendProbe;
      },
    };
    const rows = await probeBackends([be], 1000);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'a', name: 'A', probe: { ok: true, version: '1.0' } });
    expect(rows[0]!.supportedModes).toEqual(['full']);
    expect(seenForce).toBe(true);
  });

  it('单个后端卡死 → 超时兜底归一成 probe undefined（按不可用渲染），不拖垮同批其他后端', async () => {
    const hang = { id: 'h', displayName: 'H', supportedModes: undefined, doctor: () => new Promise<BackendProbe>(() => {}) };
    const rows = await probeBackends([hang, fast('ok', { ok: true, version: '2' })], 50);
    expect(rows[0]!.probe).toBeUndefined();
    expect(rows[1]!.probe).toEqual({ ok: true, version: '2' });
  });

  it('doctor 抛错同样归一成 probe undefined，绝不放行', async () => {
    const boom = {
      id: 'b',
      displayName: 'B',
      supportedModes: undefined,
      doctor: async (): Promise<BackendProbe> => {
        throw new Error('spawn ENOENT');
      },
    };
    const rows = await probeBackends([boom], 1000);
    expect(rows[0]!.probe).toBeUndefined();
  });
});

describe('buildProjectSettingsCard 的 🧠 后端区块', () => {
  const base = { name: 'P', cwd: '/x', kind: 'multi' as const, origin: 'created' as const };

  it('显示当前后端与 profile，并说明 profile 是路由入口', () => {
    const json = JSON.stringify(buildProjectSettingsCard(base));
    expect(json).toContain('🧠 后端');
    expect(json).toContain('codex-appserver'); // 缺省回退到默认 id
    expect(json).toContain('Profile 同时决定后端与运行环境');
    // 去切换：后端区块不再有「打开后端选择卡」的按钮（旧 dm.proj.backend 入口已删）
    expect(json).not.toContain('dm.proj.backend');
  });

  it('调用方传入展示名时优先用展示名', () => {
    const json = JSON.stringify(
      buildProjectSettingsCard({ ...base, backend: 'codex-appserver' }, 'Codex (app-server)'),
    );
    expect(json).toContain('Codex (app-server)');
  });

  it('notice 提示行渲染在卡顶（切换成功后的「✅ 已切到 xxx · 新话题生效」留痕）', () => {
    const card = buildProjectSettingsCard(base, 'Codex (app-server)', '✅ 已切到 **Codex (app-server)** · 新话题生效');
    const first = JSON.stringify((card.body as { elements: unknown[] }).elements[0]);
    expect(first).toContain('已切到');
    expect(first).toContain('新话题生效');
  });
});

describe('buildNewProjectFormCard 的后端 Profile 选择', () => {
  it('未传 profiles → 不渲染 Profile 下拉', () => {
    const json = JSON.stringify(buildNewProjectFormCard({}));
    expect(json).not.toContain('select_static');
    expect(json).not.toContain('backendProfile');
  });

  it('渲染单一 backendProfile 下拉，并预选第一个默认 Profile', () => {
    const profiles = [
      { label: 'Codex / codex/默认', value: 'profile:codex/默认' },
      { label: 'Codex / personal · C:/Users/u/.codex-personal', value: 'profile:personal' },
      { label: 'Claude / claude/默认', value: 'profile:claude/默认' },
    ];
    const json = JSON.stringify(buildNewProjectFormCard({ profiles }));
    expect(json).toContain('"name":"backendProfile"');
    expect(json).not.toContain('"name":"backend"');
    expect(json).toContain('profile:personal');
    expect(json).toContain('profile:claude/默认');
    expect(json).toContain('"initial_option":"profile:codex/默认"');
  });

  it('完成卡显示解析后的后端与 Profile', () => {
    const done = JSON.stringify(
      buildNewProjectDoneCard(
        { name: 'P', cwd: '/x', kind: 'multi', origin: 'created', backendProfile: 'personal' } as never,
        'Codex',
      ),
    );
    expect(done).toContain('🧠');
    expect(done).toContain('Codex');
    expect(done).toContain('personal');
  });
});

describe('新建项目 backend profile 选项与提交校验', () => {
  const cfg: Pick<AppConfig, 'backendProfiles'> = {
    backendProfiles: {
      'codex/默认': { backend: 'codex-appserver', env: {} },
      'claude/默认': { backend: 'claude-agent', env: {} },
      personal: {
        backend: 'codex-appserver',
        env: { CODEX_HOME: 'C:/Users/u/.codex-personal', HTTPS_PROXY: 'http://user:secret@proxy' },
      },
    },
  };

  it('选项只展示 profile、后端和 CODEX_HOME，不泄露其它环境变量', () => {
    const json = JSON.stringify(backendProfileOptionsFor(cfg));
    expect(json).toContain('profile:personal');
    expect(json).toContain('C:/Users/u/.codex-personal');
    expect(json).not.toContain('HTTPS_PROXY');
    expect(json).not.toContain('secret');
  });

  it('命名项返回并校验真实 profile', () => {
    expect(safeBackendProfileName({ backendProfile: 'profile:personal' }, cfg)).toBe('personal');
    expect(safeBackendProfileName({ backendProfile: 'profile:claude/默认' }, cfg)).toBe('claude/默认');
  });

  it('拒绝未选、伪造或缺失的 profile', () => {
    expect(() => safeBackendProfileName({}, cfg)).toThrow(/请选择/);
    expect(() => safeBackendProfileName({ backendProfile: 'personal' }, cfg)).toThrow(/无效/);
    expect(() => safeBackendProfileName({ backendProfile: 'profile:missing' }, cfg)).toThrow(/不存在/);
  });
});

describe('validateBackendSwitch（切换校验的纯函数）', () => {
  const ok: BackendProbe = { ok: true, version: '1.0' };
  // 纯函数：registered/supportedModes 都是入参，不读真注册表。codex-only 现实下真注册表
  // 只有 codex-appserver；这里额外塞一个泛化 'full-only' 占位 id 以保住「仅支持 full」分支的覆盖
  // （不引用任何已删后端）。
  const registered = ['codex-appserver', 'full-only'];

  it('注册表里没有的 id 拒绝，并列出可用后端', () => {
    const reason = validateBackendSwitch({ target: 'no-such', registered, project: {}, probe: ok });
    expect(reason).toContain('未知后端');
    expect(reason).toContain('codex-appserver');
  });

  it('doctor 探测不通过拒绝，并把 hint（装法/登录提示）带给用户', () => {
    const reason = validateBackendSwitch({
      target: 'codex-appserver',
      registered,
      project: {},
      probe: { ok: false, version: null, hint: '未找到 codex CLI' },
    });
    expect(reason).toContain('不可用');
    expect(reason).toContain('未找到 codex CLI');
  });

  it('探测没跑成（probe undefined）按不可用拒绝，绝不放行', () => {
    expect(validateBackendSwitch({ target: 'codex-appserver', registered, project: {} })).toContain('不可用');
  });

  it('目标后端仅支持 full 时：项目任一档不是 full 都拒绝并说明（含 guestMode 分档）', () => {
    const supportedModes = ['full'] as const;
    // 管理员档非 full
    expect(
      validateBackendSwitch({ target: 'full-only', registered, project: { mode: 'qa' }, supportedModes, probe: ok }),
    ).toContain('仅支持');
    // 管理员档 full 但普通用户档 qa —— guest 档也必须被支持
    const reason = validateBackendSwitch({
      target: 'full-only',
      registered,
      project: { mode: 'full', guestMode: 'qa' },
      supportedModes,
      probe: ok,
    });
    expect(reason).toContain('完全访问');
    expect(reason).toContain('🔐 权限');
  });

  it('全过返回 null：注册 + 探活 + 档位支持（缺省档 = full 视为 full）', () => {
    expect(
      validateBackendSwitch({
        target: 'full-only',
        registered,
        project: {}, // 旧数据缺省 → effectiveMode 'full'
        supportedModes: ['full'],
        probe: ok,
      }),
    ).toBeNull();
  });

  it('supportedModes 未声明（codex）⇒ 任意档位放行', () => {
    expect(
      validateBackendSwitch({
        target: 'codex-appserver',
        registered,
        project: { mode: 'qa', guestMode: 'write' },
        probe: ok,
      }),
    ).toBeNull();
  });

  it('codex-appserver 后端实例 supportedModes 未声明（全档）—— 切换 UI 提前拦截与硬守卫同源', () => {
    expect(createBackend('codex-appserver').supportedModes).toBeUndefined();
  });
});

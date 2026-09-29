import { createInterface } from 'node:readline/promises';
import { loadConfig, saveConfig, buildEncryptedAccountConfig } from '../config/store';
import { ensureDefaultBackendProfiles } from '../agent/profiles';
import { setSecret } from '../config/keystore';
import { isComplete, secretKeyForApp, type AppConfig } from '../config/schema';
import { resolveAppSecret } from '../config/secret-resolver';
import { runRegistrationWizard } from './wizard';
import { validateAppCredentials } from '../utils/feishu-auth';
import {
  diagnoseEventSubscription,
  pollEventSubscription,
  summarizeEventDiagnosis,
  REQUIRED_EVENTS,
  type EventDiagnosis,
} from '../utils/event-diagnosis';
import { buildScopeGrantUrl, buildEventConfigUrl, labelScope } from '../config/scopes';
import { detectAgents } from '../agent';
import { openUrl } from '../utils/open-url';
import { log } from '../core/logger';
import { useBotDir } from '../config/paths';
import { ensureRegistry, addBot, currentBot, findBot, loadBots, uniqueName, type BotEntry } from '../config/bots';

export interface OnboardResult {
  cfg: AppConfig;
  secret: string;
  /** required scopes still ungranted at validation time (undefined = couldn't check). */
  missingScopes?: string[];
  /** 事件订阅诊断（版本信息 API，三态 + unchecked 降级；undefined = 没跑诊断）。 */
  events?: EventDiagnosis;
}

/**
 * Verify the agent backend (codex) is runnable。探 codex agent（detectAgents），
 * 可用即放行；不可用时**仍只告警不阻塞**（与缺权限策略一致——零交互纯告知，因为
 * 要同时支持人 + codex 安装/升级），让用户装好 codex 后再用。
 *
 * 返回 true 始终放行（不再拒启）。布尔仍保留给调用方签名（早期返回点用得到）。
 */
export async function ensureAnyAgent(): Promise<boolean> {
  const agents = await detectAgents().catch(() => []);
  const anyAvailable = agents.some((a) => a.backends.some((b) => b.available));
  if (anyAvailable) return true;
  // 都无：告警但不阻塞。
  const rule = '-'.repeat(64);
  console.error(`\n${rule}`);
  console.error('⚠️  未检测到可用的 codex 后端——仍会启动，但群里发消息会报后端不可用。');
  console.error('   装上 codex：npm i -g @openai/codex，然后 codex login');
  console.error('   装好后用 `feishu-codex-bridge doctor` 自检。');
  console.error(`${rule}\n`);
  return true;
}

/** @deprecated 旧名，保留兼容 `bot init` 调用点；语义已是 ensureAnyAgent（任一 agent 可用即放行，都无也不阻塞）。 */
export const ensureCodex = ensureAnyAgent;

/**
 * Bring a bot to a runnable state and return its config + secret.
 *
 * - With `opts.bot` (a name or appId), resolves THAT specific bot — used by
 *   `run --bot <name>` and the multi-bot supervisor's children. A missing
 *   selector is an error (never the create-wizard, even with `allowCreate`).
 * - Without a selector, resolves the registry's `current` bot (migrating a
 *   legacy flat install on first run). With `allowCreate`, a missing current
 *   bot triggers the scan-QR wizard (named `default`) — this is what makes the
 *   implicit `run`/`start` "init if not initialized". Without it (or off a TTY)
 *   a missing bot is an error.
 * - Validates credentials; on missing scopes it prints a non-blocking notice
 *   (which features are gated, where to grant, that 诊断 can grant later) and
 *   auto-opens the grant page on a TTY — but NEVER blocks startup or reads
 *   stdin, so a human at a terminal and codex/automation behave identically.
 *
 * Returns null (after printing why) on any failure.
 */
export async function ensureOnboarded(
  opts: { allowCreate?: boolean; bot?: string } = {},
): Promise<OnboardResult | null> {
  // 任一 agent 可用即放行；都无也只告警不阻塞（Web 引导下载）—— 永远 true。
  await ensureAnyAgent();

  const reg = await ensureRegistry();
  const entry = opts.bot ? findBot(reg, opts.bot) : currentBot(reg);
  if (!entry) {
    if (opts.bot) {
      console.error(
        `✗ 找不到机器人「${opts.bot}」。用 \`feishu-codex-bridge bot list\` 查看已注册的机器人。`,
      );
      return null;
    }
    if (!opts.allowCreate) {
      console.error('✗ 尚未配置任何飞书机器人。请先运行 `feishu-codex-bridge bot init`（或前台 `run`）扫码创建。');
      return null;
    }
    return registerNewBot('default');
  }

  useBotDir(entry.appId);
  const cfg = await loadConfig();
  if (!isComplete(cfg)) {
    console.error(`✗ 当前机器人「${entry.name}」(${entry.appId}) 配置缺失或损坏。可 \`bot rm ${entry.name}\` 后重新 \`bot init\`。`);
    return null;
  }
  if (ensureDefaultBackendProfiles(cfg)) await saveConfig(cfg);
  const r = await validateAndReport(cfg);
  if (r === null) return null;
  return { cfg, secret: r.secret, missingScopes: r.missingScopes, events: r.events };
}

/**
 * Run the scan-QR wizard to create a brand-new feishu app, persist it (keystore
 * + per-bot config dir + registry), validate, and surface the scope link.
 * `desiredName` defaults to the bot's display name (slugified); pass `'default'`
 * for the implicit first-run from `run`/`start`. Returns null on failure.
 */
export async function registerNewBot(desiredName?: string): Promise<OnboardResult | null> {
  // The scan needs a human at a terminal. A headless context (the launchd
  // service, CI) must never enter the wizard — `registerApp` would print a QR
  // to a log nobody reads and poll forever. Fail fast with a pointer instead.
  if (!process.stdout.isTTY) {
    console.error(
      '✗ 当前不是交互式终端，无法扫码创建飞书应用。\n' +
        '  请在终端前台运行 `feishu-codex-bridge bot init`（或 `run` / `start`）扫码 onboarding。',
    );
    return null;
  }

  const wizardCfg = await runRegistrationWizard();
  const app = wizardCfg.accounts.app;
  if (typeof app.secret !== 'string') {
    console.error('✗ 向导未返回明文密钥，无法继续。');
    return null;
  }

  // Validate with the plaintext secret before persisting — bad creds shouldn't
  // leave a half-registered bot behind.
  const v = await validateAppCredentials(app.id, app.secret, app.tenant);
  if (!v.ok) {
    console.error(`✗ 应用凭据校验失败：${v.reason}`);
    return null;
  }

  await setSecret(secretKeyForApp(app.id), app.secret);
  useBotDir(app.id); // from here all per-bot files land under bots/<appId>/
  const cfg = await buildEncryptedAccountConfig(app.id, app.tenant, wizardCfg.preferences);
  await saveConfig(cfg);

  const reg = await loadBots();
  const name = uniqueName(reg, desiredName ?? v.botName ?? 'default');
  await addBot({ name, appId: app.id, tenant: app.tenant, botName: v.botName, createdAt: Date.now() });

  console.log(`✓ 已创建机器人「${name}」  bot: ${v.botName ?? '-'}  appId: ${app.id}`);
  log.info('onboard', 'bot-created', { name, appId: app.id, bot: v.botName ?? null });
  noticeMissingScopes(cfg, v.missingScopes);
  const events = await diagnoseEventSubscription(app.id, app.secret, app.tenant);
  noticeEventDiagnosis(cfg, events);

  const secret = await resolveAppSecret(cfg);
  return { cfg, secret, missingScopes: v.missingScopes, events };
}

/** Resolve secret, validate credentials, report result; on missing scopes,
 *  print the non-blocking notice (see {@link noticeMissingScopes}); then run the
 *  event-subscription diagnosis and report it too (same notice-only policy). */
async function validateAndReport(
  cfg: AppConfig,
): Promise<{ secret: string; missingScopes?: string[]; events: EventDiagnosis } | null> {
  const secret = await resolveAppSecret(cfg);
  const v = await validateAppCredentials(cfg.accounts.app.id, secret, cfg.accounts.app.tenant);
  if (!v.ok) {
    console.error(`✗ 应用凭据校验失败：${v.reason}`);
    console.error('  应用可能被禁用/未发布；可重跑 `feishu-codex-bridge bot init` 重新扫码。');
    return null;
  }
  console.log(`✓ 凭据校验通过  bot: ${v.botName ?? '-'}  appId: ${cfg.accounts.app.id}`);
  log.info('onboard', 'credentials-ok', { appId: cfg.accounts.app.id, bot: v.botName ?? null });
  noticeMissingScopes(cfg, v.missingScopes);
  const events = await diagnoseEventSubscription(cfg.accounts.app.id, secret, cfg.accounts.app.tenant);
  noticeEventDiagnosis(cfg, events);
  return { secret, missingScopes: v.missingScopes, events };
}

/**
 * Gate used by `start` before daemonizing — the one truly-manual step. Missing
 * scopes are deliberately NOT handled here: {@link validateAndReport} already
 * printed the non-blocking notice during onboarding, and we never block daemon
 * install on scopes (some tenants can't grant on demand; 诊断 grants later). What
 * remains is events & callbacks, which have NO write API and no deep-preselect —
 * so we print exact click-paths and trust the operator's Enter. The subscription
 * *state* is readable though (version-info API): when the diagnosis already says
 * ok we skip the wall of text and just confirm. No-op off a TTY (scripted
 * re-install / codex). Always returns true on a TTY now; the boolean is kept for
 * the signature `start` relies on.
 */
export async function confirmReadyForDaemon(result: OnboardResult): Promise<boolean> {
  if (!process.stdin.isTTY) return true;
  const { app } = result.cfg.accounts;

  // 诊断已确认事件订阅生效 → 不再甩整面墙的手动步骤，只留一条无法检测的回调提醒。
  if (result.events?.state === 'ok') {
    console.log(`\n✅ 事件订阅检测：${summarizeEventDiagnosis(result.events)}`);
    console.log('   （卡片按钮若无反应，去后台「回调配置」标签检查 card.action.trigger——回调没有查询接口，无法自动检测。）');
    await promptEnter('\n按 Enter 安装后台服务（Ctrl+C 取消）… ');
    return true;
  }

  // Events AND callbacks have no *write* API and no deep-preselect — only scopes
  // have those. So this stays a manual step: print exact click-paths and trust
  // the operator's Enter. (The diagnosis above tells us subscription state via
  // the read-only version-info API; callbacks aren't in it, so still spell out:)
  // The classic trap: card.action.trigger is a *callback* (回调配置 tab), NOT an
  // event — searching for it under 「添加事件」 finds nothing. Spell out the tabs.
  const eventUrl = buildEventConfigUrl(app.id, app.tenant);
  const opened = openUrl(eventUrl);
  if (result.events) console.log(`\n事件订阅检测：${summarizeEventDiagnosis(result.events)}`);
  console.log('\n最后这几步飞书没有写入 API/深链可代办（只能查、不能配），需你手动点：\n');
  console.log(`  【1】事件与回调（${opened ? '已自动打开' : '打开下面链接'}）：${eventUrl}`);
  console.log('       这页顶部有三个标签：「事件配置」「回调配置」「加密策略」。');
  console.log('       • 切到「事件配置」标签 → 「订阅方式」改「长连接」→ 点「添加事件」搜并勾选：');
  console.log('           im.message.receive_v1（接收消息）、application.bot.menu_v6（机器人菜单）');
  console.log('       • （可选）想要「在飞书文档评论里 @机器人就自动回复」，再加这一个事件：');
  console.log('           drive.notice.comment_add_v1（云文档新增评论）');
  console.log('           它依赖「文档评论」权限（docs:document.comment:read / :create，授权链接已预勾选）；不加则该功能静默关闭。');
  console.log('       • （可选）想要「把我加进已有群就能绑定成项目」，再加这两个事件：');
  console.log('           im.chat.member.bot.added_v1（机器人被加入群 → 私聊推送绑定卡）');
  console.log('           im.chat.member.bot.deleted_v1（机器人被移出群 → 自动解绑项目）');
  console.log('           它们依赖「群信息/群成员」权限（im:chat:readonly / im:chat.members:write_only，已预勾选）；不加则该功能静默关闭。');
  console.log('       • （可选）想要「点表情驱动：终态卡 👍 续轮 / 运行卡 OK 终止」，再加这一个事件：');
  console.log('           im.message.reaction.created_v1（新增消息表情回复）');
  console.log('           它依赖「表情回复读取」权限（im:message.reactions:read，已预勾选）；不加则该功能静默关闭。');
  console.log('       • 切到「回调配置」标签 → 「订阅方式」改「长连接」→ 点「添加回调」勾选：');
  console.log('           card.action.trigger（卡片回传交互）');
  console.log('           ⚠️ 它是「回调」不是「事件」——在上面「添加事件」里搜不到，必须切到「回调配置」这个标签。');
  console.log('  【2】左侧栏「应用发布 → 版本管理与发布」→ 创建一个版本并发布。');
  console.log('\n  （保存「长连接」订阅方式要求长连接在线；若提示连接未建立，');
  console.log('    先开另一个终端跑 `feishu-codex-bridge run` 把桥连上，再回这页保存。）');
  await promptEnter('\n以上都点完后按 Enter 安装后台服务（Ctrl+C 取消）… ');
  return true;
}

async function promptEnter(message: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(message);
  } finally {
    rl.close();
  }
}

/**
 * 缺权限时只「告知」，绝不阻塞启动、绝不读 stdin —— 人和 codex/自动化行为一致。
 * 打印：缺哪些功能、去哪申请、之后可从私聊「🩺 诊断」补。TTY 下顺手自动开一次浏览器
 * 授权页（{@link openUrl} 自身在非 TTY 直接 no-op，所以 codex / supervisor 子进程 /
 * daemon 不会弹浏览器、只打印链接）。missingScopes 三态：undefined=没查成、空=已齐全。
 */
function noticeMissingScopes(cfg: AppConfig, missingScopes: string[] | undefined): void {
  if (missingScopes === undefined) {
    log.info('onboard', 'scope-check-skipped', { reason: 'scope list unavailable' });
    return;
  }
  if (missingScopes.length === 0) return;
  const url = buildScopeGrantUrl(cfg.accounts.app.id, cfg.accounts.app.tenant);
  const opened = openUrl(url); // TTY → 开浏览器并返回 true；非 TTY → 不开、返回 false
  // 纯 ASCII 边框：`-` 在 UTF-8 与 GBK 下编码相同，老式 cmd.exe（CP936）也不会乱码。
  const rule = '-'.repeat(64);
  console.log(`\n${rule}`);
  console.log(`⚠️  缺 ${missingScopes.length} 项权限（不影响启动，但这些功能开通前用不了）：`);
  for (const s of missingScopes) console.log(`   · ${labelScope(s)}`);
  console.log(
    opened
      ? '🌐 已自动打开浏览器授权页（即时生效、无需重启）：'
      : '   去这里申请（勾选 → 确认，即时生效、无需重启）：',
  );
  console.log(`   👉 ${url}`);
  console.log('   不想现在弄也行：之后私聊机器人 →「🩺 诊断」可随时再申请。');
  console.log(`${rule}\n`);
}

/**
 * 事件订阅诊断结果只「告知」，绝不阻塞启动、绝不读 stdin（同 noticeMissingScopes
 * 的既有策略）。这里**不**自动开浏览器——事件页保存「长连接」要求连接在线，开页
 * 时机交给 {@link announceEventsWhenLive}（run 在 startBridge 之后调）。
 */
function noticeEventDiagnosis(cfg: AppConfig, d: EventDiagnosis): void {
  log.info('onboard', 'event-diagnosis', { state: d.state, ...(d.reason ? { reason: d.reason } : {}), ...(d.missingRequired?.length ? { missingRequired: d.missingRequired } : {}) });
  if (d.state === 'ok') {
    console.log(`✓ 事件订阅检测：${summarizeEventDiagnosis(d)}`);
    if (d.missingOptional?.length) {
      console.log(`  （可选事件未订阅：${d.missingOptional.join('、')} —— 对应功能静默关闭，需要时去后台「事件配置」添加。）`);
    }
    return;
  }
  if (d.state === 'unchecked') {
    // 缺 scope / 网络不通：优雅降级，一行带过，别在每次启动刷屏。
    console.log(`· 事件订阅检测：${summarizeEventDiagnosis(d)}；若 @我 没反应，请照 README 检查「事件与回调」配置。`);
    return;
  }
  // unpublished / missing：@bot 必然没反应，给精确指引（仍不阻塞）。
  const url = buildEventConfigUrl(cfg.accounts.app.id, cfg.accounts.app.tenant);
  const rule = '-'.repeat(64);
  console.log(`\n${rule}`);
  console.log(`⚠️  事件订阅检测：${summarizeEventDiagnosis(d)}`);
  if (d.state === 'unpublished') {
    console.log('   去「事件与回调 → 事件配置」订阅方式选「长连接」、添加事件');
    console.log(`   ${REQUIRED_EVENTS.join('、')}，再到「应用发布」创建版本并发布：`);
  } else {
    console.log('   去「事件与回调 → 事件配置」添加上面缺的事件，再发布一个新版本：');
  }
  console.log(`   👉 ${url}`);
  console.log('   配置生效后我会在这里播报「事件已生效」。');
  console.log(`${rule}\n`);
}

/**
 * run 专用收尾：bridge 已在线（满足事件页保存「长连接」须在线的硬前置）后，若
 * 诊断显示事件未生效（unpublished/missing），自动打开「事件与回调」深链（TTY 才
 * 开浏览器，非 TTY no-op），并轮询版本 API；用户配完 + 发布版本后主动播报
 * 「事件已生效」。ok / unchecked / 没诊断 → no-op。绝不 throw（fire-and-forget）。
 */
export async function announceEventsWhenLive(result: OnboardResult): Promise<void> {
  const d = result.events;
  if (!d || d.state === 'ok' || d.state === 'unchecked') return;
  const { app } = result.cfg.accounts;
  try {
    const url = buildEventConfigUrl(app.id, app.tenant);
    const opened = openUrl(url);
    console.log(
      opened
        ? '🌐 已自动打开「事件与回调」配置页（长连接已在线，可直接保存）；配置好并发布版本后我会播报。'
        : `· 事件配置页：${url}（长连接已在线，可直接保存；配置好并发布版本后我会播报。）`,
    );
    const ok = await pollEventSubscription(app.id, result.secret, app.tenant);
    if (ok) {
      console.log(`\n✅ 事件已生效：${summarizeEventDiagnosis(ok)} —— 现在去群里 @我 即可开工。`);
      log.info('onboard', 'events-live', { appId: app.id, version: ok.version ?? null });
    } else {
      log.info('onboard', 'events-poll-timeout', { appId: app.id });
    }
  } catch (err) {
    log.fail('onboard', err, { phase: 'announce-events' });
  }
}

export type { BotEntry };

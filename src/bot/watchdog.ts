import type { AgentActivity } from '../agent/types';

/** 静默命令（编译、测试等）不应套用模型输出的短期限。 */
export const COMMAND_IDLE_TIMEOUT_MS = 30 * 60_000;
/** MCP、联网搜索等外部工具的最短静默期限。 */
export const TOOL_IDLE_TIMEOUT_MS = 10 * 60_000;
/** 轻量 RPC 探活本身的最长等待。 */
export const WATCHDOG_PROBE_TIMEOUT_MS = 5_000;
/** 探活成功只宽限一次，不能靠健康的 app-server 无限掩盖卡住的 turn。 */
export const WATCHDOG_PROBE_GRACE_MS = 60_000;

export type WatchdogStage = 'probe-start' | 'probe-ok' | 'probe-failed' | 'interrupt' | 'interrupt-failed' | 'force';

export interface WatchdogDiagnostic extends AgentActivity {
  stage: WatchdogStage;
  idleForMs: number;
  thresholdMs: number;
  error?: string;
}

/** 根据可观测运行态选择静默期限；用户配置始终是下限，绝不会被动态策略缩短。 */
export function activityIdleTimeoutMs(baseIdleMs: number, activity: AgentActivity): number {
  if (activity.activeKind === 'command') return Math.max(baseIdleMs, COMMAND_IDLE_TIMEOUT_MS);
  if (activity.activeKind === 'tool') return Math.max(baseIdleMs, TOOL_IDLE_TIMEOUT_MS);
  return baseIdleMs;
}

export interface AdaptiveIdleTimeoutOptions {
  /** 普通模型阶段的静默期限；<= 0 表示关闭。 */
  idleMs: number;
  /** 外部手动终止信号。 */
  stop?: Promise<unknown>;
  /** 后端运行态；缺失时退化为固定静默期限。 */
  activity?: () => AgentActivity;
  /** 软超时后的轻量后端探活。 */
  probe?: () => Promise<void>;
  /** 探活成功后的单次宽限。 */
  probeGraceMs?: number;
  probeTimeoutMs?: number;
  /** 宽限耗尽或探活失败后优雅中断当前 turn。 */
  interrupt?: () => Promise<void>;
  interruptDrainMs?: number;
  /** 确认该轮已超时（开始优雅中断时触发）。 */
  onTimeout: (diagnostic: WatchdogDiagnostic) => void;
  /** 优雅中断后仍未收尾，即将由调用方强制回收。 */
  onForce?: (diagnostic: WatchdogDiagnostic) => void;
  onDiagnostic?: (diagnostic: WatchdogDiagnostic) => void;
}

type ProbeResult = { ok: true } | { ok: false; error: string };

async function probeWithin(probe: () => Promise<void>, timeoutMs: number): Promise<ProbeResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      probe().then(
        (): ProbeResult => ({ ok: true }),
        (err: unknown): ProbeResult => ({ ok: false, error: err instanceof Error ? err.message : String(err) }),
      ),
      new Promise<ProbeResult>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, error: `探活超过 ${timeoutMs}ms` }), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 状态感知的两阶段 watchdog：
 *  1. 按模型/命令/外部工具选择静默期限；
 *  2. 到期后探活，成功只给予一次短宽限；
 *  3. 宽限耗尽或探活失败则优雅 interrupt，并继续排空事件流；
 *  4. interrupt 后仍不收尾才结束本地流，由调用方强制回收进程。
 */
export async function* withAdaptiveIdleTimeout<T>(
  source: AsyncIterable<T>,
  opts: AdaptiveIdleTimeoutOptions,
): AsyncGenerator<T> {
  if ((!opts.idleMs || opts.idleMs <= 0) && !opts.stop) {
    yield* source;
    return;
  }

  const iter = source[Symbol.asyncIterator]();
  const stopRace = opts.stop?.then(() => '__stop__' as const);
  let pendingNext: Promise<IteratorResult<T>> | undefined;
  let probeForActivityAt: number | undefined;
  let graceDeadline = 0;
  let graceForActivityAt: number | undefined;
  let interruptDeadline = 0;
  let fallbackActivityAt = Date.now();

  const snapshot = (): AgentActivity => opts.activity?.() ?? { lastActivityAt: fallbackActivityAt };
  const diagnostic = (stage: WatchdogStage, activity: AgentActivity, thresholdMs: number, error?: string): WatchdogDiagnostic => ({
    ...activity,
    stage,
    idleForMs: Math.max(0, Date.now() - activity.lastActivityAt),
    thresholdMs,
    error,
  });

  while (true) {
    const activity = snapshot();
    const thresholdMs = activityIdleTimeoutMs(opts.idleMs, activity);
    if (graceForActivityAt !== activity.lastActivityAt) {
      graceDeadline = 0;
      graceForActivityAt = undefined;
    }
    const deadline = interruptDeadline || graceDeadline || (activity.lastActivityAt + thresholdMs);
    const waitMs = Math.max(0, deadline - Date.now());
    let timer: ReturnType<typeof setTimeout> | undefined;
    pendingNext ??= iter.next();
    const races: Promise<IteratorResult<T> | '__idle__' | '__stop__'>[] = [pendingNext];
    if (opts.idleMs > 0) {
      races.push(new Promise<'__idle__'>((resolve) => {
        timer = setTimeout(() => resolve('__idle__'), waitMs);
      }));
    }
    if (stopRace) races.push(stopRace);
    const raced = await Promise.race(races);
    if (timer) clearTimeout(timer);
    if (raced === '__stop__') return;
    if (raced !== '__idle__') {
      pendingNext = undefined;
      if (raced.done) return;
      fallbackActivityAt = Date.now();
      yield raced.value;
      continue;
    }

    const current = snapshot();
    const currentThresholdMs = activityIdleTimeoutMs(opts.idleMs, current);
    if (interruptDeadline) {
      const info = diagnostic('force', current, currentThresholdMs);
      opts.onDiagnostic?.(info);
      opts.onForce?.(info);
      return;
    }

    // 定时器与刚到达的原始通知可能同一时刻竞争；活动时钟前进后重新计算，不能误杀。
    if (current.lastActivityAt !== activity.lastActivityAt && Date.now() - current.lastActivityAt < currentThresholdMs) {
      continue;
    }

    if (opts.probe && probeForActivityAt !== current.lastActivityAt) {
      opts.onDiagnostic?.(diagnostic('probe-start', current, currentThresholdMs));
      const result = await probeWithin(opts.probe, opts.probeTimeoutMs ?? WATCHDOG_PROBE_TIMEOUT_MS);
      const afterProbe = snapshot();
      if (afterProbe.lastActivityAt !== current.lastActivityAt) continue;
      probeForActivityAt = current.lastActivityAt;
      if (result.ok) {
        const info = diagnostic('probe-ok', current, currentThresholdMs);
        opts.onDiagnostic?.(info);
        graceForActivityAt = current.lastActivityAt;
        graceDeadline = Date.now() + (opts.probeGraceMs ?? WATCHDOG_PROBE_GRACE_MS);
        continue;
      }
      opts.onDiagnostic?.(diagnostic('probe-failed', current, currentThresholdMs, result.error));
    }

    graceDeadline = 0;
    const info = diagnostic('interrupt', current, currentThresholdMs);
    opts.onDiagnostic?.(info);
    opts.onTimeout(info);
    interruptDeadline = Date.now() + (opts.interruptDrainMs ?? INTERRUPT_DRAIN_TIMEOUT_MS);
    if (opts.interrupt) {
      void opts.interrupt().catch((err: unknown) => {
        opts.onDiagnostic?.(diagnostic(
          'interrupt-failed',
          snapshot(),
          currentThresholdMs,
          `中断请求失败：${err instanceof Error ? err.message : String(err)}`,
        ));
      });
    }
  }
}

/**
 * Wrap an async iterable with a per-event idle timeout and an optional external
 * stop signal. If no event arrives within `idleMs`, calls `onTimeout()` and
 * ends the stream (the caller's onTimeout should abort the underlying turn).
 * If `stop` resolves, the stream ends immediately — ⏹ 终止的**兜底**路径（见
 * {@link createGracefulInterrupt}：0.139+ 的正常路径是发 turn/interrupt 后等
 * 事件流自然 done；只有 turnId 未到手或超时没收尾才用 stop 强停本地循环）。
 * `idleMs <= 0` disables the idle timer.
 *
 * `lastActivity` decouples LIVENESS from RENDERING: the event map drops raw
 * notifications it doesn't surface (e.g. command output deltas), so a long
 * shell command can stream output for minutes while yielding nothing here.
 * When the idle timer fires we check the backend's real activity clock — if it
 * moved within `idleMs`, re-arm for the remainder instead of killing the turn.
 */
export async function* withIdleTimeout<T>(
  source: AsyncIterable<T>,
  idleMs: number,
  onTimeout: () => void,
  stop?: Promise<unknown>,
  lastActivity?: () => number,
): AsyncGenerator<T> {
  if ((!idleMs || idleMs <= 0) && !stop) {
    yield* source;
    return;
  }
  const iter = source[Symbol.asyncIterator]();
  const stopRace = stop?.then(() => '__stop__' as const);
  // Re-arming must keep waiting on the SAME pending next() — an async generator
  // queues a second next() behind the first, so racing a fresh one each lap
  // would silently drop the value the abandoned call eventually resolves with.
  let pendingNext: Promise<IteratorResult<T>> | undefined;
  let timerMs = idleMs;
  while (true) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    pendingNext ??= iter.next();
    const races: Promise<IteratorResult<T> | '__idle__' | '__stop__'>[] = [pendingNext];
    if (idleMs && idleMs > 0) {
      races.push(new Promise<'__idle__'>((res) => {
        timer = setTimeout(() => res('__idle__'), timerMs);
      }));
    }
    if (stopRace) races.push(stopRace);
    const raced = await Promise.race(races);
    if (timer) clearTimeout(timer);
    if (raced === '__idle__') {
      const sinceActivity = lastActivity ? Date.now() - lastActivity() : Infinity;
      if (sinceActivity < idleMs) {
        timerMs = idleMs - sinceActivity; // real activity recently — re-arm for the remainder
        continue;
      }
      onTimeout();
      return;
    }
    if (raced === '__stop__') return;
    pendingNext = undefined;
    timerMs = idleMs;
    const r = raced as IteratorResult<T>;
    if (r.done) return;
    yield r.value;
  }
}

/** ⏹ 优雅中断的兜底窗口：turn/interrupt 发出后等不到事件流自然收尾（codex 旧版
 * 的「stream just hangs」行为 / 进程挂死）就强制结束本地循环、走杀进程恢复锤。
 * 0.139 实测收尾紧跟 interrupt 应答（同 tick 的 turn/completed），5s 是纯保险。 */
export const INTERRUPT_DRAIN_TIMEOUT_MS = 5_000;

/**
 * ⏹ 终止的优雅中断控制器（QW-15）。codex 0.139+ 在 turn/interrupt 后以
 * turn/completed(status:"interrupted") 干净收尾（08b-interrupt-probe 真机实测；
 * event-map 本就把 turn/completed 映射为 done）——所以 interrupt 先发 abort、让
 * 消费循环等事件流**自然结束**，线程与进程留用（同进程同 thread 可继续复用，
 * 下一条消息免 resume 冷启）。两条强停路径（`forced()` 为 true，调用方按旧样
 * 杀进程回收）：① turnId 还没到手（极早期点击，没法定向 interrupt）→ 立即强停；
 * ② abort 发出后 `timeoutMs` 内流没收尾（codex 版本旧 / 挂死）→ 超时强停。
 * `dispose()` 在循环结束后撤掉兜底定时器。幂等：重复点击只 abort 一次。
 */
export function createGracefulInterrupt(opts: {
  /** current turn id（turn_started 事件消费后才有） */
  turnId: () => string | undefined;
  /** send turn/interrupt to the backend（fire-and-forget，错误调用方自吞） */
  abort: (turnId: string) => void;
  /** end the local consume loop NOW（接 withIdleTimeout stop 信号的 resolve） */
  forceStop: () => void;
  /** 兜底窗口，默认 {@link INTERRUPT_DRAIN_TIMEOUT_MS} */
  timeoutMs?: number;
}): {
  /** ⏹ 入口（接 ActiveState.interrupt） */
  interrupt: () => void;
  /** ⏹ 被点过 */
  interrupted: () => boolean;
  /** 走了强停（杀进程恢复锤）而非自然收尾 —— killed 判定的输入 */
  forced: () => boolean;
  /** 事件流收尾后清掉兜底定时器（无论哪条路径结束都要调） */
  dispose: () => void;
} {
  let interrupted = false;
  let forced = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    interrupt: (): void => {
      if (interrupted) return;
      interrupted = true;
      const tid = opts.turnId();
      if (!tid) {
        forced = true;
        opts.forceStop();
        return;
      }
      opts.abort(tid);
      timer = setTimeout(() => {
        forced = true;
        opts.forceStop();
      }, opts.timeoutMs ?? INTERRUPT_DRAIN_TIMEOUT_MS);
    },
    interrupted: (): boolean => interrupted,
    forced: (): boolean => forced,
    dispose: (): void => {
      if (timer) clearTimeout(timer);
    },
  };
}

/** A queued slot request from {@link Semaphore.enqueue} (M-3 排队可见可取消). */
export interface QueuedAcquire {
  /** Resolves with the release fn once a slot is granted — or `null` if the
   * waiter was cancelled while still queued. */
  acquired: Promise<(() => void) | null>;
  /** 1-based position in the wait queue; 0 once granted (or cancelled). */
  position(): number;
  /** Remove the waiter before its slot is granted (排队取消). True if removed
   * (`acquired` resolves `null`, the reservation is gone); false if the slot
   * was already granted / already cancelled — the caller then owns a normal
   * release and must route the cancel to the running turn instead. */
  cancel(): boolean;
}

type Waiter = { grant: () => void; onAdvance?: (pos: number) => void };

/** Minimal FIFO semaphore for the global concurrent-run cap. */
export class Semaphore {
  private active = 0;
  private waiters: Waiter[] = [];
  constructor(private readonly max: number) {}

  /** True if acquire() would grant a slot without queueing. */
  hasFree(): boolean {
    return this.active < this.max;
  }

  async acquire(): Promise<() => void> {
    // acquire() exposes no cancel handle, so `acquired` always grants.
    return (await this.enqueue().acquired) as () => void;
  }

  /**
   * Acquire with queue visibility + cancellation: when the pool is full the
   * returned handle exposes the waiter's live 1-based queue position
   * (`onAdvance` fires on every change) and `cancel()` to leave the queue —
   * the entry ahead-of/behind semantics stay strictly FIFO.
   */
  enqueue(onAdvance?: (pos: number) => void): QueuedAcquire {
    let settle!: (r: (() => void) | null) => void;
    const acquired = new Promise<(() => void) | null>((res) => {
      settle = res;
    });
    let settled = false; // granted or cancelled — guards double-settling
    const grant = (): void => {
      settled = true;
      this.active++;
      let released = false;
      settle(() => {
        if (released) return;
        released = true;
        this.active--;
        const next = this.waiters.shift();
        if (next) {
          next.grant();
          this.notifyAdvance();
        }
      });
    };
    const entry: Waiter = { grant, onAdvance };
    if (this.active < this.max) grant();
    else this.waiters.push(entry);
    return {
      acquired,
      position: (): number => {
        const i = this.waiters.indexOf(entry);
        return i >= 0 ? i + 1 : 0;
      },
      cancel: (): boolean => {
        if (settled) return false;
        const i = this.waiters.indexOf(entry);
        if (i < 0) return false;
        this.waiters.splice(i, 1);
        settled = true;
        settle(null);
        this.notifyAdvance(i);
        return true;
      },
    };
  }

  /** Tell every waiter at/after `fromIndex` its new 1-based position. */
  private notifyAdvance(fromIndex = 0): void {
    for (let i = fromIndex; i < this.waiters.length; i++) this.waiters[i]?.onAdvance?.(i + 1);
  }
}

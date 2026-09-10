import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActivityTracker } from '../src/agent/codex-appserver/backend';
import type { ServerNotification, ThreadItem } from '../src/agent/codex-appserver/protocol';

const notification = (method: string, params: unknown): ServerNotification =>
  ({ method, params }) as ServerNotification;

describe('Codex watchdog 运行态', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('跟踪并行工具的开始、原始活动与完成状态', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const tracker = createActivityTracker();

    vi.setSystemTime(2_000);
    tracker.observe(notification('item/started', {
      item: { type: 'commandExecution', id: 'cmd-1', command: 'npm test', cwd: '/repo' } as ThreadItem,
    }));
    expect(tracker.snapshot()).toMatchObject({
      lastActivityAt: 2_000,
      lastMethod: 'item/started',
      activeKind: 'command',
      activeSince: 2_000,
    });

    vi.setSystemTime(3_000);
    tracker.observe(notification('item/commandExecution/outputDelta', { itemId: 'cmd-1', delta: '...' }));
    expect(tracker.snapshot()).toMatchObject({
      lastActivityAt: 3_000,
      lastMethod: 'item/commandExecution/outputDelta',
      activeKind: 'command',
      activeSince: 2_000,
    });

    vi.setSystemTime(4_000);
    tracker.observe(notification('item/started', {
      item: { type: 'mcpToolCall', id: 'mcp-1' } as ThreadItem,
    }));
    // 并行时命令优先，不能因后启动的 MCP 把长命令期限降回普通工具期限。
    expect(tracker.snapshot()).toMatchObject({ activeKind: 'command', activeSince: 2_000 });

    vi.setSystemTime(5_000);
    tracker.observe(notification('item/completed', {
      item: { type: 'commandExecution', id: 'cmd-1', command: 'npm test', cwd: '/repo' } as ThreadItem,
    }));
    expect(tracker.snapshot()).toMatchObject({ activeKind: 'tool', activeSince: 4_000 });

    vi.setSystemTime(6_000);
    tracker.observe(notification('item/completed', {
      item: { type: 'mcpToolCall', id: 'mcp-1' } as ThreadItem,
    }));
    expect(tracker.snapshot().activeKind).toBeUndefined();
    expect(tracker.snapshot().activeSince).toBeUndefined();
  });

  it('turn 结束或 fatal error 时清空遗留工具状态', () => {
    const tracker = createActivityTracker();
    tracker.observe(notification('item/started', {
      item: { type: 'commandExecution', id: 'cmd-1', command: 'build', cwd: '/repo' } as ThreadItem,
    }));
    tracker.observe(notification('turn/completed', { turn: { id: 'turn-1' } }));
    expect(tracker.snapshot().activeKind).toBeUndefined();

    tracker.observe(notification('item/started', {
      item: { type: 'mcpToolCall', id: 'mcp-1' } as ThreadItem,
    }));
    tracker.observe(notification('error', { error: { message: 'boom' }, willRetry: false }));
    expect(tracker.snapshot().activeKind).toBeUndefined();
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLarkProxyTransport } from '../src/utils/network-proxy';

const PROXY_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
] as const;

function clearProxyEnv(): void {
  for (const key of PROXY_KEYS) vi.stubEnv(key, '');
}

afterEach(() => vi.unstubAllEnvs());

describe('createLarkProxyTransport', () => {
  it('keeps the SDK direct when no proxy applies', () => {
    clearProxyEnv();
    expect(createLarkProxyTransport('https://open.feishu.cn')).toBeUndefined();
  });

  it('creates one CONNECT agent for Axios and WebSocket', () => {
    clearProxyEnv();
    vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.1:7890');

    const transport = createLarkProxyTransport('https://open.feishu.cn');

    expect(transport).toBeDefined();
    expect(transport?.displayUrl).toBe('http://127.0.0.1:7890/');
    expect(transport?.agent).toBeDefined();
    expect(transport?.httpInstance).toBeDefined();
  });

  it('keeps the SDK response-body contract', async () => {
    clearProxyEnv();
    vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.1:7890');
    const transport = createLarkProxyTransport('https://open.feishu.cn');
    const request = vi.fn().mockResolvedValue({
      data: { code: 0 },
      headers: { requestId: 'x' },
      config: {},
    });
    // Exercise the installed interceptor without opening a network connection.
    const handlers = (transport?.httpInstance as unknown as {
      interceptors: { response: { handlers: Array<{ fulfilled: (value: unknown) => unknown }> } };
    }).interceptors.response.handlers;

    request.mockResolvedValue(await handlers[0]?.fulfilled(await request()));
    expect(await request()).toEqual({ code: 0 });
  });

  it('honours NO_PROXY', () => {
    clearProxyEnv();
    vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.1:7890');
    vi.stubEnv('NO_PROXY', 'open.feishu.cn');

    expect(createLarkProxyTransport('https://open.feishu.cn')).toBeUndefined();
  });

  it('never exposes proxy credentials in diagnostics', () => {
    clearProxyEnv();
    vi.stubEnv('HTTPS_PROXY', 'http://alice:secret@127.0.0.1:7890');

    const transport = createLarkProxyTransport('https://open.feishu.cn');

    expect(transport?.displayUrl).toBe('http://127.0.0.1:7890/');
  });

  it('rejects SOCKS URLs with an actionable error', () => {
    clearProxyEnv();
    vi.stubEnv('HTTPS_PROXY', 'socks5://127.0.0.1:1080');

    expect(() => createLarkProxyTransport('https://open.feishu.cn')).toThrow(
      'use an HTTP or HTTPS proxy URL',
    );
  });
});

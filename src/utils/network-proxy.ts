import axios from 'axios';
import type { HttpInstance } from '@larksuiteoapi/node-sdk';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { getProxyForUrl } from 'proxy-from-env';

export interface LarkProxyTransport {
  /** Axios-compatible transport used by every SDK REST/config request. */
  httpInstance: HttpInstance;
  /** Agent forwarded to the SDK's WebSocket client. */
  agent: HttpsProxyAgent<string>;
  /** Credential-free value suitable for diagnostics. */
  displayUrl: string;
}

/**
 * Build one CONNECT-capable transport for both halves of the Lark SDK.
 *
 * Axios' built-in `HTTPS_PROXY=http://...` handling sends an absolute-form
 * plaintext request to some HTTP proxies instead of opening a CONNECT tunnel.
 * Xray/v2rayN then forwards that plaintext to the origin's TLS port, which
 * Feishu rejects with "plain HTTP request was sent to HTTPS port". Supplying
 * an explicit agent and disabling Axios' own proxy rewriting avoids that path.
 *
 * `proxy-from-env` preserves the familiar HTTPS_PROXY / HTTP_PROXY / ALL_PROXY
 * and NO_PROXY semantics. No result means callers should retain the SDK's
 * default direct transport.
 */
export function createLarkProxyTransport(apiBaseUrl: string): LarkProxyTransport | undefined {
  const proxyUrl = getProxyForUrl(apiBaseUrl);
  if (!proxyUrl) return undefined;

  const parsed = new URL(proxyUrl);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `Unsupported Feishu proxy protocol ${parsed.protocol}; use an HTTP or HTTPS proxy URL`,
    );
  }

  const agent = new HttpsProxyAgent(proxyUrl);
  const axiosInstance = axios.create({
    // The agent owns proxy selection and CONNECT. Letting Axios also process
    // *_PROXY would apply the proxy twice and recreate the plaintext failure.
    proxy: false,
    httpAgent: agent,
    httpsAgent: agent,
  });
  // Match @larksuiteoapi/node-sdk's defaultHttpInstance contract: generated
  // SDK methods expect the decoded body, not AxiosResponse. Keep the special
  // header-return mode used by a handful of SDK APIs as well.
  axiosInstance.interceptors.response.use((response) => {
    const config = response.config as typeof response.config & { $return_headers?: boolean };
    if (config.$return_headers) {
      return { data: response.data, headers: response.headers } as never;
    }
    return response.data as never;
  });
  const httpInstance = axiosInstance as unknown as HttpInstance;

  parsed.username = '';
  parsed.password = '';
  return { httpInstance, agent, displayUrl: parsed.toString() };
}

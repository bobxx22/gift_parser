/**
 * Минимальный HTTP/2-клиент с браузерным TLS-отпечатком.
 *
 * Нужен ровно для Tonnel: их Cloudflare отдаёт «Just a moment…» обычным
 * HTTP/1.1-клиентам Node (axios, undici, curl), но пропускает HTTP/2
 * с набором шифров как у Chrome. Проверено: 403 -> 200.
 */

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import http2, { ClientHttp2Session } from 'node:http2';

const CHROME_CIPHERS = [
  'TLS_AES_128_GCM_SHA256',
  'TLS_AES_256_GCM_SHA384',
  'TLS_CHACHA20_POLY1305_SHA256',
  'ECDHE-ECDSA-AES128-GCM-SHA256',
  'ECDHE-RSA-AES128-GCM-SHA256',
  'ECDHE-ECDSA-AES256-GCM-SHA384',
  'ECDHE-RSA-AES256-GCM-SHA384',
  'ECDHE-ECDSA-CHACHA20-POLY1305',
  'ECDHE-RSA-CHACHA20-POLY1305',
  'ECDHE-RSA-AES128-SHA',
  'ECDHE-RSA-AES256-SHA',
  'AES128-GCM-SHA256',
  'AES256-GCM-SHA384',
  'AES128-SHA',
  'AES256-SHA',
].join(':');

export interface Http2Response<T> {
  status: number;
  data: T;
  raw: string;
}

@Injectable()
export class Http2Client implements OnModuleDestroy {
  private readonly logger = new Logger(Http2Client.name);
  private readonly sessions = new Map<string, ClientHttp2Session>();

  onModuleDestroy(): void {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }

  private async session(origin: string): Promise<ClientHttp2Session> {
    const existing = this.sessions.get(origin);
    if (existing && !existing.closed && !existing.destroyed) return existing;

    const session = http2.connect(origin, {
      ciphers: CHROME_CIPHERS,
      ALPNProtocols: ['h2', 'http/1.1'],
      minVersion: 'TLSv1.2',
    });
    session.setTimeout(30_000, () => session.close());
    session.on('error', (error) => {
      this.logger.debug(`HTTP/2 ${origin}: ${String(error.message)}`);
      this.sessions.delete(origin);
    });
    session.on('close', () => this.sessions.delete(origin));

    await new Promise<void>((resolve, reject) => {
      const onConnect = () => {
        session.off('error', onError);
        resolve();
      };
      const onError = (error: Error) => {
        session.off('connect', onConnect);
        reject(error);
      };
      session.once('connect', onConnect);
      session.once('error', onError);
    });
    this.sessions.set(origin, session);
    return session;
  }

  async postJson<T>(
    origin: string,
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
    timeoutMs = 25_000,
  ): Promise<Http2Response<T>> {
    const session = await this.session(origin);
    const payload = JSON.stringify(body ?? {});
    // Порядок заголовков — часть отпечатка HTTP/2: Cloudflare пропускает именно
    // эту последовательность (content-* -> user-agent/origin/referer -> accept*).
    const request = session.request({
      ':method': 'POST',
      ':path': path,
      ':scheme': 'https',
      ':authority': new URL(origin).host,
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
      ...headers,
      accept: '*/*',
      'accept-language': 'ru-RU,ru;q=0.9,en;q=0.8',
    });
    request.setTimeout(timeoutMs, () => request.close(http2.constants.NGHTTP2_CANCEL));

    return new Promise<Http2Response<T>>((resolve, reject) => {
      let status = 0;
      let raw = '';
      request.on('response', (responseHeaders) => {
        status = Number(responseHeaders[':status'] ?? 0);
      });
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => {
        raw += chunk;
      });
      request.on('end', () => {
        let data: T;
        try {
          data = raw ? (JSON.parse(raw) as T) : (null as T);
        } catch {
          data = null as T;
        }
        resolve({ status, data, raw });
      });
      request.on('error', reject);
      request.end(payload);
    });
  }
}

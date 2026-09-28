/** Общая обвязка HTTP для площадок: единый User-Agent, таймауты, один ретрай. */

import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import http from 'node:http';
import https from 'node:https';

/** Общие агенты с keep-alive: экономят TLS-рукопожатие на каждом запросе. */
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 16, keepAliveMsecs: 15_000 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 16, keepAliveMsecs: 15_000 });

export const USER_AGENT =
  'Mozilla/5.0 (Linux; Android 13; SM-G998B) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/128.0.0.0 Mobile Safari/537.36 Telegram-Android/11.5.0';

export const DESKTOP_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/128.0.0.0 Safari/537.36';

export class MarketError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'MarketError';
  }
}

export class MarketAuthError extends MarketError {
  constructor(message: string) {
    super(message, 401);
    this.name = 'MarketAuthError';
  }
}

/**
 * Клиент площадки с простым cookie-jar: MRKT после /auth ставит cookie
 * `access_token` и без неё отвечает 401 (в Python это делал requests.Session).
 */
export function createHttp(baseURL: string, headers: Record<string, string> = {}): AxiosInstance {
  const instance = axios.create({
    baseURL,
    timeout: 25_000,
    httpAgent,
    httpsAgent,
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
      'Content-Type': 'application/json',
      ...headers,
    },
    validateStatus: () => true,
  });

  const jar = new Map<string, string>();
  instance.interceptors.response.use((response) => {
    const setCookie = response.headers['set-cookie'];
    if (Array.isArray(setCookie)) {
      for (const cookie of setCookie) {
        const pair = cookie.split(';')[0] ?? '';
        const index = pair.indexOf('=');
        if (index > 0) jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
      }
    }
    return response;
  });
  instance.interceptors.request.use((config) => {
    if (jar.size) {
      config.headers.set(
        'Cookie',
        [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; '),
      );
    }
    return config;
  });
  return instance;
}

/**
 * Повтор на сетевую ошибку. `attempts = 1` — без повтора: для медленных роутов
 * второй заход просто удваивает ожидание (Portals умеет висеть по 25 секунд).
 */
export async function requestWithRetry<T>(
  http: AxiosInstance,
  config: AxiosRequestConfig,
  label: string,
  attempts = 2,
): Promise<{ status: number; data: T }> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await http.request<T>(config);
      return { status: response.status, data: response.data };
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
    }
  }
  throw new MarketError(`${label}: ${String((lastError as Error)?.message ?? lastError)}`);
}

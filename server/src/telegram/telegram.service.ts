/**
 * Клиент Telegram (MTProto через teleproto).
 *
 * Отвечает за три вещи:
 *   1. хранение сессии в Postgres (таблица settings);
 *   2. выпуск initData для мини-аппов MRKT / Portals / Tonnel;
 *   3. вызовы официального маркета подарков (payments.*).
 */

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Api, TelegramClient, sessions, utils } from 'teleproto';
import { Repository } from 'typeorm';

import { SettingEntity } from '../database/entities';

const SESSION_KEY = 'telegram.session';
const INIT_DATA_KEY = 'telegram.initdata';
const INIT_DATA_TTL_MS = 40 * 60 * 1000;

export type MiniAppKey = 'mrkt' | 'portals' | 'tonnel';

interface MiniApp {
  bot: string;
  shortName?: string;
  main?: boolean;
}

/** Мини-аппы площадок: у каждого свой способ открытия. */
export const MINI_APPS: Record<MiniAppKey, MiniApp> = {
  mrkt: { bot: 'mrkt', shortName: 'app', main: true },
  portals: { bot: 'portals_market_bot', shortName: 'market' },
  tonnel: { bot: 'tonnel_network_bot', shortName: 'gifts', main: true },
};

const DEVICE = {
  deviceModel: 'Samsung SM-G998B',
  systemVersion: 'Android 13 (SDK 33)',
  appVersion: '11.5.0',
  langCode: 'ru',
  systemLangCode: 'ru-RU',
};

export class NotLoggedInError extends Error {
  constructor() {
    super('Нет сессии Telegram. Войди на вкладке «Telegram» или импортируй сессию Python.');
  }
}

interface PendingLogin {
  phone: string;
  phoneCodeHash: string;
  createdAt: number;
}

@Injectable()
export class TelegramService implements OnModuleDestroy {
  private readonly logger = new Logger(TelegramService.name);
  private client: TelegramClient | null = null;
  private connecting: Promise<TelegramClient> | null = null;
  private pending: PendingLogin | null = null;
  private initDataCache = new Map<string, { value: string; ts: number }>();
  private initDataLoaded = false;

  constructor(
    private readonly config: ConfigService,
    @InjectRepository(SettingEntity)
    private readonly settings: Repository<SettingEntity>,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await this.disconnect();
  }

  // ------------------------------------------------------------- настройки
  private get credentials(): { apiId: number; apiHash: string } {
    const value = this.config.get<{ apiId: number; apiHash: string }>('telegram');
    if (!value?.apiId || !value.apiHash) {
      throw new Error('Не заданы API_ID / API_HASH — проверь .env в корне проекта');
    }
    return value;
  }

  private async readSetting<T>(key: string): Promise<T | null> {
    const row = await this.settings.findOne({ where: { key } });
    return (row?.value as T) ?? null;
  }

  private async writeSetting(key: string, value: unknown): Promise<void> {
    await this.settings.save({ key, value });
  }

  async getSessionString(): Promise<string | null> {
    const stored = await this.readSetting<{ session: string }>(SESSION_KEY);
    return stored?.session ?? null;
  }

  async saveSessionString(session: string): Promise<void> {
    await this.writeSetting(SESSION_KEY, { session });
  }

  // --------------------------------------------------------------- клиент
  /** Ленивое подключение; параллельные вызовы ждут один и тот же коннект. */
  async getClient(requireAuth = true): Promise<TelegramClient> {
    if (this.client?.connected) {
      if (requireAuth && !(await this.client.isUserAuthorized())) throw new NotLoggedInError();
      return this.client;
    }
    if (!this.connecting) {
      this.connecting = this.connect().finally(() => {
        this.connecting = null;
      });
    }
    const client = await this.connecting;
    if (requireAuth && !(await client.isUserAuthorized())) throw new NotLoggedInError();
    return client;
  }

  private async connect(): Promise<TelegramClient> {
    const { apiId, apiHash } = this.credentials;
    const saved = (await this.getSessionString()) ?? '';
    const client = new TelegramClient(new sessions.StringSession(saved), apiId, apiHash, {
      connectionRetries: 3,
      retryDelay: 1000,
      ...DEVICE,
    });
    client.setLogLevel('error' as never);
    await client.connect();
    this.client = client;
    return client;
  }

  async disconnect(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (!client) return;
    try {
      await client.disconnect();
      await client.destroy();
    } catch (error) {
      this.logger.warn(`Не удалось закрыть клиент: ${String(error)}`);
    }
  }

  private async persistSession(client: TelegramClient): Promise<void> {
    const value = (client.session as sessions.StringSession).save();
    if (value) await this.saveSessionString(value);
  }

  // ----------------------------------------------------------------- вход
  async status(): Promise<{ authorized: boolean; user: string | null }> {
    try {
      const client = await this.getClient(false);
      if (!(await client.isUserAuthorized())) return { authorized: false, user: null };
      const me = await client.getMe();
      const name = [me.firstName, me.lastName].filter(Boolean).join(' ');
      const handle = me.username ? `@${me.username}` : String(me.id);
      return { authorized: true, user: `${name} (${handle})`.trim() };
    } catch (error) {
      this.logger.warn(`Статус Telegram: ${String(error)}`);
      return { authorized: false, user: null };
    }
  }

  /** Шаг 1: Telegram присылает код в приложение. */
  async startLogin(phone: string): Promise<{ sent: boolean }> {
    const { apiId, apiHash } = this.credentials;
    const client = await this.getClient(false);
    const result = await client.sendCode({ apiId, apiHash }, phone);
    this.pending = { phone, phoneCodeHash: result.phoneCodeHash, createdAt: Date.now() };
    return { sent: true };
  }

  /** Шаг 2: код (и пароль 2FA, если включён) вводит сам пользователь. */
  async confirmLogin(code: string, password?: string): Promise<{ user: string | null }> {
    if (!this.pending) throw new Error('Сначала запроси код: POST /api/auth/telegram/start');
    const { apiId, apiHash } = this.credentials;
    const client = await this.getClient(false);
    try {
      await client.invoke(
        new Api.auth.SignIn({
          phoneNumber: this.pending.phone,
          phoneCodeHash: this.pending.phoneCodeHash,
          phoneCode: code,
        }),
      );
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      if (!message.includes('SESSION_PASSWORD_NEEDED')) throw error;
      if (!password) {
        throw new Error('Включена двухфакторная защита — пришли пароль вместе с кодом');
      }
      await client.signInWithPassword(
        { apiId, apiHash },
        {
          password: async () => password,
          onError: async (err: Error) => {
            throw err;
          },
        },
      );
    }
    this.pending = null;
    await this.persistSession(client);
    this.initDataCache.clear();
    const status = await this.status();
    return { user: status.user };
  }

  async logout(): Promise<void> {
    try {
      const client = await this.getClient(false);
      if (await client.isUserAuthorized()) await client.invoke(new Api.auth.LogOut());
    } catch (error) {
      this.logger.warn(`Выход: ${String(error)}`);
    }
    await this.disconnect();
    await this.settings.delete({ key: SESSION_KEY });
    await this.settings.delete({ key: INIT_DATA_KEY });
    this.initDataCache.clear();
  }

  // ------------------------------------------------------------- initData
  private async loadInitDataCache(): Promise<void> {
    if (this.initDataLoaded) return;
    const stored = await this.readSetting<Record<string, { value: string; ts: number }>>(INIT_DATA_KEY);
    if (stored) {
      for (const [key, entry] of Object.entries(stored)) {
        if (entry?.value) this.initDataCache.set(key, entry);
      }
    }
    this.initDataLoaded = true;
  }

  private async saveInitDataCache(): Promise<void> {
    await this.writeSetting(INIT_DATA_KEY, Object.fromEntries(this.initDataCache));
  }

  /** initData мини-аппа: то, чем авторизуются MRKT, Portals и Tonnel. */
  async initData(app: MiniAppKey, force = false): Promise<string> {
    await this.loadInitDataCache();
    const cached = this.initDataCache.get(app);
    if (!force && cached && Date.now() - cached.ts < INIT_DATA_TTL_MS) return cached.value;

    const config = MINI_APPS[app];
    const client = await this.getClient();
    const peer = await client.getInputEntity(config.bot);
    const bot = utils.getInputUser(peer as never);
    const attempts: Array<() => Promise<{ url: string }>> = [];
    if (config.main) {
      attempts.push(() =>
        client.invoke(
          new Api.messages.RequestMainWebView({ peer, bot, platform: 'android' }),
        ) as Promise<{ url: string }>,
      );
    }
    if (config.shortName) {
      attempts.push(() =>
        client.invoke(
          new Api.messages.RequestAppWebView({
            peer,
            app: new Api.InputBotAppShortName({ botId: bot, shortName: config.shortName! }),
            platform: 'android',
            writeAllowed: true,
          }),
        ) as Promise<{ url: string }>,
      );
    }
    attempts.push(() =>
      client.invoke(
        new Api.messages.RequestWebView({ peer, bot, platform: 'android', fromBotMenu: true }),
      ) as Promise<{ url: string }>,
    );

    const errors: string[] = [];
    for (const attempt of attempts) {
      try {
        const result = await attempt();
        const value = extractInitData(result.url);
        this.initDataCache.set(app, { value, ts: Date.now() });
        await this.saveInitDataCache();
        return value;
      } catch (error) {
        errors.push(String((error as Error)?.message ?? error));
      }
    }
    throw new Error(`Не удалось открыть мини-апп @${config.bot}: ${errors.join('; ')}`);
  }

  // ------------------------------------------------------------- MTProto
  async invoke<T>(request: Api.AnyRequest): Promise<T> {
    const client = await this.getClient();
    return client.invoke(request) as Promise<T>;
  }
}

/** Достаёт tgWebAppData из фрагмента URL мини-аппа. */
export function extractInitData(url: string): string {
  const fragment = url.split('#')[1] ?? '';
  for (const part of fragment.split('&')) {
    const [key, ...rest] = part.split('=');
    if (key === 'tgWebAppData') return decodeURIComponent(rest.join('='));
  }
  throw new Error(`В ответе Telegram нет tgWebAppData: ${url.slice(0, 120)}`);
}

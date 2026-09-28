/**
 * Переносит существующую сессию Telethon (tg_session.session) в Postgres,
 * чтобы не логиниться заново: читаем auth_key и адрес дата-центра и собираем
 * StringSession для teleproto.
 *
 *   npm run import-session
 */

import 'reflect-metadata';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { TelegramClient, sessions } from 'teleproto';
import { AuthKey } from 'teleproto/crypto/AuthKey';
import { DataSource } from 'typeorm';

import configuration from '../config/configuration';
import { ENTITIES, SettingEntity } from '../database/entities';

async function main(): Promise<void> {
  const config = configuration();
  const path = process.argv[2]
    ? resolve(process.argv[2])
    : resolve(config.projectRoot, 'tg_session.session');
  if (!existsSync(path)) {
    // Не ошибка: сессии Telethon может не быть — тогда вход делается через API.
    console.log(`Файла сессии нет (${path}) — пропускаю.`);
    console.log('Войти можно из интерфейса: POST /api/auth/telegram/start, затем /confirm.');
    return;
  }

  const db = new DatabaseSync(path, { readOnly: true });
  const row = db
    .prepare('SELECT dc_id, server_address, port, auth_key FROM sessions LIMIT 1')
    .get() as { dc_id: number; server_address: string; port: number; auth_key: Uint8Array } | undefined;
  db.close();
  if (!row?.auth_key) throw new Error('В файле сессии нет ключа авторизации');

  const session = new sessions.StringSession('');
  session.setDC(Number(row.dc_id), String(row.server_address), Number(row.port));
  const authKey = new AuthKey();
  await authKey.setKey(Buffer.from(row.auth_key));
  session.setAuthKey(authKey);
  const sessionString = session.save();
  console.log(`Сессия прочитана: DC ${row.dc_id} ${row.server_address}:${row.port}`);

  // Проверяем, что ключ действительно рабочий.
  const client = new TelegramClient(
    new sessions.StringSession(sessionString),
    config.telegram.apiId,
    config.telegram.apiHash,
    { connectionRetries: 3 },
  );
  client.setLogLevel('error' as never);
  await client.connect();
  const authorized = await client.isUserAuthorized();
  if (!authorized) {
    await client.destroy();
    throw new Error('Ключ не принят Telegram — войди заново через интерфейс');
  }
  const me = await client.getMe();
  console.log(`Аккаунт: ${me.firstName ?? ''} ${me.username ? `@${me.username}` : me.id}`);
  await client.disconnect();
  await client.destroy();

  const dataSource = new DataSource({ type: 'postgres', ...config.database, entities: ENTITIES });
  await dataSource.initialize();
  await dataSource
    .getRepository(SettingEntity)
    .save({ key: 'telegram.session', value: { session: sessionString } });
  await dataSource.destroy();
  console.log('Сессия сохранена в Postgres (settings.telegram.session). Логиниться заново не нужно.');
}

void main().catch((error) => {
  console.error(String(error?.message ?? error));
  process.exit(1);
});

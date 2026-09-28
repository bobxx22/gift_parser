import { Body, Controller, Get, Post } from '@nestjs/common';

import { TelegramService } from './telegram.service';

/** Вход в Telegram: код и пароль вводит сам пользователь во фронте. */
@Controller('api/auth/telegram')
export class TelegramController {
  constructor(private readonly telegram: TelegramService) {}

  @Get('status')
  status() {
    return this.telegram.status();
  }

  @Post('start')
  start(@Body() body: { phone: string }) {
    return this.telegram.startLogin(String(body.phone ?? '').trim());
  }

  @Post('confirm')
  confirm(@Body() body: { code: string; password?: string }) {
    return this.telegram.confirmLogin(String(body.code ?? '').trim(), body.password);
  }

  @Post('logout')
  async logout() {
    await this.telegram.logout();
    return { ok: true };
  }
}

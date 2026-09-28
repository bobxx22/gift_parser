import { Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';

import { FloorInfo, TradeDto } from '../common/types';

/**
 * WebSocket: фронт подписывается на sessionId и получает живые сделки,
 * обновления флоров и прогресс загрузки.
 */
@WebSocketGateway({ cors: { origin: true, credentials: true } })
export class EventsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(EventsGateway.name);

  @WebSocketServer()
  server: Server;

  handleConnection(client: Socket): void {
    this.logger.debug(`подключился ${client.id}`);
  }

  handleDisconnect(client: Socket): void {
    this.logger.debug(`отключился ${client.id}`);
  }

  @SubscribeMessage('search:subscribe')
  subscribe(@MessageBody() body: { sessionId: string }, @ConnectedSocket() client: Socket) {
    if (!body?.sessionId) return { ok: false };
    void client.join(this.room(body.sessionId));
    return { ok: true };
  }

  @SubscribeMessage('search:unsubscribe')
  unsubscribe(@MessageBody() body: { sessionId: string }, @ConnectedSocket() client: Socket) {
    if (body?.sessionId) void client.leave(this.room(body.sessionId));
    return { ok: true };
  }

  private room(sessionId: string): string {
    return `search:${sessionId}`;
  }

  hasSubscribers(sessionId: string): boolean {
    const room = this.server?.sockets?.adapter?.rooms?.get(this.room(sessionId));
    return Boolean(room && room.size > 0);
  }

  emitTrades(sessionId: string, trades: TradeDto[], snapshot: unknown, market?: string): void {
    this.server?.to(this.room(sessionId)).emit('trades:new', { trades, snapshot, market });
  }

  emitFloors(sessionId: string, floors: FloorInfo[], snapshot: unknown): void {
    this.server?.to(this.room(sessionId)).emit('floors:update', { floors, snapshot });
  }

  emitProgress(sessionId: string, text: string): void {
    this.server?.to(this.room(sessionId)).emit('search:progress', { text });
  }

  /** Лента выгодных: общая для всех, без привязки к сессии поиска. */
  emitDeals(deals: unknown[]): void {
    this.server?.emit('deals:new', { deals });
  }

  emitDone(sessionId: string, snapshot: unknown): void {
    this.server?.to(this.room(sessionId)).emit('search:done', { snapshot });
  }
}

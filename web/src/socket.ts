import { io, Socket } from 'socket.io-client';

let socket: Socket | null = null;

/** Одно соединение на всё приложение: живые сделки, флоры и прогресс. */
export function getSocket(): Socket {
  if (!socket) {
    socket = io({ transports: ['websocket'], autoConnect: true });
  }
  return socket;
}

import Redis from 'ioredis';
import { createAdapter } from '@socket.io/redis-adapter';
import type { Server } from 'socket.io';
import { RoomStore } from './roomStore';

/** Explicitly opt-in; existing deployments keep their current startup behavior. */
export async function sharedBackend(io: Server): Promise<RoomStore> {
  if (process.env['REALTIME_SHARED_ENABLED'] !== 'true') return new RoomStore();
  const url = process.env['SOCKET_REDIS_URL'];
  if (!url) throw new Error('Shared realtime mode requires SOCKET_REDIS_URL');
  const pub = new Redis(url, { lazyConnect: true, connectTimeout: 2000, commandTimeout: 2000, maxRetriesPerRequest: 1 });
  const sub = pub.duplicate();
  const events = pub.duplicate();
  for (const client of [pub, sub, events]) client.on('error', () => { /* handled by readiness checks */ });
  await Promise.all([pub.connect(), sub.connect(), events.connect()]);
  io.adapter(createAdapter(pub, sub, { key: 'jukebox:socket', requestsTimeout: 2000 }));
  io.use(async (socket, next) => {
    try {
      if ([pub, sub, events].some(client => client.status !== 'ready')) throw new Error('Unavailable');
      const { userId, roomId, issuedAt } = socket.data;
      const isRevoked = async () => {
        const revoked = await pub.mget(`jukebox:revoked:user:${userId}`, `jukebox:revoked:room:${roomId}`);
        return revoked.some(value => value && Number(value) >= (issuedAt ?? 0));
      };
      if (await isRevoked()) throw new Error('Revoked');
      // Pub/sub is immediate when healthy; this recovers a missed revocation.
      const authTimer = setInterval(() => {
        void isRevoked().then(revoked => { if (revoked) socket.disconnect(true); }).catch(() => {});
      }, 15000);
      authTimer.unref();
      socket.once('disconnect', () => clearInterval(authTimer));
      // Bound Redis work before awaiting any shared checks, including packet bursts.
      let localTokens = 60;
      let localLast = Date.now();
      socket.use(async (_packet, proceed) => {
        try {
          const now = Date.now();
          localTokens = Math.min(60, localTokens + Math.max(0, now - localLast) * 0.02);
          localLast = now;
          if (localTokens < 1) return;
          localTokens--;
          if ([pub, sub, events].some(client => client.status !== 'ready')) return;
          const count = Number(await pub.eval(`
            local n = redis.call('INCR', KEYS[1])
            if n == 1 then redis.call('EXPIRE', KEYS[1], 1) end
            return n
          `, 1, `jukebox:socket-limit:${userId}`));
          if (count <= 60) proceed();
        } catch { /* shared mode must not silently fall back to independent writes */ }
      });
      next();
    } catch { next(new Error('Realtime unavailable or credentials revoked')); }
  });
  await events.subscribe('jukebox:events');
  events.on('message', (_channel, message) => {
    try {
      const event = JSON.parse(message) as { roomId?: string; userId?: string; revoke?: boolean; revokedAt?: number };
      if (event.revoke) {
        for (const socket of io.sockets.sockets.values()) {
          if (((event.roomId && socket.data.roomId === event.roomId) || (event.userId && socket.data.userId === event.userId)) &&
              (socket.data.issuedAt ?? 0) <= (event.revokedAt ?? Infinity)) socket.disconnect(true);
        }
      } else if (typeof event.roomId === 'string') io.local.to(event.roomId).emit('queue-invalidated');
    } catch { /* malformed backend notification */ }
  });
  return new RoomStore(pub);
}

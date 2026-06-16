// src/services/socketService.ts
import { Server, Socket } from 'socket.io';
import jwt, { JwtPayload } from 'jsonwebtoken';
import { config } from '../config';
import {
  ServerToClientEvents,
  ClientToServerEvents,
  InterServerEvents,
  SocketData,
  SyncCommand,
  ChangeVideoEvent,
  QueueUpdatedEvent,
  QueueRemovedEvent,
  ThemeChangedEvent,
  EmojiReactionEvent,
} from '../types';

// Convenience alias for a fully-typed socket.
type AppSocket = Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

// Reactions are intentionally a small fixed set. Anything outside this list is
// rejected so clients can't broadcast arbitrary payloads. Keep this in sync with
// REACTION_EMOJIS on the frontend (music-duo/src/components/ReactionBar.tsx).
const ALLOWED_EMOJIS = new Set(['❤️', '😂', '🔥', '👏', '🥳', '👎']);

export class SocketService {
  private io: Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;
  private roomPresence: Map<string, Map<string, { id: string; name?: string; image?: string }>> = new Map();
  private socketState: Map<string, { userId?: string; rooms: Set<string> }> = new Map();
  private cleanupInterval: ReturnType<typeof setInterval>;
  private presenceThrottleTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  // Room-wide shuffle state, replayed to each member on join so a late joiner sees the
  // host's current setting instead of the default (off).
  private roomShuffle: Map<string, boolean> = new Map();
  // Room-wide theme, replayed to each member on join (same reason as shuffle above).
  private roomTheme: Map<string, 'default' | 'love'> = new Map();
  // Per-socket token bucket to stop one client flooding the room with reactions
  private emojiRateLimit: Map<string, { tokens: number; last: number }> = new Map();
  // Last known playback state per room, so a client that (re)joins after a drop or
  // screen-off can be snapped back to the live position via 'sync-request'. serverTs is
  // the server clock at the time the state was recorded, used to advance a playing
  // position by the elapsed time when replaying.
  private roomSyncState: Map<string, { videoId?: string; cmd: 'play' | 'pause'; seekTime: number; serverTs: number }> = new Map();

  constructor(io: Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>) {
    this.io = io;
    // Auth must be registered before connection handlers so it runs on every handshake.
    this.setupAuthMiddleware();
    this.setupEventHandlers();
    // Periodic cleanup of stale presence entries every 5 minutes
    this.cleanupInterval = setInterval(() => this.cleanupStalePresence(), 5 * 60 * 1000);
    this.cleanupInterval.unref();
  }

  // Verify the signed handshake token and bind a trusted identity to the socket.
  // Every connection MUST present a valid token minted by the Next.js app
  // (/api/rooms/[id]/socket-token); there is no unauthenticated path. The token carries
  // the user id, the room it authorizes, and whether that room's host is premium
  // (syncEligible). Clients cannot forge it, so all later authorization reads from
  // socket.data rather than from client-supplied payloads.
  private setupAuthMiddleware(): void {
    this.io.use((socket: AppSocket, next: (err?: Error) => void) => {
      try {
        const secret = config.auth.jwtSecret;
        if (!secret) {
          // Misconfigured server - fail closed.
          return next(new Error('server auth misconfigured'));
        }

        const rawToken = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
        const token = typeof rawToken === 'string' ? rawToken : undefined;
        if (!token) return next(new Error('unauthorized'));

        const payload = jwt.verify(token, secret, { algorithms: ['HS256'] }) as JwtPayload;
        const userId = typeof payload.sub === 'string' ? payload.sub : undefined;
        if (!userId) return next(new Error('unauthorized'));

        socket.data.userId = userId;
        socket.data.syncEligible = payload['syncEligible'] === true;
        if (typeof payload['roomId'] === 'string') socket.data.roomId = payload['roomId'];
        if (typeof payload['name'] === 'string') socket.data.name = payload['name'];
        if (typeof payload['image'] === 'string') socket.data.image = payload['image'];
        return next();
      } catch {
        // Invalid/expired token.
        return next(new Error('unauthorized'));
      }
    });
  }

  // Authorization gate for all live sync/broadcast events (playback, queue, theme,
  // reactions). Every socket is authenticated by the time it reaches here, so this
  // requires: the socket is joined to the room, the room is sync-eligible (host is
  // premium), and the token was issued for this exact room.
  private canSync(socket: AppSocket, roomId: string): boolean {
    if (!this.socketState.get(socket.id)?.rooms.has(roomId)) return false;
    return socket.data.syncEligible === true && socket.data.roomId === roomId;
  }

  // Input validation helpers
  private isValidString(val: unknown, maxLen = 200): val is string {
    return typeof val === 'string' && val.length > 0 && val.length <= maxLen;
  }

  private isValidRoomId(val: unknown): val is string {
    return this.isValidString(val, 100);
  }

  // Clean up rooms with no active sockets
  private cleanupStalePresence(): void {
    for (const [roomId, members] of this.roomPresence) {
      const roomSockets = this.io.sockets.adapter.rooms.get(roomId);
      if (!roomSockets || roomSockets.size === 0) {
        this.roomPresence.delete(roomId);
        this.roomShuffle.delete(roomId);
        this.roomTheme.delete(roomId);
        continue;
      }
      // Remove users whose sockets are no longer connected
      for (const [userId] of members) {
        let hasActiveSocket = false;
        for (const socketId of roomSockets) {
          const state = this.socketState.get(socketId);
          if (state?.userId === userId) {
            hasActiveSocket = true;
            break;
          }
        }
        if (!hasActiveSocket) {
          members.delete(userId);
        }
      }
      if (members.size === 0) {
        this.roomPresence.delete(roomId);
        this.roomShuffle.delete(roomId);
        this.roomTheme.delete(roomId);
        // Clean up throttle timer for empty room
        const timer = this.presenceThrottleTimers.get(roomId);
        if (timer) {
          clearTimeout(timer);
          this.presenceThrottleTimers.delete(roomId);
        }
      }
    }

    // Drop saved playback state for rooms that no longer have any connected sockets,
    // so the map can't grow unbounded over time.
    for (const roomId of this.roomSyncState.keys()) {
      const roomSockets = this.io.sockets.adapter.rooms.get(roomId);
      if (!roomSockets || roomSockets.size === 0) {
        this.roomSyncState.delete(roomId);
      }
    }
  }

  private setupEventHandlers(): void {
    this.io.on('connection', (socket: Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>) => {
      console.log('client connected', socket.id);
      this.socketState.set(socket.id, { rooms: new Set() });

      // Limit rooms per socket to prevent abuse
      const MAX_ROOMS_PER_SOCKET = 5;

      // Join room handler
      socket.on('join-room', (roomId: string) => {
        try {
          if (!this.isValidRoomId(roomId)) return;
          // A verified token authorizes exactly one room; reject mismatches.
          if (socket.data.roomId !== roomId) return;
          const state = this.socketState.get(socket.id);
          if (state && state.rooms.size >= MAX_ROOMS_PER_SOCKET) return;
          this.handleJoinRoom(socket, roomId);
        } catch (err) {
          console.error('Error in join-room handler:', err);
        }
      });

      // Presence join. The user's identity is taken from the verified token, never from
      // the client payload, so a client cannot impersonate another user (the `user`
      // field in the event is ignored).
      socket.on('presence-join', ({ roomId }) => {
        try {
          if (!this.isValidRoomId(roomId)) return;
          // A verified token authorizes exactly one room; reject mismatches.
          if (socket.data.roomId !== roomId) return;

          const presenceUser: { id: string; name?: string; image?: string } = {
            id: socket.data.userId as string,
          };
          if (this.isValidString(socket.data.name, 200)) presenceUser.name = socket.data.name;
          if (this.isValidString(socket.data.image, 500)) presenceUser.image = socket.data.image;

          // Ensure socket has joined the room first
          const state = this.socketState.get(socket.id);
          if (!state?.rooms.has(roomId)) {
            if (state && state.rooms.size >= MAX_ROOMS_PER_SOCKET) return;
            // Auto-join the room if not already joined
            this.handleJoinRoom(socket, roomId);
          }
          this.trackPresence(socket, roomId, presenceUser);
          this.broadcastPresence(roomId);
          // Replay the room's current shuffle state to this joiner, so a member who joins
          // after the host enabled shuffle sees it on (not the default off).
          const shuffle = this.roomShuffle.get(roomId);
          if (typeof shuffle === 'boolean') socket.emit('shuffle-changed', shuffle);
          const theme = this.roomTheme.get(roomId);
          if (theme) socket.emit('theme-changed', theme);
        } catch (err) {
          console.error('Error in presence-join handler:', err);
        }
      });

      // Leave room handler
      socket.on('leave-room', ({ roomId, userId }) => {
        try {
          if (!this.isValidRoomId(roomId)) return;
          if (!this.isValidString(userId, 100)) return;
          const state = this.socketState.get(socket.id);
          // Identity comes from the verified token - prevents evicting another user's
          // presence by spoofing their id.
          if (socket.data.userId !== userId) return;
          // Remove this socket from room tracking so userHasActiveSocket returns false
          socket.leave(roomId);
          if (state) state.rooms.delete(roomId);
          this.removePresenceIfInactive(roomId, userId);
          this.broadcastPresence(roomId);
        } catch (err) {
          console.error('Error in leave-room handler:', err);
        }
      });

      // Sync ping handler
      socket.on('sync-ping', () => {
        try {
          this.handleSyncPing(socket);
        } catch (err) {
          console.error('Error in sync-ping handler:', err);
        }
      });

      // Sync request handler — a (re)joining client asks for the room's current
      // playback state; we reply to that socket only so it can snap to the live position.
      socket.on('sync-request', (data: { roomId: string; videoId?: string }) => {
        try {
          if (!data || !this.isValidRoomId(data.roomId)) return;
          if (data.videoId !== undefined && !this.isValidString(data.videoId, 20)) return;
          if (!this.canSync(socket, data.roomId)) return;
          this.handleSyncRequest(socket, data.roomId, data.videoId);
        } catch (err) {
          console.error('Error in sync-request handler:', err);
        }
      });

      // Sync command handler
      socket.on('sync-command', (data: SyncCommand) => {
        try {
          if (!data || !this.isValidRoomId(data.roomId)) return;
          if (data.cmd !== 'play' && data.cmd !== 'pause') return;
          if (typeof data.timestamp !== 'number' || typeof data.seekTime !== 'number') return;
          if (!isFinite(data.timestamp) || !isFinite(data.seekTime) || data.seekTime < 0) return;
          const { roomId } = data;
          if (this.canSync(socket, roomId)) {
            this.handleSyncCommand(socket, data);
          }
        } catch (err) {
          console.error('Error in sync-command handler:', err);
        }
      });

      // Change video handler
      socket.on('change-video', (data: ChangeVideoEvent) => {
        try {
          if (!data || !this.isValidRoomId(data.roomId)) return;
          if (!this.isValidString(data.newVideoId, 20)) return;
          const { roomId } = data;
          if (this.canSync(socket, roomId)) {
            this.handleChangeVideo(socket, data);
          }
        } catch (err) {
          console.error('Error in change-video handler:', err);
        }
      });

      // Queue updated handler
      socket.on('queue-updated', (data: QueueUpdatedEvent) => {
        try {
          if (!data || !this.isValidRoomId(data.roomId)) return;
          if (!data.item || !this.isValidString(data.item.videoId, 20)) return;
          if (!this.isValidString(data.item.title, 500)) return;
          const { roomId } = data;
          if (this.canSync(socket, roomId)) {
            this.handleQueueUpdated(socket, data);
          }
        } catch (err) {
          console.error('Error in queue-updated handler:', err);
        }
      });

      // Queue removed handler
      socket.on('queue-removed', (data: QueueRemovedEvent) => {
        try {
          if (!data || !this.isValidRoomId(data.roomId)) return;
          if (!this.isValidString(data.itemId, 100)) return;
          if (data.deletedOrder !== undefined && (typeof data.deletedOrder !== 'number' || !isFinite(data.deletedOrder))) return;
          if (data.newCurrentIndex !== undefined && (typeof data.newCurrentIndex !== 'number' || !isFinite(data.newCurrentIndex))) return;
          const { roomId } = data;
          if (this.canSync(socket, roomId)) {
            this.handleQueueRemoved(socket, data);
          }
        } catch (err) {
          console.error('Error in queue-removed handler:', err);
        }
      });

      // Theme changed handler
      socket.on('theme-changed', (data: ThemeChangedEvent) => {
        try {
          if (!data || !this.isValidRoomId(data.roomId)) return;
          if (data.theme !== 'default' && data.theme !== 'love') return;
          const { roomId } = data;
          if (this.canSync(socket, roomId)) {
            this.handleThemeChanged(data);
          }
        } catch (err) {
          console.error('Error in theme-changed handler:', err);
        }
      });

      // Shuffle toggle handler — room-wide setting, broadcast to everyone (host-gated on client)
      socket.on('shuffle-changed', (data: { roomId: string; shuffle: boolean }) => {
        try {
          if (!data || !this.isValidRoomId(data.roomId)) return;
          if (typeof data.shuffle !== 'boolean') return;
          if (!this.canSync(socket, data.roomId)) return;
          console.log(`shuffle-changed -> room:${data.roomId} shuffle:${data.shuffle}`);
          this.roomShuffle.set(data.roomId, data.shuffle);
          // Broadcast to others only — sender already set the new shuffle state optimistically
          socket.to(data.roomId).emit('shuffle-changed', data.shuffle);
        } catch (err) {
          console.error('Error in shuffle-changed handler:', err);
        }
      });

      // Queue cleared handler — tell others to drop their queue
      socket.on('queue-cleared', (data: { roomId: string }) => {
        try {
          if (!data || !this.isValidRoomId(data.roomId)) return;
          if (!this.canSync(socket, data.roomId)) return;
          console.log(`queue-cleared -> room:${data.roomId}`);
          socket.to(data.roomId).emit('queue-cleared', { roomId: data.roomId });
        } catch (err) {
          console.error('Error in queue-cleared handler:', err);
        }
      });

      // Emoji reaction handler — transient, one-shot broadcast to others in the room
      socket.on('emoji-reaction', (data: EmojiReactionEvent) => {
        try {
          if (!data || !this.isValidRoomId(data.roomId)) return;
          if (typeof data.emoji !== 'string' || !ALLOWED_EMOJIS.has(data.emoji)) return;
          if (!this.canSync(socket, data.roomId)) return;
          if (!this.allowEmoji(socket.id)) return;
          this.handleEmojiReaction(socket, data);
        } catch (err) {
          console.error('Error in emoji-reaction handler:', err);
        }
      });

      // Disconnect handler — delay cleanup to avoid race with reconnection.
      // When a user switches tabs, the old socket disconnects and a new one connects.
      // If cleanup runs before the new socket joins, presence is briefly lost.
      // If cleanup runs after, we check whether the user already reconnected and skip cleanup.
      socket.on('disconnect', () => {
        try {
          this.handleDisconnect(socket);
          this.emojiRateLimit.delete(socket.id);
          const state = this.socketState.get(socket.id);
          if (state) {
            const userId = state.userId;
            const rooms = new Set(state.rooms); // snapshot
            // Delete socketState immediately (the socket ID is gone)
            this.socketState.delete(socket.id);

            if (userId) {
              // Delay presence cleanup to let the user reconnect with a new socket
              setTimeout(() => {
                for (const roomId of rooms) {
                  // Check if the user already reconnected with a different socket
                  const hasReconnected = this.userHasActiveSocket(roomId, userId);
                  if (!hasReconnected) {
                    this.removePresenceIfInactive(roomId, userId);
                    this.broadcastPresence(roomId);
                  } else {
                    console.log(`[Presence] Skipping cleanup for user ${userId} in room ${roomId} — already reconnected`);
                  }
                }
              }, 3000); // 3 second grace period for reconnection
            }
          } else {
            this.socketState.delete(socket.id);
          }
        } catch (err) {
          console.error('Error in disconnect handler:', err);
        }
      });
    });
  }

  private handleJoinRoom(socket: Socket, roomId: string): void {
    console.log(`${socket.id} joined room ${roomId}`);
    socket.join(roomId);
    // Track that this socket is in this room
    const state = this.socketState.get(socket.id) || { rooms: new Set<string>() };
    state.rooms.add(roomId);
    this.socketState.set(socket.id, state);
    const roomSize = this.io.sockets.adapter.rooms.get(roomId)?.size || 0;
    console.log(`Room ${roomId} now has ${roomSize} clients`);
  }

  private trackPresence(
    socket: Socket,
    roomId: string,
    user: { id: string; name?: string; image?: string }
  ): void {
    // Track user association for this socket
    const state = this.socketState.get(socket.id) || { rooms: new Set<string>() };
    state.userId = user.id;
    state.rooms.add(roomId);
    this.socketState.set(socket.id, state);

    // Add or update user in room presence (idempotent — no counting)
    if (!this.roomPresence.has(roomId)) {
      this.roomPresence.set(roomId, new Map());
    }
    const members = this.roomPresence.get(roomId)!;
    const entry: { id: string; name?: string; image?: string } = { id: user.id };
    if (user.name !== undefined) entry.name = user.name;
    if (user.image !== undefined) entry.image = user.image;
    members.set(user.id, entry);
  }

  // Check if a user has any active socket in a given room
  private userHasActiveSocket(roomId: string, userId: string): boolean {
    for (const [socketId, state] of this.socketState) {
      if (state.userId === userId && state.rooms.has(roomId)) {
        // Verify the socket is actually connected
        const sock = this.io.sockets.sockets.get(socketId);
        if (sock && sock.connected) return true;
      }
    }
    return false;
  }

  // Remove user from presence if they have no active sockets in the room
  private removePresenceIfInactive(roomId: string, userId: string): void {
    if (this.userHasActiveSocket(roomId, userId)) return;
    const members = this.roomPresence.get(roomId);
    if (!members) return;
    members.delete(userId);
    if (members.size === 0) this.roomPresence.delete(roomId);
  }

  private broadcastPresence(roomId: string): void {
    const members = this.roomPresence.get(roomId);
    const memberCount = members?.size || 0;

    // For large rooms (>20 members), throttle presence broadcasts to once per 2 seconds
    if (memberCount > 20) {
      if (this.presenceThrottleTimers.has(roomId)) return; // Already scheduled
      this.presenceThrottleTimers.set(roomId, setTimeout(() => {
        this.presenceThrottleTimers.delete(roomId);
        this.emitPresence(roomId);
      }, 2000));
      return;
    }

    this.emitPresence(roomId);
  }

  private emitPresence(roomId: string): void {
    const members = Array.from(this.roomPresence.get(roomId)?.values() || []).map(m => {
      const obj: { id: string; name?: string; image?: string } = { id: m.id };
      if (m.name !== undefined) obj.name = m.name;
      if (m.image !== undefined) obj.image = m.image;
      return obj;
    });
    this.io.to(roomId).emit('room-presence', members);
  }

  private handleSyncPing(socket: Socket): void {
    socket.emit('sync-pong', Date.now());
  }

  private handleSyncCommand(socket: Socket, data: SyncCommand): void {
    const { roomId, cmd, timestamp, seekTime } = data;
    console.log(`sync-command -> room:${roomId} cmd:${cmd} seek:${seekTime}`);
    socket.to(roomId).emit('sync-command', { cmd, timestamp, seekTime });
    // Record the latest state so a (re)joiner can be snapped to it. Preserve the
    // tracked videoId (sync-command doesn't carry one).
    const prev = this.roomSyncState.get(roomId);
    this.roomSyncState.set(roomId, {
      ...(prev?.videoId !== undefined ? { videoId: prev.videoId } : {}),
      cmd,
      seekTime,
      serverTs: Date.now(),
    });
  }

  private handleChangeVideo(socket: Socket, data: ChangeVideoEvent): void {
    const { roomId, newVideoId } = data;
    console.log(`change-video -> room:${roomId} videoId:${newVideoId}`);
    // Broadcast to others only — sender already updated their own state
    socket.to(roomId).emit('video-changed', newVideoId);
    // New song resets position to 0. Keep the previous play/pause intent (a real
    // sync-command for the new song will follow shortly and correct it if needed).
    const prev = this.roomSyncState.get(roomId);
    this.roomSyncState.set(roomId, {
      videoId: newVideoId,
      cmd: prev?.cmd ?? 'play',
      seekTime: 0,
      serverTs: Date.now(),
    });
  }

  // Replay the room's current playback state to a single (re)joining socket. If the
  // state is for a known video that doesn't match what the client is on, skip (avoids
  // seeking the wrong song under replica lag); an unknown videoId is treated as the
  // current single song and replayed. A playing position is advanced by elapsed time.
  private handleSyncRequest(socket: AppSocket, roomId: string, clientVideoId?: string): void {
    const state = this.roomSyncState.get(roomId);
    if (!state) return;
    if (state.videoId !== undefined && clientVideoId !== undefined && state.videoId !== clientVideoId) {
      return;
    }
    let seekTime = state.seekTime;
    if (state.cmd === 'play') {
      const elapsedSec = (Date.now() - state.serverTs) / 1000;
      if (elapsedSec > 0) seekTime = state.seekTime + elapsedSec;
    }
    // Small buffer so the client has time to schedule the seek/play. timestamp is in
    // server time; the client converts it via its measured clock offset.
    socket.emit('sync-command', { cmd: state.cmd, seekTime, timestamp: Date.now() + 200 });
    console.log(`sync-request replay -> socket:${socket.id} room:${roomId} cmd:${state.cmd} seek:${seekTime.toFixed(1)}`);
  }

  private handleQueueUpdated(socket: Socket, data: QueueUpdatedEvent): void {
    const { roomId, item } = data;
    console.log(`queue-updated -> room:${roomId} item:${item.title}`);
    // Broadcast to others only — sender already refreshed their own queue
    socket.to(roomId).emit('queue-updated', item);
  }

  private handleQueueRemoved(socket: Socket, data: QueueRemovedEvent): void {
    const { roomId, itemId, deletedOrder, newCurrentIndex } = data;
    console.log(`queue-removed -> room:${roomId} itemId:${itemId}`);
    // Forward full data so receivers can update their index without extra fetch
    socket.to(roomId).emit('queue-removed', { roomId, itemId, deletedOrder, newCurrentIndex });
  }

  private handleThemeChanged(data: ThemeChangedEvent): void {
    const { roomId, theme } = data;
    console.log(`theme-changed -> room:${roomId} theme:${theme}`);
    this.roomTheme.set(roomId, theme);
    this.io.to(roomId).emit('theme-changed', theme);
  }

  // Token bucket: capacity 8, refill 5 tokens/sec. Allows quick bursts of taps
  // but silently drops sustained floods. Cleared on disconnect.
  private allowEmoji(socketId: string): boolean {
    const CAPACITY = 8;
    const REFILL_PER_SEC = 5;
    const now = Date.now();
    const bucket = this.emojiRateLimit.get(socketId) || { tokens: CAPACITY, last: now };
    bucket.tokens = Math.min(CAPACITY, bucket.tokens + ((now - bucket.last) / 1000) * REFILL_PER_SEC);
    bucket.last = now;
    if (bucket.tokens < 1) {
      this.emojiRateLimit.set(socketId, bucket);
      return false;
    }
    bucket.tokens -= 1;
    this.emojiRateLimit.set(socketId, bucket);
    return true;
  }

  private handleEmojiReaction(socket: Socket, data: EmojiReactionEvent): void {
    const { roomId, emoji } = data;
    // Broadcast to others only — sender renders its own reaction locally
    socket.to(roomId).emit('emoji-reaction', { emoji });
  }

  private handleDisconnect(socket: Socket): void {
    console.log('client disconnected', socket.id);
  }
}

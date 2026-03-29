// src/services/socketService.ts
import { Server, Socket } from 'socket.io';
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
  SyncHeartbeat,
} from '../types';

export class SocketService {
  private io: Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;
  private roomPresence: Map<string, Map<string, { id: string; name?: string; image?: string }>> = new Map();
  private socketState: Map<string, { userId?: string; rooms: Set<string> }> = new Map();
  private cleanupInterval: ReturnType<typeof setInterval>;
  private presenceThrottleTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private playbackState: Map<string, { isPlaying: boolean; seekTime: number; timestamp: number }> = new Map();

  constructor(io: Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>) {
    this.io = io;
    this.setupEventHandlers();
    // Periodic cleanup of stale presence entries every 5 minutes
    this.cleanupInterval = setInterval(() => this.cleanupStalePresence(), 5 * 60 * 1000);
    this.cleanupInterval.unref();
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
        this.playbackState.delete(roomId);
        // Clean up throttle timer for empty room
        const timer = this.presenceThrottleTimers.get(roomId);
        if (timer) {
          clearTimeout(timer);
          this.presenceThrottleTimers.delete(roomId);
        }
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
          const state = this.socketState.get(socket.id);
          if (state && state.rooms.size >= MAX_ROOMS_PER_SOCKET) return;
          this.handleJoinRoom(socket, roomId);
        } catch (err) {
          console.error('Error in join-room handler:', err);
        }
      });

      // Presence join with user info
      socket.on('presence-join', ({ roomId, user }) => {
        try {
          if (!this.isValidRoomId(roomId)) return;
          if (!user || !this.isValidString(user.id, 100)) return;
          // Ensure socket has joined the room first
          const state = this.socketState.get(socket.id);
          if (!state?.rooms.has(roomId)) {
            if (state && state.rooms.size >= MAX_ROOMS_PER_SOCKET) return;
            // Auto-join the room if not already joined
            this.handleJoinRoom(socket, roomId);
          }
          const presenceUser: { id: string; name?: string; image?: string } = { id: user.id };
          if (this.isValidString(user.name, 200)) presenceUser.name = user.name;
          if (this.isValidString(user.image, 500)) presenceUser.image = user.image;
          this.trackPresence(socket, roomId, presenceUser);
          this.broadcastPresence(roomId);
        } catch (err) {
          console.error('Error in presence-join handler:', err);
        }
      });

      // Leave room handler
      socket.on('leave-room', ({ roomId, userId }) => {
        try {
          if (!this.isValidRoomId(roomId)) return;
          if (!this.isValidString(userId, 100)) return;
          // Verify the userId matches this socket's user — prevents spoofing
          const state = this.socketState.get(socket.id);
          if (state?.userId !== userId) return;
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

      // Sync command handler
      socket.on('sync-command', (data: SyncCommand) => {
        try {
          if (!data || !this.isValidRoomId(data.roomId)) return;
          if (data.cmd !== 'play' && data.cmd !== 'pause') return;
          if (typeof data.timestamp !== 'number' || typeof data.seekTime !== 'number') return;
          if (!isFinite(data.timestamp) || !isFinite(data.seekTime) || data.seekTime < 0) return;
          const { roomId } = data;
          if (this.socketState.get(socket.id)?.rooms.has(roomId)) {
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
          if (this.socketState.get(socket.id)?.rooms.has(roomId)) {
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
          if (this.socketState.get(socket.id)?.rooms.has(roomId)) {
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
          if (this.socketState.get(socket.id)?.rooms.has(roomId)) {
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
          if (this.socketState.get(socket.id)?.rooms.has(roomId)) {
            this.handleThemeChanged(data);
          }
        } catch (err) {
          console.error('Error in theme-changed handler:', err);
        }
      });

      // Host sends playback state every ~5s so server can relay to late joiners
      socket.on('sync-heartbeat', (data: SyncHeartbeat) => {
        try {
          if (!data || !this.isValidRoomId(data.roomId)) return;
          if (typeof data.isPlaying !== 'boolean') return;
          if (typeof data.seekTime !== 'number' || !isFinite(data.seekTime)) return;
          if (typeof data.timestamp !== 'number' || !isFinite(data.timestamp)) return;
          if (this.socketState.get(socket.id)?.rooms.has(data.roomId)) {
            this.playbackState.set(data.roomId, {
              isPlaying: data.isPlaying,
              seekTime: data.seekTime,
              timestamp: data.timestamp,
            });
          }
        } catch (err) {
          console.error('Error in sync-heartbeat handler:', err);
        }
      });

      // Guest requests current playback state to sync on join
      socket.on('sync-request', (data: { roomId: string }) => {
        try {
          if (!data || !this.isValidRoomId(data.roomId)) return;
          if (!this.socketState.get(socket.id)?.rooms.has(data.roomId)) return;
          const state = this.playbackState.get(data.roomId);
          if (state) {
            socket.emit('sync-state', state);
          }
        } catch (err) {
          console.error('Error in sync-request handler:', err);
        }
      });

      // Disconnect handler — delay cleanup to avoid race with reconnection.
      // When a user switches tabs, the old socket disconnects and a new one connects.
      // If cleanup runs before the new socket joins, presence is briefly lost.
      // If cleanup runs after, we check whether the user already reconnected and skip cleanup.
      socket.on('disconnect', () => {
        try {
          this.handleDisconnect(socket);
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
  }

  private handleChangeVideo(socket: Socket, data: ChangeVideoEvent): void {
    const { roomId, newVideoId } = data;
    console.log(`change-video -> room:${roomId} videoId:${newVideoId}`);
    // Broadcast to others only — sender already updated their own state
    socket.to(roomId).emit('video-changed', newVideoId);
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
    this.io.to(roomId).emit('theme-changed', theme);
  }

  private handleDisconnect(socket: Socket): void {
    console.log('client disconnected', socket.id);
  }
}

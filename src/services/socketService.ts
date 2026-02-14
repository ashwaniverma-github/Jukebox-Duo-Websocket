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
} from '../types';

export class SocketService {
  private io: Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;
  private roomPresence: Map<string, Map<string, { id: string; name?: string; image?: string; count: number }>> = new Map();
  private socketState: Map<string, { userId?: string; rooms: Set<string> }> = new Map();

  constructor(io: Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>) {
    this.io = io;
    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    this.io.on('connection', (socket: Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>) => {
      console.log('🔌 client connected', socket.id);
      this.socketState.set(socket.id, { rooms: new Set() });

      // Join room handler
      socket.on('join-room', (roomId: string) => {
        this.handleJoinRoom(socket, roomId);
      });

      // Presence join with user info
      socket.on('presence-join', ({ roomId, user }) => {
        this.trackPresence(socket, roomId, user);
        this.broadcastPresence(roomId);
      });

      // Leave room handler - kept for compatibility but clients shouldn't call this
      // (sockets auto-leave rooms on disconnect)
      socket.on('leave-room', ({ roomId, userId }) => {
        // Only update presence, don't call socket.leave() to avoid issues
        this.decrementPresence(roomId, userId);
        this.broadcastPresence(roomId);
      });

      // Sync ping handler
      socket.on('sync-ping', () => {
        this.handleSyncPing(socket);
      });

      // Sync command handler
      socket.on('sync-command', (data: SyncCommand) => {
        // Gate by room membership via socket rooms; any room member is allowed
        const { roomId } = data;
        if (this.socketState.get(socket.id)?.rooms.has(roomId)) {
          this.handleSyncCommand(socket, data);
        }
      });

      // Change video handler
      socket.on('change-video', (data: ChangeVideoEvent) => {
        const { roomId } = data;
        if (this.socketState.get(socket.id)?.rooms.has(roomId)) {
          this.handleChangeVideo(data);
        }
      });

      // Queue updated handler
      socket.on('queue-updated', (data: QueueUpdatedEvent) => {
        const { roomId } = data;
        if (this.socketState.get(socket.id)?.rooms.has(roomId)) {
          this.handleQueueUpdated(data);
        }
      });

      // Queue removed handler
      socket.on('queue-removed', (data: QueueRemovedEvent) => {
        const { roomId } = data;
        if (this.socketState.get(socket.id)?.rooms.has(roomId)) {
          this.handleQueueRemoved(data);
        }
      });

      // Theme changed handler
      socket.on('theme-changed', (data: ThemeChangedEvent) => {
        const { roomId } = data;
        if (this.socketState.get(socket.id)?.rooms.has(roomId)) {
          this.handleThemeChanged(data);
        }
      });

      // Disconnect handler
      socket.on('disconnect', () => {
        this.handleDisconnect(socket);
        // Clean up presence contributions for this socket
        const state = this.socketState.get(socket.id);
        if (state) {
          const userId = state.userId;
          for (const roomId of state.rooms) {
            if (userId) {
              this.decrementPresence(roomId, userId);
              this.broadcastPresence(roomId);
            }
          }
        }
        this.socketState.delete(socket.id);
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

    // Increment presence count for user in the room
    if (!this.roomPresence.has(roomId)) {
      this.roomPresence.set(roomId, new Map());
    }
    const members = this.roomPresence.get(roomId)!;
    const existing = members.get(user.id);
    if (existing) {
      existing.count += 1;
    } else {
      const entry: { id: string; name?: string; image?: string; count: number } = {
        id: user.id,
        count: 1,
      };
      if (user.name !== undefined) entry.name = user.name;
      if (user.image !== undefined) entry.image = user.image;
      members.set(user.id, entry);
    }
  }

  private decrementPresence(roomId: string, userId: string): void {
    const members = this.roomPresence.get(roomId);
    if (!members) return;
    const entry = members.get(userId);
    if (!entry) return;
    entry.count -= 1;
    if (entry.count <= 0) {
      members.delete(userId);
    }
    if (members.size === 0) this.roomPresence.delete(roomId);
  }



  private broadcastPresence(roomId: string): void {
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
    console.log(`📡 sync-command → room:${roomId} cmd:${cmd} seek:${seekTime}`);
    socket.to(roomId).emit('sync-command', { cmd, timestamp, seekTime });
  }

  private handleChangeVideo(data: ChangeVideoEvent): void {
    const { roomId, newVideoId } = data;
    console.log(`change-video → room:${roomId} videoId:${newVideoId}`);
    const roomSize = this.io.sockets.adapter.rooms.get(roomId)?.size || 0;
    console.log(`Broadcasting video-changed to ${roomSize} clients in room ${roomId}`);
    this.io.to(roomId).emit('video-changed', newVideoId);
    console.log(`video-changed event emitted to room ${roomId}`);
  }

  private handleQueueUpdated(data: QueueUpdatedEvent): void {
    const { roomId, item } = data;
    console.log(`queue-updated → room:${roomId} item:${item.title}`);
    const roomSize = this.io.sockets.adapter.rooms.get(roomId)?.size || 0;
    console.log(`Broadcasting queue-updated to ${roomSize} clients in room ${roomId}`);
    this.io.to(roomId).emit('queue-updated', item);
    console.log(`queue-updated event emitted to room ${roomId}`);
  }

  private handleQueueRemoved(data: QueueRemovedEvent): void {
    const { roomId, itemId } = data;
    console.log(`queue-removed → room:${roomId} itemId:${itemId}`);
    const roomSize = this.io.sockets.adapter.rooms.get(roomId)?.size || 0;
    console.log(`Broadcasting queue-removed to ${roomSize} clients in room ${roomId}`);
    this.io.to(roomId).emit('queue-removed', itemId);
    console.log(`queue-removed event emitted to room ${roomId}`);
  }

  private handleThemeChanged(data: ThemeChangedEvent): void {
    const { roomId, theme } = data;
    console.log(`theme-changed → room:${roomId} theme:${theme}`);
    this.io.to(roomId).emit('theme-changed', theme);
  }

  private handleDisconnect(socket: Socket): void {
    console.log('client disconnected', socket.id);
  }

} 
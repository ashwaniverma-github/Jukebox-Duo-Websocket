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
} from '../types';

export class SocketService {
  private io: Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

  constructor(io: Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>) {
    this.io = io;
    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    this.io.on('connection', (socket: Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>) => {
      console.log('🔌 client connected', socket.id);

      // Join room handler
      socket.on('join-room', (roomId: string) => {
        this.handleJoinRoom(socket, roomId);
      });

      // Sync ping handler
      socket.on('sync-ping', () => {
        this.handleSyncPing(socket);
      });

      // Sync command handler
      socket.on('sync-command', (data: SyncCommand) => {
        this.handleSyncCommand(socket, data);
      });

      // Change video handler
      socket.on('change-video', (data: ChangeVideoEvent) => {
        this.handleChangeVideo(data);
      });

      // Queue updated handler
      socket.on('queue-updated', (data: QueueUpdatedEvent) => {
        this.handleQueueUpdated(data);
      });

      // Queue removed handler
      socket.on('queue-removed', (data: QueueRemovedEvent) => {
        this.handleQueueRemoved(data);
      });

      // Disconnect handler
      socket.on('disconnect', () => {
        this.handleDisconnect(socket);
      });
    });
  }

  private handleJoinRoom(socket: Socket, roomId: string): void {
    console.log(`👥 ${socket.id} joined room ${roomId}`);
    socket.join(roomId);
    const roomSize = this.io.sockets.adapter.rooms.get(roomId)?.size || 0;
    console.log(`📊 Room ${roomId} now has ${roomSize} clients`);
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
    console.log(`🎬 change-video → room:${roomId} videoId:${newVideoId}`);
    const roomSize = this.io.sockets.adapter.rooms.get(roomId)?.size || 0;
    console.log(`📊 Broadcasting video-changed to ${roomSize} clients in room ${roomId}`);
    this.io.to(roomId).emit('video-changed', newVideoId);
    console.log(`✅ video-changed event emitted to room ${roomId}`);
  }

  private handleQueueUpdated(data: QueueUpdatedEvent): void {
    const { roomId, item } = data;
    console.log(`📝 queue-updated → room:${roomId} item:${item.title}`);
    const roomSize = this.io.sockets.adapter.rooms.get(roomId)?.size || 0;
    console.log(`📊 Broadcasting queue-updated to ${roomSize} clients in room ${roomId}`);
    this.io.to(roomId).emit('queue-updated', item);
    console.log(`✅ queue-updated event emitted to room ${roomId}`);
  }

  private handleQueueRemoved(data: QueueRemovedEvent): void {
    const { roomId, itemId } = data;
    console.log(`🗑️ queue-removed → room:${roomId} itemId:${itemId}`);
    const roomSize = this.io.sockets.adapter.rooms.get(roomId)?.size || 0;
    console.log(`📊 Broadcasting queue-removed to ${roomSize} clients in room ${roomId}`);
    this.io.to(roomId).emit('queue-removed', itemId);
    console.log(`✅ queue-removed event emitted to room ${roomId}`);
  }

  private handleDisconnect(socket: Socket): void {
    console.log('❌ client disconnected', socket.id);
  }

  // Public method to get room statistics
  public getRoomStats(roomId: string): { roomSize: number; connectedClients: number } {
    const roomSize = this.io.sockets.adapter.rooms.get(roomId)?.size || 0;
    const connectedClients = this.io.engine.clientsCount;
    return { roomSize, connectedClients };
  }

  // Public method to broadcast to all clients
  public broadcastToAll(event: keyof ServerToClientEvents, data: any): void {
    this.io.emit(event, data);
  }

  // Public method to broadcast to specific room
  public broadcastToRoom(roomId: string, event: keyof ServerToClientEvents, data: any): void {
    this.io.to(roomId).emit(event, data);
  }
} 
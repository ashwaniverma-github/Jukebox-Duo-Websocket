// src/types/index.ts

export interface SyncCommand {
  roomId: string;
  cmd: 'play' | 'pause';
  timestamp: number;
  seekTime: number;
}

export interface ChangeVideoEvent {
  roomId: string;
  newVideoId: string;
}

export interface QueueItem {
  videoId: string;
  title: string;
  thumbnail?: string;
}

export interface QueueUpdatedEvent {
  roomId: string;
  item: QueueItem;
}

export interface QueueRemovedEvent {
  roomId: string;
  itemId: string;
}

export interface ServerToClientEvents {
  'sync-pong': (serverTimestamp: number) => void;
  'sync-command': (data: Omit<SyncCommand, 'roomId'>) => void;
  'video-changed': (newVideoId: string) => void;
  'queue-updated': (item: QueueItem) => void;
  'queue-removed': (itemId: string) => void;
  'room-presence': (members: { id: string; name?: string; image?: string }[]) => void;
}

export interface ClientToServerEvents {
  'join-room': (roomId: string) => void;
  'sync-ping': (clientTimestamp: number) => void;
  'sync-command': (data: SyncCommand) => void;
  'change-video': (data: ChangeVideoEvent) => void;
  'queue-updated': (data: QueueUpdatedEvent) => void;
  'queue-removed': (data: QueueRemovedEvent) => void;
  'presence-join': (data: { roomId: string; user: { id: string; name?: string; image?: string } }) => void;
  'leave-room': (data: { roomId: string; userId: string }) => void;
}

export interface InterServerEvents {
  // Add any inter-server events if needed
}

export interface SocketData {
  // Add any socket-specific data if needed
} 
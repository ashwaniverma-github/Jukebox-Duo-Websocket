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
  deletedOrder?: number;
  newCurrentIndex?: number;
}

export interface ThemeChangedEvent {
  roomId: string;
  theme: 'default' | 'love';
}

export interface SyncHeartbeat {
  roomId: string;
  isPlaying: boolean;
  seekTime: number;
  timestamp: number;
}

export interface SyncStateResponse {
  isPlaying: boolean;
  seekTime: number;
  timestamp: number;
}

export interface ServerToClientEvents {
  'sync-pong': (serverTimestamp: number) => void;
  'sync-command': (data: Omit<SyncCommand, 'roomId'>) => void;
  'video-changed': (newVideoId: string) => void;
  'queue-updated': (item: QueueItem) => void;
  'queue-removed': (data: { roomId: string; itemId: string; deletedOrder?: number; newCurrentIndex?: number }) => void;
  'room-presence': (members: { id: string; name?: string; image?: string }[]) => void;
  'theme-changed': (theme: 'default' | 'love') => void;
  'sync-state': (data: SyncStateResponse) => void;
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
  'theme-changed': (data: ThemeChangedEvent) => void;
  'sync-heartbeat': (data: SyncHeartbeat) => void;
  'sync-request': (data: { roomId: string }) => void;
}

export interface InterServerEvents {
  // Add any inter-server events if needed
}

export interface SocketData {
  // Add any socket-specific data if needed
} 
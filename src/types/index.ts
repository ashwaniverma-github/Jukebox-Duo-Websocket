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
  id: string;
  roomId?: string;
  videoId: string;
  title: string;
  thumbnail?: string;
  order: number;
  addedById?: string;
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

export interface EmojiReactionEvent {
  roomId: string;
  emoji: string;
}

export interface ServerToClientEvents {
  'sync-pong': (serverTimestamp: number) => void;
  'sync-command': (data: Omit<SyncCommand, 'roomId'>) => void;
  'video-changed': (newVideoId: string) => void;
  'queue-updated': (item: QueueItem) => void;
  'queue-removed': (data: { roomId: string; itemId: string; deletedOrder?: number; newCurrentIndex?: number }) => void;
  'room-presence': (members: { id: string; name?: string; image?: string }[]) => void;
  'theme-changed': (theme: 'default' | 'love') => void;
  'emoji-reaction': (data: { emoji: string }) => void;
  'shuffle-changed': (shuffle: boolean) => void;
  'queue-cleared': (data: { roomId: string }) => void;
}

export interface ClientToServerEvents {
  'join-room': (roomId: string) => void;
  'sync-ping': (clientTimestamp: number) => void;
  // Asks the server to replay the room's current playback state to this socket only.
  // Sent after a (re)join so a returning client snaps to the live position. The reply
  // is delivered via the normal 'sync-command' event (handled by the existing listener).
  'sync-request': (data: { roomId: string; videoId?: string }) => void;
  'sync-command': (data: SyncCommand) => void;
  'change-video': (data: ChangeVideoEvent) => void;
  'queue-updated': (data: QueueUpdatedEvent) => void;
  'queue-removed': (data: QueueRemovedEvent) => void;
  'presence-join': (data: { roomId: string; user: { id: string; name?: string; image?: string } }) => void;
  'leave-room': (data: { roomId: string; userId: string }) => void;
  'theme-changed': (data: ThemeChangedEvent) => void;
  'emoji-reaction': (data: EmojiReactionEvent) => void;
  'shuffle-changed': (data: { roomId: string; shuffle: boolean }) => void;
  'queue-cleared': (data: { roomId: string }) => void;
}

export interface InterServerEvents {
  // Add any inter-server events if needed
}

export interface SocketData {
  // Verified identity + authorization, populated by the auth middleware from the
  // signed handshake token. Never trust client-supplied values when these are set.
  userId?: string;        // verified user id (token `sub`)
  name?: string;          // verified display name
  image?: string;         // verified avatar url
  roomId?: string;        // the room this token authorizes the socket for
  syncEligible?: boolean; // true when the room's host is premium (sync unlocked)
}
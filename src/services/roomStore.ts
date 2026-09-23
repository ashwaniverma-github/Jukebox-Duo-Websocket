import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';

export interface PlaybackState {
  videoId?: string;
  queueItemId?: string;
  cmd: 'play' | 'pause';
  seekTime: number;
  timestamp: number;
  revision: number;
  generation: string;
}
export class RoomStore {
  private lastCleanup = 0;
  private local = new Map<string, { value: string; expires: number }>();
  constructor(private redis?: Redis) {}
  async now(): Promise<number> {
    if (!this.redis) return Date.now();
    const [seconds, micros] = await this.redis.time();
    return Number(seconds) * 1000 + Math.floor(Number(micros) / 1000);
  }
  async get<T>(roomId: string, field: string): Promise<T | undefined> {
    const key = `jukebox:room:${roomId}:${field}`;
    if (this.redis) {
      const value = await this.redis.get(key);
      return value ? JSON.parse(value) as T : undefined;
    }
    const value = this.local.get(key);
    if (!value || value.expires < Date.now()) { this.local.delete(key); return undefined; }
    return JSON.parse(value.value) as T;
  }
  async set(roomId: string, field: string, value: unknown): Promise<void> {
    const key = `jukebox:room:${roomId}:${field}`;
    if (this.redis) { await this.redis.set(key, JSON.stringify(value), 'EX', 86400); return; }
    // Bound fallback memory for single-instance deployments.
    if (Date.now() - this.lastCleanup > 60000) {
      this.lastCleanup = Date.now();
      for (const [id, entry] of this.local) if (entry.expires < this.lastCleanup) this.local.delete(id);
    }
    if (this.local.size >= 10000 && !this.local.has(key)) {
      const oldest = this.local.keys().next().value;
      if (oldest !== undefined) this.local.delete(oldest);
    }
    this.local.delete(key); // Refresh write order so active entries survive eviction.
    this.local.set(key, { value: JSON.stringify(value), expires: Date.now() + 86400000 });
  }
  async playback(roomId: string, state: Omit<PlaybackState, 'revision' | 'generation'>): Promise<PlaybackState> {
    if (this.redis) {
      // Assign revision and replace state atomically, so slow workers cannot overwrite
      // a newer command. Counter lives as long as playback state.
      const raw = await this.redis.eval(`
        local key = KEYS[1]
        local old = redis.call('GET', key)
        local revision = 1
        local state = cjson.decode(ARGV[1])
        if old then
          local previous = cjson.decode(old)
          revision = previous.revision + 1
          state.generation = previous.generation or state.generation
        end
        state.revision = revision
        local encoded = cjson.encode(state)
        redis.call('SET', key, encoded, 'EX', 86400)
        return encoded
      `, 1, `jukebox:room:${roomId}:playback`, JSON.stringify({ ...state, generation: randomUUID() }));
      return JSON.parse(raw as string) as PlaybackState;
    }
    // No await between reading and storing the local revision.
    const key = `jukebox:room:${roomId}:playback`;
    const previous = this.local.get(key);
    const revision = previous && previous.expires > Date.now() ? (JSON.parse(previous.value) as PlaybackState).revision + 1 : 1;
    const generation = previous && previous.expires > Date.now() ? (JSON.parse(previous.value) as PlaybackState).generation : randomUUID();
    const next = { ...state, revision, generation };
    await this.set(roomId, 'playback', next);
    return next;
  }
}

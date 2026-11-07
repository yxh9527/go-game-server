import { EventEmitter } from "node:events";
import { randomUUID } from 'node:crypto';
import { createGameSessionStore, createInMemoryGameSessionBackend } from '../../shared/rpc/game-session-store.js';

const gameSessionBackend=createInMemoryGameSessionBackend();

export class BusRpcDev {
  constructor() {
    this.events = new EventEmitter();
    this.events.setMaxListeners(100);
    this.cache = new Map();
    this.gameSessions=createGameSessionStore({backend:gameSessionBackend,instanceId:randomUUID()});
  }

  async publish(channel, payload) {
    this.events.emit(channel, payload);
  }

  async getCache(key) {
    const entry = this.cache.get(String(key));
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.cache.delete(String(key));
      return null;
    }
    return entry.value;
  }

  async setCache(key, value, ttlSeconds) {
    const ttl = Math.max(1, Math.floor(Number(ttlSeconds) || 1));
    this.cache.set(String(key), { value: String(value), expiresAt: Date.now() + ttl * 1000 });
    return true;
  }

  subscribe(channel, fn) {
    this.events.on(channel, fn);
  }

  async close() { await this.gameSessions.close(); }
}

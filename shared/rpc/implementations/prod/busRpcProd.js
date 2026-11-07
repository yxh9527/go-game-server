import { prodDeps } from "./prodDeps.js";
import { createCashCarryStore } from '../../cash-carry-store.js';
import { createGameSessionStore } from '../../game-session-store.js';
import { randomUUID } from 'node:crypto';

export class BusRpcProd {
  constructor() {
    this.redis = prodDeps.redis;
    this.cashCarry = createCashCarryStore(this.redis);
    this.gameSessions = createGameSessionStore({ redis: this.redis, instanceId: randomUUID(), required: true });
    this.sub = this.redis?.duplicate?.();
    this.handlers = new Map();
    this.sub?.on("message", (channel, message) => {
      for (const fn of this.handlers.get(channel) || []) {
        fn(message);
      }
    });
  }

  async publish(channel, payload) {
    if (!this.redis) {
      return;
    }
    await this.redis.publish(channel, payload);
  }

  async getCache(key) {
    return this.redis ? this.redis.get(String(key)) : null;
  }

  async setCache(key, value, ttlSeconds) {
    if (!this.redis) return false;
    const ttl = Math.max(1, Math.floor(Number(ttlSeconds) || 1));
    await this.redis.set(String(key), String(value), "EX", ttl);
    return true;
  }

  subscribe(channel, fn) {
    const list = this.handlers.get(channel) || [];
    list.push(fn);
    this.handlers.set(channel, list);
    this.sub?.subscribe(channel);
  }

  async close() {
    await this.gameSessions.close();
    this.sub?.disconnect();
  }
}

import { prodDeps } from "./prodDeps.js";

export class BusRpcProd {
  constructor() {
    this.redis = prodDeps.redis;
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

  subscribe(channel, fn) {
    const list = this.handlers.get(channel) || [];
    list.push(fn);
    this.handlers.set(channel, list);
    this.sub?.subscribe(channel);
  }

  async close() {
    this.sub?.disconnect();
  }
}

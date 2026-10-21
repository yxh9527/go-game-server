import { EventEmitter } from "node:events";

export class BusRpcDev {
  constructor() {
    this.events = new EventEmitter();
    this.events.setMaxListeners(100);
  }

  async publish(channel, payload) {
    this.events.emit(channel, payload);
  }

  subscribe(channel, fn) {
    this.events.on(channel, fn);
  }

  async close() {}
}

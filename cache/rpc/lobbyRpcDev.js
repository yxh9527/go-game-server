import { createMemoryStore } from "./store.js";

export class LobbyRpcDev {
  constructor() {
    this.store = createMemoryStore();
  }

  listRooms() {
    return this.store.listRooms();
  }

  listMatches() {
    return this.store.listMatches();
  }

  getMatch(id) {
    return this.store.getMatch(id);
  }

  insertMatch(row) {
    return this.store.insertMatch(row);
  }

  updateMatch(id, patch) {
    return this.store.updateMatch(id, patch);
  }

  getAward(id) {
    return this.store.getAward(id);
  }

  listTickets() {
    return this.store.listTickets();
  }

  insertTicket(row) {
    return this.store.insertTicket(row);
  }

  updateTicket(id, patch) {
    return this.store.updateTicket(id, patch);
  }

  listRates() {
    return this.store.listRates();
  }

  upsertRate(row) {
    return this.store.upsertRate(row);
  }

  listAwards() {
    return this.store.listAwards();
  }

  insertAward(row) {
    return this.store.insertAward(row);
  }

  updateAward(id, patch) {
    return this.store.updateAward(id, patch);
  }

  listBlinds() {
    return this.store.listBlinds();
  }

  insertBlinds(row) {
    return this.store.insertBlinds(row);
  }

  updateBlinds(id, patch) {
    return this.store.updateBlinds(id, patch);
  }

  listMatchPlayers() {
    return this.store.listMatchPlayers();
  }

  listMatchRooms() {
    return this.store.listMatchRooms();
  }

  countUnusedTickets(userId) {
    return this.store.countUnusedTickets(userId);
  }
}

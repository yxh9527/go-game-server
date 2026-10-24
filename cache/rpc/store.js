import { seedAwards, seedBlinds, seedMatches, seedRates, seedRooms, seedTickets } from "./seed.js";

function clone(row) {
  return JSON.parse(JSON.stringify(row));
}

function nextId(map) {
  let max = 0;
  for (const id of map.keys()) {
    if (Number(id) > max) {
      max = Number(id);
    }
  }
  return max + 1;
}

export function createMemoryStore() {
  const rooms = new Map(seedRooms().map((row) => [row.id, row]));
  const matches = new Map(seedMatches().map((row) => [row.id, row]));
  const tickets = new Map(seedTickets().map((row) => [row.id, row]));
  const rates = new Map(seedRates().map((row) => [row.currency, row]));
  const awards = new Map(seedAwards().map((row) => [row.id, row]));
  const blinds = new Map(seedBlinds().map((row) => [row.id, row]));
  const matchPlayers = [];
  const matchRooms = [];

  return {
    async listRooms() {
      return [...rooms.values()].filter((row) => Number(row.state) === 1).map(clone);
    },
    async listMatches() {
      return [...matches.values()].sort((a, b) => (a.sort_index - b.sort_index) || (b.id - a.id)).map(clone);
    },
    async getMatch(id) {
      const row = matches.get(Number(id));
      return row ? clone(row) : null;
    },
    async insertMatch(row) {
      const id = row.id || nextId(matches);
      const saved = { ...row, id };
      matches.set(id, saved);
      return clone(saved);
    },
    async updateMatch(id, patch) {
      const old = matches.get(Number(id));
      if (!old) {
        return null;
      }
      const saved = { ...old, ...patch, id: Number(id) };
      matches.set(Number(id), saved);
      return clone(saved);
    },
    async getAward(id) {
      const row = awards.get(Number(id));
      return row ? clone(row) : null;
    },
    async listTickets() {
      return [...tickets.values()].sort((a, b) => a.id - b.id).map(clone);
    },
    async insertTicket(row) {
      const id = nextId(tickets);
      const saved = { ...row, id };
      tickets.set(id, saved);
      return clone(saved);
    },
    async updateTicket(id, patch) {
      const old = tickets.get(Number(id));
      if (!old) {
        return null;
      }
      const saved = { ...old, ...patch, id: Number(id) };
      tickets.set(Number(id), saved);
      return clone(saved);
    },
    async listRates() {
      return [...rates.values()].sort((a, b) => a.id - b.id).map(clone);
    },
    async upsertRate(row) {
      const exist = rates.get(row.currency);
      if (!exist) {
        let max = 0;
        for (const item of rates.values()) {
          if (item.id > max) {
            max = item.id;
          }
        }
        const saved = { ...row, id: max + 1 };
        rates.set(row.currency, saved);
        return clone(saved);
      }
      const saved = { ...exist, rate: row.rate, update_time: row.update_time };
      rates.set(row.currency, saved);
      return clone(saved);
    },
    async listAwards() {
      return [...awards.values()].sort((a, b) => a.id - b.id).map(clone);
    },
    async insertAward(row) {
      const id = nextId(awards);
      const saved = { ...row, id };
      awards.set(id, saved);
      return clone(saved);
    },
    async updateAward(id, patch) {
      const old = awards.get(Number(id));
      if (!old) {
        return null;
      }
      const saved = { ...old, ...patch, id: Number(id) };
      awards.set(Number(id), saved);
      return clone(saved);
    },
    async listBlinds() {
      return [...blinds.values()].sort((a, b) => a.id - b.id).map(clone);
    },
    async insertBlinds(row) {
      const id = nextId(blinds);
      const saved = { ...row, id };
      blinds.set(id, saved);
      return clone(saved);
    },
    async updateBlinds(id, patch) {
      const old = blinds.get(Number(id));
      if (!old) {
        return null;
      }
      const saved = { ...old, ...patch, id: Number(id) };
      blinds.set(Number(id), saved);
      return clone(saved);
    },
    async listMatchPlayers() {
      return matchPlayers.map(clone);
    },
    async listMatchRooms() {
      return matchRooms.map(clone);
    },
    async countUnusedTickets(_userId) {
      return 0;
    },
  };
}

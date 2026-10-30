import { rel } from "../rel.js";

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

export async function createMetaService(runtime) {
  const v = runtime.hotVersion;
  const { AppError } = await rel(import.meta.url, "../errors.js", v);
  const { validateAwardJSON } = await rel(import.meta.url, "../award.js", v);
  const { DEFAULT_CURRENCY } = await rel(import.meta.url, "../constants.js", v);
  const store = runtime.store;
  async function publishMetadata(kind, row) {
    await runtime.bus?.publish('match', JSON.stringify({ event: 'match_metadata', data: JSON.stringify({ kind, row }) }));
    return row;
  }

  return {
    async listTickets() {
      return store.listTickets();
    },
    async createTicket(body) {
      const ts = nowSec();
      return store.insertTicket({
        name: body.name,
        price: body.price ?? 0,
        currency: body.currency || DEFAULT_CURRENCY,
        match_id: body.match_id ?? 0,
        num: body.num ?? 0,
        remain: body.remain ?? body.num ?? 0,
        create_time: ts,
        update_time: ts,
      });
    },
    async updateTicket(id, body) {
      const old = (await store.listTickets()).find((row) => Number(row.id) === Number(id));
      if (!old) {
        throw new AppError(404, "not found");
      }
      const saved = await store.updateTicket(id, {
        name: body.name ?? old.name,
        price: body.price ?? old.price,
        currency: body.currency || old.currency,
        match_id: body.match_id ?? old.match_id,
        num: body.num ?? old.num,
        remain: body.remain ?? old.remain,
        update_time: nowSec(),
      });
      if (!saved) {
        throw new AppError(404, "not found");
      }
      return saved;
    },
    async listRates() {
      return store.listRates();
    },
    async upsertRate(body) {
      if (!body.currency) {
        throw new AppError(400, "currency required");
      }
      const ts = nowSec();
      return store.upsertRate({
        currency: body.currency,
        rate: body.rate,
        create_time: ts,
        update_time: ts,
      });
    },
    async listAwards() {
      return store.listAwards();
    },
    async createAward(body) {
      try {
        validateAwardJSON(body.detail);
      } catch (err) {
        throw new AppError(400, err.message);
      }
      const ts = nowSec();
      return publishMetadata('award', await store.insertAward({
        name: body.name,
        detail: body.detail,
        create_time: ts,
        update_time: ts,
      }));
    },
    async updateAward(id, body) {
      const old = await store.getAward(id);
      if (!old) {
        throw new AppError(404, "not found");
      }
      const detail = body.detail ?? old.detail;
      try {
        validateAwardJSON(detail);
      } catch (err) {
        throw new AppError(400, err.message);
      }
      return publishMetadata('award', await store.updateAward(id, {
        name: body.name ?? old.name,
        detail,
        update_time: nowSec(),
      }));
    },
    async listBlinds() {
      return store.listBlinds();
    },
    async createBlinds(body) {
      const ts = nowSec();
      return publishMetadata('blinds', await store.insertBlinds({
        name: body.name,
        data: body.data,
        create_time: ts,
        update_time: ts,
      }));
    },
    async updateBlinds(id, body) {
      const list = await store.listBlinds();
      const old = list.find((row) => Number(row.id) === Number(id));
      if (!old) {
        throw new AppError(404, "not found");
      }
      return publishMetadata('blinds', await store.updateBlinds(id, {
        name: body.name ?? old.name,
        data: body.data ?? old.data,
        update_time: nowSec(),
      }));
    },
  };
}

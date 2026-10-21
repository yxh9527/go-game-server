import { rel } from "../rel.js";

const MATCH_COLUMNS = [
  "agent_id",
  "championship_name",
  "consults",
  "game_type",
  "room_type",
  "championship_type",
  "register_type",
  "register_gold",
  "service_gold",
  "currency",
  "register_ticket",
  "ticket_id",
  "allow_ticket_pay",
  "ticket_value",
  "ticket_name",
  "init_point",
  "min_player",
  "max_player",
  "delay_register_level",
  "delay_register_time",
  "register_time_limit",
  "rest_time",
  "rest_time_interval",
  "increase_bind_time",
  "rebuy_time",
  "max_buy",
  "force_show_card",
  "fix_pot",
  "total_pot",
  "free_type_pot",
  "bonus_pot",
  "bounty_pot",
  "blinds_id",
  "blind_type",
  "award_id",
  "award_json",
  "state",
  "start_time",
  "end_time",
  "sort_index",
  "current_player",
  "current_live_player",
  "blind_level",
  "big_blind",
  "small_blind",
  "settlement_type",
  "domain",
  "shield",
  "create_time",
  "update_time",
];

function pick(row) {
  const out = {};
  for (const key of MATCH_COLUMNS) {
    if (row[key] !== undefined) {
      out[key] = row[key];
    }
  }
  return out;
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

export async function createMatchService(runtime) {
  const v = runtime.hotVersion;
  const constants = await rel(import.meta.url, "../constants.js", v);
  const { newEnvelope } = await rel(import.meta.url, "../envelope.js", v);
  const { validateAwardJSON } = await rel(import.meta.url, "../award.js", v);
  const { AppError } = await rel(import.meta.url, "../errors.js", v);
  const store = runtime.store;

  async function publish(event, payload) {
    await runtime.bus.publish(
      constants.REDIS_CHANNEL_MATCH,
      newEnvelope(event, payload),
    );
  }

  async function fillAward(row) {
    if (row.award_json || !row.award_id) {
      return;
    }
    const award = await store.getAward(row.award_id);
    if (!award) {
      throw new AppError(404, "award template not found");
    }
    row.award_json = award.detail;
  }

  async function get(id) {
    const row = await store.getMatch(id);
    if (!row) {
      throw new AppError(404, "not found");
    }
    return row;
  }

  return {
    async list() {
      return store.listMatches();
    },
    get,
    async create(body) {
      const row = pick(body);
      row.currency = row.currency || constants.DEFAULT_CURRENCY;
      row.game_type = row.game_type || constants.TEXAS_GAME_TYPE;
      row.room_type = row.room_type || constants.TEXAS_MATCH_ROOM;
      row.state = row.state ?? constants.MATCH_STATE_DRAFT;
      await fillAward(row);
      try {
        validateAwardJSON(row.award_json);
      } catch (err) {
        throw new AppError(400, err.message);
      }
      const ts = nowSec();
      row.create_time = ts;
      row.update_time = ts;
      const created = await store.insertMatch(row);
      await publish(constants.EVENT_MATCH_UPSERT, created);
      return created;
    },
    async update(id, body) {
      const old = await get(id);
      if (old.state === constants.MATCH_STATE_FINISHED || old.state === constants.MATCH_STATE_CANCELLED) {
        throw new AppError(400, "field locked after match started");
      }
      if (old.state === constants.MATCH_STATE_RUNNING) {
        const next = {
          championship_name: body.championship_name ?? old.championship_name,
          consults: body.consults ?? old.consults,
          update_time: nowSec(),
        };
        const saved = await store.updateMatch(id, next);
        await publish(constants.EVENT_MATCH_UPSERT, saved);
        return saved;
      }
      const row = { ...pick(old), ...pick(body) };
      row.currency = row.currency || old.currency;
      row.room_type = row.room_type || old.room_type;
      row.state = old.state;
      row.current_player = old.current_player;
      row.current_live_player = old.current_live_player;
      row.create_time = old.create_time;
      row.update_time = nowSec();
      await fillAward(row);
      try {
        validateAwardJSON(row.award_json);
      } catch (err) {
        throw new AppError(400, err.message);
      }
      const keys = MATCH_COLUMNS.filter((k) => k !== "create_time");
      const patch = {};
      for (const k of keys) {
        patch[k] = row[k];
      }
      const saved = await store.updateMatch(id, patch);
      await publish(constants.EVENT_MATCH_UPSERT, saved);
      return saved;
    },
    async changeState(id, to) {
      const old = await get(id);
      if (!constants.canTransitMatch(old.state, to)) {
        throw new AppError(400, "invalid match state");
      }
      const endTime = to === constants.MATCH_STATE_FINISHED || to === constants.MATCH_STATE_CANCELLED
        ? Date.now()
        : old.end_time;
      const saved = await store.updateMatch(id, { state: to, end_time: endTime, update_time: nowSec() });
      await publish(constants.EVENT_MATCH_STATE, saved);
      return saved;
    },
  };
}

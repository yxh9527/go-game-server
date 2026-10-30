import assert from "node:assert/strict";
import test from "node:test";
import { attachMatchMetadata, createMatchStore } from "../../hall/src/store.js";

test("apply match envelope updates memory only", () => {
  const store = createMatchStore();
  store.replaceMatches([{ id: 2, state: 1, championship_name: "old" }]);
  store.applyEnvelope(JSON.stringify({
    event: "match_state",
    data: JSON.stringify({ id: 2, state: 2, championship_name: "new" }),
  }));
  assert.equal(store.getMatch(2).state, 2);
  assert.equal(store.getMatch(2).championship_name, "new");
});

test('reward and blind metadata updates preserve resident snapshot ordering and references', () => {
  const store = createMatchStore(), apply = store.applyEnvelope;
  store.replaceMetadata({ awards: [{ id: 1, detail: 'old' }], blinds: [{ id: 2, data: 'old' }] });
  assert.equal(attachMatchMetadata(store), store);
  assert.equal(store.applyEnvelope, apply);
  store.applyEnvelope({ event: 'match_snapshot', data: { sequence: 4, match: { id: 7 }, players: [], tables: [] } });
  for (const [kind, row] of [['award', { id: 1, detail: 'new' }], ['blinds', { id: 2, data: 'new' }]]) {
    store.applyEnvelope(JSON.stringify({ event: 'match_metadata', data: JSON.stringify({ kind, row }) }));
  }
  store.applyEnvelope({ event: 'match_snapshot', data: { sequence: 3, match: { id: 7, state: 2 }, players: [{ match_id: 7, player_id: 1 }] } });
  assert.equal(store.getAward(1).detail, 'new');
  assert.equal(store.getBlinds(2).data, 'new');
  assert.equal(store.getPlayer(7, 1), null);
  assert.equal(store.getMatch(7).state, undefined);
});

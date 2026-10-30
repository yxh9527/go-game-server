import assert from "node:assert/strict";
import test from "node:test";
import { MATCH_STATE_DRAFT, MATCH_STATE_REGISTERING, isListedMatch, toClientMatch } from "../../hall/src/to-client.js";

test("draft matches stay out of hall list", () => {
  assert.equal(isListedMatch({ state: MATCH_STATE_DRAFT }), false);
  assert.equal(isListedMatch({ state: MATCH_STATE_REGISTERING }), true);
});

test("client match keeps championshipName as json string", () => {
  const name = "[{\"lang\":\"zh_cn\",\"championshipName\":\"德州每日免费赛\"}]";
  const out = toClientMatch({
    id: 2,
    state: MATCH_STATE_REGISTERING,
    championship_name: name,
    start_time: 1791964800000,
    create_time: 1791888191,
    room_type: 101,
    force_show_card: 1,
    fix_pot: 1,
  }, { gameServer: "127.0.0.1:11041" });
  assert.equal(typeof out.championshipName, "string");
  assert.equal(JSON.parse(out.championshipName)[0].championshipName, "德州每日免费赛");
  assert.equal(out.roomType, 101);
  assert.equal(out.forceShowCard, true);
  assert.equal(out.startDate, "1791964800000");
  assert.equal(out.createTime, "1791888191000");
  assert.equal(out.register, false);
  assert.equal(out.domain, "127.0.0.1:11041");
});

test('native tournament tabs show configured money and tickets, actual players and blind strings', () => {
  const out = toClientMatch({ id: 8, currency: 'CNY', state: 2, award_json: JSON.stringify([
    { rank: 2, items: [{ kind: 'ticket', ticketId: 4, amount: '3' }] },
    { rank: 1, items: [{ kind: 'money', currency: 'CNY', amount: '15000' }, { kind: 'ticket', ticketId: 4, amount: '1' }] },
  ]) }, {
    players: [
      { player_id: 12, name: 'eliminated', points: 0, status: 2, rank: 3, room_id: 0 },
      { player_id: 11, name: 'second', points: 5000, status: 4, room_id: 701 },
      { player_id: 10, name: 'leader', avatar: '/avator/90007.png', points: 10000, status: 4, room_id: 702 },
    ],
    blinds: { data: JSON.stringify([{ min: 50, max: 100, interval: 180 }, { min: 100, max: 200, interval: 180 }]) },
  });
  assert.deepEqual(out.MTTRankPrices.map(p => [p.rank, p.from, p.to, p.price, p.ticketNums]), [
    ['1/1', 1, 1, 15000, 1], ['2/2', 2, 2, 0, 3],
  ]);
  assert.deepEqual(out.MTTUserRanks.map(p => [p.userId, p.userName, p.point, p.roomId]), [
    [10, 'leader', 10000, 702], [11, 'second', 5000, 701], [12, 'eliminated', 0, 0],
  ]);
  assert.equal(out.MTTUserRanks[0].icon, '/avator/90007.png');
  assert.match(out.MTTUserRanks[1].icon, /^\/avator\/\d+\./);
  assert.deepEqual(out.blindConfig, ['1/50/100', '2/100/200']);
  assert.equal(out.increaseBindTime, 3);
});

test('frozen prizes and blinds override changed templates; absent players remain empty', () => {
  const out = toClientMatch({ id: 9, state: 1, currency: 'CNY',
    award_json: JSON.stringify([{ rank: 1, items: [{ kind: 'money', currency: 'CNY', amount: '100' }] }]),
    blind_config: [{ min: 5, max: 10, interval: 300 }],
  }, { award: { detail: '[]' }, blinds: { data: '[{"min":500,"max":1000,"interval":600}]' } });
  assert.equal(out.MTTRankPrices[0].price, 100);
  assert.deepEqual(out.blindConfig, ['1/5/10']);
  assert.equal(out.increaseBindTime, 5);
  assert.deepEqual(out.MTTUserRanks, []);
  const fallback = toClientMatch({ id: 10, small_blind: 50, big_blind: 100, currency: 'CNY' }, {
    award: { detail: '[{"rank":1,"items":[{"kind":"money","currency":"CNY","amount":"50000"}]}]' },
  });
  assert.equal(fallback.MTTRankPrices[0].price, 50000);
  assert.deepEqual(fallback.blindConfig, ['1/50/100']);
  assert.equal(fallback.increaseBindTime, 0);
});

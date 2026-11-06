import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseAction, chooseExchange, chooseQue, decisionContext, danger } from '../../../../game-server/src/games/mahjong/robot.js';
import { roomRules } from '../../../../game-server/src/games/mahjong/config.js';
import { suit, contains } from '../../../../game-server/src/games/mahjong/tiles.js';
import { MahjongGame } from '../../../../game-server/src/games/mahjong/MahjongGame.js';
import * as engine from '../../../../game-server/src/games/mahjong/engine.js';

test('known human waits change discard and prevent a robbable added kong', () => {
  const cards = [4, 8, 9, 10, 11, 12, 13, 14, 18, 19, 20, 21, 22, 23];
  const context = { rules: roomRules({ room_type: 28, play_mode: 2 }), groups: [], opponents: [
    { cards: [0, 0, 0, 1, 2, 3, 9, 10, 11, 18, 19, 20, 4], groups: [], queType: 0, ting: false },
  ] };
  assert.ok(danger(4, context) > danger(8, context));
  const input = { cards, family: 'csmj', context, options: [{ type: 2 }, { type: 5, card: 4 }] };
  assert.deepEqual(chooseAction(input, () => 0), { type: 2, card: 8 });
  assert.equal(suit(chooseAction({ ...input, queType: 1 }, () => 0).card), 1);
  assert.deepEqual(chooseAction({ ...input, ting: true, drawn: 4 }, () => 0), { type: 2, card: 4 });
  assert.equal(chooseAction({ ...input, options: [{ type: 8, card: 4 }, { type: 2 }] }).type, 8);
});

test('exchange keeps physical tiles and suited triples, and context never reads another bot or the wall', () => {
  const cards = [0, 0, 1, 2, 3, 4, 9, 10, 11, 18, 19, 20, 22, 23];
  const selected = chooseExchange(cards);
  assert.equal(selected.length, 3);
  assert.equal(new Set(selected.map(suit)).size, 1);
  assert.ok(contains(cards, selected));
  assert.ok([1, 2, 3].includes(chooseQue(cards)));
  const actor = { uid: 1, bot: true, groupCards: [] }, bot = { uid: 3, bot: true };
  const human = { uid: 2, handCards: [0, 1, 2, 3], groupCards: [], queType: 0 };
  const table = { hand: { rules: roomRules({ room_type: 26, play_mode: 1 }), players: [actor, human, bot] } };
  Object.defineProperty(bot, 'handCards', { get() { throw new Error('bot hand read'); } });
  Object.defineProperty(table.hand, 'deck', { get() { throw new Error('wall read'); } });
  assert.deepEqual(decisionContext(table, actor).opponents[0].cards, human.handCards);
});

test('all three Mahjong families complete mixed two/four-player hands with conserved funded chips', () => {
  const game = new MahjongGame(), io = { env: 'dev', broadcast() {}, forEachPlayer() {} };
  for (const [type, mode] of [[26, 1], [26, 0], [28, 2], [28, 4], [30, 1], [30, 0]]) {
    const table = game.createTable(870000 + type * 10 + mode, type,
      { room_type: type, play_mode: mode, ante: 10, carry_min: 2000, tax_percent: 0 });
    table.members = Array.from({ length: table.roomRules.maxPeople }, (_, pos) => ({
      uid: pos + 1, pos, point: 100000, bot: pos > 0, tuoGuanState: pos === 0,
    }));
    engine.begin(io, table, 1000);
    let now = 1000, turns = 0;
    while (table.hand && turns++ < 2500) { now += 1000; engine.tick(io, table, now); }
    assert.equal(table.hand, null, 'mixed hand must finish without rejected actions');
    assert.ok(table.members.every(p => p.point >= 0 && Number.isSafeInteger(p.point)));
    assert.equal(table.members.reduce((sum, p) => sum + p.point, 0), table.members.length * 100000);
  }
});

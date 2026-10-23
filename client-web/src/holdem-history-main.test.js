import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { createTexasTable, texasHistoryDetail, texasHistoryPayload } from "../../game-server/src/games/holdem/engine.js";
import { evaluate7 } from "../../game-server/src/games/holdem/cards.js";

// The current historyContent prefab uses these main-bundle components, not
// DzpkHistoryDetail in the older Holdem-bundle panel. Exercise the real parser
// and renderer together with the server's actual detail/list payloads.
const bundle = fs.readFileSync(new URL("../../static/client/2.0.1279/assets/main/index.88f4e.js", import.meta.url), "utf8");

function method(module, anchor, next, context) {
  const moduleStart = bundle.indexOf("'" + module + "':[");
  const start = bundle.indexOf(anchor, moduleStart);
  const end = bundle.indexOf(next, start);
  assert.ok(moduleStart >= 0 && start >= moduleStart && end > start);
  return vm.runInNewContext("(" + bundle.slice(start + anchor.length, end) + ")", context);
}

function label() {
  return { string: "", node: {}, setString() {}, clean() {} };
}

function list() {
  return {
    cards: [],
    updateList(cards, bestFive = []) { this.cards = Array.from(cards); this.bestFive = Array.from(bestFive); },
    clear() { this.cards = []; },
  };
}

function rowRenderer(model) {
  const row = {
    node_titles: [],
    lb_positionType: label(), lb_name: label(), lb_type: label(), lb_totalWin: label(),
    commonNd: { active: true },
    superList_holds: list(), superList_commons: list(),
    getCardTypeLangKey(data) { return "cardType" + data.cardType; },
  };
  const render = method("HoldemHistoryOpenCardItem", "M['prototype']['updateObject']=", ",M['prototype']['clear']=", {
    J: ["", "BTN", "SB", "BB", "STR", "UTG", "UTG_1"],
    B: { default: { colorFromHex: (color) => color, limitLabelCharacters(target, name) { target.string = name; } } },
    D: { default: { transformLmCoinTrue: (score) => score / 100 } },
    E: { default: { userData: { uid: 10001 } } },
    F: { HoldemHistoryModel: {} },
    z: { SingleFactory: { getInstance: () => model } },
  });
  row.update = (data, index = 0) => render.call(row, data, index);
  return row;
}

function replayTable() {
  const table = createTexasTable(700016, 19, { small_blind: 10, big_blind: 20 });
  const board = [1, 15, 29, 43, 6];
  const holes = [[9, 10], [22, 23], [35, 36], [48, 49], [12, 25], [38, 51]];
  table.history.push({
    gameRoomId: table.roomId, currentInningNum: 1, pot: 240, forceShowCard: false,
    firstGameList: holes.map((hole, index) => {
      const evaluated = evaluate7([...hole, ...board]);
      return {
        uid: index + 1, userName: "Bot" + index, posName: index + 1,
        score: index === 0 ? 50 : -10, isWin: index === 0, openingPoint: 1000,
        cards: [...hole, ...board], handPais: hole, showCards: hole, commonPoker: board,
        cardTypeInfo: { cardTypeId: evaluated.cardTypeId, handCardList: evaluated.best5 },
        operateList: [],
      };
    }),
    secondGameList: [], roundEvents: [],
  });
  return table;
}

test("original Holdem parser renders two hole cards and five board cards for six players", () => {
  const table = replayTable();
  const replay = texasHistoryPayload(table).playBackList[0];
  const detail = texasHistoryDetail(table, 1);
  let stage;
  const model = {
    _stageAndOptsMap: new Map(), gameRecordDetailMap: {}, _currentPlayBack: replay,
    getCurrentPlayBack() { return this._currentPlayBack; },
    getUserScoreData(uid) { return this._currentPlayBack.firstGameList.find((player) => player.uid === uid); },
    getMemberInfo(uid) { return this.detailData.memberResults.find((player) => player.userInfo.uid === uid); },
    recordDetailCallBack(summary, timeline, showdown) { stage = showdown; },
  };
  const parse = method("HoldemHistoryModel", "z['prototype']['onPushRecordDetail']=", ",z['prototype']['checkToShowSendCards']=", {
    q: { GameState: { BET_FRONT: 1, BET_BLIND: 2, BET_PERFLOP: 4 } },
    v: { default: { userData: { uid: 10001 } } },
    w: { default: { SHOW: 11 } },
  });
  parse.call(model, detail);
  assert.equal(stage.playerList.length, 6);
  assert.deepEqual(Array.from(stage.cardList), table.history[0].firstGameList[0].commonPoker);
  const row = rowRenderer(model);
  for (let index = 0; index < stage.playerList.length; index++) {
    const player = stage.playerList[index];
    // op=46 handPais is the two hole cards, not the evaluated five-card hand.
    assert.equal(player.holdCards.length, 2);
    assert.equal(player.commonCards.length, 5);
    row.superList_commons.updateList(player.commonCards);
    row.commonNd.active = true;
    row.update(player, index);
    const stored = table.history[0].firstGameList.find((entry) => entry.uid === player.uid);
    assert.deepEqual(row.superList_holds.cards, stored.showCards);
    assert.deepEqual(row.superList_commons.cards, stored.commonPoker);
    assert.equal(new Set([...row.superList_holds.cards, ...row.superList_commons.cards]).size, 7);
    assert.equal(model.getUserScoreData(player.uid).cardTypePokers.length, 5);
    const highlighted = [row.superList_holds, row.superList_commons]
      .flatMap((list) => list.cards.filter((card) => list.bestFive.includes(card)));
    assert.equal(highlighted.length, 5);
    assert.deepEqual(highlighted.slice().sort((a, b) => a - b),
      stored.cardTypeInfo.handCardList.slice().sort((a, b) => a - b));
  }
});

for (const storedCount of [2, 5, 7]) {
  test("server adapts " + storedCount + " stored cards to the original detail contract", () => {
    const table = replayTable();
    const stored = table.history[0].firstGameList[0];
    stored.handPais = storedCount === 2 ? stored.showCards.slice()
      : storedCount === 5 ? stored.cardTypeInfo.handCardList.slice() : stored.cards.slice();
    const before = structuredClone(table.history);
    const player = texasHistoryPayload(table).playBackList[0].firstGameList[0];
    const detail = JSON.parse(texasHistoryDetail(table, 1).exploitsInfoMsgs[0].inningResults)[0];
    const row = rowRenderer({ getUserScoreData: () => player, getCurrentPlayBack: () => ({ firstGameList: [player] }) });
    row.update({ uid: 1, posName: 1, name: "Bot", cardType: detail.cardTypeId, score: detail.score,
      holdCards: detail.handPais, commonCards: detail.commonPokerList });
    assert.deepEqual(row.superList_holds.cards, stored.showCards);
    assert.deepEqual(row.superList_commons.cards, stored.commonPoker);
    assert.deepEqual(detail.cardTypeInfo.handCardList, stored.cardTypeInfo.handCardList);
    assert.deepEqual(table.history, before);
  });
}

test("reusing an active showdown row clears previous cards without revealing hidden cards", () => {
  const player = { uid: 1, score: 50, cardTypePokers: [9, 15, 29, 43, 6] };
  const row = rowRenderer({ getUserScoreData: () => player, getCurrentPlayBack: () => ({ firstGameList: [player] }) });
  row.update({ uid: 1, posName: 1, name: "Bot", cardType: 2, score: 50, holdCards: [9, 10], commonCards: [1, 15, 29, 43, 6] });
  assert.equal(row.superList_holds.cards.length, 2);
  assert.equal(row.superList_commons.cards.length, 5);
  row.update({ uid: 1, posName: 1, name: "Bot", cardType: null, score: 50, holdCards: [-1, -1], commonCards: [] });
  assert.deepEqual(row.superList_holds.cards, []);
  assert.deepEqual(row.superList_commons.cards, []);
});

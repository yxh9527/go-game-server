import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

// Execute the shipped rendering method so the test counts actual card nodes,
// including cards accidentally appended by a second rendering loop.
const bundle = fs.readFileSync(new URL("../../static/client/2.0.1279/assets/Holdem/index.55219.js", import.meta.url), "utf8");
const anchor = "O['prototype']['setupShowCardsStage']=";
const start = bundle.indexOf(anchor);
const end = bundle.indexOf(",O['prototype']['updatePokerFaceBack']=", start);
assert.ok(start >= 0 && end > start, "Holdem showdown renderer must exist");

function node(name = "") {
  const named = new Map();
  const value = {
    name,
    active: true,
    children: [],
    getChildByName(key) {
      if (!named.has(key)) {
        named.set(key, node(key));
        this.children.push(named.get(key));
      }
      return named.get(key);
    },
    addChild(child) { this.children.push(child); },
    removeAllChildren() { this.children = []; named.clear(); },
    getComponent() { return component; },
  };
  const component = { node: value, setString() {}, clean() {} };
  return value;
}

function viewFor(results, operations = [{ operationType: 11, pot: 200 }]) {
  const view = {
    _settleResults: results,
    _allOperations: operations,
    showCardsNd: node(),
    detailCardPref: "card",
    detailCardsItemPref: "player",
    isAllinRepeat() { return this._settleResults.some((row) => row.secondCardTypeInfo); },
    getMemberInfo(uid) { return { posName: 1, userInfo: { uid, name: `player-${uid}` } }; },
  };
  const cc = {
    Label: "label", Sprite: "sprite", SpriteFrame: "frame",
    instantiate(prefab) { return node(prefab); },
    resources: { load(path, type, callback) { callback(null, { name: path.split("/").at(-1) }); } },
  };
  const render = vm.runInNewContext(`(${bundle.slice(start + anchor.length, end)})`, {
    cc,
    H: { default: { userData: { uid: 1 } } },
    E: { default: { SHOW: 11 } },
    B: { default: { colorFromHex: (color) => color, limitLabelCharacters(label, name) { label.string = name; } } },
    z: { default: "localized-label" },
    I: ["", "BTN"],
  });
  view.render = () => render.call(view);
  return view;
}

const board = [3, 4, 5, 6, 7];
const bestFive = [1, 3, 4, 5, 6];
function player(overrides = {}) {
  return {
    uid: 1, score: 100, firstScore: 100, secondScore: 100,
    handPais: [1, 2, ...board],
    commonPokerList: board,
    cardTypeInfo: { cardTypeId: 5, handCardList: bestFive },
    ...overrides,
  };
}

function cardsIn(container) {
  return container.children.map((child) => Number(child.getComponent().spriteFrame.name));
}

function assertShowdown(view, stageName, expected) {
  const stage = view.showCardsNd.getChildByName(stageName);
  const rows = stage.getChildByName("content").children;
  assert.equal(rows.length, expected.length);
  rows.forEach((row, index) => {
    const cards = row.getChildByName("cardsNd");
    assert.deepEqual(cardsIn(cards.getChildByName("holdsNd")), expected[index]);
    assert.equal(cards.getChildByName("commonsNd").children.length, 0);
  });
}

for (const handPais of [[1, 2], bestFive, [1, 2, ...board]]) {
  test(`Holdem showdown renders best five with ${handPais.length} stored cards`, () => {
    const view = viewFor([player({ handPais }), player({ uid: 2, score: -100 })]);
    view.render();
    assertShowdown(view, "firstNd", [bestFive, bestFive]);
    assert.deepEqual(cardsIn(view.showCardsNd.getChildByName("firstNd").getChildByName("topNd").getChildByName("cardsNd")), board);
    view.render();
    assertShowdown(view, "firstNd", [bestFive, bestFive]);
  });
}

test("Holdem repeated showdown uses each run's own best five", () => {
  const secondBest = [2, 8, 9, 10, 11];
  const repeatedCards = {
    secondCommonPokerList: [8, 9, 10, 11, 12],
    secondCardTypeInfo: { cardTypeId: 5, handCardList: secondBest },
  };
  const view = viewFor([
    player(repeatedCards),
    player({ ...repeatedCards, uid: 2, score: -100, firstScore: -100, secondScore: -100 }),
  ]);
  view.render();
  assertShowdown(view, "firstNd", [bestFive, bestFive]);
  assertShowdown(view, "secondNd", [secondBest, secondBest]);
});

test("Holdem showdown does not add players with unrevealed cards", () => {
  const view = viewFor([player(), player({ uid: 2, score: -100, handPais: [], cardTypeInfo: undefined })]);
  view.render();
  assertShowdown(view, "firstNd", [bestFive]);
});

test("Holdem non-showdown self view retains its original card display", () => {
  const view = viewFor([player({ handPais: [1, 2], cardTypeInfo: undefined })], [{ operationType: 5, pot: 20 }]);
  view.render();
  const cards = view.showCardsNd.getChildByName("firstNd").getChildByName("content").children[0].getChildByName("cardsNd");
  assert.deepEqual(cardsIn(cards.getChildByName("holdsNd")), [1, 2]);
  assert.deepEqual(cardsIn(cards.getChildByName("commonsNd")), board);
});

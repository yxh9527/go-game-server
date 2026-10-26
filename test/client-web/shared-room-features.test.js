import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { ranking } from "../../game-server/src/core/room-features.js";
import { fairCodeDetail } from "../../game-server/src/core/fair-code.js";
import { beginHand, createTexasTable, onTexasAction, texasRoomInfo, texasConf } from "../../game-server/src/games/holdem/engine.js";
import { HoldemGame } from "../../game-server/src/games/holdem/HoldemGame.js";
import { encodeFrame, decodeFrame } from "../../game-server/src/codec.js";
import { PUSH, SEND } from "../../game-server/src/messages.js";
import { OP } from "../../game-server/src/games/holdem/op.js";
import { ZjhGame } from "../../game-server/src/games/zjh/ZjhGame.js";
import * as robot from "../../game-server/src/core/robot.js";
import { createHandler } from "../../game-server/src/create-handler.js";
import { createRegistry } from "../../game-server/src/registry.js";
import { createRoomLogic } from "../../hall/src/rooms.js";
import * as hallDecode from "../../hall/src/decode.js";

const main = fs.readFileSync(new URL("../../static/client/2.0.1279/assets/main/index.88f4e.js", import.meta.url), "utf8");
const holdem = fs.readFileSync(new URL("../../static/client/2.0.1279/assets/Holdem/index.55219.js", import.meta.url), "utf8");
const multyBet = fs.readFileSync(new URL("../../static/client/2.0.1279/assets/BairenMultyBet/index.74b50.js", import.meta.url), "utf8");
function method(bundle, anchor, next, globals = {}) {
  const start = bundle.indexOf(anchor);
  const end = bundle.indexOf(next, start);
  assert.ok(start >= 0 && end > start);
  return vm.runInNewContext("(" + bundle.slice(start + anchor.length, end) + ")", globals);
}

const convertSecondsToDHMS = method(main, "U['convertSecondsToDHMS']=", ",U['keepDecimal']=");

test("original Bairen socket selector and unsubscribe complete for ordinary room entry data", { timeout: 2000 }, async () => {
  for (const separateServer of [false, true]) {
    const connectRoomData = createRoomLogic(hallDecode).enterRoomPayload({ room_type: 19, game_room_config_id: 70 }, {}, {
      game_server: "room.example:443", hundred_server: separateServer ? "hundred.example:443" : "room.example:443",
    });
    const registry = createRegistry();
    const table = createTexasTable(connectRoomData.roomId, 19, { carry_min: 500 });
    const session = { userId: 63, roomId: table.roomId, gameId: table.gameId, inRoom: true,
      authenticated: true, wallet: 500 };
    table.members.push({ uid: 63, name: "player", pos: 0, point: 500 });
    registry.setTable(table.roomId, table);
    const callbacks = new Map();
    const received = [];
    const socket = { readyState: 1, send(raw) {
      const frame = decodeFrame(raw);
      received.push(frame);
      callbacks.get(frame.msgid)?.(frame.payload);
    } };
    registry.bind(socket, session);
    const handler = await createHandler({ hotVersion: "original-unsubscribe", registry, configs: [], findConfig: () => null,
      wallet: { credit() { assert.fail("unsubscribe must not credit"); }, persist() { assert.fail("unsubscribe must not persist"); } },
      log: { info() {}, error() {} },
    });
    const pending = [];
    const transport = (socketUrl) => ({ socketUrl, send(id, payload) {
      pending.push(Promise.resolve().then(() => handler.onMessage(socket, encodeFrame(id, payload))));
    } });
    const primary = transport("wss://room.example:443/");
    const secondary = transport(separateServer ? "wss://hundred.example:443/" : "");
    const helper = {};
    Object.defineProperty(helper, "roomSocket", { get: method(multyBet,
      "Object['defineProperty'](P,'roomSocket',{'get':", ",'enumerable':", {
        G: { default: { canKiwi: false } }, E: { default: { instance: { connectRoomData } } },
        C: { default: { ins: primary } }, D: { default: { ins: secondary } },
        A: { default: { getUrlDomain: (url) => url.replace(/^wss?:\/\//, "").replace(/\/$/, "") } },
        console: { log() {} },
      }) });
    helper.sendMsg = method(multyBet, "P['sendMsg']=", ",P['toastTip']=");
    const unsubscribe = method(multyBet, "K['prototype']['sendUnregRoomsReq']=", ",K['prototype']['sendRoomBetReq']=", {
      C: { default: { offByTargetName: (id) => callbacks.delete(id), on: (id, callback) => callbacks.set(id, callback) } },
      E: { BRMBDef: { Request: SEND, Response: PUSH } }, F: { default: helper },
    });
    const viewModel = {};
    const before = JSON.stringify(table);
    for (const inRoom of [true, false]) {
      session.inRoom = inRoom;
      assert.equal(await unsubscribe.call(viewModel), 0, "original promise resolves using 6225 without a client hook");
      assert.equal(session.inRoom, inRoom);
      assert.equal(session.wallet, 500);
      assert.equal(JSON.stringify(table), before, "auxiliary unsubscribe cannot remove seats or alter main room state");
    }
    await Promise.all(pending);
    assert.equal(helper.roomSocket, separateServer ? secondary : primary);
    assert.deepEqual(received.map((frame) => frame.msgid), [PUSH.MB_UNREG_ROOMS_RES, PUSH.MB_UNREG_ROOMS_RES]);
  }
});

test("original holdem exit handler returns observers and seated players to the API hall", async () => {
  for (const seated of [false, true]) {
    const registry = createRegistry();
    const game = new HoldemGame();
    const table = game.createTable(700016, 19, { carry_min: 500 });
    const session = { userId: 62, name: "player", roomId: table.roomId, gameId: game.id, inRoom: true, wallet: seated ? 500 : 1000 };
    if (seated) table.members.push({ uid: session.userId, name: session.name, pos: 0, point: 500, state: 1 });
    else game.watch(table, session);
    registry.setTable(table.roomId, table);
    const received = [];
    const ws = { readyState: 1, send(frame) { received.push(decodeFrame(frame)); } };
    registry.bind(ws, session);
    const handler = await createHandler({ hotVersion: "client-exit", registry, configs: [], findConfig: () => null,
      wallet: { async persist() {} }, log: { info() {}, error() {} },
    });
    let returnedToHall = 0;
    const globals = {
      ad: { default: { userData: { uid: session.userId } } },
      aw: { default: { ReportLog() {} } },
      ai: { Holdem_audio: { ins: { leaveRoom() {} } } },
      ac: { default: { isApi: () => true, gotoApiHall: () => { returnedToHall += 1; } } },
    };
    const room = { _conf: game.roomInfo(table), dispatchEventAll() {},
      checkToShowStartGameAndInviteFriend() {}, checkToShowWaitNextRound() {},
    };
    room.levelRoom = method(holdem, "aI['prototype']['levelRoom']=", ",aI['prototype']['updateBlindDispalyInfo']=", globals);
    const exit = method(holdem, "aI['prototype']['userLevelRoom']=", ",aI['prototype']['userLevelRoomData']=", globals);
    await handler.onMessage(ws, encodeFrame(SEND.SEND_LEVEL_OUT));
    for (const frame of received) if (frame.msgid === PUSH.USER_LEVEL_ROOM) exit.call(room, frame.payload);
    assert.equal(returnedToHall, 1, seated ? "seated player returns" : "observer returns");
    assert.equal(session.wallet, 1000);
  }
});

for (const type of [19, 25]) {
  test(type + ": original client shows robot buy-in through incremental seat messages", (t) => {
    let now = 1_800_000_000_000;
    t.mock.method(Date, "now", () => now);
    const game = type === 19 ? new HoldemGame() : new ZjhGame();
    const table = game.createTable(700012, type, { robot_behavior: { joinProbability: 1, leaveProbability: 0,
      checkMinMs: 1000, checkMaxMs: 1000, carryMinMs: 1000, carryMaxMs: 1000 } });
    table.botTarget = 1;
    game.watch(table, { userId: 42, name: "human observer", wallet: 1000 });
    const received = [];
    const ctx = { table, send() {}, io: { broadcast(id, payload) {
      received.push(decodeFrame(encodeFrame(id, payload)));
    } } };
    const conf = JSON.parse(JSON.stringify(game.roomInfo(table)));
    const root = new URL("../../static/client/2.0.1279/assets/Zjh/", import.meta.url);
    const source = type === 19 ? holdem : fs.readFileSync(new URL(fs.readdirSync(root)
      .find((file) => /^index.*[.]js$/.test(file)), root), "utf8");
    const owner = type === 19 ? "aI" : "ay";
    const seats = type === 19 ? "Y" : "U";
    const events = new Proxy({}, { get: (_obj, key) => key });
    const room = { _conf: conf, _levelList: [], _curStatus: "BET_PERFLOP", initRoomInfo() {},
      getSeatByID: (uid) => conf.memberList.find((m) => m.userInfo?.uid === uid),
      getMyMemberInfo: () => null, getMyObMemberInfo: () => null,
      dispatchEventAll() {}, checkToShowStartGameAndInviteFriend() {}, checkToShowWaitNextRound() {},
    };
    const cc = { app: { gameRoom: room } };
    const join = method(source, owner + "['prototype']['userJoinRoom']=", "," + owner + "['prototype']['userstandUpRoom']=", {
      cc, a7: { Evts: events }, a0: { Evts: events },
    });
    let displayed;
    const refresh = method(source, seats + "['prototype']['userJoinRoom']=", "," + seats + "['prototype']['onPushCarryInTipsUserList']=", { cc });
    const ui = { getLocalIndex: () => 0, _seatsScript: [{ reflashBaseScore: (data) => { displayed = data.point; } }] };
    const deliver = () => {
      for (const frame of received.splice(0)) {
        assert.notEqual(frame.msgid, PUSH.ROOM_INFO, "seat updates must not trigger loginSuccess");
        if (frame.msgid === PUSH.JOIN_ROOM) {
          join.call(room, frame.payload);
          refresh.call(ui, frame.payload);
        }
      }
    };
    robot.tickRoom(game, ctx, now, () => 0.5);
    now += 1000; robot.tickRoom(game, ctx, now, () => 0.5); deliver();
    assert.equal(displayed, 0);
    const uid = table.members[0].uid;
    assert.equal(room.getSeatByID(uid).point, 0);
    now += 1000; robot.tickRoom(game, ctx, now, () => 0.5); deliver();
    assert.ok(table.members[0].point > 0);
    assert.equal(displayed, table.members[0].point);
    assert.equal(room.getSeatByID(uid).point, displayed);
  });
}

test("original carry panel displays remaining seconds and stand-up closes it", (t) => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  const game = new HoldemGame();
  const table = game.createTable(700009, 19, { carry_min: 500 });
  table.botTarget = 0;
  const session = { userId: 99, name: "waiting", wallet: 10000 };
  const sent = [];
  const ctx = { table, session, body: { position: 0 },
    send: (id, payload) => sent.push([id, payload]), io: { broadcast: (id, payload) => sent.push([id, payload]) } };
  game.onSitDown(ctx);
  const member = table.members.find((item) => item.uid === 99);
  const cc = { color: () => ({}), app: { gameRoom: {
    getMyMemberInfo: () => member,
    getRoomInfo: () => ({ roomType: 19 }), params: { carryMin: 500 },
  } } };
  let countdown;
  const node = () => ({ node: {}, string: "" });
  const panel = {
    progressMask: {}, carryMin: node(), carryMax: node(), dairuBtn: {}, dairuTxt: {}, countDownTxt: {},
    balanceNd: {}, balanceLb: node(), tipLb: { setKey() {} }, carrySlider: {}, carryProc: {},
    autoCarryInMinTg: {}, countdownLb: node(), addEvents() {}, updateCurCarry() {},
    getRoomDefaultBet: (data) => data.carryDefault, getRoomMinBet: () => 10,
    getCarryMin: (params) => params.carryMin, getSliderRanges() {}, updateAutoCarryIn() {},
    startCountdown: (seconds) => { countdown = seconds; },
  };
  const start = main.lastIndexOf("R['prototype']['init']=", main.indexOf("Y['isByServerSettle']"));
  assert.ok(start >= 0);
  const init = method(main.slice(start), "R['prototype']['init']=", ",R['prototype']['startCountdown']=", {
    cc, clearInterval() {}, J: { default: { transformLmCoinTrue: (score) => score / 100 } },
    E: { default: { keepDecimal: (value) => value, isNullOrUndefined: (value) => value == null } },
    C: { GameID: { DZPK: 19, QZNN: 6, ZJH: 25 } }, L: { CarryInSecs: 12 },
  });
  const open = method(holdem, "aI['prototype']['openCarryPanel']=", ",aI['prototype']['inningBeginInfo']=", {
    cc, ab: { default: { SEND, PUSH } }, ac: { default: { showView: (_path, _name, _script, args) => {
      init.call(panel, args[0]);
    } } },
  });
  const room = { _conf: {}, getMyMemberInfo: () => member, getIsOb: () => false };
  for (const [elapsed, seconds] of [[0, 12], [4500, 7.5]]) {
    now = 1_800_000_000_000 + elapsed;
    const payload = decodeFrame(encodeFrame(PUSH.CARRYIN_RESULT, game.carryPanel(table, session))).payload;
    open.call(room, payload);
    assert.equal(countdown, seconds, "original client divides remaining milliseconds by 1000");
    assert.equal(panel.countdownLb.node.active, true);
  }
  let displayed;
  const seatCountdown = method(holdem, "Y['prototype']['onEvtStartCarryInCountdown']=", ",Y['prototype']['onPushAuditCarryInTips']=");
  seatCountdown.call({ getLocalIndex: () => 0, _seatsScript: [{ startCarryInCountdown: (_type, value) => { displayed = value; } }] }, {
    uid: 99, carryLeftTime: Math.ceil(game.roomInfo(table).memberList[0].carryLeftTime / 1000),
  });
  assert.equal(displayed, 8);
  now = 1_800_000_000_000 + 12000;
  game.tick(ctx);
  const push = sent.find(([id]) => id === PUSH.USER_STANDUP_ROOM);
  assert.equal(push[1], 99);
  const events = [];
  const standUp = method(holdem, "aI['prototype']['userstandUpRoom']=", ",aI['prototype']['onPushForceStandUp']=", {
    ad: { default: { userData: { uid: 99 } } }, aw: { default: { ReportLog() {} } },
    a7: { Evts: { CloseCarryIn: "close-carry" } }, ac: { default: { closeViewByName() {} } },
  });
  standUp.call({ _conf: {}, userstandUpData() {}, dispatchEventAll: (event) => events.push(event),
    btnsLayer: { getComponent: () => ({ init() {} }) }, reflashGuanZhanIng() {},
    gameTuoguan: { toggleGameTuoguan() {} }, toggleSendCardsBtNd() {}, toggleAutoSendCardsBtNd() {},
    checkToShowJisuChangeRoom() {}, checkToShowStartGameAndInviteFriend() {}, checkToShowWaitNextRound() {},
  }, decodeFrame(encodeFrame(...push)).payload);
  assert.ok(events.includes("close-carry"), "original stand-up handler closes the buy-in dialog");
  const settling = { _conf: {}, _curStatus: "SETTLE", _levelList: [],
    getIsJoinGame: () => true, userstandUpData() { assert.fail("must defer removal until animations end"); },
    checkToShowStartGameAndInviteFriend() {}, checkToShowWaitNextRound() {},
  };
  standUp.call(settling, 7);
  assert.equal(settling._levelList.length, 1);
  assert.equal(settling._levelList[0].data.uid, 7);
  assert.equal(settling._levelList[0].isStandup, true);
});

test("original ranking panel accepts server statistics and observer profile rows", () => {
  const table = { members: [{ uid: 1, name: "Alice", point: 500 }], observers: [{ uid: 2, name: "Bob" }] };
  const report = ranking(table);
  const keys = [];
  const text = () => ({ string: "", node: {}, setKey: (...args) => keys.push(args) });
  let rows;
  let observers;
  const panel = {
    node: { activeInHierarchy: true }, isInTable: { isChecked: false },
    rankingList: { setData: (value) => { rows = value; } },
    totalHands: text(), totalStream: text(), totalTakeIn: text(), gamePoint: text(),
    gameTime: text(), lastTime: text(), averagePot: text(), totalBaoXian: text(),
    onWatchGameList: (value) => { observers = value; },
  };
  const render = method(holdem, "U['prototype']['onPushGameRankList']=", ",U['prototype']['updateRoomTimeStr']=", {
    F: { default: { formatNumber: String, convertSecondsToDHMS } },
    cc: { app: { gameRoom: { getRoomInfo: () => ({ dzpk: { openInsurance: false } }) } } },
  });
  panel.updateRoomTimeStr = method(holdem, "U['prototype']['updateRoomTimeStr']=", ",U['prototype']['onShowName']=", {
    F: { default: { convertSecondsToDHMS } },
  });
  render.call(panel, report);
  assert.equal(rows[0].userName, "Alice");
  assert.equal(observers[0].userName, "Bob");
  assert.match(observers[0].userIcon, /^\/avator\//);
  assert.ok(!JSON.stringify(keys).includes("NaN"));
  assert.equal(keys.find((row) => row[1] === "time_remaining")[2], "08:00:00");
});

test("original table and ranking clocks render the same eight-hour room deadline", () => {
  const game = new HoldemGame();
  const table = game.createTable(700000, 19, {});
  const renderClock = method(holdem, "aI['prototype']['updateRoomTimeStr']=", ",aI['prototype']['reflashPot']=", {
    a4: { default: { convertSecondsToDHMS } },
  });
  const renderRankClock = method(holdem, "U['prototype']['updateRoomTimeStr']=", ",U['prototype']['onShowName']=", {
    F: { default: { convertSecondsToDHMS } },
  });
  const startClock = method(holdem, "aI['prototype']['startRoomTimeCountdown']=", ",aI['prototype']['updateRoomTimeStr']=", {
    ae: { default: { startCountdownTextAct: (node, seconds, update) => {
      update(node, seconds);
      if (seconds > 0) update(node, seconds - 1);
    } } },
  });
  const expected = ["08:00:00", "07:50:00", "00:00:00"];
  for (const [index, elapsed] of [0, 600000, 28800000].entries()) {
    table.createdAt = Date.now() - elapsed;
    for (const raw of [game.roomInfo(table), texasRoomInfo(table)]) {
      const info = decodeFrame(encodeFrame(PUSH.ROOM_INFO, raw)).payload;
      const panel = { _conf: info, roomTimeLb: { node: {}, string: "" }, updateRoomTimeStr: renderClock };
      renderClock.call(panel, info.leftTime);
      assert.equal(panel.roomTimeLb.string, expected[index]);
      assert.equal(info.dzpk.gameTime / 3600, 8, "table settings read nested gameTime");
      startClock.call(panel);
      assert.match(panel.roomTimeLb.string, /^\d{2}:\d{2}:\d{2}$/);
      assert.ok(!panel.roomTimeLb.string.includes("NaN"));
    }
    const report = decodeFrame(encodeFrame(PUSH.DZPK_PUSH_RANKINGLIST, ranking(table))).payload;
    let displayed;
    renderRankClock.call({ _originHistoryData: report, lastTime: { setKey: (_mod, _key, text) => { displayed = text; } } }, report.lastTime);
    assert.equal(displayed, expected[index]);
    assert.equal(texasConf(table).dzpkParams.gameTime, 28800);
  }
});

test("original common ranking cache has complete room data before observer updates and on button click", () => {
  const game = new HoldemGame();
  const table = game.createTable(700005, 19, {});
  table.createdAt = Date.now() - 600000;
  table.botTarget = 0;
  const info = game.roomInfo(table);
  const cc = { app: { gameRoom: { _conf: info } } };
  const rendered = [];
  const panel = { mRestTime: { setKey: (_mod, _key, value) => rendered.push(value) }, StopSecondsTimer() {} };
  panel.UpdateRestTime = method(main, "Q['prototype']['UpdateRestTime']=", ",Q['prototype']['ShowYouYuToggle']=", {
    cc, A: { default: { convertSecondsToDHMS } },
  });
  const cache = { ForceUpdate() { panel.UpdateRestTime(this.mData, this.mData?.lastTime); } };
  const model = { Data_CommonRankData: cache, Data_CommonRankHaveYouYu: {} };
  model.SetRankObUser = method(main, "z['prototype']['SetRankObUser']=", ",A=k(");
  // Reproduce the reported bug using the original client's observer-only cache.
  model.SetRankObUser([]);
  assert.equal(rendered.at(-1), "NaN:NaN:NaN");
  delete cache.mData;
  rendered.length = 0;

  const received = [];
  const deliver = (id, payload) => {
    const frame = decodeFrame(encodeFrame(id, payload));
    received.push(frame);
    if (id === PUSH.DZPK_PUSH_RANKINGLIST) {
      cache.mData = frame.payload;
      cache.ForceUpdate();
    } else if (id === PUSH.DZPK_PUSH_WATCHGAME) model.SetRankObUser(frame.payload);
  };
  const ctx = { table, session: { userId: 99, name: "watcher", wallet: 1000 }, body: {}, send: deliver,
    io: { broadcast: deliver } };
  game.onJoin(ctx);
  assert.equal(received.find((frame) => [1244, 2219].includes(frame.msgid)).msgid, 1244);
  assert.equal(cache.mData.lastTime, 28200);
  assert.deepEqual(cache.mData.userList, []);
  assert.equal(cache.mData.obMemberList[0].uid, 99);
  assert.ok(rendered.length > 0 && rendered.every((value) => value === "07:50:00"));
  game.onLoginRoom(ctx);
  assert.ok(rendered.every((value) => !value.includes("NaN")));

  const requests = [];
  const click = method(main, "aE['prototype']['onRankingClick']=", ",aE['prototype']['onToggleNextStandUp']=", {
    cc, ak: { GameID: { DZPK: 19 } }, ah: { default: { Instance: model } },
    a2: { default: { instance: { send: (id, payload) => requests.push([id, payload]) } } },
    a3: { default: { SEND } }, ai: { default: { ShowLayer() {} } }, aj: { default: { Bundle: "resources", PrefabPath: "ranking" } },
  });
  table.createdAt = Date.now() - 1200000;
  click.call({ playButtonClick() {}, dispatchEventAll() {} });
  assert.equal(requests[0][0], 1130);
  assert.equal(requests[0][1].buttonCode, "realtime_rank_main_btn");
  assert.equal(game.onMessage(ctx, ...requests[0]), true);
  assert.equal(cache.mData.lastTime, 27600);
  assert.equal(rendered.at(-1), "07:40:00");
  const count = received.length;
  assert.equal(game.onMessage(ctx, SEND.DATA_REPORT, { buttonCode: "game_review_btn" }), false);
  assert.equal(received.length, count, "unrelated analytics events do not send ranking data");
});

test("original room dismissal handler accepts roomId and returns to the hall on confirmation", () => {
  const state = {};
  let confirm;
  let returned = 0;
  let alerts = 0;
  const scene = { _conf: { roomId: 700000, playerClubId: 0 }, node: { getChildByName: () => null } };
  const handle = method(main, "ao['prototype']['onPushRoomDissMiss']=", ",ao['prototype']['bigInningResult']=", {
    cc: { app: { isPlayBack: false }, isValid: () => true },
    V: { default: state },
    U: { default: {
      showGameAlert: (_title, _type, owner, callback, ...args) => {
        alerts += 1;
        confirm = () => callback.call(owner);
        assert.equal(args[4].msgKey, "room_dismiss");
      },
      gotoClub: () => { returned += 1; },
    } },
    setTimeout: (fn, delay) => { assert.equal(delay, 400); fn(); },
  });
  handle.call(scene, { roomId: 700001 });
  assert.equal(alerts, 0, "another room cannot close the current view");
  handle.call(scene, { roomId: 700000 });
  assert.equal(state.isRoomDissMiss, true);
  assert.equal(alerts, 1);
  assert.equal(returned, 0);
  confirm();
  assert.equal(returned, 1);
});

test("original verification view reads proof code and maps burned slots to actual board", () => {
  const table = createTexasTable(700030, 19, {});
  table.members = [{ uid: 1, name: "one", point: 1000, pos: 0 }, { uid: 2, name: "two", point: 1000, pos: 1 }];
  table.observers = [{ uid: 99 }];
  const io = { env: "dev", broadcast() {}, send() {}, forEachPlayer() {} };
  beginHand(io, table);
  while (table.phase === "playing") {
    const actor = table.members.find((member) => member.uid === table.hand.actorUid);
    onTexasAction(io, table, { userId: actor.uid }, { operation: table.hand.currentBet > actor.streetBet ? OP.FOLLOW : OP.PASS });
  }
  const detail = fairCodeDetail(table, 99, 1);
  const gameIds = { DZPK: 19, DZNN: 20, DZJH: 21, BR_BJL: 58, BR_BJK: 59, BR_LHD: 60, BLACKJACK: 31 };
  const panel = {
    _data: { gameRoomId: table.roomId }, roomType: 19, _roomType: 19,
    verify_btn: { _flag_: false }, id_label: {}, code_label: {}, scrollView: { scrollToTop() {} }, changeVerifyBtnState() {},
  };
  const render = method(main, "a4['prototype']['onResult']=", ",a4['prototype']['switchVerifyBtnState']=", { K: { GameID: gameIds } });
  render.call(panel, detail);
  assert.equal(panel._code, detail.notarizationCode);
  assert.equal(panel.id_label.string, "700030-1");
  panel._cards = detail.pokerList.map((row, index) => ({ index, info: JSON.parse(row.pokerInfo), showFunc(data) { this.shown = data; } }));
  const flop = panel._cards.filter((card) => card.info.flop);
  const turn = panel._cards.filter((card) => card.info.turn);
  const river = panel._cards.filter((card) => card.info.river);
  const runtime = { lastCard: flop.at(-1) };
  const setTurn = method(main, "a4['prototype']['setTurnCards']=", ",a4['prototype']['setRiveCards']=", { K: { GameID: gameIds }, console });
  const setRiver = method(main, "a4['prototype']['setRiveCards']=", ",a4['prototype']['setTableHandCards']=", { K: { GameID: gameIds } });
  setTurn.call(panel, turn.map((card) => card.info), runtime);
  setRiver.call(panel, river.map((card) => card.info), runtime);
  assert.equal(runtime.turnCard.index, turn[0].index);
  assert.equal(runtime.riveCard.index, river[0].index);
  assert.deepEqual([...flop, ...turn, ...river].map((card) => card.info.index), table.history[0].firstGameList[0].commonPoker);
});

test("original verify button groups real hand and board cards and masks folded opponents", async () => {
  const moduleStart = main.indexOf("'blockchain_verify_center':[");
  const helpersStart = main.indexOf("var x,z,A", moduleStart);
  const helpersEnd = main.indexOf(";Object['defineProperty']", helpersStart);
  const helpers = vm.runInNewContext("(()=>{" + main.slice(helpersStart, helpersEnd) + ";return {E,F};})()");
  const ids = { DZPK: 19, DZNN: 20, QZNN: 24, BR_BJL: 58, BR_BJK: 59, BLACKJACK: 31 };
  for (const fold of [false, true]) {
    const table = createTexasTable(700031, 19, {});
    table.members = [{ uid: 1, point: 1000, pos: 0 }, { uid: 2, point: 1000, pos: 1 }];
    table.observers = [{ uid: 99 }];
    const io = { env: "dev", broadcast() {}, send() {}, forEachPlayer() {} };
    beginHand(io, table);
    const foldedUid = table.hand.actorUid;
    while (table.phase === "playing") {
      const actor = table.members.find((member) => member.uid === table.hand.actorUid);
      onTexasAction(io, table, { userId: actor.uid }, {
        operation: fold ? OP.ABANDON : table.hand.currentBet > actor.streetBet ? OP.FOLLOW : OP.PASS,
      });
    }
    for (const uid of [99, foldedUid]) {
      const detail = fairCodeDetail(table, uid, 1);
      const context = {
        ...helpers, K: { GameID: ids }, q: { PokerStackNumMap: { default: [] } },
        M: { default: { isEmpty: (v) => v == null || v === "" } },
        Q: { default: { getLangText: () => "" } }, U: { default: { userData: { uid } } },
        V: { default: { checkRuntime: (r) => Boolean(r.lastCard), checkCardExists: Boolean,
          safeCall: (obj, name, ...args) => obj[name](...args) } }, cc: {}, console,
      };
      const cards = Array.from({ length: 52 }, () => ({
        node: {}, set(info, data, index) { Object.assign(this, { info, data, index }); },
        show(visible) { this.visible = visible; }, showFunc(info) { this.visible = Boolean(info); },
      }));
      const seats = new Map([0, 1].map((pos) => [pos, { show(rows) { this.rows = rows; }, hide() {} }]));
      const panel = {
        _info: detail, roomType: 19, _roomType: 19, _cards: cards, _seats: seats,
        verify_btn: {}, subtract_view: {}, verify_help: {},
        subtract_view_card_group: { children: [], getComponent() {} },
        async resetTable() {}, switchVerifyBtnState() {}, setCutCardTip() {},
        setDoubleCardTip() {}, setSingleCardTip() {}, scheduleOnce() {},
        getFlopText() {}, getTurnText() {}, getRiverText() {},
      };
      for (const name of ["onClickVerify", "getFlops", "getCardByPokerIndex", "setHandCards", "setFlopCards", "setTurnCards", "setRiveCards", "setTableHandCards"]) {
        panel[name] = method(main, "a4['prototype']['" + name + "']=", ",a4['prototype']", context);
      }
      await panel.onClickVerify();
      for (const player of table.members) {
        const rows = seats.get(player.pos).rows;
        assert.equal(rows.length, 2);
        const visible = !fold || player.uid === uid;
        assert.ok(rows.every((row) => row.show === visible));
        if (visible) assert.deepEqual(Array.from(rows, (row) => row.info.index), player.hole);
        else assert.ok(rows.every((row) => row.info.index < 0));
      }
      const board = cards.filter((card) => card.info.flop || card.info.turn || card.info.river);
      assert.equal(board.length, fold ? 0 : 5);
      assert.ok(board.every((card) => card.visible));
    }
  }
});

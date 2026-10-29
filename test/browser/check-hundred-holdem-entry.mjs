import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { decodeFrame } from '../../game-server/src/codec.js';
import { PUSH } from '../../game-server/src/messages.js';

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gogame-hundred-holdem-'));
const mode = Number(process.argv.find(arg => arg.startsWith('--mode='))?.slice(7) || 1);
assert.ok([1, 2, 3, 4, 5].includes(mode));
const browser = spawn(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-extensions', '--no-first-run',
  '--disable-background-networking', '--remote-debugging-port=0', '--user-data-dir=' + profile,
  '--window-size=1280,900', 'about:blank',
], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const sessions = [], errors = [], frames = [], logs = [];
let ws, ev, send;
try {
  let port;
  for (let i = 0; i < 100; i++) {
    try { port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; break; }
    catch { await delay(100); }
  }
  const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page');
  ws = new WebSocket(target.webSocketDebuggerUrl.replace('localhost', '127.0.0.1'));
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  let id = 0;
  const pending = new Map();
  send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const n = ++id, timer = setTimeout(() => { pending.delete(n); reject(new Error('CDP timeout ' + method)); }, 15000);
    pending.set(n, m => { clearTimeout(timer); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m); });
    ws.send(JSON.stringify({ id: n, method, params, sessionId }));
  });
  ws.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); }
    else if (m.method === 'Target.attachedToTarget') {
      sessions.push(m.params.sessionId);
      send('Runtime.enable', {}, m.params.sessionId).catch(() => {});
      send('Network.enable', {}, m.params.sessionId).catch(() => {});
    } else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails);
    else if (m.method === 'Runtime.consoleAPICalled') {
      const line = m.params.args.map(a => a.value ?? a.description ?? '').join(' ');
      if (!line.includes('[HALL-NET]') && /Bairen|6105|6205|6123|6224|6227|gotoScene|TypeError|GOGAME-DEV|非百人/.test(line)) logs.push(line.slice(0,700));
    } else if (/Network.webSocketFrame(Sent|Received)/.test(m.method)) {
      try {
        const frame = decodeFrame(Buffer.from(m.params.response.payloadData, 'base64'));
        if (frame) frames.push({ direction: m.method.endsWith('Sent') ? 'send' : 'receive', ...frame });
      } catch {}
    }
  });
  const evaluate = async (expression, sessionId) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    assert.ok(!r.result?.exceptionDetails, JSON.stringify(r.result?.exceptionDetails));
    return r.result?.result?.value;
  };
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  const uid = 88000750 + mode;
  await send('Page.navigate', { url: `http://lobby.localhost:11042/21/0?userId=${uid}&userToken=dev-${uid}&openId=${uid}&v=2.0.1279` });
  await delay(8000);
  const category = await evaluate(`(()=>{const el=document.querySelector('img[src*="category/02.webp"]');el?.parentElement.click();return !!el;})()`);
  assert.ok(category, 'native hundred category is available');
  await delay(4000);
  console.log('CATEGORY',await evaluate(`({text:document.body.innerText,types:Array.from(document.querySelectorAll('img[src*="types/"]')).map(e=>e.getAttribute('src'))})`));
  const game = await evaluate(`(()=>{const el=document.querySelector('img[src*="types/1000.png"]');el?.parentElement.click();return !!el;})()`);
  assert.ok(game, 'native hundred card game menu is available');
  await delay(3000);
  console.log('ROOMS', await evaluate(`Array.from(document.querySelectorAll('[class*=roomList] li')).map(e=>e.innerText)`));
  const selected = await evaluate(`(()=>{const rows=Array.from(document.querySelectorAll('[class*=roomList] li'));const row=rows[${mode - 1}];row?.click();return row?.innerText;})()`);
  assert.ok(selected, 'hundred Holdem rooms are listed');
  await delay(25000);
  let session;
  for (const candidate of sessions) {
    const name = await evaluate('window.cc&&cc.director.getScene()?.name', candidate);
    console.log('SCENE', name); if (name === 'gameHoldem') session = candidate;
  }
  console.log('FRAMES', JSON.stringify(frames.filter(f => [1105,1205,2102,2201,2111,6105,6205,6123,6224,6227,6124,6225,2110,2205].includes(f.msgid)).map(f=>({direction:f.direction,id:f.msgid,roomType:f.payload?.roomType,roomId:f.payload?.roomId,state:f.payload?.state,rooms:f.payload?.roomInfos?.length}))));
  console.log('LOGS', JSON.stringify(logs.slice(-55)));
  console.log('ERRORS', JSON.stringify(errors.map(e=>e.exception?.description||e.text)));
  assert.ok(session, 'hundred entry reaches the original Holdem host scene');
  ev = expression => evaluate(expression, session);
  console.log('STATE', JSON.stringify(await ev(`(()=>{const g=__require('GlobalGameData').default;const F=__require('Facade').default;const b=F.getModule('Bairen');return {roomId:g.roomId,roomItem:g.roomItemData,openHundredGame:g.openHundredGame,isInBairenQpGame:g.isInBairenQpGame,conf:cc.app.gameRoom?._conf,module:b&&{roomType:b.roomType,roomId:b.roomId,playMode:b.playMode},nodes:Object.values(cc.game._persistRootNodes).map(n=>({name:n.name,active:n.active}))};})()`)));
  console.log('OVERLAY',await ev(`(()=>{const b=__require('Facade').default.getModule('Bairen');return {isAutoOpen:b._isAutoOpen,hundredSwitch:b._hundredSwitch,rootChildren:b._rootNode?.children.map(n=>({name:n.name,active:n.active,components:n._components.map(c=>({type:c.constructor.name,isPanelShow:c._isPanelShow}))})),sceneOptions:__require('SceneManager').default.instance?.currentOptions};})()`));
  assert.equal(await ev(`__require('GlobalGameData').default.isInBairenQpGame`), true, 'native hundred overlay opens automatically');
  assert.ok(frames.some(f => f.direction === 'receive' && f.msgid === 6205 && f.payload.roomType === 50), 'native ENTER receives a hundred room snapshot');
  assert.equal(frames.find(f => f.direction === 'receive' && f.msgid === 6205).payload.playMode, mode);
  assert.ok(frames.some(f => f.direction === 'receive' && f.msgid === 6227 && f.payload.roomInfos.length === 5), 'native registration receives all five modes');
  assert.equal(errors.length, 0, 'no uncaught client exceptions');
  const shot = await send('Page.captureScreenshot');
  fs.writeFileSync(path.join(os.tmpdir(), 'gogame-hundred-holdem-entry.png'), Buffer.from(shot.result.data, 'base64'));
  const until = async (check, timeout, description) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await check()) return; await delay(250); }
    assert.fail('timeout: ' + description);
  };
  const selectedRoom = frames.find(f => f.direction === 'receive' && f.msgid === 6205).payload.roomId;
  const publicRobotBets = () => frames.filter(f => f.direction === 'receive' && f.msgid === PUSH.BET_BROADCAST
    && f.payload.roomId === selectedRoom && f.payload.allPlayerBets.some(row => row.total > 0));
  const readClocks = () => ev("(()=>{const result=[],seen=new Set();function walk(n){if(!n||seen.has(n))return;seen.add(n);for(const c of n._components||[]){if(c.coundownLb)result.push({node:n.name,active:n.activeInHierarchy,text:c.coundownLb.string,parent:n.parent?.name});if(c._coundownClockCmp)result.push({item:n.name,roomId:c.roomId,state:c.currentGameState,reconnect:c._isReconnect,text:c._coundownClockCmp.coundownLb?.string,active:c._coundownClockCmp.node.activeInHierarchy});}for(const child of n.children||[])walk(child);}walk(cc.director.getScene());Object.values(cc.game._persistRootNodes).forEach(walk);return result;})()");
  const readCardOdds = () => ev("(()=>{const result=[],seen=new Set();function walk(n){if(!n||seen.has(n))return;seen.add(n);for(const c of n._components||[]){if(c.areaOddsLbMap&&c.roomId){const odds=[];c.areaOddsLbMap.forEach((label,id)=>odds.push({id,text:label.string,value:c._areaOddsValue?.[id]}));result.push({roomId:c.roomId,state:c.currentGameState,odds});}}for(const child of n.children||[])walk(child);}walk(cc.director.getScene());Object.values(cc.game._persistRootNodes).forEach(walk);return result;})()");
  const assertCardOdds = (card, expected) => {
    assert.ok(card, 'original multi-bet card exists');
    assert.deepEqual(card.odds.map(row => Number(row.id)).sort(), [1, 2], 'native compact card exposes the two side odds');
    for (const {id, text, value} of card.odds) {
      assert.ok(Number.isFinite(value) && value > 0, JSON.stringify({roomId:card.roomId,id,text,value}));
      assert.equal(value, expected[id].odds);
      assert.equal(text, '1:' + expected[id].odds, 'original card renders the server odds');
    }
  };
  console.log('CLOCKS_INITIAL', JSON.stringify(await readClocks()));
  const cardIds = frames.find(f => f.msgid === 6227).payload.roomInfos
    .filter(room => room.roomId !== selectedRoom).map(room => room.roomId);
  assert.equal(cardIds.length, 4);
  for (const roomId of cardIds) {
    let first;
    await until(async () => {
      first = (await readClocks()).find(c => c.roomId === roomId && c.active && c.state === 2);
      return first && Number(first.text) >= 5 && Number(first.text) <= 20;
    }, 40000, 'visible native card clock starts for room ' + roomId);
    await delay(2200);
    const later = (await readClocks()).find(c => c.roomId === roomId);
    assert.equal(later.state, 2);
    assert.ok(Number(later.text) < Number(first.text) && Number(later.text) > 0, JSON.stringify({first, later}));
    const card = (await readCardOdds()).find(c => c.roomId === roomId);
    const state = frames.filter(f => f.msgid === 6228 && f.payload.roomId === roomId && f.payload.state === 2).at(-1).payload;
    assertCardOdds(card, state.areaOdds);
    console.log('CARD_ODDS', JSON.stringify(card));
    console.log('CLOCK_DECREASE', JSON.stringify({roomId, before:first.text, after:later.text}));
  }
  assert.ok(frames.some(f => f.msgid === 6228 && f.payload.customData === 2 && f.payload.state === 2));
  const registrationStart = frames.length;
  await ev("__require('BairenMultyBetHelper').default.vm.sendRegRoomsReq();true");
  await until(() => frames.slice(registrationStart).some(f => f.msgid === 6227), 5000, 'native room snapshot refresh');
  const refreshed = frames.slice(registrationStart).find(f => f.msgid === 6227).payload;
  const restoredClocks = await readClocks();
  const restoredOdds = await readCardOdds();
  for (const room of refreshed.roomInfos.filter(r => cardIds.includes(r.roomId) && r.state === 2 && r.countDown >= 3000)) {
    const clock = restoredClocks.find(c => c.roomId === room.roomId);
    const seconds = Math.floor(room.countDown / 1000);
    assert.ok(clock.active && Number(clock.text) <= seconds && Number(clock.text) >= seconds - 1,
      JSON.stringify({roomId:room.roomId, countDown:room.countDown, clock}));
    console.log('CLOCK_RESTORED', JSON.stringify({roomId:room.roomId, remainingMs:room.countDown, text:clock.text}));
    assertCardOdds(restoredOdds.find(c => c.roomId === room.roomId), room.hundredParams.betAreaOdds);
  }
  const clockShot = await send('Page.captureScreenshot');
  fs.writeFileSync(path.join(os.tmpdir(), 'gogame-hundred-holdem-countdown.png'), Buffer.from(clockShot.result.data, 'base64'));
  await until(() => publicRobotBets().length > 0, 35000, 'automatic public robot bets before any human bet');
  console.log('ROBOT_BETS', JSON.stringify({ roomId: selectedRoom, broadcasts: publicRobotBets().length,
    totals: publicRobotBets().at(-1).payload.allPlayerBets }));
  await until(() => ev("__require('BairenHelper').default.vm.isBetting()"), 35000, 'native betting controls enable');
  console.log('CLOCKS_BETTING', JSON.stringify(await readClocks()));
  await delay(2200);
  console.log('CLOCKS_LATER', JSON.stringify(await readClocks()));
  const before = frames.length;
  assert.equal(await ev(`(()=>{const vm=__require('BairenHelper').default.vm;vm.commandSetChipValue(100);const accepted=vm.commandBet(1);vm.commandSureBet();return accepted;})()`), true);
  await until(() => frames.slice(before).some(f=>f.direction==='receive'&&f.msgid===6201), 5000, 'bet receipt');
  const bet = frames.slice(before).find(f=>f.direction==='receive'&&f.msgid===6201).payload;
  assert.equal(bet.code, 0, JSON.stringify(bet));
  const request = frames.slice(before).find(f=>f.direction==='send'&&f.msgid===6101).payload;
  const stake = request.params.reduce((sum, row) => sum + row.total, 0);
  assert.ok(Number.isSafeInteger(stake) && stake > 0, 'the original client sends integer points');
  assert.equal(bet.myBets.reduce((sum, row) => sum + row.total, 0), stake, 'receipt preserves requested points');
  const rid = bet.roomId;
  await until(() => frames.slice(before).some(f=>f.direction==='receive'&&f.msgid===6229&&f.payload.roomId===rid), 30000, 'personal settlement');
  const result=frames.slice(before).find(f=>f.direction==='receive'&&f.msgid===6229&&f.payload.roomId===rid).payload;
  assert.equal(result.points, bet.points + stake + result.realScore);
  assert.equal(Number.isFinite(result.realScore), true);
  console.log('BET_AND_SETTLE',JSON.stringify({bet:bet.myBets,stake,pointsAfterBet:bet.points,pointsAfterSettlement:result.points,realScore:result.realScore}));
  await until(() => frames.slice(before).some(f=>f.direction==='receive'&&f.msgid===6204&&f.payload.roomId===rid&&f.payload.inning>result.inning), 15000, 'next round');
  assert.equal(await ev(`cc.director.getScene().name`), 'gameHoldem', 'the game remains open after settlement');
  const historyStart = frames.length;
  await ev("__require('Facade').default.getModule('Bairen').emit(__require('BairenTypes').BairenEvent.SHOW_BAIREN_HISTORY);true");
  await until(() => frames.slice(historyStart).some(f => f.msgid === 6222), 5000, 'native history list automatically requests its latest detail');
  const historyList = frames.slice(historyStart).find(f => f.msgid === 6221).payload;
  const historyDetail = frames.slice(historyStart).find(f => f.msgid === 6222).payload;
  assert.equal(historyDetail.gameRoomId, rid);
  assert.equal(historyDetail.currInning, result.inning);
  assert.deepEqual(historyDetail.showdownPokers, result.showdownPokers);
  assert.equal(historyDetail.betDetailTableMap[1].betScore, stake);
  assert.equal(historyDetail.betDetailTableMap[1].realScore, result.realScore);
  const historyPanelExpr = "(()=>{const roots=[cc.director.getScene(),...Object.values(cc.game._persistRootNodes)],seen=new Set();function find(n){if(!n||seen.has(n))return null;seen.add(n);const c=(n._components||[]).find(c=>c.public_node&&c.tool_bar&&c.round_label&&c.node.activeInHierarchy);if(c)return c;for(const child of n.children||[]){const found=find(child);if(found)return found;}return null;}for(const root of roots){const c=find(root);if(c)return c;}return null;})()";
  const readHistory = () => ev("(()=>{const c=" + historyPanelExpr + ";return c&&{round:c.round_label.string,cards:c.public_node.getChildByName('layout').childrenCount,rows:c.info_content.content.childrenCount,page:c.tool_bar.getChildByName('text_content').getChildByName('text').getComponent(cc.Label).string};})()");
  await until(async () => (await readHistory())?.cards === 5, 5000, 'five public cards render in the original history panel');
  let historyUi = await readHistory();
  assert.equal(Number(historyUi.round), result.inning);
  assert.ok(historyUi.rows > 0, 'personal betting rows render');
  assert.equal(historyUi.page, historyList.list.length + '/' + historyList.list.length);
  if (historyList.list.length > 1) {
    await ev("(()=>{const c=" + historyPanelExpr + ";c.onClickPrev();return true;})()");
    const previous = historyList.list.at(-2);
    await until(async () => Number((await readHistory())?.round) === previous, 5000, 'native previous history page');
    await ev("(()=>{const c=" + historyPanelExpr + ";c.onClickNext();return true;})()");
    await until(async () => Number((await readHistory())?.round) === result.inning, 5000, 'native next history page');
  }
  console.log('HISTORY_UI', JSON.stringify({list:historyList.list,detail:historyDetail,ui:await readHistory()}));
  const historyShot = await send('Page.captureScreenshot');
  fs.writeFileSync(path.join(os.tmpdir(), 'gogame-hundred-holdem-history.png'), Buffer.from(historyShot.result.data, 'base64'));
  await ev("__require('Facade').default.getModule('Bairen').emit(__require('BairenTypes').BairenEvent.HIDE_BAIREN_HISTORY);true");
  assert.equal(errors.length, 0, JSON.stringify(errors.map(e=>e.exception?.description||e.text)));
  assert.equal(frames.some(f=>f.direction==='receive'&&f.msgid===0), false, 'hot modules retain valid wire message IDs');
  assert.equal(logs.filter(line=>/TypeError|DecimalError|NaN|逻辑异常|数据异常/.test(line)).length, 0, 'no swallowed client data/animation errors');
  await ev(`__require('BairenHelper').default.vm.commandExit();true`);
  await ev(`__require('SocketMgr').default.instance.send(2110);true`);
  await until(async () => (await ev(`cc.director.getScene().name`)) === 'webHallOb', 10000, 'return to hall');
  await until(() => evaluate(`Array.from(document.querySelectorAll('[class*=gameIframe] iframe')).every(el=>getComputedStyle(el).visibility==='hidden'||getComputedStyle(el).display==='none'||!el.getClientRects().length)`), 5000, 'game iframe releases the hall');
  assert.ok(await evaluate(`Array.from(document.querySelectorAll('[class*=roomList] li')).some(el=>el.getBoundingClientRect().height>0)`), 'the original hall room list is visible after exit');
  const hallShot = await send('Page.captureScreenshot');
  fs.writeFileSync(path.join(os.tmpdir(), 'gogame-hundred-holdem-return-hall.png'), Buffer.from(hallShot.result.data, 'base64'));
  assert.equal(errors.length, 0, 'exit has no uncaught client exceptions');
  console.log('PASS: native entry, five-room registration, bet, settlement, next round and exit');
} catch (error) {
  console.log('FAIL_FRAMES',JSON.stringify(frames.slice(-100).map(f=>({direction:f.direction,id:f.msgid,data:[6101,6201,6229].includes(f.msgid)?f.payload:{roomId:f.payload?.roomId,inning:f.payload?.inning,state:f.payload?.state}}))));
  console.log('FAIL_LOGS',JSON.stringify(logs.slice(-20)));
  throw error;
} finally {
  if (ev) await ev(`__require('SocketMgr').default.instance.send(2110);true`).catch(() => {});
  ws?.close(); browser.kill();
}

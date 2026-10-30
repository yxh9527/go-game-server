import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { decodeFrame } from '../../game-server/src/codec.js';

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gogame-hundred-blackjack-'));
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
  const target = (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()).find(t => t.type === 'page');
  ws = new WebSocket(target.webSocketDebuggerUrl.replace('localhost', '127.0.0.1'));
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  let id = 0; const pending = new Map();
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
      if (!line.includes('[HALL-NET]') && /BlackJack|Bairen|gotoScene|TypeError|NaN|FrameTaskRunner|逻辑异常|数据异常/.test(line)) logs.push(line.slice(0, 700));
    } else if (/Network.webSocketFrame(Sent|Received)/.test(m.method)) {
      try { const frame = decodeFrame(Buffer.from(m.params.response.payloadData, 'base64'));
        if (frame) frames.push({ direction: m.method.endsWith('Sent') ? 'send' : 'receive', ...frame }); } catch {}
    }
  });
  const evaluate = async (expression, sessionId) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    assert.ok(!r.result?.exceptionDetails, JSON.stringify(r.result?.exceptionDetails));
    return r.result?.result?.value;
  };
  const until = async (check, timeout, description) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await check()) return; await delay(300); }
    assert.fail('timeout: ' + description);
  };
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  const uid = 88001060;
  await send('Page.navigate', { url: 'http://lobby.localhost:11042/21/0?userId=' + uid + '&userToken=dev-' + uid + '&openId=' + uid + '&v=2.0.1279' });
  await delay(8000);
  assert.ok(await evaluate("(()=>{const el=document.querySelector('img[src*=\"category/02.webp\"]');el?.parentElement.click();return !!el;})()"));
  await delay(3500);
  assert.ok(await evaluate("(()=>{const el=document.querySelector('img[src*=\"types/1000.png\"]');el?.parentElement.click();return !!el;})()"));
  await delay(2500);
  assert.ok(await evaluate("(()=>{const el=Array.from(document.querySelectorAll('[class*=categorySelector] li')).find(el=>/21|二十一/.test(el.textContent));el?.click();return !!el;})()"));
  await delay(2000);
  const listed = await evaluate("Array.from(document.querySelectorAll('[class*=roomList] li')).map(el=>({text:el.innerText,image:el.querySelector('img')?.getAttribute('src')}))");
  console.log('CATEGORY_LIST', JSON.stringify(listed));
  assert.equal(listed.length, 1); assert.ok(listed[0].image.includes('/1000/60.webp'));
  await evaluate("document.querySelector('[class*=roomList] li').click();true");
  await delay(25000);
  let session;
  for (const candidate of sessions) {
    const name = await evaluate('window.cc&&cc.director.getScene()?.name', candidate);
    console.log('SCENE', name); if (name === 'bjk') session = candidate;
  }
  assert.ok(session, 'the original ordinary Bjk spectator host loads');
  ev = expression => evaluate(expression, session);
  const moduleExpr = "__require('Facade').default.getModule('BlackJack')";
  const vmExpr = moduleExpr + '.gameViewModel';
  console.log('ENTRY', JSON.stringify(await ev('(()=>{const m=' + moduleExpr + ';return {overlay:m?.isOverlayMode,roomType:m?.roomType,roomId:m?.roomId,state:m?.gameViewModel?.__currentGameState};})()')));
  await until(() => frames.some(f => f.direction === 'receive' && f.msgid === 6205 && f.payload.roomType === 60), 10000, 'ENTER 60');
  const enter = frames.find(f => f.direction === 'receive' && f.msgid === 6205 && f.payload.roomType === 60).payload;
  const rid = enter.roomId;
  assert.equal(enter.playMode, 0); assert.equal(enter.totalCardsNum, 312);
  console.log('SUBSCRIPTIONS', JSON.stringify(frames.filter(f => [6123, 6224, 6227, 6230].includes(f.msgid))));
  if (frames.some(f => f.msgid === 6123 && (f.payload.roomType === 60 || f.payload.mulRoomTypeList?.some(r => r.roomType === 60))))
    assert.ok(frames.some(f => f.msgid === 6227 && f.payload.roomInfos.some(r => r.roomType === 60)));
  assert.equal(errors.length, 0, JSON.stringify(errors));
  const shot = await send('Page.captureScreenshot');
  fs.writeFileSync(path.join(os.tmpdir(), 'gogame-hundred-blackjack-entry.png'), Buffer.from(shot.result.data, 'base64'));
  await until(() => frames.some(f => f.msgid === 6202 && f.payload.roomId === rid && f.payload.allPlayerBets.some(row => row.total > 0)), 50000, 'public robot bets');
  const rounds = [];
  for (let round = 0; round < 2; round++) {
    await until(() => ev(vmExpr + '.__currentGameState===2'), 70000, 'native betting');
    const before = frames.length;
    const accepted = await ev('(()=>{const vm=' + vmExpr + ';vm.setCurrentChipValue(100);const ok=vm.commandBet(1);vm.commandConfirmBet();return ok;})()');
    assert.equal(accepted, true);
    await until(() => frames.slice(before).some(f => f.direction === 'receive' && f.msgid === 6201), 5000, 'bet receipt');
    const bet = frames.slice(before).find(f => f.direction === 'receive' && f.msgid === 6201).payload;
    assert.equal(bet.code, 0, JSON.stringify(bet));
    const request = frames.slice(before).find(f => f.direction === 'send' && f.msgid === 6101).payload;
    const stake = request.params.reduce((sum, row) => sum + row.total, 0);
    await until(() => frames.slice(before).some(f => f.msgid === 6204 && f.payload.state === 6 && f.payload.roomId === rid), 60000, 'personal settlement state');
    const result = frames.slice(before).filter(f => f.msgid === 6208 && f.payload.roomId === rid).at(-1).payload;
    assert.equal(result.points, bet.points + stake + result.realScore);
    assert.equal(result.blackJackAreaInfos.length, 4);
    for (const info of result.blackJackAreaInfos) {
      assert.deepEqual(info.finalCards, result.showdownPokers[info.area]);
      assert.equal(info.supplySteps.length, info.finalCards.length - 2);
      assert.ok(info.finalCards.length >= 2 && info.finalCards.length <= 5);
    }
    await delay(500);
    const model = await ev('(()=>{const vm=' + vmExpr + ';return {score:vm.gameResultData.realScore,points:vm.gameResultData.points,shoe:vm.model.__roomBaseInfo,state:vm.__currentGameState};})()');
    assert.equal(model.score, result.realScore); assert.ok(Number.isFinite(model.shoe.progress));
    console.log('ROUND', JSON.stringify({bet, result, model})); rounds.push(result);
    if (!round) await until(() => frames.some(f => f.msgid === 6204 && f.payload.roomId === rid && f.payload.inning > result.inning), 20000, 'next round');
  }
  const historyStart = frames.length;
  await ev(moduleExpr + ".emit(__require('BlackJackConfig').BlackJackConfig.Event.CLICK_HISTORY);true");
  await until(() => frames.slice(historyStart).some(f => f.msgid === 6222), 5000, 'native history detail');
  const detail = frames.slice(historyStart).find(f => f.msgid === 6222).payload;
  assert.deepEqual(detail.blackJackAreaInfos, rounds.at(-1).blackJackAreaInfos);
  assert.equal(detail.betDetailTableMap[1].realScore, rounds.at(-1).realScore);
  const panelExpr = "(()=>{const seen=new Set();function find(n){if(!n||seen.has(n))return null;seen.add(n);const c=(n._components||[]).find(c=>c.resultNode&&c.tool_bar&&c.round_label&&c.node.activeInHierarchy);if(c)return c;for(const child of n.children||[]){const r=find(child);if(r)return r;}return null;}for(const n of [cc.director.getScene(),...Object.values(cc.game._persistRootNodes)]){const c=find(n);if(c)return c;}return null;})()";
  const readPanel = () => ev('(()=>{const p=' + panelExpr + ';return p&&{round:p.round_label.string,rows:p.content.childrenCount,cards:p.resultNode.children.filter(c=>c.activeInHierarchy).map(c=>({name:c.name,active:c.activeInHierarchy}))};})()');
  await until(async () => Number((await readPanel())?.round) === detail.currInning, 5000, 'history renders');
  assert.equal((await readPanel()).rows, 1);
  await ev('(()=>{const p=' + panelExpr + ';p.onClickPrev();return true;})()');
  await until(async () => Number((await readPanel())?.round) === rounds[0].inning, 5000, 'previous review');
  await ev('(()=>{const p=' + panelExpr + ';p.onClickNext();return true;})()');
  await until(async () => Number((await readPanel())?.round) === detail.currInning, 5000, 'next review');
  console.log('HISTORY_UI', JSON.stringify(await readPanel()));
  const historyShot = await send('Page.captureScreenshot');
  fs.writeFileSync(path.join(os.tmpdir(), 'gogame-hundred-blackjack-history.png'), Buffer.from(historyShot.result.data, 'base64'));
  await ev('(()=>{const p=' + panelExpr + ';p.hide();return true;})()');
  assert.equal(errors.length, 0, JSON.stringify(errors.map(e => e.exception?.description || e.text)));
  assert.equal(logs.filter(line => /TypeError|DecimalError|NaN|FrameTaskRunner|逻辑异常|数据异常/.test(line)).length, 0, JSON.stringify(logs.slice(-20)));
  await ev(moduleExpr + '.emit(__require(\'BlackJackConfig\').BlackJackConfig.Event.CLICK_EXIT);true');
  await until(() => ev("!__require('GlobalGameData').default.isInBairenQpGame"), 5000, 'native exit closes the hundred overlay');
  await ev("__require('SocketMgr').default.instance.send(2110);true");
  await until(async () => await ev('cc.director.getScene().name') === 'webHallOb', 10000, 'return to hall');
  await until(() => evaluate("Array.from(document.querySelectorAll('[class*=gameIframe] iframe')).every(el=>getComputedStyle(el).visibility==='hidden'||getComputedStyle(el).display==='none'||!el.getClientRects().length)"), 5000, 'hall visible');
  assert.equal(errors.length, 0, JSON.stringify(errors));
  console.log('PASS: native hundred Blackjack category, host, robots, bet, supply, settlement, review, paging and hall return');
} catch (error) {
  console.log('ENTRY_FRAMES', JSON.stringify(frames.filter(f => [2102,2201,6105,6205,6123,6224,6227,6230].includes(f.msgid))));
  console.log('FAIL_FRAMES', JSON.stringify(frames.slice(-40).map(f => ({id:f.msgid,direction:f.direction,data:f.payload}))));
  console.log('FAIL_LOGS', JSON.stringify(logs.slice(-20)));
  console.log('FAIL_ERRORS', JSON.stringify(errors.map(e => e.exception?.description || e.text)));
  throw error;
} finally {
  if (ev) await ev("(()=>{const m=__require('Facade').default.getModule('BlackJack');m?.emit(__require('BlackJackConfig').BlackJackConfig.Event.CLICK_EXIT);__require('SocketMgr').default.instance.send(2110);return true;})()").catch(() => {});
  ws?.close(); browser.kill();
}

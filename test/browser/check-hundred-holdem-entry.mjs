import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { decodeFrame } from '../../game-server/src/codec.js';

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
  await until(() => ev(`__require('BairenHelper').default.vm.isBetting()`), 35000, 'native betting controls enable');
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

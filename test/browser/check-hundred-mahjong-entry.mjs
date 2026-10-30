import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { decodeFrame } from '../../game-server/src/codec.js';
import { checkCrossGameShortcuts } from './check-cross-game-shortcuts.mjs';
const shortcutOnly = process.env.ONLY_CROSS_SHORTCUTS === '1';

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gogame-hundred-mahjong-'));
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
  const uid = 88001062;
  await send('Page.navigate', { url: 'http://lobby.localhost:11042/21/0?userId=' + uid + '&userToken=dev-' + uid + '&openId=' + uid + '&v=2.0.1279' });
  await delay(8000);
  assert.ok(await evaluate("(()=>{const el=document.querySelector('img[src*=\"category/02.webp\"]');el?.parentElement.click();return !!el;})()"));
  await delay(3500);
  assert.ok(await evaluate("(()=>{const el=document.querySelector('img[src*=\"types/1000.png\"]');el?.parentElement.click();return !!el;})()"));
  await delay(2500);
  assert.ok(await evaluate("(()=>{const el=Array.from(document.querySelectorAll('[class*=categorySelector] li')).find(el=>/\u9ebb\u5c06/.test(el.textContent));el?.click();return !!el;})()"));
  await delay(2000);
  const listed = await evaluate("Array.from(document.querySelectorAll('[class*=roomList] li')).map(el=>({text:el.innerText,image:el.querySelector('img')?.getAttribute('src')}))");
  console.log('CATEGORY_LIST', JSON.stringify(listed));
  assert.equal(listed.length, 1); assert.equal(listed[0].image, '/l01/img/room/type/1000/62.webp');
  await until(()=>evaluate("(()=>{const img=document.querySelector('[class*=roomList] li img');return img?.complete&&img.naturalWidth>0;})()"),5000,'native Mahjong cover loads');
  await evaluate("document.querySelector('[class*=roomList] li').click();true");
  await delay(25000);
  let session;
  for (const candidate of sessions) {
    const name = await evaluate('window.cc&&cc.director.getScene()?.name', candidate);
    console.log('SCENE', name); if (name === 'gameJsmj') session = candidate;
  }
  assert.ok(session, 'original speed Mahjong four-person spectator host loads');
  ev = expression => evaluate(expression, session);
  await until(() => frames.some(f => f.msgid === 6205 && f.payload.roomType === 62), 10000, 'ENTER 62');
  const entry = frames.find(f => f.msgid === 6205 && f.payload.roomType === 62).payload, rid = entry.roomId;
  assert.equal(entry.playMode, 1); assert.equal(Object.keys(entry.areaOdds).length, 11);
  await checkCrossGameShortcuts({ ev, frames, until, delay, roomType:50, screenshot:async phase=>{const shot=await send('Page.captureScreenshot');fs.writeFileSync(path.join(os.tmpdir(),'gogame-mahjong-shortcut-'+phase+'.png'),Buffer.from(shot.result.data,'base64'));} });
  if (!shortcutOnly) {
  console.log('ENTRY', JSON.stringify({host:await ev('cc.app.gameRoom?._conf'),entry}));
  console.log('SUBSCRIPTIONS', JSON.stringify(frames.filter(f => [6123,6224,6227,6230].includes(f.msgid))));
  const publicRobotBets = () => frames.filter(f=>f.direction==='receive'&&f.msgid===6202&&f.payload.roomId===rid&&f.payload.allPlayerBets?.some(b=>b.total>0));
  await until(() => publicRobotBets().length > 0, 35000, 'robots bet before human');
  console.log('ROBOT_BETS', JSON.stringify(publicRobotBets().at(-1).payload));
  const vmExpr = "__require('BairenHelper').default.vm";
  const clockExpr = "(()=>{const seen=new Set();function find(n){if(!n||seen.has(n))return null;seen.add(n);const c=(n._components||[]).find(c=>c.stage_progress&&c.node.activeInHierarchy);if(c)return Number(c.stage_progress.node.getChildByName('state').getComponent(cc.Label).string);for(const child of n.children||[]){const v=find(child);if(v!=null)return v;}return null;}for(const n of [cc.director.getScene(),...Object.values(cc.game._persistRootNodes)]){const v=find(n);if(v!=null)return v;}return null;})()";
  const rounds=[];
  for(let round=0;round<2;round++){
    await until(async()=>await ev(vmExpr+'.isBetting()')&&await ev(clockExpr)>=4,40000,'betting opens');
    const clock = await ev(clockExpr);
    await delay(1100);
    const later=await ev(clockExpr);console.log('COUNTDOWN',JSON.stringify({clock,later}));
    assert.ok(Number.isFinite(clock)&&Number.isFinite(later)&&later<clock&&later>=0);
    const selected = await ev("(()=>{const m="+vmExpr+".model;const ids=[1,2,3,4,5,6,7,8,9,10,11].filter(id=>m.__currentBetAreaOdds.get(id)>0);return {id:ids[0],odds:Array.from(m.__currentBetAreaOdds.entries()),balance:m.__currentBalance};})()");
    assert.ok(selected.id,JSON.stringify(selected));
    const before=frames.length;
    assert.equal(await ev("(()=>{const vm="+vmExpr+";vm.commandSetChipValue(100);const ok=vm.commandBet("+selected.id+");vm.commandSureBet();return ok;})()"),true);
    await until(()=>frames.slice(before).some(f=>f.direction==='receive'&&f.msgid===6201),5000,'bet accepted');
    const bet=frames.slice(before).find(f=>f.direction==='receive'&&f.msgid===6201).payload;assert.equal(bet.code,0,JSON.stringify(bet));
    const request=frames.slice(before).find(f=>f.direction==='send'&&f.msgid===6101).payload;
    const stake=request.params.reduce((n,b)=>n+b.total,0);assert.ok(Number.isSafeInteger(stake)&&stake>0);
    await until(()=>frames.slice(before).some(f=>f.msgid===6229&&f.payload.roomId===rid),35000,'settlement');
    const result=frames.slice(before).find(f=>f.msgid===6229&&f.payload.roomId===rid).payload;
    assert.equal(result.points,bet.points+stake+result.realScore);
    for(const key of ['player','banker']){
      assert.equal(result.showdownPokers[key].length,2);
      assert.ok(result.showdownPokers[key].every(c=>Number.isInteger(c)&&(c>=0&&c<=8||c===29)));
      assert.ok(result.showdownTypes[key]>=1&&result.showdownTypes[key]<=30);
    }
    await until(()=>frames.slice(before).some(f=>f.msgid===6204&&f.payload.roomId===rid&&f.payload.inning===result.inning&&f.payload.state===6),10000,'native settlement updates roads');
    await delay(500);
    const model=await ev("(()=>{const vm="+vmExpr+".model;return {balance:vm.__currentBalance,settle:vm.__currentSettleData,open:vm.__currentOpenCardsData,routes:vm.__routeDataList};})()");
    assert.equal(model.balance,result.points);assert.equal(model.settle.realScore,result.realScore);
    assert.deepEqual(model.open.a_cards,result.showdownPokers.player);assert.deepEqual(model.open.b_cards,result.showdownPokers.banker);
    assert.ok(model.routes.some(row=>row.ret.includes(result.winningAreas[0])));
    console.log('ROUND',JSON.stringify({round,bet,result,model}));rounds.push({...result,chosenArea:selected.id});
    if(round===0)await until(()=>frames.some(f=>f.msgid===6204&&f.payload.roomId===rid&&f.payload.inning>result.inning),20000,'next round');
  }
  const historyStart=frames.length;
  await ev("__require('Facade').default.getModule('Bairen').emit(__require('BairenTypes').BairenEvent.SHOW_BAIREN_HISTORY);true");
  await until(()=>frames.slice(historyStart).some(f=>f.msgid===6222),6000,'native history detail');
  const detail=frames.slice(historyStart).find(f=>f.msgid===6222).payload;
  assert.deepEqual(detail.showdownPokers,rounds.at(-1).showdownPokers);
  assert.equal(detail.betDetailTableMap[rounds.at(-1).chosenArea].realScore,rounds.at(-1).realScore);
  const panelExpr="(()=>{const seen=new Set();function find(n){if(!n||seen.has(n))return null;seen.add(n);const c=(n._components||[]).find(c=>c.other_node&&c.tool_bar&&c.round_label&&c.node.activeInHierarchy);if(c)return c;for(const child of n.children||[]){const r=find(child);if(r)return r;}return null;}for(const n of [cc.director.getScene(),...Object.values(cc.game._persistRootNodes)]){const c=find(n);if(c)return c;}return null;})()";
  const readPanel=()=>ev("(()=>{const p="+panelExpr+";return p&&{round:p.round_label.string,rows:p.info_content.content.childrenCount,sides:['a','b'].map(key=>{const n=p.other_node.getChildByName(key);return {active:n.activeInHierarchy,cards:n.children.filter(c=>/^poker_/.test(c.name)&&c.activeInHierarchy).map(c=>{const p=c._components.find(p=>p.value_sprite);return {frame:p?.value_sprite?.spriteFrame?.name};})};})};})()");
  await until(async()=>Number((await readPanel())?.round)===detail.currInning,5000,'history renders');
  let ui=await readPanel();assert.ok(ui.rows>0);assert.ok(ui.sides.every(s=>s.active&&s.cards.length===2&&s.cards.every(c=>c.frame)));
  await ev("(()=>{const p="+panelExpr+";p.onClickPrev();return true;})()");
  await until(async()=>Number((await readPanel())?.round)===rounds[0].inning,5000,'previous review');
  await ev("(()=>{const p="+panelExpr+";p.onClickNext();return true;})()");
  await until(async()=>Number((await readPanel())?.round)===detail.currInning,5000,'next review');
  console.log('HISTORY_UI',JSON.stringify(await readPanel()));
  await delay(700); // Let the native labels and asynchronous sprites reach the rendered frame.
  const shot=await send('Page.captureScreenshot');
  fs.writeFileSync(path.join(os.tmpdir(),'gogame-hundred-mahjong-history.png'),Buffer.from(shot.result.data,'base64'));
  await ev("__require('Facade').default.getModule('Bairen').emit(__require('BairenTypes').BairenEvent.HIDE_BAIREN_HISTORY);true");
  assert.equal(errors.length,0,JSON.stringify(errors.map(e=>e.exception?.description||e.text)));
  assert.equal(logs.filter(line=>/TypeError|DecimalError|NaN|FrameTaskRunner|逻辑异常|数据异常|麻将牌不存在/.test(line)).length,0,JSON.stringify(logs.slice(-30)));
  }
  assert.equal(errors.length,0,JSON.stringify(errors.map(e=>e.exception?.description||e.text)));
  // The native panel hide handler owns its animation, input mask and exit request.
  await ev("__require('Facade').default.getModule('Bairen').emit(__require('BairenTypes').BairenEvent.FORCED_CLOSE_PANEL);true");
  await until(()=>ev("!__require('GlobalGameData').default.isInBairenQpGame"),5000,'overlay closes');
  await ev("__require('SocketMgr').default.instance.send(2110);true");
  await until(async()=>await ev('cc.director.getScene().name')==='webHallOb',10000,'return to hall');
  await until(()=>evaluate("Array.from(document.querySelectorAll('[class*=gameIframe] iframe')).every(el=>getComputedStyle(el).visibility==='hidden'||getComputedStyle(el).display==='none'||!el.getClientRects().length)"),5000,'hall visible');
  assert.equal(errors.length,0,JSON.stringify(errors));
  await delay(500);
  const hallShot=await send('Page.captureScreenshot');
  fs.writeFileSync(path.join(os.tmpdir(),'gogame-hundred-mahjong-hall.png'),Buffer.from(hallShot.result.data,'base64'));
  console.log(shortcutOnly ? 'PASS: native Mahjong cross-game shortcuts, balances, settlement, new round and hall return' : 'PASS: native hundred Mahjong category, spectator host, robots, clocks, two bets, settlement, roads, review, paging and hall return');
} catch(error){
  console.log('ENTRY_FRAMES',JSON.stringify(frames.filter(f=>[2102,2201,6105,6106,6205,6123,6124,6224,6225,6227,6230].includes(f.msgid))));
  console.log('FAIL_FRAMES',JSON.stringify(frames.slice(-35)));
  console.log('FAIL_LOGS',JSON.stringify(logs.slice(-35)));
  console.log('FAIL_ERRORS',JSON.stringify(errors.map(e=>e.exception?.description||e.text)));throw error;
} finally {
  if(ev)await ev("(()=>{const vm=__require('BairenHelper').default.vm;vm?.commandExit();__require('SocketMgr').default.instance.send(2110);return true;})()").catch(()=>{});
  ws?.close();browser.kill();
}

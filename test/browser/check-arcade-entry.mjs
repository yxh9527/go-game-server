import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { decodeFrame } from '../../game-server/src/codec.js';



const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gogame-arcade-'));
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
      if (!line.includes('[HALL-NET]') && /Turntable|BlackJack|Bairen|gotoScene|TypeError|NaN|FrameTaskRunner|逻辑异常|数据异常/.test(line)) logs.push(line.slice(0, 700));
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
  const requested = process.env.ARCADE_TYPES ? process.env.ARCADE_TYPES.split(',').map(Number) : [53,54,55,56,57];
  for (const type of requested) {
    const names = {53:'奔驰宝马',54:'森林舞会',55:'飞禽走兽',56:'麻将转了',57:'趣味捕鱼'};
    const uid = 88010000 + type;
    const startFrames = frames.length, startErrors = errors.length;
    await send('Page.navigate', { url:'http://lobby.localhost:11042/21/0?userId='+uid+'&userToken=dev-'+uid+'&openId='+uid+'&v=2.0.1279' });
    await delay(7000);
    assert.ok(await evaluate("(()=>{const el=document.querySelector('img[src*=\"category/02.webp\"]');el?.parentElement.click();return !!el;})()"));
    await delay(2000);
    assert.ok(await evaluate("(()=>{const el=document.querySelector('img[src*=\"types/1001.png\"]');el?.parentElement.click();return !!el;})()"));
    await delay(2500);
    const listed=await evaluate("Array.from(document.querySelectorAll('[class*=roomList] li')).map(el=>({text:el.innerText,image:el.querySelector('img')?.getAttribute('src')}))");
    console.log('LIST',type,JSON.stringify(listed));assert.equal(listed.filter(row=>Object.values(names).some(name=>row.text.startsWith(name))).length,5);
    const entered=await evaluate("(()=>{const rows=Array.from(document.querySelectorAll('[class*=roomList] li'));const el=rows.find(el=>el.innerText.includes("+JSON.stringify(names[type])+")||el.querySelector('img')?.getAttribute('src').includes('/"+type+".'));el?.click();return !!el;})()");
    assert.ok(entered,'native lobby arcade entry '+type);await delay(15000);
    let session;
    const scene={53:'bcbm',54:'slwh',55:'fqzs',56:'mj',57:'by'}[type];
    for(const candidate of sessions.slice().reverse()) {
      try{if(await evaluate('window.cc&&cc.director.getScene()?.name',candidate)===scene){session=candidate;break;}}catch{}
    }
    assert.ok(session,'original arcade scene '+scene);ev=expression=>evaluate(expression,session);
    const ownFrames=()=>frames.slice(startFrames);
    await until(()=>ownFrames().some(f=>f.msgid===6205&&f.payload.roomType===type),5000,'ENTER '+type);
    const entry=ownFrames().find(f=>f.msgid===6205&&f.payload.roomType===type).payload,rid=entry.roomId;
    assert.equal(entry.defaultOuter.length,24);assert.equal(entry.defaultInner.length,24);assert.equal(Object.keys(entry.areaOdds).length,30);
    const main="(()=>{let found;function walk(n){const c=n.getComponent&&n.getComponent('TurntableMain');if(c)found=c;n.children?.forEach(walk);}walk(cc.director.getScene());return found;})()";
    const state=()=>ev('('+main+').viewModel.model.__currentGameState');
    await until(async()=>await state()===2,45000,'betting '+type);
    const betStart=frames.length;
    console.log('BEFORE_UI',type,JSON.stringify(await ev('(()=>{const p='+main+';return {state:p.viewModel.model.__currentGameState,balance:p.viewModel.model.__currentBalance,chip:p.viewModel.__currentChipValue};})()')));
    await ev('(()=>{const p='+main+';p.operation_part.onChipButtonClick(null,"1");p.area_part.onAreaClick(null,"13");p.operation_part.onConfirmButtonClick();return true;})()');
    await until(()=>frames.slice(betStart).some(f=>f.msgid===6201&&f.payload.roomType===type&&f.payload.code===0),5000,'native bet succeeds '+type);
    const bet=frames.slice(betStart).find(f=>f.msgid===6201&&f.payload.roomType===type&&f.payload.code===0).payload;
    assert.equal(bet.myTotalBets[0].areaId,13);assert.equal(bet.myTotalBets[0].total,100);
    const inning=await ev('('+main+').viewModel.model.__currentInning');
    await until(()=>ownFrames().some(f=>f.msgid===6208&&f.payload.inning===inning&&Object.keys(f.payload.areaWinningScores||{}).length>0),35000,'personal settlement '+type);
    const result=ownFrames().find(f=>f.msgid===6208&&f.payload.inning===inning&&Object.keys(f.payload.areaWinningScores||{}).length>0).payload;
    assert.equal(result.points,entry.points+result.realScore);assert.equal(result.winningAreas.length,15);
    await until(async()=>await state()===6,5000,'settlement animation state '+type);
    await delay(11000);
    console.log('SETTLE_UI',type,JSON.stringify(await ev('(()=>{const p='+main+';return {state:p.viewModel.model.__currentGameState,balance:p.viewModel.model.__currentBalance,win:p.win_lose_part.node.active,outer:p.outer_circular_part.getItemInfo('+result.outerIndex+').type,inner:p.inner_circular_part.getItemInfo('+result.innerIndex+').type};})()')));
    const shot=await send('Page.captureScreenshot');fs.writeFileSync(path.join(os.tmpdir(),'gogame-arcade-'+type+'-settle.png'),Buffer.from(shot.result.data,'base64'));
    await until(()=>ownFrames().some(f=>f.msgid===6202&&f.payload.roomId===rid&&f.payload.allPlayerBets.some(b=>b.areaId!==13&&b.total>0)),15000,'robot bets '+type);
    await ev("__require('Facade').default.getModule('Turntable').emit(__require('TurntableConfig').TurntableConfig.Event.SHOW_HISTORY);true");
    await until(()=>ownFrames().some(f=>f.msgid===6221&&f.payload.list?.includes(inning)),5000,'history list '+type);
    await until(()=>ownFrames().some(f=>f.msgid===6222&&f.payload.currInning===inning),5000,'history detail '+type);
    const detail=ownFrames().find(f=>f.msgid===6222&&f.payload.currInning===inning).payload;
    assert.equal(detail.innerValue,result.innerValue);assert.equal(detail.outerValue,result.outerValue);assert.equal(detail.betDetailTableMap[13].betScore,100);
    await delay(800);const hs=await send('Page.captureScreenshot');fs.writeFileSync(path.join(os.tmpdir(),'gogame-arcade-'+type+'-history.png'),Buffer.from(hs.result.data,'base64'));
    assert.equal(errors.length,startErrors,JSON.stringify(errors.slice(startErrors).map(e=>e.exception?.description||e.text)));
    await ev('('+main+').viewModel.commandLeaveGame();true');
    await until(async()=>await ev('cc.director.getScene().name')==='webHallOb',10000,'return to hall '+type);
    console.log('PASS_ARCADE',type,names[type],JSON.stringify({inning,realScore:result.realScore,points:result.points}));
  }
  assert.equal(errors.length,0,JSON.stringify(errors.map(e=>e.exception?.description||e.text)));
  console.log('PASS: original arcade entry, chips/area/confirm, robots, payout, review and hall return');
} catch(error) {
  console.log('FAIL_FRAMES',JSON.stringify(frames.slice(-20)));
  console.log('FAIL_LOGS',JSON.stringify(logs.slice(-25)));
  console.log('FAIL_ERRORS',JSON.stringify(errors.map(e=>e.exception?.description||e.text)));throw error;
} finally { ws?.close();browser.kill(); }

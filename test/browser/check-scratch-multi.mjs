import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { decodeFrame } from '../../game-server/src/codec.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gogame-scratch-multi-'));
const browser = spawn(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-extensions', '--no-first-run',
  '--remote-debugging-port=0', '--user-data-dir=' + profile, '--window-size=1280,1000', 'about:blank',
], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
const frames = [], errors = [], logs = [], sessions = [], pending = new Map();
let socket, sequence = 0;
try {
  let port;
  for (let i = 0; i < 100; i++) {
    try { port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; break; }
    catch { await delay(100); }
  }
  const target = (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()).find(t => t.type === 'page');
  socket = new WebSocket(target.webSocketDebuggerUrl.replace('localhost', '127.0.0.1'));
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 15000);
    pending.set(id, message => { clearTimeout(timer); message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result); });
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });
  socket.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); }
    else if (m.method === 'Target.attachedToTarget') {
      const id = m.params.sessionId; sessions.push(id);
      Promise.all([send('Runtime.enable', {}, id), send('Network.enable', {}, id)]).catch(e => logs.push(e.message));
    } else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails);
    else if (m.method === 'Runtime.consoleAPICalled') {
      const line = m.params.args.map(a => a.value ?? a.description ?? '').join(' ');
      if (/Multy|6231|6127|TypeError|FrameTaskRunner|ggl/.test(line)) logs.push(line.slice(0, 500));
      if (m.params.type === 'error' && /TypeError:|ReferenceError:|SyntaxError:|任务出错/.test(line)) errors.push({ text: line });
    } else if (/Network.webSocketFrame(Sent|Received)/.test(m.method)) {
      try { const f = decodeFrame(Buffer.from(m.params.response.payloadData, 'base64'));
        if (f) frames.push({ direction: m.method.endsWith('Sent') ? 'send' : 'receive', ...f }); } catch {}
    }
  });
  const evaluate = async (expression, sessionId) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    assert.ok(!r.exceptionDetails, JSON.stringify(r.exceptionDetails)); return r.result?.value;
  };
  const until = async (check, timeout, description) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await check()) return; await delay(300); }
    assert.fail('timeout: ' + description);
  };
  await Promise.all([send('Page.enable'), send('Runtime.enable'), send('Network.enable')]);
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  const uid = 88116163;
  await send('Page.navigate', { url: 'http://lobby.localhost:11042/21/0?userId=' + uid + '&userToken=dev-' + uid + '&openId=' + uid + '&v=2.0.1279' });
  await delay(6500);
  if (!await evaluate('!!document.querySelector(\'img[src*="types/1004.png"]\')')) {
    await evaluate('document.querySelector(\'img[src*="category/02.webp"]\')?.parentElement.click();true'); await delay(800);
  }
  assert.ok(await evaluate('(()=>{const n=document.querySelector(\'img[src*="types/1004.png"]\');n?.parentElement.click();return !!n})()'));
  await delay(1300);
  assert.ok(await evaluate('(()=>{const n=document.querySelector(\'img[src*="room/type/1004/61.webp"]\');n?.closest("li").click();return !!n})()'));
  let session;
  await until(async () => { for (const id of sessions) try {
    if (await evaluate('typeof cc!=="undefined"&&cc.director.getScene()?.name==="gglmj"', id)) { session = id; return true; }
  } catch {} }, 25000, 'native scratch scene');
  const ev = expression => evaluate(expression, session);
  const find = predicate => `(()=>{function walk(n){if(!n)return null;const c=(n._components||[]).find(c=>${predicate});if(c)return c;for(const ch of n.children||[]){const r=walk(ch);if(r)return r;}return null;}for(const n of [cc.director.getScene(),...Object.values(cc.game._persistRootNodes)]){const r=walk(n);if(r)return r;}return null;})()`;
  const entrance = find('typeof c.onEntranceClick==="function"');
  await until(() => ev('!!(' + entrance + ')'), 10000, 'native multi entrance');
  await ev('(' + entrance + ').onEntranceClick();true');
  const panel = find('Array.isArray(c._roomItemCmps)');
  await until(async () => await ev('(()=>{const p=' + panel + ';return !!p&&p._roomItemCmps.some(c=>c.roomType===61)&&p._roomItemCmps.some(c=>c.roomType===63)})()'), 20000, 'two native scratch room cards');
  const inspect = () => ev('(()=>{const p=' + panel + ';return {active:p.node.activeInHierarchy,rooms:p._roomItemCmps.map(c=>({roomId:c.roomId,type:c.roomType,prices:Array.from(c.itemMap.keys()),rows:Array.from(c.itemMap).map(([price,r])=>({price,phase:r.phase,auto:r.autoCount,wallet:r.pendingWalletAmount}))}))}})()');
  console.log('MULTI_INITIAL', JSON.stringify(await inspect()));
  assert.ok((await inspect()).active);
  const initialRooms = (await inspect()).rooms;
  assert.ok(initialRooms.every(r => r.prices.includes(1)));
  // Native click handlers, no injected betting packets. Trigger both games at
  // the same denomination so response-room correlation is exercised in-browser.
  const start = frames.length;
  await ev('(()=>{const p=' + panel + ';for(const c of p._roomItemCmps){const r=c.itemMap.get(1);r.onClickConfirm();}return true})()');
  await until(() => frames.slice(start).filter(f => f.msgid === 6231).length === 2, 10000, 'both scratch purchase results');
  const receipts = frames.slice(start).filter(f => f.msgid === 6231).map(f => f.payload);
  assert.ok(receipts.every(r => r.code === 0 && r.faceValue === 100 && r.huMask.length === 20), JSON.stringify(receipts));
  assert.equal(new Set(receipts.map(r => r.roomId)).size, 2);
  assert.equal(frames.slice(start).filter(f => f.direction === 'send' && f.msgid === 6127).length, 2);
  await until(async () => (await inspect()).rooms.every(r => r.rows.find(row => row.price === 1).phase === 0), 45000, 'native reveal and settlement complete');
  assert.equal(await ev("__require('MultyBetHelper').default.vm.__usertBalancePoints"), receipts.at(-1).walletAmount);
  console.log('MULTI_SINGLE', JSON.stringify(receipts.map(r => ({ roomId: r.roomId, serial: r.serialFull, win: r.winAmount, wallet: r.walletAmount }))));
  const autoStart = frames.length;
  await ev('(()=>{const p=' + panel + ';const r=p._roomItemCmps[0].itemMap.get(2);r.onClickAuto();r.autoCount=2;r.onClickConfirm();return true})()');
  await until(() => frames.slice(autoStart).filter(f => f.msgid === 6231).length >= 2, 45000, 'native automatic scratch repeats');
  await until(async () => (await inspect()).rooms[0].rows.find(row => row.price === 2).phase === 0, 45000, 'automatic count finishes');
  assert.equal(frames.slice(autoStart).filter(f => f.msgid === 6231).length, 2);
  assert.ok(frames.slice(autoStart).filter(f => f.msgid === 6231).every(f => f.payload.faceValue === 200 && f.payload.code === 0));
  assert.equal(await ev("__require('MultyBetHelper').default.vm.__usertBalancePoints"), frames.findLast(f => f.msgid === 6231).payload.walletAmount);
  const screenshot = await send('Page.captureScreenshot');
  const shotPath = path.resolve('test/browser/scratch-multi.png');
  fs.writeFileSync(shotPath, Buffer.from(screenshot.data, 'base64'));
  await ev('(' + panel + ').hide();true');
  await until(() => frames.some(f => f.direction === 'send' && f.msgid === 6124), 6000, 'native panel unsubscribe');
  await until(async () => !(await inspect()).active, 6000, 'native panel hide animation');
  assert.equal(await ev('cc.director.getScene().name'), 'gglmj');
  assert.equal(errors.length, 0, JSON.stringify(errors));
  console.log('PASS_SCRATCH_MULTI', JSON.stringify({ receipts: 4, rooms: initialRooms.map(r => r.roomId), screenshot: shotPath, ui: await inspect() }));
} catch (error) {
  console.log('FAIL_ERRORS', JSON.stringify(errors));
  console.log('FAIL_FRAMES', JSON.stringify(frames.slice(-12)));
  console.log('FAIL_LOGS', JSON.stringify(logs.slice(-15)));
  throw error;
} finally { socket?.close(); browser.kill(); }

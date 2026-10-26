import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import assert from 'node:assert/strict';

// Requires resident dev services. Uses a separate browser profile and test
// account. Optional --holdem exercises the same bridge with the Holdem bundle.
// --betting seats/funds that dev account and checks the first Zjh action turn,
// then leaves through the normal room protocol.
const holdem = process.argv.includes('--holdem');
const betting = process.argv.includes('--betting');
const history = process.argv.includes('--history');
const expectedScene = holdem ? 'gameHoldem' : 'gameZjh';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gogame-zjh-'));
const executable = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser = spawn(executable, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-extensions', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--remote-debugging-port=0', '--user-data-dir=' + profile, '--window-size=1280,900',
  '--autoplay-policy=no-user-gesture-required', 'about:blank',
], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let diagnostics = '';
browser.stderr.on('data', data => { diagnostics = (diagnostics + data).slice(-4000); });
const delay = ms => new Promise(r => setTimeout(r, ms));
const log = [];
let ws;
let leaveTestRoom;
try {
  let port;
  for (let i = 0; i < 100; i++) {
    try { port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; break; } catch {}
    await delay(100);
  }
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = targets.find(t => t.type === 'page');
  ws = new WebSocket(target.webSocketDebuggerUrl.replace('localhost', '127.0.0.1'));
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  let id = 0;
  const pending = new Map();
  const sessions = [];
  ws.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); }
    else if (m.method === 'Target.attachedToTarget') {
      const session = m.params.sessionId; sessions.push(session);
      send('Runtime.enable', {}, session); send('Network.enable', {}, session);
    } else if (['Runtime.exceptionThrown', 'Runtime.consoleAPICalled', 'Network.requestWillBeSent', 'Network.responseReceived', 'Network.webSocketFrameReceived', 'Network.webSocketFrameSent'].includes(m.method)) log.push(m);
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const n = ++id;
    const timer = setTimeout(() => { pending.delete(n); reject(new Error('CDP timeout: ' + method)); }, 15000);
    pending.set(n, message => { clearTimeout(timer); resolve(message); });
    ws.send(JSON.stringify({ id: n, method, params, sessionId }));
  });
  const evaluate = async expression => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result;
  await send('Runtime.enable'); await send('Network.enable'); await send('Page.enable');
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await send('Page.navigate', { url: 'http://lobby.localhost:11042/21/0?userId=88000252&userToken=dev-88000252&openId=88000252&v=2.0.1279' });
  await delay(16000);
  if (holdem) {
    await evaluate(`Array.from(document.querySelectorAll('span,p,div,a')).find(e=>e.textContent==='德州'&&e.children.length===0)?.click()`);
    await delay(2000);
  }
  const click = await evaluate(`(()=>{const e=document.querySelector('[class*="roomList"] li');if(!e)return false;e.click();return true;})()`);
  assert.equal(click.result.value, true, 'hall contains a clickable room');
  await delay(18000);
  const frames = [];
  for (const session of sessions) {
    const response = await send('Runtime.evaluate', { expression: `(()=>{const r=window.cc&&cc.app?.gameRoom;return {scene:window.cc&&cc.director.getScene()?.name,roomType:r?._conf?.roomType,observer:!!r?.getMyObMemberInfo(),seated:!!r?.getMyMemberInfo()};})()`, returnByValue: true }, session);
    frames.push(response.result?.result?.value);
  }
  const shot = await send('Page.captureScreenshot');
  fs.writeFileSync(`test/browser/${expectedScene}-entry.png`, Buffer.from(shot.result.data, 'base64'));
  const errors = log.filter(x => x.method === 'Runtime.exceptionThrown');
  const room = frames.find(f => f?.scene === expectedScene);
  const visible = await evaluate(`(()=>{const f=document.querySelector('[class*="gameIframe"]');return f&&getComputedStyle(f).visibility==='visible';})()`);
  console.log(JSON.stringify({ expectedScene, frames, visible: visible.result.value, errors }));
  assert.ok(room, 'original client reached the expected game scene');
  assert.equal(room.roomType, holdem ? 19 : 25);
  assert.equal(room.observer, true);
  assert.equal(room.seated, false);
  assert.equal(visible.result.value, true, 'hall displays the game frame');
  assert.equal(errors.length, 0, 'no uncaught browser errors');
  if (history) {
    const frameEval = async expression => {
      const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessions.at(-1));
      assert.ok(!response.result?.exceptionDetails, JSON.stringify(response.result?.exceptionDetails));
      return response.result?.result?.value;
    };
    const opened = await frameEval(`(()=>{const c=cc.Canvas.instance.getComponentsInChildren(cc.Component).find(c=>typeof c.onGameHistoryClick==='function');if(!c)return false;c.onGameHistoryClick();return true;})()`);
    assert.equal(opened, true, 'original history button is available');
    await delay(5000);
    const rows = await frameEval(`cc.Canvas.instance.getComponentsInChildren('ZjhHisDetaiActItem').filter(c=>c._data).map(c=>({name:c.nameLabel.string,amount:c.amountLb.string,pot:c.potLab.string}))`);
    console.log('HISTORY', JSON.stringify(rows));
    assert.ok(rows.length > 0, 'history detail renders actual action rows');
    assert.ok(rows.every(r => typeof r.name === 'string' && r.name && !/NaN/.test(r.amount + r.pot)));
    const frameErrors = log.filter(x => x.method === 'Runtime.exceptionThrown' ||
      x.method === 'Runtime.consoleAPICalled' && x.params.args.some(a => a.subtype === 'error' || /trim is not a function/.test(a.description || a.value || '')));
    assert.equal(frameErrors.length, 0, JSON.stringify(frameErrors));
  }
  if (betting) {
    assert.equal(holdem, false, '--betting verifies Zjh controls');
    const session = sessions.at(-1);
    const frameEval = async expression => {
      const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, session);
      assert.ok(!response.result?.exceptionDetails, JSON.stringify(response.result?.exceptionDetails));
      return response.result?.result?.value;
    };
    leaveTestRoom = () => frameEval(`__require('SocketMgr').default.instance.send(2110); true`);
    const pos = await frameEval(`(()=>{const r=cc.app.gameRoom;const seat=r._conf.memberList.find(s=>!s.userInfo);if(!seat)return -1;__require('SocketMgr').default.instance.send(5003,{position:seat.pos});return seat.pos;})()`);
    assert.ok(pos >= 0, 'test account has an empty seat');
    await delay(500);
    await frameEval(`__require('SocketMgr').default.instance.send(5001,{carryIn:10});true`);
    let controls;
    for (let i = 0; i < 180; i++) {
      controls = await frameEval(`(()=>{const ui=cc.Canvas.instance.getComponentInChildren('ZjhPlayerAction');if(!ui)return null;return {actions:ui.actionBtns.activeInHierarchy,waiting:ui.preActionToggles.node.activeInHierarchy,buttons:['bipai','qipai','jiazhu','gendaodi','genzhu'].map(k=>({name:k,visible:ui[k+'Btn'].activeInHierarchy,amount:ui[k+'Label']?.string})),seated:!!cc.app.gameRoom.getMyMemberInfo()};})()`);
      if (controls?.actions) break;
      await delay(500);
    }
    console.log('BETTING', JSON.stringify(controls));
    assert.equal(controls?.actions, true, 'test player receives an action turn');
    assert.equal(controls.waiting, false, 'waiting toggles must not overlay action buttons');
    assert.ok(controls.buttons.every(b => b.visible));
    assert.ok(controls.buttons.every(b => b.amount == null || !/NaN|undefined/.test(b.amount)));
    const bettingShot = await send('Page.captureScreenshot');
    fs.writeFileSync('test/browser/gameZjh-betting.png', Buffer.from(bettingShot.result.data, 'base64'));
    assert.equal(log.filter(x => x.method === 'Runtime.exceptionThrown').length, 0);
  }
} catch (error) {
  fs.writeFileSync('test/browser/entry-failure.json', JSON.stringify({ log, diagnostics }));
  throw error;
} finally {
  if (leaveTestRoom) { await leaveTestRoom().catch(() => {}); await delay(500); }
  ws?.close(); browser.kill();
}

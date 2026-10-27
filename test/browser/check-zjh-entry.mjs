import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import assert from 'node:assert/strict';

// Requires resident dev services. Uses a separate browser profile and test
// account. Optional --holdem exercises the same bridge with the Holdem bundle.
// --tier=N selects a Zjh tier (0..8). Each tier uses a separate test account.
// --betting seats/funds that dev account and checks the first Zjh action turn,
// then leaves through the normal room protocol.
// --fold also verifies silent partial-card snapshot restoration and fold-show.
// --info opens the original table information panel and validates look-two rules.
const holdem = process.argv.includes('--holdem');
const fold = process.argv.includes('--fold') || process.argv.includes('--fold-debug');
const betting = process.argv.includes('--betting') || fold;
const history = process.argv.includes('--history');
const info = process.argv.includes('--info');
const observe = process.argv.includes('--observe');
const tierIndex = Number(process.argv.find(a => a.startsWith('--tier='))?.split('=')[1] || 0);
const zjhTiers = [[2501, 3, 10, 100], [16, 3, 100, 1000], [17, 3, 500, 5000], [125, 3, 2000, 50000], [134, 2, 100, 1000], [73, 2, 500, 5000], [74, 2, 2000, 50000], [2503, 5, 10, 100], [2502, 5, 100, 1000]];
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
  const userId = 88000252 + tierIndex + (fold ? 1000 : 0);
  await send('Page.navigate', { url: `http://lobby.localhost:11042/21/0?userId=${userId}&userToken=dev-${userId}&openId=${userId}&v=2.0.1279` });
  await delay(16000);
  if (holdem) {
    await evaluate(`Array.from(document.querySelectorAll('span,p,div,a')).find(e=>e.textContent==='德州'&&e.children.length===0)?.click()`);
    await delay(2000);
  }
  const list = await evaluate(`Array.from(document.querySelectorAll('[class*="roomList"] li')).map(e=>e.innerText)`);
  console.log('ROOMS', JSON.stringify(list.result.value));
  if (!holdem) assert.equal(list.result.value.length, 9, 'all nine Zjh tiers are visible');
  const click = await evaluate(`(()=>{const e=document.querySelectorAll('[class*="roomList"] li')[${tierIndex}];if(!e)return false;e.click();return true;})()`);
  assert.equal(click.result.value, true, 'hall contains a clickable room');
  await delay(18000);
  const frames = [];
  for (const session of sessions) {
    const response = await send('Runtime.evaluate', { expression: `(()=>{const r=window.cc&&cc.app?.gameRoom;return {scene:window.cc&&cc.director.getScene()?.name,roomType:r?._conf?.roomType,ante:r?._conf?.ctjh?.ante,carryMin:r?._conf?.ctjh?.carryMin,playMode:r?._conf?.playMode,observer:!!r?.getMyObMemberInfo(),seated:!!r?.getMyMemberInfo()};})()`, returnByValue: true }, session);
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
  if (!holdem) {
    assert.equal(room.playMode, zjhTiers[tierIndex][1]);
    assert.equal(room.ante, zjhTiers[tierIndex][2]);
    assert.equal(room.carryMin, zjhTiers[tierIndex][3]);
  }
  assert.equal(room.observer, true);
  assert.equal(room.seated, false);
  assert.equal(visible.result.value, true, 'hall displays the game frame');
  assert.equal(errors.length, 0, 'no uncaught browser errors');
  if(observe){
    assert.equal(holdem,false);
    const frameEval=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},sessions.at(-1));assert.ok(!r.result?.exceptionDetails,JSON.stringify(r.result?.exceptionDetails));return r.result?.result?.value;};
    leaveTestRoom=()=>frameEval(`__require('SocketMgr').default.instance.send(2110);true`);
    await frameEval(`(()=>{window.__observerDeals=[];const n=__require('NotificationCenter').default,emit=n.emit;n.emit=function(event,data,...args){if(event==='blockchain:fapai'){const r=cc.app.gameRoom,b=r._conf.memberList.find(m=>m.userInfo&&r.getLocalIndex(m.pos)===0);__observerDeals.push({inning:r._conf.currentInning,bottom:b?.userInfo.uid,cards:data.cards.map(c=>{const m=r._conf.memberList.find(m=>m.userInfo&&r.getLocalIndex(m.pos)===c.index),p=data.comp.getCardPosByIndex(c);return {uid:m?.userInfo.uid,index:c.index,pos:c.pos,x:p?.x,y:p?.y};})});}return emit.call(this,event,data,...args);};return true;})()`);
    let deals=[];
    for(let i=0;i<180;i++){deals=await frameEval('window.__observerDeals');if(deals.length>=2)break;await delay(600);}
    assert.ok(deals.length>=2,'spectator sees two new deals');
    assert.ok(deals.every(d=>d.bottom&&d.cards.length>=6&&d.cards.every(c=>c.uid&&Number.isFinite(c.x)&&Number.isFinite(c.y))),'all animation targets and bottom seats have actual players');
    assert.equal(await frameEval('!!cc.app.gameRoom.getMyMemberInfo()'),false);
    console.log('OBSERVER_DEALS',JSON.stringify(deals.map(d=>({inning:d.inning,bottom:d.bottom,cards:d.cards.length}))));
    const screenshot=await send('Page.captureScreenshot');fs.writeFileSync('test/browser/gameZjh-observer.png',Buffer.from(screenshot.result.data,'base64'));
    const observedErrors=log.filter(x=>x.method==='Runtime.exceptionThrown');assert.equal(observedErrors.length,0,JSON.stringify(observedErrors));
  }
  if (info) {
    const frameEval = async expression => {
      const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessions.at(-1));
      assert.ok(!response.result?.exceptionDetails, JSON.stringify(response.result?.exceptionDetails));
      return response.result?.result?.value;
    };
    const opened = await frameEval(`(()=>{const c=cc.Canvas.instance.getComponentsInChildren(cc.Component).find(c=>typeof c.onGameInfoClick==='function');if(!c)return false;c.onGameInfoClick();return true;})()`);
    assert.equal(opened, true, 'original table information button is available');
    await delay(2500);
    const displayed = await frameEval(`(()=>{const c=cc.Canvas.instance.getComponentInChildren('TableInfoPanel');if(!c)return null;return {labels:[...c.node.getComponentsInChildren(cc.Label),...c.node.getComponentsInChildren(cc.RichText)].filter(x=>x.node.activeInHierarchy).map(x=>x.string),room:cc.app.gameRoom.getRoomInfo()};})()`);
    console.log('TABLE_INFO', JSON.stringify(displayed));
    assert.ok(displayed, 'original table information panel opens');
    const actual = displayed.room;
    assert.equal(actual.maxPeople, 7);
    assert.equal(actual.memberList.length, 7);
    assert.equal(actual.disusePoint, actual.ctjh.carryMin - actual.ctjh.ante);
    assert.equal(actual.ctjh.randomSit, true);
    assert.equal(actual.ctjh.banTalk, true);
    if (room.playMode === 2) {
      assert.equal(actual.ctjh.taxType, 2);
      assert.equal(actual.ctjh.taxPercent, 500);
      assert.ok(displayed.labels.some(text => text.includes('5.0%')));
    }
    const screenshot = await send('Page.captureScreenshot');
    fs.writeFileSync('test/browser/gameZjh-info.png', Buffer.from(screenshot.result.data, 'base64'));
    await frameEval(`cc.Canvas.instance.getComponentInChildren('TableInfoPanel').closeIt();true`);
  }
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
    if (fold) await frameEval(`(()=>{window.__flips=[];const p=__require('BairenCard').default.prototype;const orig=p.showLastPaiAnim;p.showLastPaiAnim=function(...args){const own=cc.Canvas.instance.getComponentInChildren('ZjhAllPaiMain')?._seatsScript[0]?._hold.children.includes(this.node);window.__flips.push({t:Date.now(),card:this._cardNum,own});return orig.apply(this,args);};return true;})()`);
    const pos = await frameEval(`(()=>{const r=cc.app.gameRoom;const seat=r._conf.memberList.find(s=>!s.userInfo);if(!seat)return -1;__require('SocketMgr').default.instance.send(5003,{position:seat.pos});return seat.pos;})()`);
    assert.ok(pos >= 0, 'test account has an empty seat');
    await delay(500);
    await frameEval(`__require('SocketMgr').default.instance.send(5001,{carryIn:${Math.max(10, zjhTiers[tierIndex][3] / 100)}});true`);
    let controls;
    for (let i = 0; i < 180; i++) {
      controls = await frameEval(`(()=>{const ui=cc.Canvas.instance.getComponentInChildren('ZjhPlayerAction');if(!ui)return null;const self=cc.app.gameRoom.getMyMemberInfo();return {actions:ui.actionBtns.activeInHierarchy,waiting:ui.preActionToggles.node.activeInHierarchy,buttons:['bipai','qipai','jiazhu','gendaodi','genzhu'].map(k=>({name:k,visible:ui[k+'Btn'].activeInHierarchy,amount:ui[k+'Label']?.string})),seated:!!self,cards:self?.holds};})()`);
      if (controls?.actions) break;
      await delay(500);
    }
    console.log('BETTING', JSON.stringify(controls));
    assert.equal(controls?.actions, true, 'test player receives an action turn');
    assert.equal(controls.waiting, false, 'waiting toggles must not overlay action buttons');
    assert.ok(controls.buttons.every(b => b.visible));
    assert.ok(controls.buttons.every(b => b.amount == null || !/NaN|undefined/.test(b.amount)));
    const initialVisible = room.playMode === 2 ? 2 : room.playMode === 5 ? 1 : 0;
    assert.equal(controls.cards?.filter(c => c >= 0).length, initialVisible, 'first turn shows only the authorized initial cards');
    if (fold) {
      await delay(1000);
      await frameEval(`window.__flips=[];__require('SocketMgr').default.instance.send(2111);true`);
      await delay(1000);
      await frameEval(`__require('SocketMgr').default.instance.send(2111);true`);
      await delay(1000);
      const restored = await frameEval(`({cards:cc.app.gameRoom.getMyMemberInfo()?.holds,flips:window.__flips.filter(x=>x.own),inning:cc.app.gameRoom._conf.currentInning})`);
      console.log('RESTORED', JSON.stringify(restored));
      assert.equal(restored.flips.length, 0, 'snapshots restore partial cards without replaying flip animations');
      assert.equal(restored.cards?.filter(c => c >= 0).length, initialVisible, 'snapshot restoration preserves authorized card faces');
      await frameEval(`cc.Canvas.instance.getComponentInChildren('ZjhPlayerAction').onQiPaiClick();true`);
      await delay(3000);
      const folded = await frameEval(`({cards:cc.app.gameRoom.getMyMemberInfo()?.holds,flips:window.__flips.filter(x=>x.own),inning:cc.app.gameRoom._conf.currentInning})`);
      console.log('FOLDED', JSON.stringify(folded));
      assert.equal(folded.cards?.filter(c=>c>=0).length, 3, 'fold reveals all three cards immediately');
    }
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

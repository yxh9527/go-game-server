import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { decodeFrame } from '../../game-server/src/codec.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gogame-room-change-'));
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
      if (/@http|reqRoomList|Error|TypeError|FrameTaskRunner|目标房|换|列表/.test(line)) logs.push(line.slice(0, 1500));
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
  const uid=Number(process.env.GOGAME_BROWSER_UID)||88117759;
  await send('Page.navigate',{url:'http://lobby.localhost:11042/21/0?userId='+uid+'&userToken=dev-'+uid+'&openId='+uid+'&v=2.0.1279'});
  await delay(8500);
  assert.ok(await evaluate('(()=>{const e=document.querySelectorAll(\'[class*="roomList"] li\')[0];e?.click();return !!e})()'));
  let session;
  await until(async()=>{for(const id of sessions)try{if(await evaluate('typeof cc!=="undefined"&&cc.director.getScene()?.name==="gameZjh"',id)){session=id;return true}}catch{}},25000,'Zjh scene');
  const ev=expression=>evaluate(expression,session);
  await ev("__require('GameUtils').default.showView('prefabs/game/roomListInside/roomListInside','roomListInside','roomListInside',__require('enums').RoomListInsideType.RateRoom);true");
  await delay(2500);
  const tab=await ev("(()=>{const p=cc.Canvas.instance.getComponentInChildren('roomListInside');const t=p.hallToggleContainer.node.getChildByName('2').getComponent(cc.Toggle);t.isChecked=true;cc.Component.EventHandler.emitEvents(t.checkEvents,t);return t.checkEvents.map(e=>e.handler)})()");
  await delay(2200);
  await ev("(()=>{const p=cc.Canvas.instance.getComponentInChildren('roomListInside');const c=p.node.getComponentsInChildren('roomListInsideGameItem').find(c=>c.node.activeInHierarchy&&c._data?.gameType===1003);if(!c)return false;c.onToggle();return true})()");
  await delay(2000);
  const fields=await ev("(()=>{const p=cc.Canvas.instance.getComponentInChildren('roomListInside');return p.node.getComponentsInChildren(cc.Component).filter(c=>c.data?.roomType===59&&typeof c.joinRoom2==='function'&&c.node.activeInHierarchy).map(c=>({roomId:c.data.roomId,mode:c.data.playMode,index:c.data.roomIndex}))})()");
  console.log('FIELDS',JSON.stringify(fields));
  assert.ok(fields.some(r=>r.mode===0)&&fields.some(r=>r.mode===1)&&fields.some(r=>r.mode===3),'all-modes tab must retain every configured mode');
  const start=frames.length;
  assert.ok(await ev("(()=>{const p=cc.Canvas.instance.getComponentInChildren('roomListInside');const c=p.node.getComponentsInChildren(cc.Component).find(c=>c.data?.roomType===59&&c.data.playMode===1&&typeof c.joinRoom2==='function'&&c.node.activeInHierarchy);if(!c)return false;c.joinRoom2();return true})()"));
  await until(()=>ev('cc.director.getScene().name==="lhd"'),25000,'actual Dragon Tiger scene');
  await until(()=>frames.slice(start).some(f=>f.msgid===6205&&f.payload.roomId===1630004),10000,'peek table snapshot after scene readiness');
  assert.equal(frames.slice(start).find(f=>f.msgid===6205).payload.playMode,1);
  assert.ok(await ev("(()=>{const c=cc.Canvas.instance.getComponentsInChildren(cc.Component).find(c=>typeof c.onClickMenu==='function'&&typeof c.onClickSwitch==='function');if(!c)return false;c.onClickMenu();return c.view.active})()"),'destination native menu opens');
  await delay(800);
  console.log('AFTER',JSON.stringify(await ev("({scene:cc.director.getScene().name,room:cc.app.gameRoom?._conf?.roomId,params:cc.app.gameRoom?.params,module:cc.app.gameRoom?.moduleName})")));
  const shot=await send('Page.captureScreenshot');fs.writeFileSync('test/browser/room-change-hundred.png',Buffer.from(shot.data,'base64'));
  assert.ok(await ev("(()=>{const c=cc.Canvas.instance.getComponentsInChildren(cc.Component).find(c=>typeof c.onClickMenu==='function'&&typeof c.onClickSwitch==='function');if(!c)return false;c.onClickSwitch();return true})()"));
  await until(()=>ev("!!cc.Canvas.instance.getComponentInChildren('roomListInside')"),8000,'Hundred menu opens field selection');
  await ev("(()=>{const p=cc.Canvas.instance.getComponentInChildren('roomListInside');const t=p.hallToggleContainer.node.getChildByName('1').getComponent(cc.Toggle);t.isChecked=true;cc.Component.EventHandler.emitEvents(t.checkEvents,t);return true})()");
  await delay(1800);
  assert.ok(await ev("(()=>{const p=cc.Canvas.instance.getComponentInChildren('roomListInside');const c=p.node.getComponentsInChildren('roomListInsideGameItem').find(c=>c.node.activeInHierarchy&&c._data?.gameType===21);if(!c)return false;c.onToggle();return true})()"));
  await delay(1800);
  assert.ok(await ev("(()=>{const p=cc.Canvas.instance.getComponentInChildren('roomListInside');const c=p.node.getComponentsInChildren(cc.Component).find(c=>c.data?.roomType===25&&c.data.playMode===3&&typeof c.joinRoom2==='function'&&c.node.activeInHierarchy);if(!c)return false;c.joinRoom2();return true})()"));
  await until(()=>ev('cc.director.getScene().name==="gameZjh"'),25000,'return to actual Zjh scene');
  assert.equal(await ev('cc.app.gameRoom._conf.roomType'),25);
  assert.ok(await ev("(()=>{const c=cc.Canvas.instance.getComponentsInChildren(cc.Component).find(c=>c.node.activeInHierarchy&&typeof c.onShowBtnsClick==='function');if(!c)return false;c.onShowBtnsClick();return true})()"),'returned native seat-game menu opens');
  const failures=errors.filter(e=>e.exception?.value!=='--------------------> Promise manually interrupted!! <--------------------');
  console.log('ERRORS',JSON.stringify(failures.map(e=>e.exception?.description||e.exception?.value||e.text)));
  assert.equal(failures.length,0);
  console.log('PASS_ROOM_CHANGE_HUNDRED','Zjh -> peek Dragon Tiger -> Zjh; both native menus and snapshots verified');
} catch (error) {
  console.log('FAIL_ERRORS', JSON.stringify(errors));
  console.log('FAIL_FRAMES', JSON.stringify(frames.slice(-12)));
  console.log('FAIL_LOGS', JSON.stringify(logs.slice(-15)));
  throw error;
} finally { socket?.close(); browser.kill(); }

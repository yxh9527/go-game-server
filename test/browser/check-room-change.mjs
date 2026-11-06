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
  const uid=88117701;
  await send('Page.navigate',{url:'http://lobby.localhost:11042/21/0?userId='+uid+'&userToken=dev-'+uid+'&openId='+uid+'&v=2.0.1279'});
  await delay(8000);
  await evaluate('Array.from(document.querySelectorAll("span")).find(e=>e.textContent==="德州"&&e.children.length===0)?.click();true');
  await delay(1500);
  assert.ok(await evaluate(`(()=>{const e=document.querySelectorAll('[class*="roomList"] li')[0];e?.click();return !!e})()`));
  let session;
  await until(async()=>{for(const id of sessions)try{if(await evaluate('typeof cc!=="undefined"&&cc.director.getScene()?.name==="gameHoldem"',id)){session=id;return true}}catch{}},25000,'holdem scene');
  const ev=expression=>evaluate(expression,session);
  await ev('(()=>{const c=cc.Canvas.instance.getComponentsInChildren(cc.Component).find(c=>typeof c.onClickChangeRate==="function");if(!c)return false;c.onClickChangeRate();return true;})()');
  await delay(3500);
  const inspect=await ev('(()=>{const c=cc.Canvas.instance.getComponentInChildren("roomListInside");return c&&{room:cc.app.gameRoom._conf.roomId,club:c.currentClub,type:c.getCurrentGameType(),config:c.getCurrentGameConfig(),list:c._currRoomList,classes:c._currClassList,total:c._totalList,skeleton:c._isShowingSwitchSkeleton,noRoom:c.noRoom.active,text:c.node.getComponentsInChildren(cc.Label).filter(l=>l.node.activeInHierarchy).map(l=>l.string).slice(0,40)}})()');
  console.log('ROOM_CHANGE_PANEL',JSON.stringify(inspect));
  assert.ok(inspect && !inspect.skeleton && !inspect.noRoom, 'field list loads actual rooms');
  const listShot = await send('Page.captureScreenshot');
  fs.writeFileSync('test/browser/room-change.png', Buffer.from(listShot.data, 'base64'));
  const before = await ev('cc.app.gameRoom._conf.roomId');
  const selected = await ev(`(()=>{const p=cc.Canvas.instance.getComponentInChildren('roomListInside');const items=p.node.getComponentsInChildren(cc.Component).filter(c=>c.data?.gameRoomConfigId&&typeof c.joinRoom2==='function'&&c.node.activeInHierarchy);const c=items.find(c=>Number(c.data.gameRoomConfigId)!==Math.floor(cc.app.gameRoom._conf.roomId/10000)&&Number(c.data.playMode)===1)||items[1];if(!c)return {items:items.map(c=>c.data)};const target=JSON.parse(JSON.stringify(c.data));c.joinRoom2();return target;})()`);
  console.log('SELECTED', JSON.stringify(selected));
  await until(async()=>await ev('cc.app.gameRoom._conf.roomId')!==before,15000,'native room switch');
  console.log('AFTER',JSON.stringify(await ev('({room:cc.app.gameRoom._conf.roomId,scene:cc.director.getScene().name,observer:cc.app.gameRoom.getIsOb()})')));
  await delay(1500);
  await ev(`__require('GameUtils').default.showView('prefabs/game/roomListInside/roomListInside','roomListInside','roomListInside',__require('enums').RoomListInsideType.RateRoom);true`);
  await delay(2000);
  for (const [label, type] of [['炸金花',25],['牛牛',24],['十三水',27],['二十一点',31],['三公暗一',32],['麻将',30]]) {
    if (type !== 25) {
      await delay(1500);
      await ev(`__require('GameUtils').default.showView('prefabs/game/roomListInside/roomListInside','roomListInside','roomListInside',__require('enums').RoomListInsideType.RateRoom);true`);
      await delay(1500);
    }
    const clicked = await ev(`(()=>{const p=cc.Canvas.instance.getComponentInChildren('roomListInside');const c=p.node.getComponentsInChildren('roomListInsideGameItem').find(c=>c.node.activeInHierarchy&&c.node.getComponentsInChildren(cc.Label).some(l=>l.string===${JSON.stringify(label)}));if(!c)return false;c.onToggle();return true;})()`);
    assert.ok(clicked, label + ' native tab');
    await until(async()=>await ev(`(()=>{const p=cc.Canvas.instance.getComponentInChildren('roomListInside');return !!p&&!p._isShowingSwitchSkeleton&&p.node.getComponentsInChildren(cc.Component).some(c=>c.data?.roomType===${type}&&typeof c.joinRoom2==='function'&&c.node.activeInHierarchy)})()`),12000,label+' scene list');
    const previous = await ev('cc.app.gameRoom._conf.roomId');
    const target = await ev(`(()=>{const p=cc.Canvas.instance.getComponentInChildren('roomListInside');const items=p.node.getComponentsInChildren(cc.Component).filter(c=>c.data?.roomType===${type}&&typeof c.joinRoom2==='function'&&c.node.activeInHierarchy);const c=items.find(c=>${type}!==31||c.data.playMode===0)||items[0];if(!c)return null;const target=JSON.parse(JSON.stringify(c.data));c.joinRoom2();return target;})()`);
    assert.ok(target);
    await until(async()=>await ev(`cc.app.gameRoom._conf.roomId!==${previous}&&cc.app.gameRoom._conf.roomType===${type}`),15000,label+' native switch');
    await delay(2500);
    const expectedScene = {25:'gameZjh',24:'Qznn',27:'sss',31:target.playMode===1?'liveBlackJack':'bjk',32:'gameSgay',30:'hzxl'}[type];
    await until(async()=>await ev(`cc.director.getScene().name===${JSON.stringify(expectedScene)}`),15000,label+' actual scene');
    assert.equal(await ev('!!cc.app.gameRoom.getMyMemberInfo()'),false,'switch joins as observer');
    console.log('CROSS_GAME_SWITCH',JSON.stringify(await ev('({room:cc.app.gameRoom._conf.roomId,type:cc.app.gameRoom._conf.roomType,scene:cc.director.getScene().name})')));
  }
  const failures = errors.filter(e=>e.exception?.value!=='--------------------> Promise manually interrupted!! <--------------------');
  console.log('NATIVE_CANCELLATIONS', errors.length-failures.length);
  console.log('ERRORS',JSON.stringify(failures));
  assert.equal(failures.length, 0, JSON.stringify(failures));
  const shot=await send('Page.captureScreenshot');fs.writeFileSync('test/browser/room-change-final.png',Buffer.from(shot.data,'base64'));
} catch (error) {
  console.log('FAIL_ERRORS', JSON.stringify(errors));
  console.log('FAIL_FRAMES', JSON.stringify(frames.slice(-12)));
  console.log('FAIL_LOGS', JSON.stringify(logs.slice(-15)));
  throw error;
} finally { socket?.close(); browser.kill(); }

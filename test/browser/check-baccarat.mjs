import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { decodeFrame } from '../../game-server/src/codec.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const dragonTiger = process.env.CARD_GAME === 'dragon-tiger';
const label = dragonTiger ? 'DRAGON_TIGER' : 'BACCARAT';
const envPrefix = dragonTiger ? 'LHD' : 'BACC';
const roomType = dragonTiger ? 59 : 58;
const scene = dragonTiger ? 'lhd' : 'bjl';
const component = dragonTiger ? 'HundredLhdMain' : 'HundredBjlMain';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gogame-baccarat-'));
const browser = spawn(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-extensions', '--no-first-run',
  '--remote-debugging-port=0', '--user-data-dir=' + profile, '--window-size=1280,900', 'about:blank',
], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
const frames = [], errors = [], sessions = [], logs = [], resourceFailures = [], pending = new Map();
const stateDiagnostics = [];
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
      if (m.params.type === 'error' && /FrameTaskRunner.*任务出错|TypeError:|ReferenceError:|SyntaxError:|Bundle .*doesn't contain/.test(line)) errors.push({ text: line });
      if (/Hundred|gotoScene|NaN|FrameTaskRunner|TypeError/.test(line)) logs.push(line.slice(0, 700));
    } else if (m.method === 'Network.responseReceived' && m.params.response.status >= 400) {
      resourceFailures.push({url:m.params.response.url,status:m.params.response.status});
    } else if (/Network.webSocketFrame(Sent|Received)/.test(m.method)) {
      try { const f = decodeFrame(Buffer.from(m.params.response.payloadData, 'base64'));
        if (f) frames.push({ direction: m.method.endsWith('Sent') ? 'send' : 'receive', receivedAt: Date.now(), ...f }); } catch {}
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
  const modes = (process.env[envPrefix + '_MODES'] || (dragonTiger ? '0,1,3,4' : '0,1,2,3,4')).split(',').map(Number);
  const firstIds = dragonTiger ? {0:1720003,1:1630004,3:59060006,4:59710002} : [1400001, 1470001, 1540001, 1800001, 58950001];
  for (const mode of modes) {
    const uid = Number(process.env[envPrefix + '_UID_BASE'] || (dragonTiger ? 88060000 : 88050000)) + mode, startFrames = frames.length, startErrors = errors.length;
    await send('Page.navigate', { url: 'http://lobby.localhost:11042/21/0?userId=' + uid + '&userToken=dev-' + uid + '&openId=' + uid + '&v=2.0.1279' });
    await delay(6500);
    await evaluate('document.querySelector(\'img[src*="category/02.webp"]\').parentElement.click()');
    await delay(1500);
    await evaluate('document.querySelector(\'img[src*="types/' + (dragonTiger ? 1003 : 1002) + '.png"]\').parentElement.click()');
    await until(() => evaluate('document.querySelectorAll("[data-room-status]").length===' + (dragonTiger ? 5 : 50)), 15000, 'native game tables');
    console.log('LOBBY', mode, JSON.stringify(await evaluate('Array.from(document.querySelectorAll("[data-room-status]")).slice(0,2).map(n=>({id:n.dataset.roomStatus,text:n.parentElement.textContent}))')));
    assert.ok(await evaluate('(()=>{const n=document.querySelector(\'[data-room-status="' + firstIds[mode] + '"]\')?.closest("li");n?.click();return !!n;})()'));
    await delay(1200);
    if (mode === 4) {
      console.log('VIP_DIALOG', await evaluate('document.body.innerText.slice(-1400)'));
      console.log('VIP_CHOICE', await evaluate('(()=>{const h=Array.from(document.querySelectorAll("h1")).find(n=>n.textContent.trim()==="桌主模式");h?.closest("li")?.click();return h?.textContent;})()'));
    }
    let session;
    await until(async()=>{
      for (const candidate of sessions.slice().reverse()) try {
        if (await evaluate('window.cc&&cc.director.getScene()?.name', candidate) === scene) { session = candidate; return true; }
      } catch {}
      return false;
    },60000,'original '+scene+' scene');
    const own = () => frames.slice(startFrames);
    await until(()=>own().some(f=>f.msgid===6205&&f.payload.roomType===roomType),20000,'native enter response');
    console.log('ENTRY_FLOW', mode, JSON.stringify(own().filter(f => [1105, 1205, 2102, 2201, 6105, 6205].includes(f.msgid)).map(f => ({ id: f.msgid, state: f.payload?.state, room: f.payload?.roomId, mode: f.payload?.playMode }))));
    assert.ok(session, 'original ' + scene + ' scene');
    const ev = expression => evaluate(expression, session);
    const main = '(()=>{let p;function walk(n){const c=n.getComponent?.("' + component + '");if(c)p=c;n.children?.forEach(walk)}walk(cc.director.getScene());return p;})()';
    const entry = own().find(f => f.msgid === 6205 && f.payload.roomType === roomType)?.payload;
    assert.ok(entry); assert.equal(entry.playMode, mode); assert.ok(entry.points > 0); assert.equal(Object.keys(entry.areaOdds).length, dragonTiger ? (mode===3?7:12) : 9);
    if (mode === 4) {
      assert.equal(entry.hostUid,uid); assert.equal(entry.playerId,uid);
      assert.equal(await ev('(' + main + ').viewModel.model.__isCzTableOwner'),true,'original owner controls');
      const beforePrivilege=frames.length;
      await ev('(' + main + ').viewModel.commandGetOwnerPrivilegeConfig();true');
      await until(()=>frames.slice(beforePrivilege).some(f=>f.msgid===6233),5000,'owner privilege');
      await ev('(' + main + ').viewModel.commandOwnerPrivilegeConfig({betTime:10,peekTime:5});true');
      await until(()=>frames.slice(beforePrivilege).some(f=>f.msgid===6234&&f.payload.betTime===10&&f.payload.peekTime===5),5000,'owner settings');
      await until(()=>frames.slice(beforePrivilege).some(f=>f.msgid===6234&&f.payload.activeBetTime===10&&f.payload.activePeekTime===5),110000,'owner settings next hand');
      console.log('PASS_OWNER_PRIVILEGE',mode);
    }
    if (process.env[envPrefix + '_ENTRY_ONLY']) { assert.equal(errors.length, startErrors, JSON.stringify(errors.slice(startErrors))); console.log('PASS_ENTRY', mode); continue; }
    await until(async () => {
      const state = own().findLast(f => f.direction === 'receive' && [6204, 6205].includes(f.msgid) && f.payload.roomId === firstIds[mode]);
      return state?.payload.state === 2 && state.payload.countDown - (Date.now() - state.receivedAt) > 8000
        && await ev('(' + main + ').viewModel.model.__currentGameState') === 2;
    }, 100000, 'sufficient betting window');
    await delay(1200);
    const before = frames.length;
    if (dragonTiger) {
      const displayed=await ev('(()=>{const p=' + main + ';return {prices:p.viewModel.__currentBetAreaOdds,labels:Object.fromEntries([...p._area_part._areaInfoMap].map(([id,v])=>[id,v.odds.string]))}})()');
      console.log('ODDS',mode,JSON.stringify(displayed));
      for(const [id,price] of Object.entries(displayed.prices)) if(price.odds>0)assert.equal(displayed.labels[id],'1:'+price.odds,'native odds label '+id);
    }
    const betArea = dragonTiger && mode===3 ? await ev('(()=>{const p=' + main + ';return Number(Object.entries(p.viewModel.__currentBetAreaOdds).find(([id,p])=>[1,2].includes(Number(id))&&p.odds>0)[0])})()') : 1;
    await ev('(()=>{const p=' + main + ';p.onChipClick(1);p.onAreaClick(' + betArea + ');p.onConfirmBet();return true})()');
    await until(() => frames.slice(before).some(f => f.msgid === 6201 && f.payload.code === 0), 5000, 'native bet');
    const multiEnabled = Boolean(process.env[envPrefix + '_MULTI']);
    const multiPanel = '(()=>{let p;function walk(n){const c=n.getComponent?.("HundredHaoluPanel");if(c)p=c;n.children?.forEach(walk)}walk(cc.director.getScene());return p;})()';
    if (multiEnabled) {
      await ev('__require("Facade").default.getModule("Hundred").emit(__require("HundredConfig").HundredConfig.Event.CLICK_HAOLU);true');
      await until(() => frames.slice(before).some(f => f.msgid === 6227 && f.payload.roomInfos?.some(r => r.roomId === firstIds[mode])), 10000, 'native multi-room registration');
      await until(async () => await ev('Boolean((' + multiPanel + ')?.node.active&&(' + multiPanel + ')._roomItemCmps.length)'), 10000, 'native multi-room panel');
    }
    const inning = await ev('(' + main + ').viewModel.model.__inning');
    await until(() => frames.slice(before).some(f => f.msgid === 6208 && Object.keys(f.payload.areaWinningScores || {}).length), 110000, 'personal result');
    await until(async () => {
      const state=await ev('(' + main + ').viewModel.model.__currentGameState');
      if(stateDiagnostics.at(-1)?.state!==state)stateDiagnostics.push({mode,state,at:Date.now()});
      return state===6;
    },15000,'settlement phase');
    if (multiEnabled) {
      const result = frames.slice(before).find(f => f.msgid === 6208 && Object.keys(f.payload.areaWinningScores || {}).length).payload;
      await until(() => frames.slice(before).some(f => f.msgid === 6229 && f.payload.roomId === firstIds[mode]), 5000, 'multi-room settlement');
      if (dragonTiger) {
        for (const frame of frames.slice(before).filter(f => [6228, 6229].includes(f.msgid) && f.payload.roomType === roomType)) {
          assert.equal(Object.hasOwn(frame.payload, 'showdownPoints'), false);
        }
        assert.ok(result.showdownPoints.dragon.length && result.showdownPoints.tiger.length, 'main owner peek points remain present');
      }
      const multiResult = await ev('(()=>{const p=' + multiPanel + ';const r=p.getRoomItemCmp(' + firstIds[mode] + ');return {active:p.node.active,settle:r.settleResultPanel.active,points:["pointsLb1","pointsLb2"].map(n=>r.settleResultPanel.getChildByName(n).getComponent(cc.Label).string)}})()');
      assert.ok(multiResult.active && multiResult.settle, JSON.stringify(multiResult));
      assert.ok(multiResult.points.every(value => value && !/undefined|NaN/.test(value)), JSON.stringify(multiResult));
      const reopen = frames.length;
      await ev('(' + multiPanel + ').hide();true');
      await until(() => frames.slice(reopen).some(f => f.msgid === 6225), 5000, 'multi-room unregister');
      await delay(400);
      await ev('__require("Facade").default.getModule("Hundred").emit(__require("HundredConfig").HundredConfig.Event.CLICK_HAOLU);true');
      await until(() => frames.slice(reopen).some(f => f.msgid === 6227), 5000, 'multi-room reconnect snapshot');
      const rejoined = frames.slice(reopen).find(f => f.msgid === 6227).payload.roomInfos.find(r => r.roomId === firstIds[mode]);
      assert.ok([6, 7].includes(rejoined.state), 'reopen during settlement');
      if (dragonTiger) assert.equal(Object.hasOwn(rejoined, 'showdownPoints'), false);
      await delay(700);
      console.log('PASS_MULTI_SETTLEMENT', mode, JSON.stringify({ ...multiResult, reopenedState: rejoined.state }));
      const multiShot = await send('Page.captureScreenshot');
      fs.writeFileSync(path.join(os.tmpdir(), 'gogame-' + scene + '-' + mode + '-multi.png'), Buffer.from(multiShot.data, 'base64'));
      await ev('(' + multiPanel + ').hide();true');
    } else await delay(5500);
    const shot = await send('Page.captureScreenshot'); fs.writeFileSync(path.join(os.tmpdir(), 'gogame-' + scene + '-' + mode + '-settle.png'), Buffer.from(shot.data, 'base64'));
    console.log('SETTLEMENT', mode, JSON.stringify(await ev('(()=>{const p=' + main + ';return {state:p.viewModel.model.__currentGameState,realScore:p.viewModel.gameResultData?.realScore,winning:p.viewModel.gameResultData?.winningAreas}})()')));
    await ev('__require("Facade").default.getModule("Hundred").emit(__require("HundredConfig").HundredConfig.Event.CLICK_HISTORY);true');
    await until(() => own().some(f => f.msgid === 6222 && f.payload.currInning === inning), 6000, 'review');
    const detail = own().find(f => f.msgid === 6222 && f.payload.currInning === inning).payload;
    if (dragonTiger) { assert.equal(detail.showdownPokers.dragon.length,1); assert.equal(detail.showdownPokers.tiger.length,1); }
    else assert.ok(detail.showdownPokers.other.length >= 2);
    assert.equal(detail.betDetailTableMap[betArea].betScore, 100);
    await delay(700); const review = await send('Page.captureScreenshot'); fs.writeFileSync(path.join(os.tmpdir(), 'gogame-' + scene + '-' + mode + '-history.png'), Buffer.from(review.data, 'base64'));
    if (process.env[envPrefix + '_BANKER'] && mode === 0) {
      const model='__require("Facade").default.getModule("Hundred").getModel(__require("HundredBankerModel").default)';
      const beforeBanker=frames.length;
      await ev('(' + model + ').applyBanker(1,100000,10000);true');
      await until(()=>frames.slice(beforeBanker).some(f=>f.msgid===6240&&f.payload.code===0),5000,'banker application');
      await until(()=>frames.slice(beforeBanker).some(f=>f.msgid===6243&&f.payload.normalBankerDataList?.some(e=>e.uid===uid&&e.onBanker)),120000,'funded banker');
      await until(()=>frames.slice(beforeBanker).some(f=>f.msgid===6244),100000,'banker settlement');
      const bankerReviewStart=frames.length;
      await ev('__require("Facade").default.getModule("Hundred").emit(__require("HundredConfig").HundredConfig.Event.CLICK_HISTORY);true');
      await until(()=>frames.slice(bankerReviewStart).some(f=>f.msgid===6222&&f.payload.bankerInningData?.bankerInningInfoMap?.[uid]),7000,'banker review');
      console.log('PASS_BANKER_HISTORY',mode);
      await ev('(' + model + ').applyBankerCancel(1);true');
      await until(()=>frames.slice(beforeBanker).some(f=>f.msgid===6241&&[2,3,4].includes(f.payload.code)),5000,'banker cancellation');
      await until(()=>frames.slice(beforeBanker).some(f=>f.msgid===3680&&f.payload.carryOutAmount>0),100000,'banker refund');
      console.log('PASS_BANKER',mode);
    }
    assert.equal(errors.length, startErrors, JSON.stringify(errors.slice(startErrors).map(e => e.exception?.description || e.text)));
    await ev('(' + main + ').viewModel.commandLeaveGame();true');
    await until(async () => await ev('cc.director.getScene().name') === 'webHallOb', 12000, 'return to hall');
    console.log('PASS_' + label, mode, inning);
  }
  console.log('PASS_' + label + '_ALL', JSON.stringify({ modes, errors: errors.length }));
} catch (error) {
  console.log('FAIL_RESOURCES',JSON.stringify(resourceFailures));
  if(socket?.readyState===WebSocket.OPEN) {
    const id=++sequence;
    const screenshot=new Promise(resolve=>{pending.set(id,resolve);});
    socket.send(JSON.stringify({id,method:'Page.captureScreenshot'}));
    const shot=await screenshot;
    if(shot.result?.data)fs.writeFileSync(path.join(os.tmpdir(),'gogame-'+scene+'-failure.png'),Buffer.from(shot.result.data,'base64'));
  }
  console.log('FAIL_STATES',JSON.stringify(stateDiagnostics));
  console.log('FAIL_PHASES',JSON.stringify(frames.filter(f=>f.direction==='receive'&&[6204,6208].includes(f.msgid)).slice(-30).map(f=>({id:f.msgid,state:f.payload.state,room:f.payload.roomId,inning:f.payload.inning,realScore:f.payload.realScore,personal:Object.keys(f.payload.areaWinningScores||{})}))));
  console.log('FAIL_FRAMES', JSON.stringify(frames.slice(-12)));
  console.log('FAIL_LOGS', JSON.stringify(logs.slice(-15)));
  console.log('FAIL_ERRORS', JSON.stringify(errors.map(e => e.exception?.description || e.text))); throw error;
} finally { socket?.close(); browser.kill(); }

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gogame-banker-'));
const browser = spawn(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-extensions', '--no-first-run',
  '--disable-background-networking', '--remote-debugging-port=0', '--user-data-dir=' + profile, '--window-size=1280,900', 'about:blank',
], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let ws, ev; const sessions = [], errors = [];
try {
  let port; for (let i = 0; i < 100; i++) { try { port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; break; } catch {} await delay(100); }
  const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page');
  ws = new WebSocket(target.webSocketDebuggerUrl.replace('localhost', '127.0.0.1'));
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  let id = 0; const pending = new Map();
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const n = ++id, timer = setTimeout(() => { pending.delete(n); reject(new Error('CDP timeout ' + method)); }, 15000);
    pending.set(n, m => { clearTimeout(timer); resolve(m); }); ws.send(JSON.stringify({ id: n, method, params, sessionId }));
  });
  ws.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); }
    else if (m.method === 'Target.attachedToTarget') { sessions.push(m.params.sessionId); send('Runtime.enable', {}, m.params.sessionId); }
    else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails);
  });
  const evaluate = async expression => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); assert.ok(!r.result?.exceptionDetails, JSON.stringify(r.result?.exceptionDetails)); return r.result?.result?.value; };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  const uid = Number(process.env.BANKER_TEST_UID || 88000694);
  await send('Page.navigate', { url: `http://lobby.localhost:11042/21/0?userId=${uid}&userToken=dev-${uid}&openId=${uid}&v=2.0.1279` });
  await delay(13000);
  await evaluate(`Array.from(document.querySelectorAll('span,p,div,a')).find(e=>e.textContent==='二十一点'&&e.children.length===0)?.click()`);
  await delay(3000);
  await evaluate(`document.querySelector('[class*=roomList] li').click()`);
  await delay(20000);
  let session; for (const candidate of sessions) { const r = await send('Runtime.evaluate', { expression: 'window.cc&&cc.director.getScene()?.name', returnByValue: true }, candidate); if (r.result?.result?.value === 'liveBlackJack') session = candidate; }
  assert.ok(session, 'original casino scene loads');
  ev = async expression => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, session); assert.ok(!r.result?.exceptionDetails, JSON.stringify(r.result?.exceptionDetails)); return r.result?.result?.value; };
  const initial = await ev(`({point:cc.app.gameRoom.__myPoint,normal:cc.director.getScene().getComponentInChildren('LiveBlackJackBanker').viewModel.getNormalSelf()})`);
  console.log('INITIAL', JSON.stringify(initial)); assert.ok(initial.point > 40000); assert.ok(!initial.normal);
  await ev(`(()=>{window.__bankerEvents=[];const n=__require('NotificationCenter').default,emit=n.emit;n.emit=function(event,data,...args){__bankerEvents.push({event,data});return emit.call(this,event,data,...args);};window.__bankerRequests=[];const socket=__require('SocketMgr').default.instance,send=socket.send;socket.send=function(id,body,...args){__bankerRequests.push({id,body});return send.call(this,id,body,...args);};return true;})()`);
  const view = () => ev(`(()=>{const g=cc.app.gameRoom,c=cc.director.getScene().getComponentInChildren('LiveBlackJackBanker'),b=c.viewModel;return {state:g.__currentGameState,inning:g.__currentInningInfo?.currentInning,left:g.__currentInningInfo?.stateDeadline-Date.now(),point:g.__myPoint,normal:b.getNormalSelf(),special:b.getSpecialSelf(),active:c.module.isSelfOnBanker(),queued:c.module.isSelfInBankerQueue(),settle:b.__lastSettle};})()`);
  const waitFor = async (test, label, timeout = 120000) => { const start = Date.now(); let value; while (Date.now() - start < timeout) { value = await view(); if (test(value)) return value; await delay(400); } throw new Error(label + ' ' + JSON.stringify(value)); };
  await waitFor(x => x.state === 2 && x.left > 6000, 'fresh betting phase');
  const clickApply = type => ev(`(()=>{const b=cc.director.getScene().getComponentInChildren('LiveBlackJackBanker');b.onClickMainButton();const a=b.banker_panel.${type}.apply;a.setAmount(200);a.syncSlider(200,100);a.onClickApply();return true;})()`);
  await clickApply('normal');
  const queued = await waitFor(x => x.normal && !x.normal.onBanker, 'native normal application queues', 5000);
  assert.equal(queued.point, initial.point, 'queueing does not debit'); console.log('QUEUED', JSON.stringify(queued));
  await ev(`(()=>{const b=cc.director.getScene().getComponentInChildren('LiveBlackJackBanker');b.onClickMainButton();b.banker_panel.normal.detail.onClickDown();return true;})()`);
  await waitFor(x => !x.normal, 'queued application cancels immediately', 5000);
  await clickApply('normal'); await clickApply('special');
  const active = await waitFor(x => x.normal?.onBanker && x.special?.onBanker, 'both areas activate on next hand');
  console.log('ACTIVE', JSON.stringify(active)); assert.equal(active.point, initial.point - 40000); assert.equal(active.active, true);
  assert.ok(active.normal.icon, 'banker avatar uses common profile mapping');
  assert.ok(await ev(`(async()=>{const b=cc.director.getScene().getComponentInChildren('LiveBlackJackBanker').viewModel.getNormalSelf();const r=await fetch(b.icon);return r.ok;})()`), 'original banker avatar asset is accessible');
  assert.equal(await ev(`!!cc.app.gameRoom.getMyMemberInfo()`), false);
  const settled = await waitFor(x => x.settle?.areas?.length === 2, 'original banker settlement overlay');
  console.log('BANKER_SETTLED', JSON.stringify(settled)); assert.ok(Number.isFinite(settled.settle.score)); assert.equal(settled.settle.take, 0);
  const overlay = await ev(`(()=>{const c=cc.director.getScene().getComponentInChildren('LiveBlackJackBankerSettle');return {win:!!c.win_node?.activeInHierarchy,lose:!!c.lose_node?.activeInHierarchy};})()`);
  console.log('SETTLEMENT_OVERLAY', JSON.stringify(overlay)); assert.ok(overlay.win || overlay.lose);
  const settlementShot = await send('Page.captureScreenshot'); fs.writeFileSync('test/browser/blackjack-casino-banker-settlement.png', Buffer.from(settlementShot.result.data, 'base64'));
  await ev(`(()=>{const b=cc.director.getScene().getComponentInChildren('LiveBlackJackBanker');b.onClickMainButton();const d=b.banker_panel.normal.detail;d.onClickCount({target:{name:'20'}});d.onClickAdjust();d.amount_editbox.string='300';d.onAmountEnded();d.onClickConfirm();return true;})()`);
  const adjusted = await waitFor(x => x.normal?.amount === 30000 && x.normal?.bankerCount === 20, 'adjustment applies');
  console.log('ADJUSTED', JSON.stringify(adjusted));
  await ev(`(()=>{const b=cc.director.getScene().getComponentInChildren('LiveBlackJackBanker');b.onClickMainButton();b.banker_panel.normal.detail.onClickDown();b.banker_panel.special.detail.onClickDown();return true;})()`);
  const down = await waitFor(x => !x.normal && !x.special && !x.active && !x.queued, 'both areas cash out'); console.log('DOWN', JSON.stringify(down));
  const accounting = await ev(`(()=>{const r=__bankerEvents.filter(x=>x.event===4562).map(x=>x.data);return {score:r.reduce((n,x)=>n+x.score,0),results:r,requests:__bankerRequests.filter(x=>[4509,4510,4511].includes(x.id))};})()`);
  console.log('ACCOUNTING', JSON.stringify(accounting)); assert.equal(down.point, initial.point + accounting.score, 'capital and actual profit returned once');
  assert.equal(accounting.requests.filter(x => x.id === 4509).length, 3); assert.ok(accounting.requests.some(x => x.id === 4511));
  await ev(`(()=>{const b=cc.director.getScene().getComponentsInChildren(cc.Button).find(b=>b.node.activeInHierarchy&&b.clickEvents.some(e=>/history/i.test(e.handler)));if(!b)throw new Error('history button missing');cc.Component.EventHandler.emitEvents(b.clickEvents,{target:b.node});return true;})()`);
  let history;
  for (let i = 0; i < 40; i++) {
    history = await ev(`(()=>{const p=cc.director.getScene().getComponentInChildren('HistoryPanel');if(!p?.historyModel?.isDataReceived)return null;return {data:p.historyModel.gameBackMsgData,page:p.historyModel.getCurrentPageNum(),title:p.curPageTitle.string,loading:p.loading.active,rows:p.historyContentScript.node.getComponentsInChildren('LiveBjkHistoryItem').filter(c=>c.node.activeInHierarchy).map(c=>({area:c.areaLb.string,banker:c.node_banker.active,name:c.mName.string})),bankSections:['bankNormal','bankSpecial'].map(n=>{const b=p.historyContentScript.node.getChildByName(n);return {name:n,active:b.activeInHierarchy,labels:b.getComponentsInChildren(cc.Label).map(l=>l.string)};})};})()`);
    if (history?.rows.length) break;
    await delay(250);
  }
  console.log('NATIVE_HISTORY', JSON.stringify(history));
  assert.ok(history?.rows.length >= 2); assert.equal(history.loading, false);
  for (const row of history.data.gameBackInfo.inningInfo[0].filter(p => !p.banker)) {
    assert.ok([1, 2, 3, 5, 6].includes(row.displaySeat));
    assert.ok(history.rows.some(r => !r.banker && r.area === String(row.displaySeat)));
  }
  const bankerReplay = history.data.gameBackInfo.bankerSettles[0];
  for (const area of accounting.results.at(-1).areas) {
    const key = area.bankerType === 1 ? 'normal' : 'special';
    const row = bankerReplay[key].bankers.find(b => b.uid === uid);
    assert.ok(row); assert.equal(row.score, area.score); assert.equal(row.proportion, area.proportion);
  }
  assert.ok(history.bankSections.every(b => b.active && b.labels.every(s => !/NaN|undefined/.test(s))));
  const lastPage = history.page;
  await ev(`cc.director.getScene().getComponentInChildren('HistoryPanel').onPrePageClick();true`); await delay(800);
  assert.equal(await ev(`cc.director.getScene().getComponentInChildren('HistoryPanel').historyModel.getCurrentPageNum()`), lastPage - 1);
  await ev(`cc.director.getScene().getComponentInChildren('HistoryPanel').onNextPageClick();true`); await delay(800);
  assert.equal(await ev(`cc.director.getScene().getComponentInChildren('HistoryPanel').historyModel.getCurrentPageNum()`), lastPage);
  const invalid = await ev(`cc.director.getScene().getComponentsInChildren(cc.Label).filter(l=>l.node.activeInHierarchy&&/NaN|undefined/.test(l.string)).map(l=>({name:l.node.name,text:l.string}))`); assert.deepEqual(invalid, []);
  const shot = await send('Page.captureScreenshot'); fs.writeFileSync('test/browser/blackjack-casino-history.png', Buffer.from(shot.result.data, 'base64'));
  console.log('FINAL_ERRORS', JSON.stringify(errors)); assert.equal(errors.length, 0);
} catch (error) {
  if (ev) console.log('DIAGNOSTICS', JSON.stringify(await ev(`({requests:window.__bankerRequests,events:window.__bankerEvents?.filter(e=>[4558,4559,4560,4561,4562,9999].includes(Number(e.event))),apply:(()=>{const a=cc.director.getScene().getComponentInChildren('LiveBlackJackBanker').banker_panel.normal.apply;return {amount:a.amount,singleWin:a.singleWin,onApply:!!a.onApply};})()})`).catch(e => String(e))));
  throw error;
} finally {
  if (ev) await ev(`(()=>{const b=cc.director.getScene().getComponentInChildren('LiveBlackJackBanker')?.viewModel;if(b?.getNormalSelf())b.commandCancel(1);if(b?.getSpecialSelf())b.commandCancel(2);__require('SocketMgr').default.instance.send(2110);return true;})()`).catch(() => {});
  ws?.close(); browser.kill();
}

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { decodeFrame } from '../../game-server/src/codec.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gogame-scratch-'));
const browser = spawn(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-extensions', '--no-first-run',
  '--remote-debugging-port=0', '--user-data-dir=' + profile, '--window-size=1280,900', 'about:blank',
], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
const frames = [], errors = [], sessions = [], logs = [], resourceFailures = [], pending = new Map();
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

  for (const type of [61,63]) {
    const uid=88110000+type, startFrames=frames.length, startErrors=errors.length;
    const bundle=type===61?'gglmj':'gglsj';
    await send('Page.navigate',{url:'http://lobby.localhost:11042/21/0?userId='+uid+'&userToken=dev-'+uid+'&openId='+uid+'&v=2.0.1279'});
    await delay(6500);
    if(process.env.SCRATCH_VERBOSE)console.log('INITIAL_IMAGES',JSON.stringify(await evaluate('Array.from(document.images).map(n=>n.getAttribute("src")).filter(s=>/types|category/.test(s))')));
    if(!await evaluate('!!document.querySelector(\'img[src*="types/1004.png"]\')')){
      await evaluate('document.querySelector(\'img[src*="category/02.webp"]\')?.parentElement.click();true');
      await delay(800);
    }
    assert.ok(await evaluate('(()=>{const n=document.querySelector(\'img[src*="types/1004.png"]\');n?.parentElement.click();return !!n})()'),'scratch game category');
    await delay(1300);
    assert.ok((await evaluate('document.body.innerText')).includes('麻将胡了'));
    assert.ok((await evaluate('document.body.innerText')).includes('赏金女王'));
    if(process.env.SCRATCH_VERBOSE)console.log('ROOM_IMAGES',JSON.stringify(await evaluate('Array.from(document.images).map(n=>({src:n.getAttribute("src"),text:n.closest("li")?.textContent})).slice(-30)')));

    assert.ok(await evaluate('(()=>{const n=document.querySelector(\'img[src*="room/type/1004/'+type+'.webp"]\');n?.closest("li").click();return !!n})()'));
    let session;
    await until(async()=>{for(const id of sessions){try{if(await evaluate('typeof cc!=="undefined"&&cc.director.getScene()?.name==="'+bundle+'"',id)){session=id;return true}}catch{}}},25000,'native '+bundle+' scene');
    const ev=expression=>evaluate(expression,session);
    const main='(()=>{let p;function walk(n){const c=n.getComponent?.("'+bundle+'_main");if(c)p=c;n.children?.forEach(walk)}walk(cc.director.getScene());return p;})()';
    const own=()=>frames.slice(startFrames);
    await until(()=>own().some(f=>f.msgid===3711),8000,'pending state');
    console.log('STATE',type,JSON.stringify(own().find(f=>f.msgid===3711)?.payload));
    assert.equal(own().find(f=>f.msgid===2201).payload.conf.roomType,type===61?'mjhl':'sjnv');
    await ev('('+main+').viewModel.__useAutoScratch=true;('+main+').viewModel.changeAuto(1);true');
    await until(()=>own().some(f=>f.msgid===3713),8000,'random reveal');
    const result=own().find(f=>f.msgid===3713)?.payload;
    assert.equal(result.code,0);assert.equal(result.huMask.length,20);
    assert.equal(result.huMask.filter(n=>n===1).length,result.huCount);
    await until(async()=>await ev('('+main+').viewModel.__currentGameState')===1,45000,'native settlement and next idle');
    console.log('PASS_REVEAL',type,result.huCount,result.winAmount);
    const historyPanel='(()=>{let p;function walk(n){const c=n.getComponent?.("'+bundle+'_history_panel");if(c)p=c;n.children?.forEach(walk)}walk(cc.director.getScene());return p;})()';
    await ev('('+main+').module.emit("open:history");true');
    await until(async()=>await ev('Boolean(('+historyPanel+')?.node.active)'),8000,'native history panel');
    await until(()=>own().some(f=>f.msgid===6221),5000,'private ticket history');
    assert.equal(own().findLast(f=>f.msgid===6221).payload.winInfo.at(-1).serialNo,result.serialFull);
    const shot=await send('Page.captureScreenshot');fs.writeFileSync(path.join(os.tmpdir(),'gogame-'+bundle+'-history.png'),Buffer.from(shot.data,'base64'));
    console.log('HISTORY_PANEL',JSON.stringify(await ev('(()=>{const p='+historyPanel+';return {active:p.node.active,page:p.page_text.string,ticket:p.ticket_text.string,price:p.price_text.string,amount:p.amount_text.string}})()')));
    await ev('('+historyPanel+').onClickClose();true');
    const beforeSearch=frames.length;
    await ev('('+main+').viewModel.commandGglSerialSearchReq("SINGLE_TICKET","123","01");true');
    await until(()=>frames.slice(beforeSearch).some(f=>f.msgid===3714),5000,'serial search');
    const search=frames.slice(beforeSearch).find(f=>f.msgid===3714).payload;assert.equal(search.code,0);assert.ok(search.matchedSerials.length);
    await ev('('+main+').viewModel.commandGglPurchaseReq("RANDOM_SINGLE",['+JSON.stringify(search.matchedSerials[0])+']);true');
    await until(()=>frames.slice(beforeSearch).some(f=>f.msgid===3712),5000,'native ticket purchase');
    assert.equal(frames.slice(beforeSearch).find(f=>f.msgid===3712).payload.code,0);
    const buyPanel='(()=>{let p;function walk(n){const c=n.getComponent?.("'+bundle+'_buy_panel");if(c)p=c;n.children?.forEach(walk)}walk(cc.director.getScene());return p;})()';
    await until(async()=>await ev('('+buyPanel+').node.active'),5000,'purchase confirmation');
    await ev('('+main+').viewModel.commandGglPendingTicketsReq();true');
    await until(()=>frames.slice(beforeSearch).some(f=>f.msgid===3711&&f.payload.pendingTickets.length===1),5000,'native pending recovery');
    await until(()=>frames.slice(beforeSearch).some(f=>f.msgid===3713&&f.payload.serialFull===search.matchedSerials[0]),15000,'specified reveal');
    await until(async()=>await ev('('+main+').viewModel.__currentGameState')===1,45000,'specified ticket settlement');

    const beforeManual=frames.length;
    await ev('(()=>{const p='+main+';p.viewModel.enterPreferManual();p.viewModel.__useAutoScratch=false;p.scratch_view.onManualTouchAttempt();return true})()');
    await until(()=>frames.slice(beforeManual).some(f=>f.msgid===3713),5000,'native manual touch purchase');
    await ev('('+main+').viewModel.__useAutoScratch=true;true');
    await until(async()=>await ev('('+main+').viewModel.__currentGameState')===1,45000,'manual ticket settlement');
    await ev('('+main+').module.emit("open:history");true');
    await until(async()=>await ev('Boolean(('+historyPanel+')?.node.active)&&('+historyPanel+').viewModel.__current100Record.winInfo.length>=3'),8000,'history pagination');
    assert.equal(await ev('('+historyPanel+').ticket_text.string'),frames.slice(beforeManual).find(f=>f.msgid===3713).payload.serialFull);
    await ev('('+historyPanel+').onClickPrev();true');
    assert.equal(await ev('('+historyPanel+').ticket_text.string'),search.matchedSerials[0]);
    await ev('('+historyPanel+').onClickNext();true');
    assert.equal(await ev('('+historyPanel+').ticket_text.string'),frames.slice(beforeManual).find(f=>f.msgid===3713).payload.serialFull);
    await ev('('+historyPanel+').onClickClose();true');
    assert.equal(await ev('Number.isFinite(('+main+').viewModel.__currentBalance)'),true,'numeric wallet');

    assert.equal(errors.length,startErrors,JSON.stringify(errors.slice(startErrors).map(e=>e.exception?.description||e.text)));
    await ev('('+main+').viewModel.commandExit();true');
    await until(async()=>await ev('cc.director.getScene().name')==='webHallOb',12000,'return to lobby');
    await until(()=>evaluate('getComputedStyle(document.querySelector(".game-iframe_gameIframe__blCWg")).visibility==="hidden"'),10000,'hall visible after exit');
    console.log('PASS_SCRATCH',type,bundle,'manual, auto, purchase, pending recovery, history pages, hall visible');

  }
} catch(error) {
  console.log('FAIL_RESOURCES',JSON.stringify(resourceFailures));
  console.log('FAIL_ERRORS',JSON.stringify(errors.map(e=>e.exception?.description||e.text)));
  console.log('FAIL_FRAMES',JSON.stringify(frames.slice(-10)));
  console.log('FAIL_LOGS',JSON.stringify(logs.slice(-10)));throw error;
} finally {socket?.close();browser.kill();}

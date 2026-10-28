import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import WebSocket, { WebSocketServer } from 'ws';
import { initRpc, closeRpc } from '../../shared/rpc/index.js';
import { createRegistry, findConfig } from '../../game-server/src/registry.js';
import { createRpcWallet } from '../../game-server/src/wallet/rpcWallet.js';
import { createHandler } from '../../game-server/src/create-handler.js';
import { createApp } from '../../hall/src/create-app.js';
import { createRoomStore, createMatchStore } from '../../hall/src/store.js';
import { isGameStaticHost, isHallApiPath, proxyToClientWeb } from '../../hall/src/static-proxy.js';
import { attachGameProxy } from '../../hall/src/game-proxy.js';
import { decodeFrame } from '../../game-server/src/codec.js';

// Temporary test servers only: exercise the real RPC facade, protocol, wallet
// and original native client without changing/restarting resident services.
const failures = [], log = { info(){}, error(...args){ failures.push(args.map(String).join(' ')); } };
const noShow = process.argv.includes('--no-show'), suffix = noShow ? '-no-show' : '';
const rpc = await initRpc({ env: 'dev' }, log), registry = createRegistry();
const runtime = { env:'dev', config:{}, hotVersion:'critical-browser', rpc, gateway:rpc.gateway,
  store:rpc.lobby, bus:rpc.bus, wallet:createRpcWallet(rpc), registry, findConfig,
  configs:await rpc.lobby.listRooms(), log };
const handler = await createHandler(runtime);
runtime.getDevHoldemRecordDetail = handler.getDevHoldemRecordDetail;
const gameServer = http.createServer((req,res)=>{ if(!handler.handleLocalRequest(req,res)){res.statusCode=404;res.end();} });
const sockets = new WebSocketServer({ server: gameServer });
sockets.on('connection',ws=>{ws.on('message',raw=>handler.onMessage(ws,raw).catch(e=>failures.push(e.stack)));
  ws.on('close',()=>handler.onClose(ws).catch(e=>failures.push(e.stack)));});
await new Promise(resolve=>gameServer.listen(0,'127.0.0.1',resolve));
const target='127.0.0.1:'+gameServer.address().port;
const roomStore=createRoomStore(), matchStore=createMatchStore();
roomStore.replace(runtime.configs);matchStore.replaceMatches(await rpc.lobby.listMatches());
const app=await createApp({env:'dev',hotVersion:'critical-browser',config:{game_server:target,hundred_server:target},
  roomStore,matchStore,rpc,wallet:runtime.wallet,gateway:rpc.gateway,store:rpc.lobby,log});
const hall=http.createServer((req,res)=>{
  if(isGameStaticHost(req.headers.host)&&!isHallApiPath(req.url))proxyToClientWeb(req,res,'127.0.0.1:4000',log);
  else app(req,res);
});
const proxies=attachGameProxy(hall,target,log);
await new Promise(resolve=>hall.listen(0,'127.0.0.1',resolve));
const hallPort=hall.address().port, uid=88000719;
let armed=false;
const tick=setInterval(()=>{
  try {
    for(const t of registry.tables.values()){
      if(!armed&&t.criticalFlag&&t.members.some(m=>m.uid===uid&&m.point>0)){
        // Move only this isolated test room's deadline. Live defaults remain
        // 5-8 minutes, verified separately by critical.test.js.
        t.criticalAt=Date.now()-1;armed=true;
      }
    }
    handler.tick();
  } catch(e){failures.push(e.stack);}
},200);
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'gogame-critical-'));
const browser=spawn(process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',[
  '--headless=new','--no-sandbox','--disable-gpu','--disable-extensions','--no-first-run',
  '--disable-background-networking','--remote-debugging-port=0','--user-data-dir='+profile,
  '--window-size=1280,900','--autoplay-policy=no-user-gesture-required','about:blank',
],{windowsHide:true,stdio:['ignore','ignore','pipe']});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const logs=[],frames=[];let ws;
try {
  let port;for(let n=0;n<100;n++){try{port=fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0];break;}catch{}await delay(100);}
  const page=(await(await fetch('http://127.0.0.1:'+port+'/json/list')).json()).find(t=>t.type==='page');
  ws=new WebSocket(page.webSocketDebuggerUrl.replace('localhost','127.0.0.1'));
  await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
  let id=0;const pending=new Map(),sessions=[];
  const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const n=++id;
    const timer=setTimeout(()=>{pending.delete(n);reject(new Error('CDP timeout '+method));},15000);
    pending.set(n,m=>{clearTimeout(timer);resolve(m);});ws.send(JSON.stringify({id:n,method,params,sessionId}));});
  ws.on('message',raw=>{const m=JSON.parse(raw);if(m.id){pending.get(m.id)?.(m);pending.delete(m.id);}
    else if(m.method==='Target.attachedToTarget'){sessions.push(m.params.sessionId);send('Runtime.enable',{},m.params.sessionId);send('Network.enable',{},m.params.sessionId);}
    else if(m.method==='Network.webSocketFrameReceived'){try{const d=m.params.response;
      if(d.opcode===2){const f=decodeFrame(Buffer.from(d.payloadData,'base64'));if(f)frames.push({...f,time:Date.now()});}}catch{}}
    else if(['Runtime.exceptionThrown','Runtime.consoleAPICalled'].includes(m.method))logs.push(m);
  });
  const evalAt=async(expression,sessionId)=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},sessionId);
    assert.ok(!r.result?.exceptionDetails,JSON.stringify(r.result?.exceptionDetails));return r.result?.result?.value;};
  await send('Runtime.enable');await send('Network.enable');await send('Page.enable');
  await send('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:false,flatten:true});
  await send('Page.navigate',{url:'http://lobby.localhost:'+hallPort+'/21/0?userId='+uid+'&userToken=dev-'+uid+'&openId='+uid+'&v=2.0.1279'});
  await delay(13000);
  if(noShow){
    await evalAt(`(()=>{const e=Array.from(document.querySelectorAll('*')).find(e=>e.children.length===0&&e.textContent.trim()==='德州');e?.click();return !!e;})()`);
    await delay(1200);
  }
  assert.equal(await evalAt(`(()=>{for(const label of ${JSON.stringify(noShow ? ['德州不秀牌','不秀牌'] : ['德州秀牌','德州','秀牌'])}){const e=Array.from(document.querySelectorAll('*')).filter(e=>e.textContent.trim()===label).sort((a,b)=>a.querySelectorAll('*').length-b.querySelectorAll('*').length)[0];if(e){e.click();return true;}}return false;})()`),true);
  await delay(2500);
  console.log('NATIVE_ROOMS',JSON.stringify(await evalAt(`Array.from(document.querySelectorAll('[class*=roomList] li')).map(e=>e.innerText)`)));
  const room=await evalAt(`(()=>{const list=Array.from(document.querySelectorAll('[class*=roomList] li'));if(list.length!==${noShow?6:13})return null;const e=list[${noShow?3:6}];e.click();return e.innerText;})()`);
  assert.ok(room,'native critical room card exists');console.log('ROOM',JSON.stringify(room));
  await delay(18000);
  let session;for(const s of sessions){if(await evalAt('window.cc&&cc.director.getScene()?.name',s).catch(()=>null)==='gameHoldem')session=s;}
  assert.ok(session,'original client reaches gameHoldem');const evaluate=e=>evalAt(e,session);
  const entry=await evaluate(`(()=>{const g=cc.app.gameRoom;return {scene:cc.director.getScene().name,params:g.params,conf:g._conf,observer:g.getIsOb(),me:g.getMyMemberInfo()};})()`);
  console.log('ENTRY',JSON.stringify({scene:entry.scene,observer:entry.observer,mode:entry.conf.playMode,params:entry.params}));
  assert.equal(entry.observer,true);assert.ok(!entry.me);assert.equal(entry.params.criticalFlag,true);assert.equal(entry.params.criticalAnte,100);
  assert.ok(frames.some(f=>f.msgid===2201&&f.payload.conf?.gameRoomConfigId===(noShow?1928:1921)));
  assert.equal(entry.params.forceShowCard,!noShow);
  await evaluate(`(()=>{for(const c of cc.director.getScene().getComponentsInChildren(cc.Component))if(c.node.activeInHierarchy&&cc.js.getClassName(c)==='GameCriticalHelpPanel')c.closeIt();return true;})()`);
  await evaluate(`cc.app.gameRoom.dispatchEventAll('HideAllPopupPanel');true`);
  assert.equal(await evaluate(`(()=>{const c=cc.director.getScene().getComponentsInChildren(cc.Component).find(c=>typeof c.clickSeatDown==='function');const nodes=[],walk=n=>{if(Number.isInteger(n.seatIndex)&&n.activeInHierarchy&&n.getComponent(cc.Button)?.interactable)nodes.push(n);n.children.forEach(walk);};if(!c)return false;walk(c.node);if(!nodes.length)return false;c.clickSeatDown({target:nodes[0]});return true;})()`),true);
  await delay(500);
  assert.equal(await evaluate(`(()=>{const c=cc.director.getScene().getComponentsInChildren(cc.Component).find(c=>c.node.activeInHierarchy&&c._curdata&&typeof c.onDaiRuClick==='function');if(!c)return false;c._carryReqCount=100;c.onDaiRuClick();return true;})()`),true);
  const started=Date.now();let progress,criticalInning,settled=false,ordinaryAfter=false,animation=false;
  while(Date.now()-started<160000){
    progress=await evaluate(`(()=>{const g=cc.app.gameRoom,all=cc.director.getScene().getComponentsInChildren(cc.Component);for(const c of all){if(c.node.activeInHierarchy&&cc.js.getClassName(c)==='GameCriticalHelpPanel')c.closeIt();}return {phase:g._curStatus,inning:g._conf.currentInning,me:g.getMyMemberInfo(),visibleErrors:all.filter(c=>c instanceof cc.Label&&c.node.activeInHierarchy&&/NaN|undefined/.test(c.string)).map(c=>c.string),critPanel:all.some(c=>c.node.activeInHierarchy&&c.node.name==='criticalStartPanel')};})()`);
    animation ||= progress.critPanel;
    const begin=frames.find(f=>f.msgid===3261&&f.payload.playMode===2&&f.payload.uidList.includes(uid));
    if(begin){criticalInning=begin.payload.currentInning;
      const slice=frames.filter(f=>f.time>=begin.time),end=slice.find(f=>f.msgid===3432&&f.payload.some(p=>p.uid===uid));
      if(end&&!settled){settled=true;console.log('CRITICAL_RESULT',JSON.stringify({inning:criticalInning,results:end.payload}));
        await delay(1500);
        const visual=await evaluate(`(()=>{const all=cc.director.getScene().getComponentsInChildren(cc.Component);return {phase:cc.app.gameRoom._curStatus,help:all.some(c=>c.node.activeInHierarchy&&cc.js.getClassName(c)==='GameCriticalHelpPanel'),labels:all.filter(c=>c instanceof cc.Label&&c.node.activeInHierarchy).map(c=>c.string)};})()`);
        assert.equal(visual.help,false);console.log('SETTLE_VISUAL',JSON.stringify(visual));
        const shots=await send('Page.captureScreenshot');fs.writeFileSync('test/browser/holdem-critical'+suffix+'-settle.png',Buffer.from(shots.result.data,'base64'));
        const states=slice.slice(0,slice.indexOf(end)).filter(f=>f.msgid===3263).map(f=>f.payload);
        assert.ok(!states.includes('BET_BLIND')&&!states.includes('BET_PERFLOP'));assert.ok(states.includes('BET_FLOP'));
        assert.equal(end.payload.reduce((sum,p)=>sum+p.score,0),0);
      }
      ordinaryAfter=frames.some(f=>f.msgid===3261&&f.payload.currentInning>criticalInning&&f.payload.playMode===0);
    }
    const t=[...registry.tables.values()].find(t=>t.members.some(m=>m.uid===uid));
    if(t?.hand?.actorUid===uid){const me=t.members.find(m=>m.uid===uid),operation=me.streetBet<t.hand.currentBet?7:10;
      // Send through the original native SocketMgr / binary codec.
      await evaluate(`__require('SocketMgr').default.instance.send(3162,{uid:${uid},operation:${operation},operationData:0});true`);
    }
    assert.deepEqual(progress.visibleErrors,[]);
    if(settled&&ordinaryAfter)break;await delay(300);
  }
  console.log('PROGRESS',JSON.stringify({criticalInning,settled,ordinaryAfter,animation,progress}));
  assert.ok(settled&&ordinaryAfter,'mandatory hand settles and returns to ordinary play');
  // The original client dismisses panels when the user's next turn arrives.
  // Pause only this isolated simulation while verifying its replay window.
  clearInterval(tick);await delay(2500);
  await evaluate(`cc.app.gameRoom.dispatchEventAll('HideAllPopupPanel');true`);
  await evaluate(`(async()=>{const all=cc.director.getScene().getComponentsInChildren(cc.Component),c=all.find(c=>cc.js.getClassName(c)==='gameHoldem'&&typeof c.onGameHistoryClick==='function')||all.find(c=>typeof c.onGameHistoryClick==='function');await c.onGameHistoryClick();return true;})()`);
  await delay(2000);
  let history;for(let n=0;n<20;n++){
    history=await evaluate(`(()=>{const all=cc.director.getScene().getComponentsInChildren(cc.Component),c=all.find(c=>c.historyModel&&c.historyContentScript),m=c?.historyModel||__require('SingleFactory').SingleFactory.getInstance(__require('HoldemHistoryModel').HoldemHistoryModel),p=m?.getCurrentPlayBack();return {found:!!m,visible:!!c?.node.activeInHierarchy,received:m?.isDataReceived,page:m?.getCurrentPageNum(),total:m?.getTotalPageaNum(),initialBet:p?.initialBet,players:p?.firstGameList?.length};})()`);
    if(history.found&&history.received)break;await delay(400);
  }
  console.log('HISTORY',JSON.stringify(history));assert.ok(history.found&&history.received);
  assert.equal(history.initialBet,100);assert.ok(history.players>=2);
  const errors=logs.filter(m=>m.method==='Runtime.exceptionThrown');console.log('ERRORS',JSON.stringify(errors));assert.deepEqual(errors,[]);assert.deepEqual(failures,[]);
  await evaluate(`__require('SocketMgr').default.instance.send(2110);true`);await delay(1500);
  assert.equal(await evalAt(`(()=>{const f=document.querySelector('[class*=gameIframe]');return !f||getComputedStyle(f).visibility!=='visible';})()`),true);
}catch(e){fs.writeFileSync('test/browser/holdem-critical'+suffix+'-failure.json',JSON.stringify({error:e.stack,logs,frames,failures}));throw e;}
finally{clearInterval(tick);ws?.close();browser.kill();for(const s of sockets.clients)s.terminate();for(const s of proxies.clients)s.terminate();
  await Promise.all([new Promise(r=>sockets.close(r)),new Promise(r=>proxies.close(r))]);
  await Promise.all([new Promise(r=>gameServer.close(r)),new Promise(r=>hall.close(r))]);await closeRpc();}

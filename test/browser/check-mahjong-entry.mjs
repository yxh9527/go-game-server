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
import * as engine from '../../game-server/src/games/mahjong/engine.js';
import * as robot from '../../game-server/src/games/mahjong/robot.js';
import { PROTOCOL } from '../../game-server/src/games/mahjong/messages.js';

// Separate servers and wallets. Never alter resident services or live hands.
const roomId = Number(process.argv[2] || 2604), type = Math.floor(roomId / 100), uid = 88000000 + roomId;
const handsToPlay = Number(process.argv[3] || 1);
const requireSelfHu = process.argv.includes('--require-self-hu');
const failures = [], log = { info(){}, error(...a){ failures.push(a.map(String).join(' ')); } };
const rpc = await initRpc({ env: 'dev' }, log), registry = createRegistry();
const runtime = { env:'dev', config:{}, hotVersion:'mahjong-browser', rpc, gateway:rpc.gateway,
  store:rpc.lobby, bus:rpc.bus, wallet:createRpcWallet(rpc), registry, findConfig,
  configs:await rpc.lobby.listRooms(), log };
const handler = await createHandler(runtime); runtime.getDevHoldemRecordDetail = handler.getDevHoldemRecordDetail;
const server = http.createServer((req,res)=>{if(!handler.handleLocalRequest(req,res)){res.statusCode=404;res.end();}});
const sockets = new WebSocketServer({server});
sockets.on('connection',ws=>{ws.on('message',raw=>handler.onMessage(ws,raw).catch(e=>failures.push(e.stack)));
  ws.on('close',()=>handler.onClose(ws).catch(e=>failures.push(e.stack)));});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const target='127.0.0.1:'+server.address().port, roomStore=createRoomStore(),matchStore=createMatchStore();
roomStore.replace(runtime.configs);matchStore.replaceMatches(await rpc.lobby.listMatches());
const app=await createApp({env:'dev',hotVersion:'mahjong-browser',config:{game_server:target,hundred_server:target},
  roomStore,matchStore,rpc,wallet:runtime.wallet,gateway:rpc.gateway,store:rpc.lobby,log});
const hall=http.createServer((req,res)=>isGameStaticHost(req.headers.host)&&!isHallApiPath(req.url)
  ?proxyToClientWeb(req,res,'127.0.0.1:4000',log):app(req,res));
const proxies=attachGameProxy(hall,target,log);await new Promise(r=>hall.listen(0,'127.0.0.1',r));
const tick=setInterval(()=>{try{handler.tick();}catch(e){failures.push(e.stack);}},200);
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'gogame-mj-'));
const browser=spawn(process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',[
  '--headless=new','--no-sandbox','--disable-gpu','--disable-extensions','--no-first-run',
  '--disable-background-networking','--remote-debugging-port=0','--user-data-dir='+profile,
  '--window-size=1280,900','--autoplay-policy=no-user-gesture-required','about:blank',
],{windowsHide:true,stdio:['ignore','ignore','pipe']});
const delay=ms=>new Promise(r=>setTimeout(r,ms)), logs=[], frames=[];let ws;
try{
  let port;for(let n=0;n<100;n++){try{port=fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0];break;}catch{}await delay(100);}
  const page=(await(await fetch('http://127.0.0.1:'+port+'/json/list')).json()).find(t=>t.type==='page');
  ws=new WebSocket(page.webSocketDebuggerUrl.replace('localhost','127.0.0.1'));await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j);});
  let id=0;const pending=new Map(),sessions=[];
  const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const n=++id,timer=setTimeout(()=>{pending.delete(n);reject(Error('CDP '+method));},15000);
    pending.set(n,m=>{clearTimeout(timer);resolve(m);});ws.send(JSON.stringify({id:n,method,params,sessionId}));});
  ws.on('message',raw=>{const m=JSON.parse(raw);if(m.id){pending.get(m.id)?.(m);pending.delete(m.id);}
    else if(m.method==='Target.attachedToTarget'){sessions.push(m.params.sessionId);send('Runtime.enable',{},m.params.sessionId);send('Network.enable',{},m.params.sessionId);}
    else if(m.method==='Network.webSocketFrameReceived'){try{const f=m.params.response;if(f.opcode===2)frames.push({...decodeFrame(Buffer.from(f.payloadData,'base64')),time:Date.now()});}catch{}}
    else if(['Runtime.exceptionThrown','Runtime.consoleAPICalled'].includes(m.method))logs.push(m);
  });
  const evalAt=async(expression,sessionId)=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},sessionId);
    assert.ok(!r.result?.exceptionDetails,JSON.stringify(r.result?.exceptionDetails));return r.result?.result?.value;};
  await send('Runtime.enable');await send('Network.enable');await send('Page.enable');
  await send('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:false,flatten:true});
  await send('Page.navigate',{url:'http://lobby.localhost:'+hall.address().port+'/21/0?userId='+uid+'&userToken=dev-'+uid+'&openId='+uid+'&v=2.0.1279'});
  await delay(13000);
  await evalAt(`(()=>{const e=Array.from(document.querySelectorAll('*')).filter(e=>e.textContent.trim()==='麻将').sort((a,b)=>a.querySelectorAll('*').length-b.querySelectorAll('*').length)[0];e?.click();return !!e;})()`);
  await delay(1000);
  const gameName={26:'极速麻将',28:'长沙麻将',30:'红中血流'}[type];
  await evalAt(`(()=>{const e=Array.from(document.querySelectorAll('*')).filter(e=>e.textContent.trim()===${JSON.stringify(gameName)}).sort((a,b)=>a.querySelectorAll('*').length-b.querySelectorAll('*').length)[0];e?.click();return !!e;})()`);
  await delay(1800);
  const list=await evalAt(`Array.from(document.querySelectorAll('[class*=roomList] li')).map(e=>e.innerText)`);console.log('LOBBY',JSON.stringify(list));
  assert.equal(list.length,6,'six native room cards');
  // Native sorting groups two/four-person tiers by mode and then base score.
  const two = roomId === 2604 || roomId === 2801 || roomId === 3002;
  const targetWords=type===28?(two?'2人':'4人'):(two?'二人':'四人');
  const clicked=await evalAt(`(()=>{const list=Array.from(document.querySelectorAll('[class*=roomList] li'));const found=list.find(e=>e.innerText.includes(${JSON.stringify(targetWords)})&&e.innerText.includes('0.1'))||list[${two?3:0}];found?.click();return found?.innerText;})()`);console.log('CLICK',clicked);
  await delay(18000);
  let session;for(const s of sessions)if(await evalAt(`!!(window.cc&&cc.app?.gameRoom&&cc.director.getScene()?.name!=='webHallOb')`,s).catch(()=>false))session=s;
  assert.ok(session,'native Mahjong scene loaded');const evaluate=e=>evalAt(e,session);
  console.log('ENTRY',JSON.stringify(await evaluate(`({scene:cc.director.getScene().name,observer:cc.app.gameRoom.getIsOb(),params:cc.app.gameRoom.params})`)));
  assert.ok(frames.some(f=>f.msgid===2201&&f.payload.conf?.gameRoomConfigId===roomId),'selected exact configuration');
  await evaluate(`(()=>{for(const c of cc.director.getScene().getComponentsInChildren(cc.Component))if(c.node.activeInHierarchy&&/HelpPanel/.test(cc.js.getClassName(c))&&typeof c.closeIt==='function')c.closeIt();cc.app.gameRoom.dispatchEventAll?.('HideAllPopupPanel');return true;})()`);
  const nativeTable=[...registry.tables.values()].find(t=>t.cfg.game_room_config_id===roomId),emptyPos=Array.from({length:nativeTable.roomRules.maxPeople},(_,i)=>i).find(i=>!nativeTable.members.some(m=>m.pos===i));
  const seat=await evaluate(`(()=>{const all=cc.director.getScene().getComponentsInChildren(cc.Component),c=all.find(c=>typeof c.clickSeatDown==='function');if(c){const nodes=[],walk=n=>{if(Number.isInteger(n.seatIndex)&&n.activeInHierarchy&&n.getComponent(cc.Button)?.interactable)nodes.push(n);n.children.forEach(walk);};walk(c.node);if(nodes.length){c.clickSeatDown({target:nodes[0]});return 'clickSeatDown';}}const p=all.find(c=>typeof c.onPlayerSitDown==='function');if(p){const n=[0,1,2,3].find(n=>p.viewModel.getLocalIndexBySeatIndex(n)===${emptyPos});p.onPlayerSitDown(null,String(n));return 'onPlayerSitDown';}const hz=all.find(c=>cc.js.getClassName(c)==='hzxlSeatPanel');if(hz){const n=[0,1,2,3].find(n=>hz.viewModel.seatNameToServerPos(n)===${emptyPos});hz.onClickSeat({target:hz.container.getSeatNode(n).getChildByName('icon')});return 'onClickSeat';}return null;})()`);console.log('SEAT',JSON.stringify(seat));
  assert.equal(typeof seat,'string','native seat button handler');await delay(700);
  const carry=await evaluate(`(()=>{const c=cc.director.getScene().getComponentsInChildren(cc.Component).find(c=>c.node.activeInHierarchy&&c._curdata&&typeof c.onDaiRuClick==='function');if(!c)return false;c._carryReqCount=100;c.onDaiRuClick();return true;})()`);assert.ok(carry,'native carry dialog');
  let settled=false,lastAction=0,reconnected=false,nativeDiscards=0,nativeSelfHus=0,postHuAutoDiscards=0,pendingAutoDiscard;const started=Date.now();
  while(Date.now()-started<240000){
    const t=[...registry.tables.values()].find(t=>t.cfg.game_room_config_id===roomId),h=t?.hand,p=h?.players.find(p=>p.uid===uid);
    if(t&&!t.cfg.robot_behavior)t.cfg.robot_behavior={checkMinMs:1000,checkMaxMs:1000,joinProbability:1,leaveProbability:0,carryMinMs:1000,carryMaxMs:1000};
    if(h&&p&&h.stage==='turn'&&!reconnected&&(type!==30||nativeDiscards>=2)){
      await evaluate(`__require('SocketMgr').default.instance.send(2111,{roomId:${nativeTable.roomId},backForground:true});true`);
      reconnected=true;await delay(500);
    }
    if(h&&p&&Date.now()-lastAction>600){
      let action;
      if(h.stage==='exchange'&&!p.exchange)action={id:3653,body:{cards:robot.chooseExchange(p.handCards)}};
      else if(h.stage==='que'&&!p.queType)action={id:3652,body:{type:robot.chooseQue(p.handCards)}};
      else if((['turn','sea','gang'].includes(h.stage)&&h.actorUid===uid)||(['first','response'].includes(h.stage)&&h.offers[uid]&&!h.responses[uid])){
        const opts=engine.options(t,p).filter(o=>type!==30||nativeDiscards>=2||o.type!==8),op=robot.chooseAction({cards:p.handCards.slice(),options:h.stage==='turn'?[...opts,{type:2}]:opts,
          family:h.rules.family,queType:p.queType,ting:p.ting,drawn:p.drawn});
        if([9,10].includes(op.type)&&op.card==null)op.card=op.cards?.[0];action={id:PROTOCOL[h.rules.family].action,body:op};
      }
      if(type===30&&action?.body.type===2&&p.huRecord.length){
        if(p.drawn!=null)pendingAutoDiscard ||= {p,before:p.discardCount,card:p.drawn,deadline:h.deadline};
        action=null; // The browser must never send a discard for a locked hand.
      }
      if(action){
        // The native blood-flow client locks manual hand input after a hu.
        // Exercise normal discards through its click handler before that.
        if(type===30&&action.id===PROTOCOL.hzxl.action&&action.body.type===2&&!p.huRecord.length){
          const card=action.body.card;
          let clickState;
          for(let attempt=0;attempt<20;attempt++){
            clickState=await evaluate(`(()=>{const all=cc.director.getScene().getComponentsInChildren(cc.Component),touch=all.filter(c=>c.node.activeInHierarchy&&c.hand&&typeof c.simulateClickCard==='function'&&'isEnableTrigger' in c),candidate=touch.find(c=>c.hand.value===${card}&&c.isEnableTrigger&&c.isEnableDrag&&c.viewModel.isSelfCanOperate&&c.viewModel.isSelfCursorPlayer);return {clickable:!!candidate,cards:touch.map(c=>({card:c.hand.value,enabled:c.isEnableTrigger,discard:c.isEnableDrag})),operator:touch[0]?.viewModel?.__currentOperatorUser,memberOperator:touch[0]?.viewModel?.__currentMemberOperator};})()`);
            if(clickState.clickable)break;
            await delay(100);
          }
          console.log('NATIVE_DISCARD',JSON.stringify({card,...clickState}));
          assert.ok(clickState.clickable,'native blood-flow hand must enable legal discards');
          const discards=p.discardCount;
          for(let click=0;click<2;click++){
            await evaluate(`(()=>{const c=cc.director.getScene().getComponentsInChildren(cc.Component).find(c=>c.node.activeInHierarchy&&c.hand?.value===${card}&&typeof c.simulateClickCard==='function'&&c.isEnableTrigger&&c.isEnableDrag);c?.simulateClickCard();return !!c;})()`);
            await delay(180);
          }
          assert.equal(p.discardCount,discards+1,'native hand click sends an accepted discard');
          nativeDiscards++;
        }else if(type===30&&action.id===PROTOCOL.hzxl.action&&action.body.type===8&&h.stage==='turn'){
          let button;
          for(let attempt=0;attempt<20;attempt++){
            button=await evaluate(`(()=>{const c=cc.director.getScene().getComponentsInChildren(cc.Component).find(c=>c.node.activeInHierarchy&&c.oper_2&&typeof c.onClickOper2Btn==='function'),n=c?.oper_2.getChildByName('btn_hu'),b=n?.getComponent(cc.Button),op=b?.clickEvents[0]?.customEventData;return {visible:!!(n?.activeInHierarchy&&b?.interactable&&c.viewModel.isSelfCanOperate),op:op?JSON.parse(op):null,multiplier:n?.getChildByName('num')?.getComponent(cc.Label)?.string};})()`);
            if(button.visible&&button.op?.card===action.body.card)break;
            await delay(100);
          }
          console.log('NATIVE_SELF_HU',JSON.stringify(button));
          assert.ok(button.visible,'native self-draw hu button is visible and enabled');
          assert.equal(button.op.type,8);assert.equal(button.op.card,action.body.card);
          assert.ok(Number.isSafeInteger(button.op.num)&&button.op.num>0);
          assert.ok(!/undefined|NaN/.test(button.multiplier));
          const wins=p.huRecord.length;
          await evaluate(`(()=>{const c=cc.director.getScene().getComponentsInChildren(cc.Component).find(c=>c.node.activeInHierarchy&&c.oper_2&&typeof c.onClickOper2Btn==='function'),n=c.oper_2.getChildByName('btn_hu');c.onClickOper2Btn({target:n},n.getComponent(cc.Button).clickEvents[0].customEventData);return true;})()`);
          await delay(250);
          assert.equal(p.huRecord.length,wins+1,'native hu button submits an accepted self-draw');
          assert.equal(p.huRecord.at(-1).ziMo,true);nativeSelfHus++;
        }else await evaluate(`__require('SocketMgr').default.instance.send(${action.id},${JSON.stringify(action.body)});true`);
        lastAction=Date.now();
      }
    }
    if(pendingAutoDiscard&&pendingAutoDiscard.p.discardCount>pendingAutoDiscard.before){
      const {p,card,deadline}=pendingAutoDiscard;
      assert.equal(p.playCards.at(-1),card,'server discards the new tile while native hand input is locked');
      assert.ok(Date.now()<deadline,'post-hu draw-discard happens before the full operation timeout');
      postHuAutoDiscards++;console.log('POST_HU_AUTO_DISCARD',JSON.stringify({card,remainingMs:deadline-Date.now()}));
      pendingAutoDiscard=null;
    }
    if(t?.roomFeatures?.settledInning>=handsToPlay){settled=true;clearInterval(tick);break;}
    await delay(300);
  }
  assert.ok(settled,'native round settles');await delay(6000);
  if(type===30)assert.ok(nativeDiscards>=2,'blood-flow hand clicks work before reconnect');
  if(requireSelfHu)assert.ok(nativeSelfHus>0,'a native self-draw hu button was clicked during this run');
  if(requireSelfHu)assert.ok(postHuAutoDiscards>0,'server resumes draw-discard after a native self-draw without a browser discard request');
  const visual=await evaluate(`(()=>{const all=cc.director.getScene().getComponentsInChildren(cc.Component);return {scene:cc.director.getScene().name,labels:all.filter(c=>c instanceof cc.Label&&c.node.activeInHierarchy).map(c=>c.string)};})()`);console.log('VISUAL',JSON.stringify(visual));
  assert.deepEqual(visual.labels.filter(s=>/NaN|undefined/.test(s)),[]);
  await evaluate(`(async()=>{const c=cc.director.getScene().getComponentsInChildren(cc.Component).find(c=>typeof c.onGameHistoryClick==='function');await c.onGameHistoryClick();return true;})()`);await delay(3000);
  const history=await evaluate(`(()=>{const c=cc.director.getScene().getComponentsInChildren(cc.Component).find(c=>c.historyModel&&c.node.activeInHierarchy);return {visible:!!c,page:c?.historyModel?.getCurrentPageNum(),received:c?.historyModel?.isDataReceived,players:c?.historyModel?.getCurrentPlayBack()?.playerList?.length};})()`);console.log('HISTORY',JSON.stringify(history));
  const badHistoryLabels=await evaluate(`cc.director.getScene().getComponentsInChildren(cc.Label).filter(c=>c.node.activeInHierarchy&&/NaN|undefined/.test(c.string)).map(c=>c.string)`);
  assert.deepEqual(badHistoryLabels,[],'history fields remain numeric');
  assert.ok(history.received);assert.ok(history.page>=1&&history.players>=2,'native history contains the completed players');
  if(handsToPlay>1){
    const pages=[];
    for(const page of [0,1]){
      await evaluate(`(()=>{const c=cc.director.getScene().getComponentsInChildren(cc.Component).find(c=>c.historyModel&&c.node.activeInHierarchy);c.historyModel.onPage(${page});return true;})()`);
      await delay(1500);
      pages.push(await evaluate(`(()=>{const c=cc.director.getScene().getComponentsInChildren(cc.Component).find(c=>c.historyModel&&c.node.activeInHierarchy);return c.historyModel.getCurrentPlayBack()?.currentInningNum;})()`));
    }
    assert.deepEqual(pages,[1,2],'native history navigates between distinct hands');console.log('HISTORY_PAGES',pages);
  }
  assert.ok(reconnected&&frames.some(f=>f.msgid===PROTOCOL[nativeTable.roomRules.family].snapshot),'native reconnect snapshot received');
  const errors=logs.filter(m=>m.method==='Runtime.exceptionThrown');console.log('ERRORS',JSON.stringify(errors));assert.deepEqual(errors,[]);assert.deepEqual(failures,[]);
  await evaluate(`__require('SocketMgr').default.instance.send(2110);true`);await delay(1500);
  assert.equal(await evalAt(`(()=>{const f=document.querySelector('[class*=gameIframe]');return !f||getComputedStyle(f).visibility!=='visible';})()`),true);
  fs.rmSync('test/browser/mahjong-'+roomId+'-failure.json',{force:true});
  console.log('PASS',roomId);
}catch(e){fs.writeFileSync('test/browser/mahjong-'+roomId+'-failure.json',JSON.stringify({error:e.stack,logs,frames,failures}));throw e;}
finally{clearInterval(tick);ws?.close();browser.kill();for(const s of sockets.clients)s.terminate();for(const s of proxies.clients)s.terminate();
  await Promise.all([new Promise(r=>sockets.close(r)),new Promise(r=>proxies.close(r))]);
  await Promise.all([new Promise(r=>server.close(r)),new Promise(r=>hall.close(r))]);await closeRpc();}

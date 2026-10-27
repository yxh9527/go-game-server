import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'gogame-casino-'));
const browser=spawn(process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',[
  '--headless=new','--no-sandbox','--disable-gpu','--disable-extensions','--no-first-run',
  '--disable-background-networking','--remote-debugging-port=0','--user-data-dir='+profile,
  '--window-size=1280,900','about:blank',
],{windowsHide:true,stdio:['ignore','ignore','pipe']});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let ws,ev;const sessions=[],errors=[];
try{
  let port;for(let i=0;i<100;i++){try{port=fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0];break;}catch{}await delay(100);}
  const target=(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t=>t.type==='page');
  ws=new WebSocket(target.webSocketDebuggerUrl.replace('localhost','127.0.0.1'));
  await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
  let id=0;const pending=new Map();
  const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{
    const n=++id,timer=setTimeout(()=>{pending.delete(n);reject(new Error('CDP timeout '+method));},15000);
    pending.set(n,m=>{clearTimeout(timer);resolve(m);});ws.send(JSON.stringify({id:n,method,params,sessionId}));
  });
  ws.on('message',raw=>{const m=JSON.parse(raw);if(m.id){pending.get(m.id)?.(m);pending.delete(m.id);}
    else if(m.method==='Target.attachedToTarget'){sessions.push(m.params.sessionId);send('Runtime.enable',{},m.params.sessionId);}
    else if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails);
  });
  const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});assert.ok(!r.result?.exceptionDetails,JSON.stringify(r.result?.exceptionDetails));return r.result?.result?.value;};
  await send('Page.enable');await send('Runtime.enable');
  await send('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:false,flatten:true});
  const uid=88000693;
  await send('Page.navigate',{url:`http://lobby.localhost:11042/21/0?userId=${uid}&userToken=dev-${uid}&openId=${uid}&v=2.0.1279`});
  await delay(13000);
  await evaluate(`Array.from(document.querySelectorAll('span,p,div,a')).find(e=>e.textContent==='二十一点'&&e.children.length===0)?.click()`);
  await delay(3000);
  console.log('ROOMS',await evaluate(`Array.from(document.querySelectorAll('[class*=roomList] li')).map(e=>e.innerText)`));
  await evaluate(`document.querySelector('[class*=roomList] li').click()`);
  await delay(20000);
  let session;for(const candidate of sessions){const r=await send('Runtime.evaluate',{expression:'window.cc&&cc.director.getScene()?.name',returnByValue:true},candidate);console.log('SCENE',r.result?.result?.value);if(r.result?.result?.value==='liveBlackJack')session=candidate;}
  console.log('ERRORS',JSON.stringify(errors));
  assert.ok(session,'casino reaches original liveBlackJack scene');
  ev=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},session);assert.ok(!r.result?.exceptionDetails,JSON.stringify(r.result?.exceptionDetails));return r.result?.result?.value;};
  console.log('ENTER',JSON.stringify(await ev(`(()=>{const g=cc.app.gameRoom;return {mode:g._conf.playMode,me:g.getMyMemberInfo(),state:g.__currentGameState,inning:g.__currentInningInfo?.currentInning};})()`)));
  assert.equal(await ev(`cc.app.gameRoom._conf.playMode`),1);
  assert.equal(await ev(`cc.app.gameRoom._conf.maxPeople`),5);
  assert.equal(await ev(`!!cc.app.gameRoom.getMyMemberInfo()`),false,'entry remains observing');
  const initial=await ev(`({point:cc.app.gameRoom.__myPoint,chip:cc.app.gameRoom.__currentChipValue,rate:__require('UICurrencyCtl').default.exchangeRate})`);
  console.log('INITIAL_BALANCE_AND_CHIP',JSON.stringify(initial));
  assert.ok(initial.point>0,'loaded casino model receives observer wallet balance');
  assert.equal(initial.chip,1,'native balance handler selects default chip without test intervention');
  await ev(`(()=>{window.__casinoEvents=[];const n=__require('NotificationCenter').default,emit=n.emit;n.emit=function(event,data,...args){__casinoEvents.push({event,data,at:Date.now()});return emit.call(this,event,data,...args);};return true;})()`);
  await ev(`(()=>{window.__casinoRequests=[];const socket=__require('SocketMgr').default.instance,send=socket.send;socket.send=function(id,body,...args){__casinoRequests.push({id,body});return send.call(this,id,body,...args);};return true;})()`);
  let betting;
  for(let i=0;i<240;i++){
    betting=await ev(`(()=>{const g=cc.app.gameRoom,p=cc.director.getScene().getComponentsInChildren('LiveBlackJackPlayer');return {state:g.__currentGameState,inning:g.__currentInningInfo?.currentInning,left:g.__currentInningInfo?.stateDeadline-Date.now(),empty:p.some(p=>!p.userInfo),occupied:p.some(p=>!!p.userInfo)};})()`);
    if(betting.state===2&&betting.left>6500&&betting.empty&&betting.occupied)break;
    await delay(250);
  }
  assert.ok(betting.state===2&&betting.left>6500&&betting.empty&&betting.occupied,'fresh betting window with an occupied and empty seat');
  await ev(`(async()=>{cc.director.getScene().getComponentsInChildren('LiveBlackJackPlayer').find(p=>p.userInfo).onClickClickArea();const c=cc.director.getScene().getComponentInChildren('LiveBlackJackControlPart');await c.onClickAnte({target:c.anteBtn});c.onClickConfirmBet();return true;})()`);
  await delay(300);
  const rejected=await ev(`({point:cc.app.gameRoom.__myPoint,chip:cc.app.gameRoom.__currentChipValue,response:cc.app.gameRoom.model.__betRsp})`);
  console.log('OBSERVER_REJECTION',JSON.stringify(rejected));
  assert.equal(rejected.response?.code,'BET_FAILED','unsupported observer wager is not mislabeled as phase error');
  assert.equal(rejected.point,initial.point,'failed observer bet preserves real wallet balance');
  assert.equal(rejected.chip,1,'rejection never resets selected chip to zero');
  const chosen=await ev(`(()=>{const p=cc.director.getScene().getComponentsInChildren('LiveBlackJackPlayer').find(p=>!p.userInfo);if(!p)return null;const seat=Number(p.node.name);p.onClickSitDown();return seat;})()`);
  assert.ok([1,2,3,5,6].includes(chosen),'native empty seat button');
  await delay(500);
  assert.equal(await ev(`cc.app.gameRoom.getMyMemberInfo()?.displaySeat`),chosen,'clicked display seat is occupied');
  assert.equal(await ev(`cc.app.gameRoom.getMyMemberInfo()?.point`),initial.point,'native seat uses the actual account balance');
  assert.equal(await ev(`cc.app.gameRoom.__myPoint`),initial.point,'seating does not debit the wallet or set it to zero');
  assert.equal(await ev(`cc.app.gameRoom.__currentInningInfo?.currentInning`),betting.inning,'native seat joins the already active betting round');
  assert.equal(await ev(`cc.app.gameRoom.__currentGameState`),2);
  const nativeBet=()=>ev(`(async()=>{const c=cc.director.getScene().getComponentInChildren('LiveBlackJackControlPart');await c.onClickAnte({target:c.anteBtn});c.onClickConfirmBet();return true;})()`);
  await nativeBet();await delay(300);
  assert.equal(await ev(`cc.app.gameRoom.model.__betRsp?.code`),200,'mid-bet entrant can confirm immediately');
  assert.equal(await ev(`cc.app.gameRoom.__myPoint`),initial.point-100);
  await nativeBet();await delay(300);
  assert.equal(await ev(`cc.app.gameRoom.model.__betRsp?.code`),200,'a second native confirmation adds to the same bet');
  assert.equal(await ev(`cc.app.gameRoom.__myPoint`),initial.point-200);
  console.log('MID_BET_CONFIRMED',JSON.stringify(await ev(`({inning:cc.app.gameRoom.__currentInningInfo?.currentInning,point:cc.app.gameRoom.__myPoint,bet:cc.app.gameRoom.__currentInningInfo?.players.find(p=>p.uid===${uid})?.betAmount})`)));
  let settled=false,actions=0,last;
  for(let i=0;i<180;i++){
    last=await ev(`(()=>{const g=cc.app.gameRoom;return {state:g.__currentGameState,inning:g.__currentInningInfo?.currentInning,available:g.__selfAvailableActions,point:g.__myPoint,bet:g.model.__betRsp,settle:g.model.__settle};})()`);
    if(last.available?.includes('INSURANCE_SKIP'))await ev(`cc.app.gameRoom.insuranceRequest(false);true`);
    else if(last.available?.includes('STAND')){await ev(`cc.director.getScene().getComponentInChildren('LiveBlackJackControlPart').onClickStand();true`);actions++;}
    if(i%20===0)console.log('PLAY',JSON.stringify({state:last.state,inning:last.inning,point:last.point,available:last.available}));
    if(last.bet?.code===200&&last.settle?.currentInning===betting.inning&&last.settle?.settleList?.some(r=>r.uid===uid)){settled=true;break;}
    await delay(500);
  }
  assert.ok(settled,'accepted casino bet reaches settlement');
  console.log('SETTLED',JSON.stringify({point:last.point,bet:last.bet,actions,rows:last.settle?.settleList?.map(r=>({uid:r.uid,bet:r.betAmount,point:r.point,score:r.score}))}));
  assert.equal(await ev(`cc.app.gameRoom.getMyMemberInfo()?.userInfo?.uid`),uid,'native seat survives beyond the old twelve-second carry timeout');
  await ev(`cc.director.getScene().getComponentsInChildren('LiveBlackJackPlayer').find(p=>p.userInfo?.uid===${uid}).onClickStandUp();true`);
  await delay(6000);
  assert.equal(await ev(`!!cc.app.gameRoom.getMyMemberInfo()`),false,'native stand-up returns to observing after settlement');
  assert.equal(await ev(`cc.app.gameRoom.__myPoint`),last.point,'standing returns only actual remaining escrow, without duplicating the account');
  const requests=await ev(`__casinoRequests.filter(r=>[4501,5001,5003].includes(r.id))`);
  console.log('NATIVE_REQUESTS',JSON.stringify(requests));
  assert.equal(requests.some(r=>r.id===5001),false,'real casino flow sends no synthetic carry-in request');
  console.log('FINAL_ERRORS',JSON.stringify(errors));
  assert.equal(errors.length,0,'original casino has no uncaught script exceptions');
  const invalid=await ev(`cc.director.getScene().getComponentsInChildren(cc.Label).filter(l=>l.node.activeInHierarchy&&/NaN|undefined/.test(l.string)).map(l=>({name:l.node.name,text:l.string}))`);
  assert.deepEqual(invalid,[],'visible casino labels stay numeric');
  const shot=await send('Page.captureScreenshot');fs.writeFileSync('test/browser/blackjack-casino-entry.png',Buffer.from(shot.result.data,'base64'));
}finally{if(ev)await ev(`__require('SocketMgr').default.instance.send(2110);true`).catch(()=>{});ws?.close();browser.kill();}

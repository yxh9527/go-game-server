import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import assert from 'node:assert/strict';

const tier=Number(process.argv.find(a=>a.startsWith('--tier='))?.split('=')[1]||0);
const play=process.argv.includes('--play');
const observe=process.argv.includes('--observe');
const audit=process.argv.includes('--audit');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'gogame-sss-'));
const browser=spawn(process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',[
  '--headless=new','--no-sandbox','--disable-gpu','--disable-extensions','--no-first-run',
  '--disable-background-networking','--remote-debugging-port=0','--user-data-dir='+profile,
  '--window-size=1280,900','--autoplay-policy=no-user-gesture-required','about:blank',
],{windowsHide:true,stdio:['ignore','ignore','pipe']});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const log=[];let ws,leave;
try {
  let port;for(let i=0;i<100;i++) {try{port=fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0];break;}catch{}await delay(100);}
  const target=(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t=>t.type==='page');
  ws=new WebSocket(target.webSocketDebuggerUrl.replace('localhost','127.0.0.1'));
  await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
  let id=0;const pending=new Map(),sessions=[];
  const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{
    const n=++id,timer=setTimeout(()=>{pending.delete(n);reject(new Error('CDP timeout '+method));},15000);
    pending.set(n,m=>{clearTimeout(timer);resolve(m);});ws.send(JSON.stringify({id:n,method,params,sessionId}));
  });
  ws.on('message',raw=>{const m=JSON.parse(raw);if(m.id){pending.get(m.id)?.(m);pending.delete(m.id);}
    else if(m.method==='Target.attachedToTarget'){sessions.push(m.params.sessionId);send('Runtime.enable',{},m.params.sessionId);}
    else if(['Runtime.exceptionThrown','Runtime.consoleAPICalled'].includes(m.method))log.push(m);
  });
  const evalRoot=async expression=>(await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true})).result?.result?.value;
  await send('Runtime.enable');await send('Page.enable');await send('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:false,flatten:true});
  const uid=88000500+tier;
  await send('Page.navigate',{url:`http://lobby.localhost:11042/21/0?userId=${uid}&userToken=dev-${uid}&openId=${uid}&v=2.0.1279`});
  await delay(13000);
  await evalRoot(`Array.from(document.querySelectorAll('span,p,div,a')).find(e=>e.textContent==='十三水'&&e.children.length===0)?.click()`);
  await delay(2500);
  console.log('ROOMS',await evalRoot(`Array.from(document.querySelectorAll('[class*="roomList"] li')).map(e=>e.innerText)`));
  assert.equal(await evalRoot(`(()=>{const list=document.querySelectorAll('[class*="roomList"] li');if(list.length!==8)return list.length;list[${tier}].click();return true;})()`),true);
  await delay(18000);
  let session;
  for(const candidate of sessions){const r=await send('Runtime.evaluate',{expression:'window.cc&&cc.director.getScene()?.name',returnByValue:true},candidate);if(r.result?.result?.value==='sss')session=candidate;}
  assert.ok(session,'original client reached Sss');
  const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},session);assert.ok(!r.result?.exceptionDetails,JSON.stringify(r.result?.exceptionDetails));return r.result?.result?.value;};

  const state=await evaluate(`(()=>{const g=cc.app.gameRoom;return {conf:g._conf,room:g.__roomInfo,me:g.getMyMemberInfo()};})()`);
  console.log('ENTER',JSON.stringify({conf:state.conf,ob:!state.me}));assert.equal(state.conf.roomType,27);assert.ok(!state.me);
  leave=()=>evaluate(`__require('SocketMgr').default.instance.send(2110);true`);
  await evaluate(`(()=>{window.__sssEvents=[];const n=__require('NotificationCenter').default,emit=n.emit;n.emit=function(event,data,...args){__sssEvents.push({event,data});if(__sssEvents.length>1000)__sssEvents.shift();return emit.call(this,event,data,...args);};return true;})()`);
  if(play){
    await evaluate(`cc.app.gameRoom.model.sitDownRequest(0);true`);await delay(500);
    await evaluate(`__require('SocketMgr').default.instance.send(5001,{carryIn:${state.conf.sssParams.carryMin/100*10}});true`);
  }
  let last,submitted=new Set(),animations=0,extended=false;
  for(let i=0;i<230;i++){
    last=await evaluate(`(()=>{const g=cc.app.gameRoom,p=cc.director.getScene().getComponentInChildren('SssCombinPanel'),panel=cc.director.getScene().getComponentInChildren('SssPlayerPanel');return {phase:g.__currentState,inning:g.__currentInningBeginInfo,deal:g.currentDealCardList,me:g.getMyMemberInfo(),arrangeActive:p?.node.activeInHierarchy,compare:g.__compareResultMsg,settle:g.__settle,events:__sssEvents.slice(-10).map(x=>x.event),visibleScores:panel?.players.map(p=>({uid:p.userInfo?.uid,score:p.countScore?.value,front:p.frontType?.value})),exceptions:0};})()`);
    if(play&&last.arrangeActive){const own=last.deal.find(p=>p.uid===uid);const inning=last.inning?.currentInning;if(own&&!own.hasArranged&&!submitted.has(inning)){
      if(!extended&&own.arrangedCount>0){await evaluate(`cc.director.getScene().getComponentInChildren('SssCombinPanel').onClickAddLastArrangeTime();true`);await delay(150);assert.equal(await evaluate(`cc.app.gameRoom.getCurrentDealCard(${uid}).arrangedCount`),own.arrangedCount-1);extended=true;}
      await evaluate(`(()=>{const p=cc.director.getScene().getComponentInChildren('SssCombinPanel');p.onAutoTypeButtonClick({target:p.autoPokerNodes.children[0]},JSON.stringify(cc.app.gameRoom.getCurrentDealCard(${uid}).arrangementOptions[0]));p.onClickComfirmButton();return true;})()`);submitted.add(inning);}}
    if(last.visibleScores?.some(p=>p.score?.value!==-1000000000&&Number.isFinite(p.score?.value)))animations++;
    const results=await evaluate(`__sssEvents.filter(x=>x.event===3924).length`);
    if(i%30===0)console.log('PROGRESS',JSON.stringify({phase:last.phase,inning:last.inning?.currentInning,me:last.me?.point,results,submitted:[...submitted]}));
    if(results>=2&&animations>4)break;
    await delay(600);
  }
  console.log('STATE',JSON.stringify({phase:last.phase,inning:last.inning?.currentInning,players:last.settle?.map(p=>({uid:p.uid,score:p.score,point:p.point}))}));console.log('ANIMATIONS',animations,'SUBMITTED',[...submitted]);
  assert.ok(last.settle?.length>=2,'original client received settlement');assert.ok(animations>0,'visible comparison scores animated');
  if(play)assert.ok(submitted.size>=1,'original arrangement UI submitted a hand');
  if(play)assert.ok(extended,'native add-time button decrements the remaining allowance');
  await delay(11000);
  const shot=await send('Page.captureScreenshot');fs.writeFileSync(`test/browser/sss-${tier}.png`,Buffer.from(shot.result.data,'base64'));
  const historyButtons=await evaluate(`(()=>{const bs=cc.director.getScene().getComponentsInChildren(cc.Button).filter(b=>b.clickEvents.some(e=>/history|record/i.test(e.handler)));return bs.map(b=>({name:b.node.name,active:b.node.activeInHierarchy,events:b.clickEvents.map(e=>({component:e._componentName,handler:e.handler}))}));})()`);
  console.log('HISTORY_BUTTONS',JSON.stringify(historyButtons));
  await evaluate(`(()=>{const b=cc.director.getScene().getComponentsInChildren(cc.Button).find(b=>b.node.activeInHierarchy&&b.clickEvents.some(e=>/history/i.test(e.handler)));if(!b)throw new Error('history button missing');cc.Component.EventHandler.emitEvents(b.clickEvents,{target:b.node});return true;})()`);
  let history;
  for(let i=0;i<30;i++){
    history=await evaluate(`(()=>{const p=cc.director.getScene().getComponentInChildren('HistoryPanel');if(!p?.historyModel?.isDataReceived)return null;return {data:p.historyModel.gameBackMsgData,page:p.historyModel.getCurrentPageNum(),title:p.curPageTitle.string,loading:p.loading.active,items:p.historyContentScript.node.getComponentsInChildren('SssHistoryItem').length};})()`);
    if(history?.data&&history.items)break;await delay(300);
  }
  console.log('HISTORY',JSON.stringify({page:history?.page,title:history?.title,items:history?.items}));assert.ok(history?.data.dataInfo.firstGameList.length>=2);assert.ok(history.items>0);assert.equal(history.loading,false);
  for(const p of history.data.dataInfo.firstGameList){assert.ok(p.userName&&p.userIcon);assert.equal(p.evalResult.frontHand.cards.length,3);assert.equal(p.evalResult.middleHand.cards.length,5);assert.equal(p.evalResult.backHand.cards.length,5);}
  const lastPage=history.page;
  await evaluate(`cc.director.getScene().getComponentInChildren('HistoryPanel').onPrePageClick();true`);await delay(800);
  assert.equal(await evaluate(`cc.director.getScene().getComponentInChildren('HistoryPanel').historyModel.getCurrentPageNum()`),lastPage-1);
  await evaluate(`cc.director.getScene().getComponentInChildren('HistoryPanel').onNextPageClick();true`);await delay(800);
  assert.equal(await evaluate(`cc.director.getScene().getComponentInChildren('HistoryPanel').historyModel.getCurrentPageNum()`),lastPage);
  console.log('PAGES',JSON.stringify({previous:lastPage-1,next:lastPage}));
  await evaluate(`cc.director.getScene().getComponentInChildren('SssHistoryItem').showDetails();true`);await delay(1000);
  assert.ok(await evaluate(`cc.director.getScene().getComponentInChildren('SssHistoryDetails')?.node.activeInHierarchy`),'native opponent comparison history opens');
  const errors=log.filter(m=>m.method==='Runtime.exceptionThrown');console.log('ERRORS',JSON.stringify(errors));assert.equal(errors.length,0);
  console.log('LABELS',await evaluate(`cc.director.getScene().getComponentsInChildren(cc.Label).filter(c=>c.node.activeInHierarchy&&/undefined|NaN/.test(c.string)).map(c=>c.string)`));
  await leave();leave=null;await delay(1200);
  assert.equal(await evalRoot(`(()=>{const f=document.querySelector('[class*="gameIframe"]');return !f||getComputedStyle(f).visibility!=='visible';})()`),true,'exit reveals hall');
}catch(error){fs.writeFileSync(`test/browser/sss-failure-${tier}.json`,JSON.stringify(log));throw error;}
finally{if(leave)await leave().catch(()=>{});ws?.close();browser.kill();}

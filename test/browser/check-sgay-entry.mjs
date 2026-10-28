import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { decodeFrame } from '../../game-server/src/codec.js';
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'gogame-sgay-'));
const browser=spawn(process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',[
  '--headless=new','--no-sandbox','--disable-gpu','--disable-extensions','--no-first-run',
  '--disable-background-networking','--remote-debugging-port=0','--user-data-dir='+profile,
  '--window-size=1280,900','--autoplay-policy=no-user-gesture-required','about:blank',
],{windowsHide:true,stdio:['ignore','ignore','pipe']});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const uid=88000732,logs=[],frames=[];let ws,leave;
try {
  let port;for(let i=0;i<100;i++){try{port=fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0];break;}catch{}await delay(100);}
  const target=(await(await fetch('http://127.0.0.1:'+port+'/json/list')).json()).find(t=>t.type==='page');
  ws=new WebSocket(target.webSocketDebuggerUrl.replace('localhost','127.0.0.1'));
  await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
  let id=0;const pending=new Map(),sessions=[];
  const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{
    const n=++id,timer=setTimeout(()=>{pending.delete(n);reject(new Error('CDP timeout '+method));},15000);
    pending.set(n,m=>{clearTimeout(timer);resolve(m);});ws.send(JSON.stringify({id:n,method,params,sessionId}));
  });
  ws.on('message',raw=>{const m=JSON.parse(raw);if(m.id){pending.get(m.id)?.(m);pending.delete(m.id);}else if(m.method==='Target.attachedToTarget'){
    sessions.push(m.params.sessionId);send('Runtime.enable',{},m.params.sessionId);send('Network.enable',{},m.params.sessionId);
  }else if(m.method==='Network.webSocketFrameReceived'){try{const data=m.params.response;
    if(data.opcode===2){const f=decodeFrame(Buffer.from(data.payloadData,'base64'));if(f)frames.push({...f,time:Date.now()});}}catch{}
  }else if(['Runtime.exceptionThrown','Runtime.consoleAPICalled'].includes(m.method))logs.push(m);});
  const evalAt=async(expression,session)=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},session);
    assert.ok(!r.result?.exceptionDetails,JSON.stringify(r.result?.exceptionDetails));return r.result?.result?.value;};
  await send('Runtime.enable');await send('Network.enable');await send('Page.enable');
  await send('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:false,flatten:true});
  await send('Page.navigate',{url:'http://lobby.localhost:11042/21/0?userId='+uid+'&userToken=dev-'+uid+'&openId='+uid+'&v=2.0.1279'});
  await delay(13000);
  assert.equal(await evalAt(`(()=>{const e=Array.from(document.querySelectorAll('*')).find(e=>e.children.length===0&&e.textContent==='三公暗一');if(e){e.click();return true;}return false;})()`),true);
  await delay(2500);
  const rooms=await evalAt(`Array.from(document.querySelectorAll('[class*=roomList] li')).map(e=>e.innerText)`);
  console.log('ROOMS',JSON.stringify(rooms));assert.equal(rooms.length,4);
  await evalAt(`(()=>{const list=Array.from(document.querySelectorAll('[class*=roomList] li'));const low=list.find(e=>e.innerText.replace(/\s/g,'').includes('5/50'));(low||list[0]).click();return true;})()`);
  await delay(18000);
  let session;for(const candidate of sessions){const scene=await evalAt('window.cc&&cc.director.getScene()?.name',candidate).catch(()=>null);if(scene==='gameSgay')session=candidate;}
  assert.ok(session,'original client reached gameSgay');const evaluate=expression=>evalAt(expression,session);
  leave=()=>evaluate(`__require('SocketMgr').default.instance.send(2110);true`);
  const entry=await evaluate(`(()=>{const g=cc.app.gameRoom;return {scene:cc.director.getScene().name,conf:g._conf,params:g.params,observer:g.getIsOb(),me:g.getMyMemberInfo()};})()`);
  console.log('ENTRY',JSON.stringify({scene:entry.scene,observer:entry.observer,ante:entry.params.ante}));assert.equal(entry.observer,true);assert.ok(!entry.me);
  assert.equal(entry.conf.roomType,32);assert.equal(entry.params.ante,500);
  const seat=await evaluate(`(()=>{const c=cc.director.getScene().getComponentsInChildren(cc.Component).find(c=>typeof c.clickSeatDown==='function');if(!c)return false;const nodes=[],walk=n=>{if(Number.isInteger(n.seatIndex)&&n.activeInHierarchy&&n.getComponent(cc.Button)?.interactable)nodes.push(n);n.children.forEach(walk);};walk(c.node);if(!nodes.length)return false;c.clickSeatDown({target:nodes[0]});return true;})()`);
  assert.equal(seat,true,'native sit-down button reserves seat');await delay(500);
  const carry=await evaluate(`(()=>{const c=cc.director.getScene().getComponentsInChildren(cc.Component).find(c=>c.node.activeInHierarchy&&c._curdata&&typeof c.onDaiRuClick==='function');if(!c)return false;c._carryReqCount=500;c.onDaiRuClick();return true;})()`);
  assert.equal(carry,true,'native carry-in panel sends deposit');
  const started=Date.now(),settleSeen=new Map();let progress,coinsSeen=false,settleShot=false;
  while(Date.now()-started<100000){
    progress=await evaluate(`(()=>{const g=cc.app.gameRoom,me=g.getMyMemberInfo(),all=cc.director.getScene().getComponentsInChildren(cc.Component),btn=all.find(c=>typeof c.sendRaiseOperation==='function'),cuo=all.find(c=>c.node.activeInHierarchy&&typeof c.HalfOpen==='function'&&typeof c.notifyFinishOnce==='function');if(btn?.enableBet&&!btn.hasSendBet&&btn.actionBtns?.activeInHierarchy){window.__sgayBetClicked=true;btn.sendRaiseOperation(1);}if(cuo&&!cuo.mOpening&&!cuo.mClosed){window.__sgayCuoOpened=true;cuo.HalfOpen();}return {phase:g._curStatus,inning:g._conf.currentInning,me,bet:!!window.__sgayBetClicked,cuoOpened:!!window.__sgayCuoOpened};})()`);
    const visual=await evaluate(`(()=>{const all=cc.director.getScene().getComponentsInChildren(cc.Component),a=all.find(c=>c.coinLayer&&Array.isArray(c._allScorePreList));return {scores:(a?._allScorePreList||[]).filter(n=>cc.isValid(n)&&n.activeInHierarchy&&n.opacity>0).flatMap(n=>n.getComponentsInChildren(cc.Label).filter(l=>l.node.activeInHierarchy).map(l=>l.string)),coins:(a?.coinLayer?.children||[]).filter(n=>n.activeInHierarchy&&n.opacity>0&&n.name===a?.coinPre?.data?.name).length};})()`);
    coinsSeen ||= visual.coins>0;
    const results=frames.filter(f=>f.msgid===4403&&f.payload.some(p=>p.uid===uid)),last=results.at(-1);
    if(last&&progress.phase==='SETTLE'&&Date.now()-last.time<4000){
      const winners=last.payload.filter(p=>p.score>0).map(p=>'+'+Number((p.score/100).toFixed(2)));
      if(winners.length&&winners.every(s=>visual.scores.includes(s))){
        settleSeen.set(last.time,visual.scores);
        if(!settleShot){const shot=await send('Page.captureScreenshot');fs.writeFileSync('test/browser/sgay-settle.png',Buffer.from(shot.result.data,'base64'));settleShot=true;}
      }
    }
    if(results.length>=2&&results.every(f=>!f.payload.some(p=>p.score>0)||settleSeen.has(f.time))&&progress.bet)break;await delay(100);
  }
  console.log('PLAY',JSON.stringify(progress));const settled=frames.filter(f=>f.msgid===4403&&f.payload.some(p=>p.uid===uid));
  console.log('SETTLED',settled.length);assert.ok(settled.length>=2,'two real hands settled');assert.ok(progress.bet,'native betting control works');
  assert.ok(progress.cuoOpened,'native rubbing-card control completed');
  assert.ok(coinsSeen,'original client displays moving chips');
  assert.ok(settled.every(f=>!f.payload.some(p=>p.score>0)||settleSeen.has(f.time)),'visible winner amounts match each settlement');
  console.log('SETTLEMENT_VISUAL',JSON.stringify({hands:settleSeen.size,coinsSeen,amounts:[...settleSeen.values()]}));
  assert.ok(settled.every(f=>f.payload.every(p=>p.handPais.length===3&&Number.isFinite(p.score)&&Number.isFinite(p.point))));
  await evaluate(`cc.app.gameRoom.dispatchEventAll('HideAllPopupPanel');true`);
  await evaluate(`(()=>{const c=cc.director.getScene().getComponentsInChildren(cc.Component).find(c=>c.historyResMsg===4408);c.onGameHistoryClick();return true;})()`);
  await delay(2500);
  const readHistory=()=>evaluate(`(()=>{const p=cc.director.getScene().getComponentsInChildren(cc.Component).find(c=>c.historyModel&&c.historyContentScript),m=p?.historyModel;return {found:!!p,page:m?.getCurrentPageNum(),total:m?.getTotalPageaNum(),received:m?.isDataReceived,results:m?.inningResults,rows:cc.director.getScene().getComponentsInChildren(cc.Component).filter(c=>c.node.activeInHierarchy&&c.cardsSuperList&&c.multiLab).map(c=>({name:c.nameLab.string,score:c.scoreLab.string,multi:c.multiLab.string,avatar:!!c.headSpr.spriteFrame}))};})()`);
  const history=await readHistory();console.log('HISTORY',JSON.stringify(history));
  assert.ok(history.found&&history.received&&history.total>=2,'native history and HTTP detail loaded');
  assert.equal(history.page,history.total);assert.ok(history.results.length>=2);
  assert.ok(history.rows.length>=2&&history.rows.every(r=>r.name&&r.avatar&&!/NaN|undefined/.test(r.multi)));
  await evaluate(`(()=>{const p=cc.director.getScene().getComponentsInChildren(cc.Component).find(c=>c.historyModel&&c.historyContentScript);p.onPrePageClick();return true;})()`);
  await delay(1500);const previous=await readHistory();assert.equal(previous.page,history.page-1);assert.ok(previous.received);
  await evaluate(`(()=>{const p=cc.director.getScene().getComponentsInChildren(cc.Component).find(c=>c.historyModel&&c.historyContentScript);p.onNextPageClick();return true;})()`);
  await delay(1500);const next=await readHistory();assert.equal(next.page,history.page);assert.ok(next.received);
  console.log('HISTORY_PAGING',JSON.stringify({previous:previous.page,next:next.page}));
  console.log('VISIBLE_ERRORS',JSON.stringify(await evaluate(`cc.director.getScene().getComponentsInChildren(cc.Label).filter(c=>c.node.activeInHierarchy&&/undefined|NaN/.test(c.string)).map(c=>({node:c.node.name,text:c.string}))`)));
  const shot=await send('Page.captureScreenshot');fs.writeFileSync('test/browser/sgay-play.png',Buffer.from(shot.result.data,'base64'));
  const errors=logs.filter(m=>m.method==='Runtime.exceptionThrown');console.log('ERRORS',JSON.stringify(errors));assert.equal(errors.length,0);
  await leave();leave=null;await delay(1500);
  assert.equal(await evalAt(`(()=>{const f=document.querySelector('[class*=gameIframe]');return !f||getComputedStyle(f).visibility!=='visible';})()`),true,'exit reveals hall');
}catch(error){fs.writeFileSync('test/browser/sgay-failure.json',JSON.stringify({logs,frames}));throw error;}
finally{if(leave)await leave().catch(()=>{});ws?.close();browser.kill();}

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import assert from 'node:assert/strict';

const tier=Number(process.argv.find(a=>a.startsWith('--tier='))?.split('=')[1]||0);
const play=process.argv.includes('--play');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'gogame-blackjack-'));
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
  const uid=88000600+tier;
  await send('Page.navigate',{url:`http://lobby.localhost:11042/21/0?userId=${uid}&userToken=dev-${uid}&openId=${uid}&v=2.0.1279`});
  await delay(13000);
  await evalRoot(`Array.from(document.querySelectorAll('span,p,div,a')).find(e=>e.textContent==='二十一点'&&e.children.length===0)?.click()`);
  await delay(2500);
  console.log('ROOMS',await evalRoot(`Array.from(document.querySelectorAll('[class*="roomList"] li')).map(e=>e.innerText)`));
  assert.equal(await evalRoot(`(()=>{const all=Array.from(document.querySelectorAll('[class*="roomList"] li')),list=all.filter(e=>e.innerText.includes('/'));if(all.length!==5||list.length!==4)return all.length;list[${tier}].click();return true;})()`),true);
  await delay(18000);
  let session;
  for(const candidate of sessions){const r=await send('Runtime.evaluate',{expression:'window.cc&&cc.director.getScene()?.name',returnByValue:true},candidate);if(r.result?.result?.value==='bjk')session=candidate;}
  assert.ok(session,'original client reached Bjk');
  const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},session);assert.ok(!r.result?.exceptionDetails,JSON.stringify(r.result?.exceptionDetails));return r.result?.result?.value;};

  const state=await evaluate(`(()=>{const g=cc.app.gameRoom;return {conf:g._conf,room:g.__roomInfo,me:g.getMyMemberInfo(),scene:cc.director.getScene().name};})()`);
  console.log('ENTER',JSON.stringify({conf:state.conf,observer:!state.me,scene:state.scene}));assert.equal(state.conf.roomType,31);assert.ok(!state.me);
  leave=()=>evaluate(`__require('SocketMgr').default.instance.send(2110);true`);
  await evaluate(`(()=>{window.__bjEvents=[];const n=__require('NotificationCenter').default,emit=n.emit;n.emit=function(event,data,...args){__bjEvents.push({event,data,at:Date.now()});if(__bjEvents.length>1000)__bjEvents.shift();return emit.call(this,event,data,...args);};return true;})()`);
  // Observe the real scene at render cadence. A settlement completion log alone
  // does not prove that chips or the winner's amount were visible.
  await evaluate(`(()=>{window.__bjVisible=[];window.__bjDesk=[];window.__bjProbe=setInterval(()=>{const g=cc.app.gameRoom,p=cc.director.getScene()?.getComponentInChildren('BjkPlayerPanel');if(!p)return;__bjDesk.push({at:Date.now(),inning:g._conf.currentInning,phase:g.__currentState,anim:p._isPlayingSettleAnim,players:p.players.map(c=>c.node.activeInHierarchy?c.getVisiblePokerCount():0),dealer:p.dealerHand?.node.activeInHierarchy?p.dealerHand.getVisiblePokerCount():0});if(g.__currentState!==8)return;__bjVisible.push({inning:g._conf.currentInning,anim:p._isPlayingSettleAnim,chips:p.cacheChips.filter(c=>c.node.activeInHierarchy).map(c=>({x:c.node.x,y:c.node.y})),wins:p.players.filter(c=>c.getWinNd()?.activeInHierarchy&&c.getWinScoreLab()?.node.activeInHierarchy).map(c=>({uid:c.userInfo?.uid,score:c.getWinScoreLab()?.string}))});},30);return true;})()`);
  if(play){
    await evaluate(`cc.app.gameRoom.model.sitDownRequest(0);true`);await delay(500);
    const seat=await evaluate(`cc.app.gameRoom.getMyMemberInfo()`);assert.ok(seat);assert.equal(seat.point,0);
    await evaluate(`__require('SocketMgr').default.instance.send(5001,{carryIn:${state.conf.bj21Params.carryMin/100*20}});true`);
  }
  let last,submitted=0,played=new Set(),winnerShot=false;
  for(let i=0;i<360;i++){
    last=await evaluate(`(()=>{const g=cc.app.gameRoom,p=cc.director.getScene().getComponentInChildren('BjkBetAction');return {phase:g.__currentState,inning:g._conf.currentInning,deal:g.currentDealCardList,me:g.getMyMemberInfo(),state:g.model.__bj21State,settle:g.model.__bj21Settle,results:__bjEvents.filter(x=>x.event===4551).length,settlementInnings:__bjEvents.filter(x=>x.event===4551).map(x=>(x.data?.data||x.data).currentInning),buttons:p?Object.fromEntries(Object.entries(p._btnMap).map(([k,v])=>[k,v.activeInHierarchy])):{}};})()`);
    if(play){
      const b=last.buttons,handler=b.minBet?'onMinBetClick':b.bumai?'onInsuranceSkipClick':b.fp?'onSplitClick':b.sbxz?'onDoubleClick':b.yp?'onHitClick':b.tp?'onStandClick':null;
      if(handler){await evaluate(`cc.director.getScene().getComponentInChildren('BjkBetAction').${handler}();true`);submitted++;played.add(last.inning);}
    }
    if(i%30===0)console.log('PROGRESS',JSON.stringify({phase:last.phase,inning:last.inning,me:last.me?.point,results:last.results,buttons:last.buttons}));
    if(!winnerShot&&await evaluate(`cc.director.getScene().getComponentInChildren('BjkPlayerPanel').players.some(p=>p.getWinNd()?.activeInHierarchy)`)){
      const shot=await send('Page.captureScreenshot');
      fs.writeFileSync(`test/browser/blackjack-winner-${tier}.png`,Buffer.from(shot.result.data,'base64'));winnerShot=true;
    }
    const animations=log.filter(m=>m.method==='Runtime.consoleAPICalled'
      &&m.params.args.some(a=>a.value==='[BJK_SETTLE] finish'))
      .filter(m=>{const args=m.params.args;return last.settlementInnings.includes(args[args.findIndex(a=>a.value==='inning=')+1]?.value);}).length;
    const cleaned=await evaluate(`(()=>{const data=__bjEvents.filter(x=>x.event===4550).map(x=>x.data?.data||x.data),settled=new Set(__bjEvents.filter(x=>x.event===4551).map(x=>(x.data?.data||x.data).currentInning));return data.filter(s=>s.gameState===9&&settled.has(s.currentInning)&&data.some(n=>n.gameState===2&&n.currentInning===s.currentInning+1)).length;})()`);
    if(last.results>=2&&animations>=2&&cleaned>=2&&(!play||played.size>=1))break;
    await delay(600);
  }
  console.log('STATE',JSON.stringify({phase:last.phase,inning:last.inning,results:last.results,
    settled:last.settle?.settleList.map(p=>({uid:p.uid,score:p.score,point:p.point}))}));assert.ok(last.results>=2,'two complete blackjack hands');
  assert.ok(last.settle.settleList.length>=1);if(play)assert.ok(submitted>=1,'native betting or play button submitted');
  assert.ok(log.filter(m=>m.method==='Runtime.consoleAPICalled'
    &&m.params.args.some(a=>a.value==='[BJK_SETTLE] finish')).length>=2,'native settlement animation finished twice');
  const visible=await evaluate(`__bjVisible`);
  const chipFrames=visible.filter(s=>s.anim&&s.chips.length),winFrames=visible.filter(s=>s.wins.length);
  console.log('VISIBLE_SETTLEMENT',JSON.stringify({chipFrames:chipFrames.length,winFrames:winFrames.length,wins:winFrames[0]?.wins}));
  assert.ok(chipFrames.length,'settlement chips are visible in the original scene');
  assert.ok(new Set(chipFrames.flatMap(s=>s.chips.map(c=>`${c.x},${c.y}`))).size>1,'settlement chips move on screen');
  const settlements=await evaluate(`__bjEvents.filter(x=>x.event===4551).map(x=>x.data?.data||x.data)`);
  const finishedInnings=new Set(log.filter(m=>m.method==='Runtime.consoleAPICalled'&&m.params.args.some(a=>a.value==='[BJK_SETTLE] finish'))
    .map(m=>{const args=m.params.args;return args[args.findIndex(a=>a.value==='inning=')+1]?.value;}));
  fs.writeFileSync(`test/browser/blackjack-settlement-${tier}.json`,JSON.stringify({visible,settlements,finishedInnings:[...finishedInnings],logs:log.filter(m=>m.method==='Runtime.consoleAPICalled'&&m.params.args.some(a=>typeof a.value==='string'&&a.value.includes('BJK_SETTLE')))}));
  assert.ok(finishedInnings.size>=2,'two innings have completed native settlement playback');
  const finishedSettlements=settlements.filter(s=>finishedInnings.has(s.currentInning));
  assert.ok(finishedSettlements.length>=2,'captured settlement payloads match completed innings');
  // Watch the interval the old test missed: collected settlement cards must
  // stay absent through END and the next betting phase until a real deal.
  const desk=await evaluate(`__bjDesk`);
  const events=await evaluate(`__bjEvents.filter(x=>x.event===4550||x.event===4551||x.event===3436).map(x=>({event:x.event,at:x.at,state:x.data?.data||x.data}))`);
  const terminal=events.filter(x=>x.event===4550&&x.state.gameState===9);
  const roundTiming=[];let cleanupCycles=0;
  for(const end of terminal.filter(e=>finishedInnings.has(e.state.currentInning))){
    const s=end.state;
    assert.deepEqual(s.players,[]);assert.deepEqual(s.dealerCards,[]);assert.deepEqual(s.actionList,[]);
    assert.equal(s.stateDeadline,0);assert.equal(s.dealerPointValue,0);assert.ok(!('settleList' in s));
    const nextBet=desk.find(f=>f.inning===s.currentInning+1&&f.phase===2);
    if(!nextBet)continue;
    const settled=events.find(e=>e.event===4551&&e.state.currentInning===s.currentInning);
    const next=events.find(e=>e.event===4550&&e.state.gameState===2&&e.state.currentInning===s.currentInning+1);
    assert.ok(settled&&next,'captured settlement and next betting timestamps');
    const intervalMs=next.at-settled.at;
    const postRoundStandUp=events.some(e=>e.event===3436&&e.at>=end.at&&e.at<=next.at);
    // Admission cash-outs must finish before a new hand. Their async completion
    // can legitimately defer this transition by one additional server tick.
    assert.ok(intervalMs>=4900&&intervalMs<=(postRoundStandUp?6800:5800),`inning ${s.currentInning}: next round starts after five seconds plus required cash-outs, got ${intervalMs}ms`);
    const finished=log.find(m=>m.method==='Runtime.consoleAPICalled'&&m.params.args.some(a=>a.value==='[BJK_SETTLE] finish')
      &&m.params.args[m.params.args.findIndex(a=>a.value==='inning=')+1]?.value===s.currentInning);
    assert.ok(finished.params.timestamp<next.at,'native settlement animation completes before the next round');
    roundTiming.push({inning:s.currentInning,intervalMs,postRoundStandUp,animationMs:Math.round(finished.params.timestamp-settled.at)});
    const frames=desk.filter(f=>f.at<=nextBet.at+1000&&((f.inning===s.currentInning&&[8,9].includes(f.phase))||(f.inning===s.currentInning+1&&f.phase===2)));
    const empty=f=>f.players.every(n=>n===0)&&f.dealer===0;
    const firstClear=frames.findIndex(empty);assert.ok(firstClear>=0,'completed desk is cleared');
    assert.ok(frames.some(f=>f.phase===9||f.phase===2),'cleanup reaches an empty next betting desk');
    assert.ok(frames.slice(firstClear).every(empty),`inning ${s.currentInning}: collected cards never return before the next deal`);
    cleanupCycles++;
  }
  assert.ok(cleanupCycles>=2,'two cleanup-to-next-bet transitions checked on screen');
  console.log('VISIBLE_CLEANUP',JSON.stringify({cleanupCycles,frames:desk.length,roundTiming}));
  fs.writeFileSync(`test/browser/blackjack-cleanup-${tier}.json`,JSON.stringify({desk,terminal,cleanupCycles,roundTiming}));
  for(const result of finishedSettlements){
    for(const row of result.settleList.filter(p=>p.score>0)){
      assert.ok(winFrames.some(s=>s.inning===result.currentInning&&s.wins.some(w=>w.uid===row.uid&&/^\+/.test(w.score))),
        `inning ${result.currentInning}: positive profit is displayed for winner ${row.uid}`);
    }
  }
  const shot=await send('Page.captureScreenshot');fs.writeFileSync(`test/browser/blackjack-${tier}.png`,Buffer.from(shot.result.data,'base64'));
  await evaluate(`(()=>{const b=cc.director.getScene().getComponentsInChildren(cc.Button).find(b=>b.node.activeInHierarchy&&b.clickEvents.some(e=>/history/i.test(e.handler)));if(!b)throw new Error('history button missing');cc.Component.EventHandler.emitEvents(b.clickEvents,{target:b.node});return true;})()`);
  let history;
  for(let i=0;i<30;i++){
    history=await evaluate(`(()=>{const p=cc.director.getScene().getComponentInChildren('HistoryPanel');if(!p?.historyModel?.isDataReceived)return null;return {data:p.historyModel.gameBackMsgData,page:p.historyModel.getCurrentPageNum(),title:p.curPageTitle.string,loading:p.loading.active,items:p.historyContentScript.node.getComponentsInChildren('BjkHistoryItem').length};})()`);
    if(history?.items)break;await delay(300);
  }
  console.log('HISTORY',JSON.stringify({page:history?.page,title:history?.title,items:history?.items}));assert.ok(history?.items>=2);assert.equal(history.loading,false);
  for(const p of history.data.gameBackInfo.inningInfo[0]){assert.ok(p.icon);assert.ok(p.handResults[0].handCards.length>=2);}
  const lastPage=history.page;
  await evaluate(`cc.director.getScene().getComponentInChildren('HistoryPanel').onPrePageClick();true`);await delay(800);
  assert.equal(await evaluate(`cc.director.getScene().getComponentInChildren('HistoryPanel').historyModel.getCurrentPageNum()`),lastPage-1);
  await evaluate(`cc.director.getScene().getComponentInChildren('HistoryPanel').onNextPageClick();true`);await delay(800);
  assert.equal(await evaluate(`cc.director.getScene().getComponentInChildren('HistoryPanel').historyModel.getCurrentPageNum()`),lastPage);
  const errors=log.filter(m=>m.method==='Runtime.exceptionThrown');console.log('ERRORS',JSON.stringify(errors));assert.equal(errors.length,0);
  assert.deepEqual(await evaluate(`cc.director.getScene().getComponentsInChildren(cc.Label).filter(c=>c.node.activeInHierarchy&&/undefined|NaN/.test(c.string)).map(c=>c.string)`),[]);
  await leave();leave=null;await delay(1200);
  assert.equal(await evalRoot(`(()=>{const f=document.querySelector('[class*="gameIframe"]');return !f||getComputedStyle(f).visibility!=='visible';})()`),true,'exit reveals hall');
}catch(error){fs.writeFileSync(`test/browser/blackjack-failure-${tier}.json`,JSON.stringify(log));throw error;}
finally{if(leave)await leave().catch(()=>{});ws?.close();browser.kill();}


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
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'gogame-niuniu-'));
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
  const uid=88000400+tier;
  await send('Page.navigate',{url:`http://lobby.localhost:11042/21/0?userId=${uid}&userToken=dev-${uid}&openId=${uid}&v=2.0.1279`});
  await delay(13000);
  await evalRoot(`Array.from(document.querySelectorAll('span,p,div,a')).find(e=>e.textContent==='牛牛'&&e.children.length===0)?.click()`);
  await delay(2500);
  console.log('ROOMS',await evalRoot(`Array.from(document.querySelectorAll('[class*="roomList"] li')).map(e=>e.innerText)`));
  assert.equal(await evalRoot(`(()=>{const list=document.querySelectorAll('[class*="roomList"] li');if(list.length!==14)return list.length;list[${tier}].click();return true;})()`),true);
  await delay(18000);
  let session;
  for(const candidate of sessions){const r=await send('Runtime.evaluate',{expression:'window.cc&&cc.director.getScene()?.name',returnByValue:true},candidate);if(r.result?.result?.value==='Qznn')session=candidate;}
  assert.ok(session,'original client reached Qznn');
  const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},session);assert.ok(!r.result?.exceptionDetails,JSON.stringify(r.result?.exceptionDetails));return r.result?.result?.value;};
  const details=await evaluate(`(()=>{const d=__require('Qznn_DataNotify').default.Instance;return {config:d.GetGamePlayConfig(),data:d.GameData};})()`);
  console.log('ENTER',JSON.stringify(details));
  assert.equal(details.config.playerCount,7);
  assert.ok(!details.data.memberDeskInfos.some(p=>p.uid===uid),'entry stays observing');
  leave=()=>evaluate(`__require('SocketMgr').default.instance.send(2110);true`);
  if(audit){
    await evaluate(`(()=>{window.__nnAudit=[];window.__nnNodes=new Map();window.__nnAuditTimer=setInterval(()=>{const d=__require('Qznn_DataNotify').default.Instance,components=cc.director.getScene().getComponentsInChildren(cc.Component),dealer=components.find(c=>'mFlyCardsCount' in c);if(!dealer)return;const g=cc.app.gameRoom;const now=Date.now(),nodes=dealer.node.children.filter(n=>n.activeInHierarchy&&n.name===dealer.mCardTemplate?.name);for(const n of nodes)if(!__nnNodes.has(n.uuid))__nnNodes.set(n.uuid,now);__nnAudit.push({time:now,phase:d.Data_Qznn_Phase.mData,inning:d.GameData.currentInning,fly:dealer.mFlyCardsCount,nodes:nodes.map(n=>({id:n.uuid,name:n.name,age:now-__nnNodes.get(n.uuid),x:n.x,y:n.y,scale:n.scale,width:n.width,height:n.height})),members:d.GameData.memberDeskInfos.map(m=>({uid:m.uid,pos:m.pos,point:m.point})),settle:d.Data_SettleEnd.mData,laizi:{active:g.mAni_lai.node.activeInHierarchy,frame:g.mCard_lai.spriteFrame?.name,value:d.Data_Qznn_Laizi.mData},fronts:cc.director.getScene().getComponentsInChildren('BasePoker').filter(c=>c.mRoot?.opacity>0&&c.mFront?.node.activeInHierarchy).map(c=>({card:c.mPokerData,frame:c.mFront.spriteFrame?.name}))});},100);return true;})()`);
  }
  if(observe){
    await evaluate(`(()=>{window.__observerDeals=[];const n=__require('NotificationCenter').default,emit=n.emit;n.emit=function(event,data,...args){if(event==='blockchain:fapaiNew'){const d=__require('Qznn_DataNotify').default.Instance,c=data._pokerCtrl,m=d.GetSitDownPlayerBySeatNum(c.mSeatNum),b=cc.Canvas.instance.getComponentInChildren('Qznn_SeatLayer').FindBottomSeat();__observerDeals.push({inning:d.GameData.currentInning,uid:m?.uid,pos:c.mSeatNum,bottom:d.GetSitDownPlayerBySeatNum(b.mSeatNum)?.uid,playing:d.PlayerPlaying(m?.uid),x:data._toWorldPos.x,y:data._toWorldPos.y,privateCards:m?.niuInfo.cardList.length});}return emit.call(this,event,data,...args);};return true;})()`);
    let deals=[];
    const layouts=new Set();
    for(let i=0;i<160;i++){
      deals=await evaluate('window.__observerDeals');
      if(audit&&deals.length){
        const layout=await evaluate(`(()=>{const d=__require('Qznn_DataNotify').default.Instance;if(!d.Data_DealAllFinish.mData||!['CONFIRM_BANKER','XIAN_RAISE'].includes(d.Data_Qznn_Phase.mData))return null;const path=n=>n.parent?path(n.parent)+'/'+n.name:n.name;return {inning:d.GameData.currentInning,phase:d.Data_Qznn_Phase.mData,members:d.GameData.memberDeskInfos,sprites:cc.director.getScene().getComponentsInChildren(cc.Sprite).filter(c=>c.node.activeInHierarchy&&c.node.opacity).map(c=>({path:path(c.node),frame:c.spriteFrame?.name,rect:c.node.getBoundingBoxToWorld(),scale:c.node.scale,parents:(()=>{const a=[];for(let n=c.node;n;n=n.parent)a.push({name:n.name,x:n.x,y:n.y,sx:n.scaleX,sy:n.scaleY,opacity:n.opacity});return a;})()}))};})()`);
        if(layout&&!layouts.has(layout.inning)){
          layouts.add(layout.inning);
          fs.writeFileSync(`test/browser/niuniu-layout-${tier}-${layout.inning}.json`,JSON.stringify(layout));
          const shot=await send('Page.captureScreenshot');
          fs.writeFileSync(`test/browser/niuniu-layout-${tier}-${layout.inning}.png`,Buffer.from(shot.result.data,'base64'));
        }
      }
      if(new Set(deals.map(d=>d.inning)).size>=2)break;
      await delay(600);
    }
    assert.ok(new Set(deals.map(d=>d.inning)).size>=2,'observer sees two new deals');
    assert.ok(deals.every(d=>d.uid&&d.bottom&&d.playing&&Number.isFinite(d.x)&&Number.isFinite(d.y)),'all animation targets and bottom seats have actual players');
    assert.ok(deals.every(d=>d.privateCards===0),'spectator receives no private cards');
    assert.equal(await evaluate(`!!__require('Qznn_DataNotify').default.Instance.GetSitDownPlayerByUid(${uid})`),false);
    console.log('OBSERVER_DEALS',JSON.stringify({hands:[...new Set(deals.map(d=>d.inning))],cards:deals.length,bottoms:[...new Set(deals.map(d=>d.bottom))]}));
  }
  if(play){
    await evaluate(`(()=>{window.__nnResults=[];window.__nnBet=false;window.__nnGrab=false;const d=__require('Qznn_DataNotify').default.Instance;const orig=d.SetSettlement;d.SetSettlement=function(v){if(v.some(p=>p.uid===${uid}))__nnResults.push(v);return orig.call(this,v)};__require('Qznn_NetWork').Qznn_NetWork.Instance.SitDown(0);return true;})()`);
    await delay(500);
    await evaluate(`__require('Qznn_NetWork').Qznn_NetWork.Instance.CarryIn(${details.config.carryMin*5});true`);
    const start=Date.now();let state;
    while(Date.now()-start<120000){
      state=await evaluate(`(()=>{const d=__require('Qznn_DataNotify').default.Instance,net=__require('Qznn_NetWork').Qznn_NetWork.Instance,me=d.GetSitDownPlayerByUid(${uid}),phase=d.Data_Qznn_Phase.mData;
        if(me&&d.PlayerPlaying(${uid})){if(['DEAL_PERFLOP','GRAB_BANKER'].includes(phase)&&me.grabBankerPoint<0){const c=cc.Canvas.instance.getComponentInChildren('Qznn_CallDealerBtns');if(c&&c.node.activeInHierarchy){window.__nnGrab=true;net.GrabBanker(0);}}if(phase==='XIAN_RAISE'&&!me.banker&&!d.GetRaisePoint()&&me.bettingMultiples.length){const c=cc.Canvas.instance.getComponentInChildren('Qznn_BetBtns');if(c&&c.node.activeInHierarchy){window.__nnBet=true;c.OnBet(me.bettingMultiples[0]);}}if(phase==='RUBBING_CARDS')net.SendShowCard();}
        return {phase,me,results:__nnResults.length,grab:window.__nnGrab,bet:window.__nnBet};})()`);
      if(state.results>=2&&state.bet&&state.phase==='SETTLE')break;await delay(700);
    }
    console.log('PLAY',JSON.stringify(state));assert.ok(state.results>0,'client received and rendered settlement');
    assert.equal(state.bet,true,'native betting buttons are visible and functional');
    assert.ok(state.results>=2,'two completed hands allow previous/next validation');
    await evaluate(`cc.Canvas.instance.getComponentInChildren('Qznn_TopMenu').mHistoryBtn.OnClick();true`);
    let history;
    for(let i=0;i<30;i++){
      history=await evaluate(`(()=>{const p=cc.director.getScene().getComponentInChildren('HistoryPanel');if(!p?.historyModel?.isDataReceived)return null;return {data:p.historyModel.gameBackMsgData,page:p.historyModel.getCurrentPageNum(),title:p.curPageTitle.string,loading:p.loading.active,items:p.historyContentScript.node.getComponentsInChildren('QznnHistoryItem').length};})()`);
      if(history?.data&&history.items)break;await delay(300);
    }
    console.log('HISTORY',JSON.stringify(history));assert.ok(history?.data.dataInfo.firstGameList.length>=2);
    assert.ok(history.items>0,'original history panel rendered player rows');
    assert.equal(history.loading,false);
    for(const row of history.data.dataInfo.firstGameList){
      assert.ok(row.userName&&row.userName!=='undefined');assert.ok(row.userIcon);
      assert.equal(row.cardTypePokers.length,5);
      assert.equal(row.handCardListWithLaiZi.length,details.config.playMode===7?5:0);
    }
    const lastPage=history.page;
    await evaluate(`cc.director.getScene().getComponentInChildren('HistoryPanel').onPrePageClick();true`);
    await delay(1000);
    const prev=await evaluate(`(()=>{const p=cc.director.getScene().getComponentInChildren('HistoryPanel');return {page:p.historyModel.getCurrentPageNum(),rows:p.historyModel.gameBackMsgData.dataInfo.firstGameList.length,title:p.curPageTitle.string};})()`);
    assert.equal(prev.page,lastPage-1);assert.ok(prev.rows>=2);assert.ok(prev.title.startsWith(prev.page+'/'));
    await evaluate(`cc.director.getScene().getComponentInChildren('HistoryPanel').onNextPageClick();true`);
    await delay(700);
    assert.equal(await evaluate(`cc.director.getScene().getComponentInChildren('HistoryPanel').historyModel.getCurrentPageNum()`),lastPage);
    console.log('PAGES',JSON.stringify({previous:prev.page,next:lastPage}));
  }
  const badNames=await evaluate(`cc.director.getScene().getComponentsInChildren(cc.Label).filter(c=>c.node.activeInHierarchy&&/undefined|NaN/.test(c.string)).map(c=>({path:c.node.name,text:c.string}))`);
  if(audit){
    const timeline=await evaluate('clearInterval(__nnAuditTimer);__nnAudit');
    fs.writeFileSync(`test/browser/niuniu-audit-${tier}.json`,JSON.stringify({timeline,log}));
    console.log('ANIMATION_AUDIT',JSON.stringify({samples:timeline.length,maxFly:Math.max(...timeline.map(t=>t.fly)),oldNodes:timeline.filter(t=>t.nodes.some(n=>n.age>2000)).slice(0,3)}));
    assert.ok(timeline.length>0,'dealer animation audit collected frames');
    assert.ok(timeline.some(t=>t.fly>0&&t.nodes.length>0),'audit observed actual flying card nodes');
    assert.ok(timeline.every(t=>t.nodes.every(n=>Number.isFinite(n.x)&&Number.isFinite(n.y)&&n.age<2000)),'flying cards finish within two seconds');
    assert.ok(timeline.every(t=>!t.laizi.active||t.laizi.frame),'wildcard indicator always resolves an original sprite');
    assert.ok(timeline.every(t=>t.fronts.every(c=>c.frame)),'every visible hand card resolves an original sprite');
  }
  assert.deepEqual(badNames,[],'visible labels do not show undefined or NaN');
  const shot=await send('Page.captureScreenshot');fs.writeFileSync(`test/browser/niuniu-${tier}.png`,Buffer.from(shot.result.data,'base64'));
  const errors=log.filter(m=>m.method==='Runtime.exceptionThrown');console.log('ERRORS',JSON.stringify(errors));assert.equal(errors.length,0);
  await leave();leave=null;await delay(1200);
  assert.equal(await evalRoot(`(()=>{const f=document.querySelector('[class*="gameIframe"]');return !f||getComputedStyle(f).visibility!=='visible';})()`),true,'exit reveals hall');
}catch(error){fs.writeFileSync(`test/browser/niuniu-failure-${tier}.json`,JSON.stringify(log));throw error;}
finally{if(leave)await leave().catch(()=>{});ws?.close();browser.kill();}

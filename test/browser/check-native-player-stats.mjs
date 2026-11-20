// Native Cocos rendering checks. Display fixtures stay inside this temporary
// browser; they never create game records, modify balances or write storage.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

const directory=fs.mkdtempSync(path.join(os.tmpdir(),'gogame-native-stats-'));
const browser=spawn(process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',[
  '--headless=new','--no-sandbox','--disable-gpu','--disable-extensions','--no-first-run',
  '--remote-debugging-port=0','--user-data-dir='+directory,'--window-size=1280,900','about:blank',
],{windowsHide:true,stdio:'ignore'});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const pending=new Map(),targets=[],errors=[];let socket,serial=0;
try{
  let port;for(let i=0;i<100&&!port;i++){try{port=fs.readFileSync(path.join(directory,'DevToolsActivePort'),'utf8').split('\n')[0];}catch{}if(!port)await pause(100);}
  assert.ok(port,'Chrome debug port');
  const page=(await(await fetch('http://127.0.0.1:'+port+'/json/list')).json()).find(item=>item.type==='page');
  socket=new WebSocket(page.webSocketDebuggerUrl.replace('localhost','127.0.0.1'));
  await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
  const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{
    const id=++serial,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout '+method));},15000);
    pending.set(id,result=>{clearTimeout(timer);result.error?reject(Error(JSON.stringify(result.error))):resolve(result.result);});
    socket.send(JSON.stringify({id,method,params,sessionId}));
  });
  socket.on('message',raw=>{
    const event=JSON.parse(raw);
    if(event.id){pending.get(event.id)?.(event);pending.delete(event.id);}
    else if(event.method==='Target.attachedToTarget'){
      targets.push(event.params.sessionId);void send('Runtime.enable',{},event.params.sessionId).catch(()=>{});
    }else if(event.method==='Runtime.exceptionThrown')errors.push(event.params.exceptionDetails);
  });
  const evaluate=async(expression,sessionId)=>{
    const result=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},sessionId);
    assert.ok(!result.exceptionDetails,JSON.stringify(result.exceptionDetails));return result.result?.value;
  };
  await send('Page.enable');await send('Runtime.enable');await send('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:false,flatten:true});
  const uid=88123380;
  await send('Page.navigate',{url:'http://lobby.localhost:11042/21/0?userId='+uid+'&userToken=dev-'+uid+'&openId='+uid+'&v=2.0.1279'});
  for(let i=0;i<80;i++){
    if(await evaluate("(()=>{const item=document.querySelector('[class*=roomList] li');item?.click();return !!item;})()"))break;
    await pause(250);
  }
  let target;
  for(let i=0;i<120&&!target;i++){
    for(const session of targets)if(await evaluate("window.cc&&cc.director.getScene()?.name",session).catch(()=>null)==='gameZjh')target=session;
    if(!target)await pause(400);
  }
  assert.ok(target,'native Zjh scene');
  const panelExpression="(()=>{const roots=[cc.director.getScene(),...Object.values(cc.game._persistRootNodes)];return roots.flatMap(n=>n.getComponentsInChildren(cc.Component)).find(c=>cc.js.getClassName(c)==='chatPanel'&&c.node.activeInHierarchy);})()";
  for(let i=0;i<80;i++){
    const opened=await evaluate("(()=>{const c=cc.director.getScene().getComponentsInChildren(cc.Component).find(c=>c._seatUserData?.uid>=90000000&&typeof c.onEmojiClick==='function');if(c){c.lastClickTime=0;c.onEmojiClick();}return !!c;})()",target);
    if(opened)break;await pause(250);
  }
  for(let i=0;i<80&&!await evaluate('!!'+panelExpression,target);i++)await pause(100);
  assert.ok(await evaluate('!!'+panelExpression,target),'native avatar panel');
  await evaluate("(()=>{const p="+panelExpression+";window.__statsTest={panel:p,data:p.data,roomType:cc.app.gameRoom._conf.roomType};return true;})()",target);
  const fixture={totalHands:4,winPercent:25,joinPercent:50,flipManualBetPercent:25,tableJoinPercent:100,isRobot:false,
    betOpportunityHands:4,manualBetHands:2,manualBetPercent:50,aboveMinimumBetHands:1,aboveMinimumBetPercent:25,
    manualGrabHands:3,manualGrabPercent:75,positiveGrabHands:1,positiveGrabPercent:25,
    doubleHands:1,doublePercent:25,splitHands:2,splitPercent:50,insuranceBuyHands:0,insuranceBuyPercent:0,
    clientArrangementHands:3,clientArrangementPercent:75,serverArrangementHands:1,serverArrangementPercent:25,extendedArrangementHands:1,extendedArrangementPercent:25,
    clientDiscardHands:3,clientDiscardPercent:75,serverDiscardHands:4,serverDiscardPercent:100};
  const reports=[];
  for(const [type,count,last]of [[24,6,'25%'],[25,5,'100%'],[26,4,'100%'],[27,5,'25%'],[28,4,'100%'],[30,4,'100%'],[31,6,'0%'],[32,4,'25%']]){
    await evaluate("(()=>{const t=window.__statsTest;cc.app.gameRoom._conf.roomType="+type+";t.panel.data=Object.assign({},t.data,"+JSON.stringify(fixture)+");t.panel.onMenu0Event(t.panel.menu_toggle_0.getComponentInChildren(cc.ToggleContainer).toggleItems[0]);return true;})()",target);
    await pause(80);
    const report=await evaluate("(()=>{const p=window.__statsTest.panel,v=p.__gogameNativeStats;if(!v)return null;return {type:"+type+",rows:v.items.filter(n=>n.active).map(n=>({title:n.getChildByName('title').getComponent(cc.Label).string,value:n.getChildByName('value').getComponent(cc.Label).string})),visible:v.root.activeInHierarchy,tabVisible:p.menu_toggle_0.getComponentInChildren(cc.ToggleContainer).toggleItems[0].node.activeInHierarchy,original:v.original.active,more:v.hint.active,scrollMax:v.scroll.getMaxScrollOffset().y};})()",target);
    assert.ok(report,'new native stat renderer is served');assert.equal(report.rows.length,count);assert.equal(report.original,false);assert.equal(report.visible,true);assert.equal(report.tabVisible,true);
    assert.equal(report.rows[0].value,'4');assert.equal(report.rows[1].value,'25%');assert.equal(report.rows.at(-1).value,last);
    assert.ok(report.rows.every(row=>row.title&&!row.title.includes('undefined')&&!row.value.includes('NaN')));
    if(count>4){
      assert.ok(report.scrollMax>0);await evaluate('window.__statsTest.panel.__gogameNativeStats.scroll.scrollToBottom(0);true',target);await pause(80);
      const offset=await evaluate('window.__statsTest.panel.__gogameNativeStats.scroll.getScrollOffset().y',target);assert.ok(Math.abs(offset-report.scrollMax)<1,'last row is reachable');
      await evaluate('window.__statsTest.panel.initView0();true',target);await pause(40);
      assert.ok(Math.abs((await evaluate('window.__statsTest.panel.__gogameNativeStats.scroll.getScrollOffset().y',target))-offset)<1,'a profile refresh preserves the scroll position');
    }
    reports.push(report);
    if(type===24||type===27){
      const shot=await send('Page.captureScreenshot');fs.writeFileSync('cache/native-player-stats-'+type+'.png',Buffer.from(shot.data,'base64'));
    }
  }
  await evaluate("(()=>{const t=window.__statsTest;cc.app.gameRoom._conf.roomType=27;t.panel.data={playerId:t.data.playerId};t.panel.initView0();return true;})()",target);await pause(80);
  const unknown=await evaluate("window.__statsTest.panel.__gogameNativeStats.items.filter(n=>n.active).map(n=>n.getChildByName('value').getComponent(cc.Label).string)",target);assert.ok(unknown.every(value=>value==='--'));
  await evaluate("(()=>{const t=window.__statsTest;cc.app.gameRoom._conf.roomType=19;t.panel.data=t.data;t.panel.initView0();return true;})()",target);
  assert.deepEqual(await evaluate("(()=>{const v=window.__statsTest.panel.__gogameNativeStats;return {overlay:v.root.active,original:v.original.active};})()",target),{overlay:false,original:true});
  await evaluate("(()=>{const t=window.__statsTest;cc.app.gameRoom._conf.roomType=t.roomType;t.panel.data=t.data;t.panel.initView0();t.panel.initView1();t.panel.hide();delete window.__statsTest;return true;})()",target);
  assert.equal(errors.length,0,'no uncaught native script errors');
  const result={reports,unknown,restoredHoldem:true,scriptErrors:errors.length};fs.writeFileSync('cache/native-player-stats-browser.json',JSON.stringify(result,null,2));console.log('PASS_NATIVE_PLAYER_STATS',JSON.stringify(result));
}finally{socket?.close();browser.kill();}

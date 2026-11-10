// Reproduce the supplied log: use the native menu to return to the hall,
// then enter Qznn and enter hzxl twice in the same iframe.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import {decodeFrame} from '../../game-server/src/codec.js';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'gogame-room-ui-'));
const browser=spawn(process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',[
  '--headless=new','--no-sandbox','--disable-gpu','--disable-extensions','--no-first-run',
  '--remote-debugging-port=0','--user-data-dir='+profile,'--window-size=1280,900','about:blank',
],{windowsHide:true,stdio:'ignore'});
const sessions=[],errors=[],diagnostics=[],frames=[],pending=new Map();
let socket,sequence=0,activeRoom=false;
try{
  let port;
  for(let i=0;i<100;i++){try{port=fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0];break;}catch{}await delay(100);}
  const page=(await(await fetch('http://127.0.0.1:'+port+'/json/list')).json()).find(p=>p.type==='page');
  socket=new WebSocket(page.webSocketDebuggerUrl.replace('localhost','127.0.0.1'));
  await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
  const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{
    const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP '+method));},15000);
    pending.set(id,m=>{clearTimeout(timer);m.error?reject(Error(JSON.stringify(m.error))):resolve(m.result);});
    socket.send(JSON.stringify({id,method,params,sessionId}));
  });
  socket.on('message',raw=>{
    const m=JSON.parse(raw);
    if(m.id){pending.get(m.id)?.(m);pending.delete(m.id);}
    else if(m.method==='Target.attachedToTarget'){
      sessions.push(m.params.sessionId);void send('Runtime.enable',{},m.params.sessionId).catch(()=>{});
      void send('Network.enable',{},m.params.sessionId).catch(()=>{});
    }else if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails);
    else if(m.method==='Runtime.consoleAPICalled'){
      const text=m.params.args.map(a=>a.value??a.description??'').join(' ');
      if(m.params.type==='error'&&/TypeError:|ReferenceError:|SyntaxError:/.test(text))errors.push({text});
      if(m.params.type==='error')diagnostics.push(text.slice(0,800));
      if(process.argv.includes('--trace-exit')&&text.includes('[GOGAME-')){diagnostics.push(text.slice(0,800));if(diagnostics.length>100)diagnostics.shift();}
      if(/onclose|reconnect|socket_reconn|close\.\.\./i.test(text)){diagnostics.push(text.slice(0,800));if(diagnostics.length>100)diagnostics.shift();}
    }else if(m.method==='Network.webSocketFrameReceived'||m.method==='Network.webSocketFrameSent'){
      try{const f=decodeFrame(Buffer.from(m.params.response.payloadData,'base64'));if([1105,1203,2201,2206,3260,6124,6225,9999].includes(f?.msgid))frames.push({direction:m.method.endsWith('Sent')?'sent':'received',id:f.msgid,activeRoom,reason:f.payload?.reason,auxiliary:f.payload?.auxiliary,roomId:f.payload?.roomId,roomType:f.payload?.roomType,confRoomType:f.payload?.conf?.roomType});}catch{}
    }
  });
  const ev=async(expression,sessionId)=>{
    const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},sessionId);
    assert.ok(!r.exceptionDetails,JSON.stringify(r.exceptionDetails));return r.result?.value;
  };
  const until=async(check,description)=>{
    for(let i=0;i<100;i++){if(await check())return;await delay(300);}
    assert.fail('timeout '+description);
  };
  const click=async label=>{
    assert.ok(await ev("(()=>{const e=Array.from(document.querySelectorAll('*')).filter(e=>e.textContent.trim()==="+JSON.stringify(label)+").sort((a,b)=>a.querySelectorAll('*').length-b.querySelectorAll('*').length)[0];e?.click();return !!e;})()"),'hall tab '+label);
    await delay(700);
  };
  await send('Page.enable');await send('Runtime.enable');
  await send('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:false,flatten:true});
  const uid=Number(process.env.GOGAME_BROWSER_UID)||88749931;
  await send('Page.navigate',{url:'http://lobby.localhost:11042/21/0?userId='+uid+'&userToken=dev-'+uid+'&openId='+uid+'&v=2.0.1279'});
  await delay(8000);
  const allSeatMenus=process.argv.includes('--all-seat-menus');
  const cases=allSeatMenus?[[['牛牛'],'Qznn'],[['二十一点'],'bjk'],[['十三水'],'sss'],[['三公暗一'],'gameSgay'],
    [['麻将','极速麻将'],'gameJsmj'],[['麻将','长沙麻将'],'csmj'],[['麻将','红中血流'],'hzxl']]
    :[[['炸金花'],'gameZjh'],[['牛牛'],'Qznn'],[['麻将','红中血流'],'hzxl'],[['麻将','红中血流'],'hzxl']];
  let caseNumber=0;
  for(const [tabs,scene]of cases){
    if(allSeatMenus&&caseNumber>0){
      const isolatedUid=uid+caseNumber;
      await send('Page.navigate',{url:'http://lobby.localhost:11042/21/0?userId='+isolatedUid+'&userToken=dev-'+isolatedUid+'&openId='+isolatedUid+'&v=2.0.1279'});
      await delay(8000);
    }
    caseNumber++;
    for(const tab of tabs)await click(tab);
    console.log('HALL_ROOM_CARDS',JSON.stringify(await ev("Array.from(document.querySelectorAll('[class*=roomList] li')).map(e=>e.innerText).slice(0,2)")));
    assert.ok(await ev("(()=>{const list=Array.from(document.querySelectorAll('[class*=roomList] li')),e="+(scene==='bjk'?"list.find(n=>n.innerText.includes('/'))":"list[0]")+";e?.click();return !!e;})()"),'native room card');
    let session;
    try{
      await until(async()=>{
        for(const candidate of sessions)if(await ev("!!(window.cc&&cc.director.getScene()?.name==="+JSON.stringify(scene)+"&&cc.app?.gameRoom?.getRoomInfo?.())",candidate).catch(()=>false)){session=candidate;return true;}
      },scene+' room ready');
    }catch(error){
      console.log('FRAME_STATE',JSON.stringify(await Promise.all(sessions.map(candidate=>ev("(()=>{if(!window.cc)return {};const r=cc.app?.gameRoom;return {scene:cc.director.getScene()?.name,type:r?._conf?.roomType,roomId:r?._conf?.roomId,info:!!r?.getRoomInfo?.(),modelInfo:!!r?.viewModel?.model?.__roomInfo,loading:document.querySelector('#gogame-debug')?.textContent};})()",candidate).catch(()=>null)))));
      throw error;
    }
    activeRoom=true;
    await delay(800);
    const findMenu="(()=>{const roots=[cc.director.getScene(),...Object.values(cc.game._persistRootNodes)],all=roots.flatMap(n=>n.getComponentsInChildren(cc.Component));return all.find(c=>c.node.activeInHierarchy&&(c.btnLayer&&typeof c.onShowBtnsClick==='function'&&typeof c.onExitRoomClick==='function'||c.mMenuBtn&&c.mDarkBG&&c.mExitBtn));})()";
    await until(()=>ev("!!"+findMenu,session),scene+' menu ready');
    const menuState=await ev("(()=>{const menu="+findMenu+";if(!menu)return {found:false};window.__gogameOldMenu=menu;if(menu.mMenuBtn){if(menu.mDarkBG.node.active)menu.hideMenu();menu.mMenuBtn.node.emit('click');return {found:true,open:menu.mDarkBG.node.active};}if(menu.btnLayer.active)menu.onShowBtnsClick(null,false);menu.onShowBtnsClick();return {found:true,open:menu.btnLayer.active};})()",session);
    assert.ok(menuState?.open,'native menu opens '+scene+': '+JSON.stringify(menuState));
    if(allSeatMenus){
      await ev("cc.app.gameRoom.dispatchEventAll?.('HideAllPopupPanel');true",session);
      assert.ok(await ev("(()=>{const room=cc.app.gameRoom,all=cc.director.getScene().getComponentsInChildren(cc.Component);const c=all.find(c=>typeof c.clickSeatDown==='function');if(c){const nodes=[];function walk(n){if(Number.isInteger(n.seatIndex)&&n.activeInHierarchy&&n.getComponent(cc.Button)?.interactable)nodes.push(n);n.children.forEach(walk);}walk(c.node);if(nodes.length){c.clickSeatDown({target:nodes[0]});return true;}}if(cc.director.getScene().name==='Qznn'){__require('Qznn_NetWork').Qznn_NetWork.Instance.SitDown(0);return true;}if(room.model?.sitDownRequest){room.model.sitDownRequest(0);return true;}const p=all.find(c=>typeof c.onPlayerSitDown==='function');if(p){p.onPlayerSitDown(null,'0');return true;}const hz=all.find(c=>cc.js.getClassName(c)==='hzxlSeatPanel');if(hz){hz.onClickSeat({target:hz.container.getSeatNode(0).getChildByName('icon')});return true;}return false;})()",session),'native seat '+scene);
      await until(()=>ev('!!cc.app.gameRoom.getMyMemberInfo()',session),scene+' seated member');
      await ev("(()=>{const utils=__require('GameUtils').default,original=utils.showMoveTips;if(!utils.__exitPolicyHook){utils.showMoveTips=function(message){window.__seatedExitTip=message;return original.apply(this,arguments);};utils.__exitPolicyHook=true;}window.__seatedExitTip='';return true;})()",session);
      const start=frames.length;
      await ev("(()=>{const menu=window.__gogameOldMenu;if(typeof menu.onExitRoomClick==='function')menu.onExitRoomClick();else menu.mExitBtn.OnClick();return true;})()",session);
      await delay(250);
      assert.ok((await ev('window.__seatedExitTip',session)).includes('下局站起'),'native menu blocks '+scene);
      assert.ok(await ev('!!cc.app.gameRoom.getMyMemberInfo()',session));
      assert.equal(frames.slice(start).some(f=>f.id===2205),false,'blocked exit has no leave receipt');
      await ev("__require('SocketMgr').default.instance.send(2110);true",session);await delay(250);
      assert.ok(frames.slice(start).some(f=>f.id===9999),'server blocks '+scene);
      await ev("(()=>{const menu=window.__gogameOldMenu;if(typeof menu.onToggleNextStandUp==='function')menu.onToggleNextStandUp();else __require('Qznn_NetWork').Qznn_NetWork.Instance.SendNextStand();return true;})()",session);
      await until(()=>ev('!cc.app.gameRoom.getMyMemberInfo()',session),scene+' standing from a chair not dealt into the current hand');
      assert.equal(await ev('cc.director.getScene().name',session),scene);
      console.log('PASS_SEAT_MENU_POLICY',JSON.stringify({scene,nativeBlocked:true,serverBlocked:true,stoodAsObserver:true}));
    }
    if(process.argv.includes('--trace-exit')){
      await ev("(()=>{window.__closeTrace=[];for(const name of ['RoomSocket','RoomSocket2']){const holder=__require(name).default.ins,raw=holder._socket;if(!raw)continue;const original=raw.onclose;raw.onclose=function(event){window.__closeTrace.push({name,phase:'before-native',code:event.code,reason:event.reason,connected:holder._isConnected,isBack:__require('GlobalGameData').default.isBack});return original?.call(this,event);};raw.addEventListener('close',event=>window.__closeTrace.push({name,phase:'closed',code:event.code,reason:event.reason,connected:holder._isConnected,hasContext:!!holder._rawDomainList}));}return true;})()",session);
      console.log('EXIT_BEFORE',JSON.stringify(await ev("(()=>{const r=cc.app.gameRoom;return {scene:cc.director.getScene().name,observer:r.getIsOb(),hasMember:!!r.getMyMemberInfo(),isBack:__require('GlobalGameData').default.isBack};})()",session)));
    }
    if(process.argv.includes('--hundred-cleanup')){
      const cleanup=await ev("(async()=>{await new Promise((resolve,reject)=>cc.assetManager.loadBundle('BairenMultyBet',error=>error?reject(error):resolve()));const h=__require('BairenMultyBetHelper').default;window.__gogameCleanupVm=h.vm;window.__gogameBairenExit=__require('BairenHelper').default.vm;let connected=false,readyState,isConnected;try{const s=h.roomSocket;connected=s.getRoomSocketIsOpen();readyState=s._socket?.readyState;isConnected=s._isConnected;}catch{}let timer;try{return {connected,readyState,isConnected,result:await Promise.race([h.vm.sendUnregRoomsReq(),new Promise(resolve=>{timer=setTimeout(()=>resolve('cleanup acknowledgement timed out'),5000);})])};}finally{clearTimeout(timer);}})()",session);
      assert.equal(cleanup.result,0,JSON.stringify(cleanup));console.log('PASS_CLEANUP_BEFORE_EXIT',JSON.stringify({scene,...cleanup}));
    }
    activeRoom=false;
    const exitStart=frames.length;
    await ev("(()=>{const menu=window.__gogameOldMenu;if(typeof menu.onExitRoomClick==='function')menu.onExitRoomClick();else menu.mExitBtn.OnClick();return true;})()",session);
    try{
      await until(()=>ev("(()=>{const frame=document.querySelector('iframe');return !frame||getComputedStyle(frame.parentElement).visibility==='hidden';})()"),'hall return '+scene);
    }catch(error){
      if(process.argv.includes('--trace-exit'))console.log('EXIT_AFTER',JSON.stringify(await ev("(()=>{const r=cc.app.gameRoom;return {scene:cc.director.getScene().name,hasRoom:!!r?.getRoomInfo?.(),observer:r?.getIsOb?.(),hasMember:!!r?.getMyMemberInfo?.(),isBack:__require('GlobalGameData').default.isBack,closeTrace:window.__closeTrace,dialogs:cc.director.getScene().getComponentsInChildren(cc.Component).filter(c=>c.node.activeInHierarchy&&/alert|kick|tip/i.test(cc.js.getClassName(c))).map(c=>cc.js.getClassName(c)).slice(0,20)};})()",session)));
      throw error;
    }
    if(process.argv.includes('--trace-exit'))console.log('EXIT_TRACE',JSON.stringify(await ev('window.__closeTrace',session)));
    await delay(800);
    assert.equal(frames.slice(exitStart).some(f=>f.id===1105),false,'normal auxiliary retirement cannot reconnect after returning to the hall');
    // An event queued by the previous scene must be harmless after teardown.
    const late=await ev("(()=>{const menu=window.__gogameOldMenu,room=cc.app.gameRoom;if(menu&&typeof menu.onShowBtnsClick==='function'&&(!room||!room.getRoomInfo?.())){menu.onShowBtnsClick();return 'checked';}return 'separate-menu-or-room-retained';})()",session);
    if(process.argv.includes('--hundred-cleanup')){
      const cleanup=await ev("(async()=>{const h=__require('BairenMultyBetHelper').default;h._socketIns=null;let selection;try{selection=h.roomSocket.getRoomSocketIsOpen()?'open':'closed';}catch(error){selection=error.message;}window.__gogameBairenExit.commandExit();const result=await window.__gogameCleanupVm.sendUnregRoomsReq();return {selection,result};})()",session);
      assert.equal(cleanup.result,0);await delay(250);console.log('PASS_QUEUED_CLEANUP_AFTER_EXIT',JSON.stringify({scene,...cleanup}));
    }
    console.log('PASS_HALL_REENTRY',JSON.stringify({scene,late}));
  }
  const failures=errors.filter(e=>e.exception?.value!=='--------------------> Promise manually interrupted!! <--------------------');
  console.log('SCRIPT_ERRORS',JSON.stringify(failures));
  assert.equal(failures.length,0);
  assert.equal(frames.filter(f=>f.id===1203&&!(f.reason==='primary-closed'&&f.auxiliary===true)).length,0,'normal teardown never reports an account replacement');
  const shot=await send('Page.captureScreenshot');fs.writeFileSync(allSeatMenus?'cache/all-seat-exit-browser.png':'cache/room-ui-reentry.png',Buffer.from(shot.data,'base64'));
  console.log('PASS_ROOM_UI_REENTRY');
}catch(error){console.log('FAIL_ROOM_UI',JSON.stringify({error:error.stack,errors,frames:frames.slice(-20),diagnostics:diagnostics.slice(-40)}));throw error;}
finally{socket?.close();browser.kill();}

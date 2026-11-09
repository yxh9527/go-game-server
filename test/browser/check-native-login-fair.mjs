import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import {decodeFrame} from '../../game-server/src/codec.js';
import {PUSH} from '../../game-server/src/messages.js';

const profile=fs.mkdtempSync(path.join(os.tmpdir(),'gogame-native-login-fair-'));
const browser=spawn(process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',[
  '--headless=new','--no-sandbox','--disable-gpu','--disable-extensions','--no-first-run',
  '--remote-debugging-port=0','--user-data-dir='+profile,'--window-size=1280,900','about:blank',
],{windowsHide:true,stdio:'ignore'});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const frames=[],errors=[],targets=[],pending=new Map();let socket,id=0;
const nonHoldem=process.argv.includes('--non-holdem'),expectedScene=nonHoldem?'gameZjh':'gameHoldem';
try{
  let port;for(let i=0;i<100;i++){try{port=fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0];break;}catch{}await delay(100);}
  assert.ok(port,'Chrome debugging port');
  const page=(await(await fetch('http://127.0.0.1:'+port+'/json/list')).json()).find(t=>t.type==='page');
  socket=new WebSocket(page.webSocketDebuggerUrl.replace('localhost','127.0.0.1'));
  await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
  const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{
    const n=++id,timer=setTimeout(()=>{pending.delete(n);reject(new Error('CDP timeout '+method));},15000);
    pending.set(n,message=>{clearTimeout(timer);message.error?reject(new Error(JSON.stringify(message.error))):resolve(message.result);});
    socket.send(JSON.stringify({id:n,method,params,sessionId}));
  });
  socket.on('message',raw=>{
    const m=JSON.parse(raw);if(m.id){pending.get(m.id)?.(m);pending.delete(m.id);}
    else if(m.method==='Target.attachedToTarget'){
      targets.push(m.params.sessionId);void send('Runtime.enable',{},m.params.sessionId).catch(()=>{});void send('Network.enable',{},m.params.sessionId).catch(()=>{});
    }else if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails);
    else if(/Network.webSocketFrame(Sent|Received)/.test(m.method)){
      try{const frame=decodeFrame(Buffer.from(m.params.response.payloadData,'base64'));if(frame)frames.push({direction:m.method.endsWith('Sent')?'sent':'received',...frame});}catch{}
    }
  });
  const evaluate=async(expression,sessionId)=>{
    const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},sessionId);
    assert.ok(!r.exceptionDetails,JSON.stringify(r.exceptionDetails));return r.result?.value;
  };
  const click=async label=>{
    assert.ok(await evaluate(`(()=>{const el=Array.from(document.querySelectorAll('*')).filter(e=>e.textContent.trim()===${JSON.stringify(label)}).sort((a,b)=>a.querySelectorAll('*').length-b.querySelectorAll('*').length)[0];el?.click();return !!el;})()`),'native tab '+label);
    await delay(1500);
  };
  await send('Page.enable');await send('Runtime.enable');await send('Network.enable');
  await send('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:false,flatten:true});
  const uid=Number(process.env.GOGAME_BROWSER_UID)||(nonHoldem?88123221:process.argv.includes('--player-gift')?88123120:88123119),token='dev-'+uid;
  await send('Page.navigate',{url:'http://lobby.localhost:11042/21/0?userId='+uid+'&userToken='+token+'&openId='+uid+'&v=2.0.1279'});
  await delay(nonHoldem?10000:7000);if(!nonHoldem){await click('德州');await click('德州不秀牌');}
  assert.ok(await evaluate(`(()=>{const el=document.querySelector('[class*=roomList] li');el?.click();return !!el;})()`),'native room card');
  let gameTarget;
  for(let i=0;i<100&&!gameTarget;i++){
    for(const target of targets)if(await evaluate(`window.cc&&cc.director.getScene()?.name`,target).catch(()=>null)===expectedScene)gameTarget=target;
    if(!gameTarget)await delay(400);
  }
  assert.ok(gameTarget,'original Holdem scene');await delay(2500);
  assert.equal(frames.filter(f=>f.direction==='received'&&f.msgid===PUSH.USER_LOGIN_KICKOUT).length,0,'first native dual-socket login never kicks');
  const logins=frames.filter(f=>f.direction==='sent'&&f.msgid===1105);
  assert.equal(logins.length,2,'original client starts its main and hundred sockets');
  assert.ok(logins.every(f=>f.payload.openHundredGame===false));
  let proof;
  for(let i=0;i<100&&!proof;i++){
    proof=frames.filter(f=>f.direction==='received'&&f.msgid===PUSH.DZPK_PUSH_BLOCKCHAIN_NOTIFY).at(-1)?.payload;
    if(!proof)await delay(400);
  }
  assert.ok(proof,'real in-memory fair-code commitment');
  const opened=await evaluate(`(()=>{const seen=new Set(),all=[];function walk(n){if(!n||seen.has(n))return;seen.add(n);all.push(...n.getComponents(cc.Component));n.children.forEach(walk);}walk(cc.director.getScene());Object.values(cc.game._persistRootNodes).forEach(walk);const manager=all.find(c=>typeof c.onShowCodeVerify==='function');manager?.onShowCodeVerify(${JSON.stringify(proof)});return !!manager;})()`,gameTarget);
  assert.ok(opened,'native fair-code view');await delay(800);
  const queries=[];
  for(let i=0;i<3;i++){
    const query=new URLSearchParams({op:'29',userId:String(uid),token,gameRoomId:String(proof.gameRoomId),currentInning:String(proof.currentInning),roomType:String(proof.roomType)});
    const response=await evaluate(`fetch(${JSON.stringify('/api/internal/v1/do?'+query)}).then(r=>r.json()).then(r=>({code:r.msgCode,cards:r.data?.pokerList?.length}))`);
    queries.push(response);assert.equal(response.code,200);assert.ok(response.cards>0);
  }
  await delay(1500);
  assert.equal(frames.filter(f=>f.direction==='received'&&f.msgid===PUSH.USER_LOGIN_KICKOUT).length,0,'repeated fair-code queries never revoke the native sockets');
  assert.equal(frames.filter(f=>f.direction==='sent'&&f.msgid===1105).length,2,'queries do not introduce player logins');
  assert.equal(await evaluate(`cc.director.getScene().name`,gameTarget),expectedScene);
  if(process.argv.includes('--seated-exit-policy')){
    await evaluate("cc.app.gameRoom.dispatchEventAll('HideAllPopupPanel');true",gameTarget);
    const menu="(()=>{const roots=[cc.director.getScene(),...Object.values(cc.game._persistRootNodes)];return roots.flatMap(n=>n.getComponentsInChildren(cc.Component)).find(c=>c.node.activeInHierarchy&&typeof c.onExitRoomClick==='function'&&typeof c.onToggleNextStandUp==='function');})()";
    assert.ok(await evaluate("(()=>{const c=cc.director.getScene().getComponentsInChildren(cc.Component).find(c=>typeof c.clickSeatDown==='function'),nodes=[];function walk(n){if(Number.isInteger(n.seatIndex)&&n.activeInHierarchy&&n.getComponent(cc.Button)?.interactable)nodes.push(n);n.children.forEach(walk);}if(!c)return false;walk(c.node);if(!nodes.length)return false;c.clickSeatDown({target:nodes[0]});return true;})()",gameTarget),'native available seat');
    await delay(500);
    assert.ok(await evaluate("(()=>{const c=cc.director.getScene().getComponentsInChildren(cc.Component).find(c=>c.node.activeInHierarchy&&c._curdata&&typeof c.onDaiRuClick==='function');if(!c)return false;c._carryReqCount=100;c.onDaiRuClick();return true;})()",gameTarget),'native carry-in');
    await delay(1000);
    for(let i=0;i<180;i++){
      if(await evaluate("!!cc.app.gameRoom.getMyMemberInfo()&&cc.app.gameRoom.getIsJoinGame("+uid+")",gameTarget))break;
      await delay(500);
    }
    assert.ok(await evaluate("!!cc.app.gameRoom.getMyMemberInfo()&&cc.app.gameRoom.getIsJoinGame("+uid+")",gameTarget),'player actually participates in a live hand');
    await evaluate("(()=>{const u=__require('GameUtils').default,old=u.showMoveTips;window.__exitTip='';u.showMoveTips=function(text){window.__exitTip=text;return old.apply(this,arguments);};return true;})()",gameTarget);
    const start=frames.length;
    await evaluate("(()=>{const c="+menu+";if(!c)return false;c.onExitRoomClick();return true;})()",gameTarget);await delay(400);
    assert.equal(frames.slice(start).some(f=>f.direction==='sent'&&f.msgid===2110),false,'native exit does not send a room-leave request while seated');
    assert.ok((await evaluate("window.__exitTip",gameTarget)).includes('下局站起'));
    await evaluate("__require('SocketMgr').default.instance.send(2110);true",gameTarget);await delay(500);
    assert.ok(frames.slice(start).some(f=>f.direction==='received'&&f.msgid===9999&&f.payload.errorMsg.includes('下局站起')),'server also rejects direct/bypassed exits');
    assert.ok(await evaluate("!!cc.app.gameRoom.getMyMemberInfo()",gameTarget));
    await evaluate("(()=>{const c="+menu+";c.onToggleNextStandUp();return true;})()",gameTarget);await delay(500);
    assert.ok(frames.slice(start).some(f=>f.direction==='received'&&f.msgid===2225&&f.payload===true),'next-round standing is acknowledged');
    for(let i=0;i<240;i++){
      if(!await evaluate("!!cc.app.gameRoom.getMyMemberInfo()",gameTarget))break;
      await evaluate("(()=>{const c=cc.director.getScene().getComponentsInChildren(cc.Component).find(c=>c.node.activeInHierarchy&&typeof c.onQiPaiClick==='function'&&c.actionBtns?.activeInHierarchy);if(c)c.onQiPaiClick();return true;})()",gameTarget);
      await delay(500);
    }
    assert.equal(await evaluate("!!cc.app.gameRoom.getMyMemberInfo()",gameTarget),false,'settlement stands the player without leaving the room');
    assert.equal(await evaluate("cc.director.getScene().name",gameTarget),expectedScene);
    assert.equal(frames.slice(start).some(f=>f.direction==='received'&&f.msgid===2205&&f.payload.uid===uid),false,'standing does not imply room exit');
    await evaluate("(()=>{const c="+menu+";c.onExitRoomClick();return true;})()",gameTarget);
    for(let i=0;i<60;i++){
      if(frames.slice(start).some(f=>f.direction==='received'&&f.msgid===2205&&f.payload.uid===uid))break;
      await delay(250);
    }
    assert.ok(frames.slice(start).some(f=>f.direction==='received'&&f.msgid===2205&&f.payload.uid===uid),'observer can explicitly leave after standing');
    assert.equal(errors.length,0);console.log('PASS_SEATED_EXIT_POLICY',JSON.stringify({scene:expectedScene,nativeExitBlocked:true,serverExitBlocked:true,stoodAfterSettlement:true,exitAfterStanding:true}));
  }
  let playerPanelCheck;
  if(process.argv.includes('--player-panel')){
    await evaluate("cc.app.gameRoom.dispatchEventAll('HideAllPopupPanel');true",gameTarget);
    const target=await evaluate("(()=>{const r=cc.app.gameRoom.getRoomInfo();return r.memberList.find(p=>p.uid>=90000000)?.uid;})()",gameTarget);
    assert.ok(target,'real seated robot for avatar popup');
    assert.ok(await evaluate("(()=>{const c=cc.director.getScene().getComponentsInChildren(cc.Component).find(c=>c._seatUserData?.uid==="+target+"&&typeof c.onEmojiClick==='function');c?.onEmojiClick();return !!c;})()",gameTarget),'native seat avatar click');await delay(2200);
    const inspect="(()=>{const seen=new Set(),all=[];function walk(n){if(!n||seen.has(n))return;seen.add(n);all.push(...n.getComponents(cc.Component));n.children.forEach(walk);}walk(cc.director.getScene());Object.values(cc.game._persistRootNodes).forEach(walk);const panel=all.find(c=>cc.js.getClassName(c)==='chatPanel'&&c.node.activeInHierarchy);return panel?{data:panel.data,name:panel.name_label.string,free:panel.menu_views_1.getChildByName('view_0').getChildByName('content').getChildByName('number').getComponent(cc.Label).string,props:panel.menu_views_1.getChildByName('view_0').getChildByName('scroll_view').getComponent(cc.ScrollView).content.children.map(n=>n.name),labels:panel.node.getComponentsInChildren(cc.Label).filter(c=>c.node.activeInHierarchy).map(c=>c.string)}:null;})()";
    for(let i=0;i<20&&!playerPanelCheck;i++){playerPanelCheck=await evaluate(inspect,gameTarget);if(!playerPanelCheck)await delay(250);}assert.ok(playerPanelCheck,'native avatar panel is visible');
    assert.equal(playerPanelCheck.data.playerId,target);assert.ok(playerPanelCheck.data.totalHands>0);
    assert.ok(Number(playerPanelCheck.free)>=0&&Number(playerPanelCheck.free)<=20);
    const identity=await evaluate("(()=>{const s=cc.app.gameRoom.getSeatByID("+target+");return s?.userInfo||s;})()",gameTarget);
    assert.equal(playerPanelCheck.data.name,identity.name);assert.equal(playerPanelCheck.data.imageUrl,identity.icon);
    assert.ok(playerPanelCheck.labels.every(s=>!String(s).includes('undefined')&&!String(s).includes('NaN')));
    if(process.argv.includes('--room-records')){
      for(let wait=0;wait<90&&!playerPanelCheck.data.recentRecordsAvailable;wait++){
        await delay(1000);
        await evaluate("__require('apiHttp').default.user_info({uid:"+target+",roomType:cc.app.gameRoom._conf.roomType});true",gameTarget);
        await delay(200);playerPanelCheck=await evaluate(inspect,gameTarget);
      }
      assert.ok(playerPanelCheck.data.recentRecordCount>0,'robot must have a real settled room hand');
      assert.equal(playerPanelCheck.data.oneWeekHands,playerPanelCheck.data.recentRecordCount,'displayed count comes from actual room history');
      assert.equal(playerPanelCheck.data.recentRecordScope,'room');
    }
    const firstData=playerPanelCheck.data;
    await evaluate("__require('apiHttp').default.user_info({uid:"+target+",roomType:cc.app.gameRoom._conf.roomType});true",gameTarget);await delay(500);
    const refreshed=(await evaluate(inspect,gameTarget)).data;
    for(const field of ['playerId','name','imageUrl','totalHands','flipManualBetPercent','joinPercent','tableJoinPercent','todayScore','oneWeekScore'])
      assert.deepEqual(refreshed[field],firstData[field],'reopening does not rerandomize '+field);
    const panelExpr="(()=>{const seen=new Set(),all=[];function walk(n){if(!n||seen.has(n))return;seen.add(n);all.push(...n.getComponents(cc.Component));n.children.forEach(walk);}walk(cc.director.getScene());Object.values(cc.game._persistRootNodes).forEach(walk);return all.find(c=>cc.js.getClassName(c)==='chatPanel'&&c.node.activeInHierarchy);})()";
    if(nonHoldem){
      assert.equal(await evaluate("(()=>{const p="+panelExpr+";return p.private_option_button.active;})()",gameTarget),false,'non-Holdem option dropdown is hidden');
      playerPanelCheck.nonHoldemOptionHidden=true;
    }
    if(process.argv.includes('--avatar-race')){
      const peers=await evaluate("cc.app.gameRoom.getRoomInfo().memberList.filter(p=>p.uid>=90000000).map(p=>p.uid).slice(0,2)",gameTarget);
      assert.equal(peers.length,2);
      await evaluate("(()=>{const all=cc.director.getScene().getComponentsInChildren(cc.Component);for(const uid of "+JSON.stringify(peers)+"){const c=all.find(c=>c._seatUserData?.uid===uid&&typeof c.onEmojiClick==='function');c.lastClickTime=0;c.onEmojiClick();}return true;})()",gameTarget);await delay(1000);
      assert.equal((await evaluate(inspect,gameTarget)).data.playerId,peers[1]);
      await evaluate("__require('NotificationCenter').default.emit(8263,{playerId:"+peers[0]+",name:'stale wrong response',imageUrl:'/wrong.png'});true",gameTarget);
      assert.equal((await evaluate(inspect,gameTarget)).data.playerId,peers[1]);
      const start=frames.length;
      await evaluate("(()=>{const p="+panelExpr+";p.data=undefined;p.onClickEmojItem({target:{name:'9'}});return true;})()",gameTarget);
      assert.equal(frames.slice(start).some(f=>f.direction==='sent'&&f.msgid===2103),false,'empty profile cannot send a prop');
      await evaluate("(()=>{const c=cc.director.getScene().getComponentsInChildren(cc.Component).find(c=>c._seatUserData?.uid==="+target+"&&typeof c.onEmojiClick==='function');c.lastClickTime=0;c.onEmojiClick();return true;})()",gameTarget);await delay(1000);
      assert.equal((await evaluate(inspect,gameTarget)).data.playerId,target);
      let avatar;
      for(let wait=0;wait<30;wait++){
        avatar=await evaluate("(()=>{const p="+panelExpr+",s=cc.director.getScene().getComponentsInChildren(cc.Component).find(c=>c._seatUserData?.uid==="+target+"&&c.headImg);const a=p.head_sprite.getComponent(cc.Sprite).spriteFrame,b=s.headImg.spriteFrame||s.headImg.getComponent(cc.Sprite).spriteFrame;return {name:p.name_label.string,seatName:s._seatUserData.userInfo?.name||s._seatUserData.name,popup:a?.getTexture()?.url,seat:b?.getTexture()?.url};})()",gameTarget);
        if(avatar.popup&&avatar.seat&&avatar.popup===avatar.seat)break;await delay(100);
      }
      assert.equal(avatar.name,avatar.seatName);assert.ok(avatar.popup&&avatar.popup===avatar.seat,'popup avatar texture matches selected seat');
      playerPanelCheck.avatarRace=avatar;
      const avatarShot=await send('Page.captureScreenshot');fs.writeFileSync(nonHoldem?'cache/avatar-other-fixed.png':'cache/avatar-holdem-fixed.png',Buffer.from(avatarShot.data,'base64'));
    }
    await evaluate("(()=>{const p="+panelExpr+";p.onMenu0Event(p.menu_toggle_0.getComponentInChildren(cc.ToggleContainer).toggleItems[1]);p.onToggleMarkItem({target:{name:'2'},isChecked:true});return true;})()",gameTarget);await delay(400);
    await evaluate("__require('SocketMgr').default.instance.send(9127,{targetId:"+target+",remark:'Browser note',remarkMessage:'private test'});true",gameTarget);await delay(400);
    const noted=await evaluate(inspect,gameTarget);assert.equal(noted.data.mark,2);assert.equal(noted.data.remarkName,'Browser note');
    assert.ok(noted.labels.includes('今日输赢')&&noted.labels.includes('本周输赢'));
    if(process.argv.includes('--room-records'))assert.ok(noted.labels.includes('本房间牌局记录'),'robot popup caption survives native translation');
    await evaluate("(()=>{const p="+panelExpr+";p.onMenu1Event(p.menu_toggle_1.getComponentInChildren(cc.ToggleContainer).toggleItems[1]);return true;})()",gameTarget);await delay(400);
    assert.equal(await evaluate("(()=>{const p="+panelExpr+";return p.menu_views_1.children[1].active;})()",gameTarget),false,'advanced props remain unavailable');
    const notedShot=await send('Page.captureScreenshot');fs.writeFileSync('cache/player-panel-risk.png',Buffer.from(notedShot.data,'base64'));
    if(firstData.recentRecordsAvailable){
      await evaluate("(()=>{const p="+panelExpr+";p.onClickItem_3();return true;})()",gameTarget);await delay(1600);
      let seven;
      for(let i=0;i<30;i++){
        seven=await evaluate("(()=>{const seen=new Set(),all=[];function walk(n){if(!n||seen.has(n))return;seen.add(n);all.push(...n.getComponents(cc.Component));n.children.forEach(walk);}walk(cc.director.getScene());Object.values(cc.game._persistRootNodes).forEach(walk);const p=all.find(c=>c.is7Days&&c.player?.playerId==="+target+");return p?{visible:p.node.activeInHierarchy,title:p.title?.string,rows:p._totalList?.length,total:p._totalSize,privateFaces:p._totalList?.some(r=>r.ownCards?.some(c=>c>=0)&&r.firstGameList?.find(p=>p.uid==="+target+")?.showCards?.every(c=>c<0))}:null;})()",gameTarget);
        if(seven?.rows>0)break;await delay(200);
      }
      assert.ok(seven?.visible&&seven.rows>0,'native seven-day opponent hand list loads');assert.equal(seven.privateFaces,false);
      if(process.argv.includes('--room-records')){assert.equal(seven.title,'本房间牌局记录');assert.ok(seven.total>=firstData.recentRecordCount);}
      if(process.argv.includes('--room-records')&&nonHoldem){
        const cards=await evaluate("(()=>{const rows=cc.director.getScene().getComponentsInChildren(cc.Component).filter(c=>c.node.activeInHierarchy&&c.gameType===25&&typeof c.refreshHandCards==='function');return rows.map(c=>({limit:c.handCardNum,source:c.data.ownCards.length,visible:c.node_ZJH.getChildByName('node_leftPoke').children.filter(n=>n.active).length}));})()",gameTarget);
        assert.ok(cards.length>0,'native Zjh record rows mount');assert.ok(cards.every(c=>c.limit===3&&c.visible===3),'native Zjh rows show three card slots');seven.cardRows=cards;
      }
      playerPanelCheck.seven=seven;
    }
    const panelShot=await send('Page.captureScreenshot');fs.writeFileSync('cache/player-panel-browser.png',Buffer.from(panelShot.data,'base64'));
    if(process.argv.includes('--player-gift')){
      await evaluate("(()=>{const p="+panelExpr+";p.hide();return true;})()",gameTarget);
      assert.ok(await evaluate("(()=>{const c=cc.director.getScene().getComponentsInChildren(cc.Component).find(c=>typeof c.clickSeatDown==='function'),nodes=[];function walk(n){if(Number.isInteger(n.seatIndex)&&n.activeInHierarchy&&n.getComponent(cc.Button)?.interactable)nodes.push(n);n.children.forEach(walk);}if(!c)return false;walk(c.node);if(!nodes.length)return false;c.clickSeatDown({target:nodes[0]});return true;})()",gameTarget),'native free seat');
      await delay(450);
      assert.ok(await evaluate("(()=>{const c=cc.director.getScene().getComponentsInChildren(cc.Component).find(c=>c.node.activeInHierarchy&&c._curdata&&typeof c.onDaiRuClick==='function');if(!c)return false;c._carryReqCount=100;c.onDaiRuClick();return true;})()",gameTarget),'native carry request');
      await delay(900);
      assert.ok(await evaluate("!!cc.app.gameRoom.getMyMemberInfo()",gameTarget),'viewer is now seated');
      await evaluate("(()=>{const c=cc.director.getScene().getComponentsInChildren(cc.Component).find(c=>c._seatUserData?.uid==="+target+"&&typeof c.onEmojiClick==='function');c.lastClickTime=0;c.onEmojiClick();return true;})()",gameTarget);await delay(700);
      const quotaBefore=Number((await evaluate(inspect,gameTarget)).free);
      const start=frames.length;
      await evaluate("(()=>{const p="+panelExpr+";p.onClickEmojItem({target:{name:'9'}});p.onClickEmojItem({target:{name:'9'}});return true;})()",gameTarget);await delay(900);
      assert.equal(frames.slice(start).filter(f=>f.direction==='sent'&&f.msgid===2103&&f.payload.type===5).length,1,'native double touch sends a single prop');
      const gift=frames.slice(start).find(f=>f.direction==='received'&&f.msgid===2203&&f.payload.type===5);
      assert.ok(gift,'native ordinary prop broadcast reaches the room');assert.equal(gift.payload.sendUid,uid);assert.equal(gift.payload.content.toId,target);
      assert.ok(frames.slice(start).some(f=>f.direction==='received'&&f.msgid===8265&&f.payload===quotaBefore-1),'daily quota decrements once');
      playerPanelCheck.gift={propId:9,before:quotaBefore,after:quotaBefore-1};
      await evaluate("(()=>{const c=cc.director.getScene().getComponentsInChildren(cc.Component).find(c=>c._seatUserData?.uid==="+target+"&&typeof c.onEmojiClick==='function');c.lastClickTime=0;c.onEmojiClick();return true;})()",gameTarget);await delay(600);
    }
    console.log('PASS_PLAYER_PANEL',JSON.stringify(playerPanelCheck));
  }
  let replayCheck;
  if(process.argv.includes('--replay')){
    await evaluate("cc.app.gameRoom.dispatchEventAll('HideAllPopupPanel');true",gameTarget);
    assert.ok(await evaluate("(async()=>{const c=cc.director.getScene().getComponentsInChildren(cc.Component).find(c=>typeof c.onGameHistoryClick==='function');if(!c)return false;await c.onGameHistoryClick();return true;})()",gameTarget),'native replay button');
    await delay(1800);
    for(let page=0;page<20;page++){
      for(let wait=0;wait<30;wait++){
        replayCheck=await evaluate("(()=>{const all=cc.director.getScene().getComponentsInChildren(cc.Component),c=all.find(c=>c.historyModel&&c.historyContentScript),m=c?.historyModel,d=m?.detailData;return {found:!!m,visible:!!c?.node.activeInHierarchy,received:m?.isDataReceived,page:m?.getCurrentPageNum(),inning:m?.getCurrentPlayBack()?.currentInningNum,players:d?JSON.parse(d.inningResults).map(p=>({uid:p.uid,handPais:p.handPais})):[],showdown:d?JSON.parse(d.roundList).some(p=>p.operationType===11):null};})()",gameTarget);
        if(replayCheck.found&&replayCheck.received&&replayCheck.players.length)break;
        await delay(200);
      }
      if(replayCheck.received&&replayCheck.showdown===false&&!replayCheck.players.some(p=>p.uid===uid))break;
      if(replayCheck.page<=1)break;
      await evaluate("__require('SingleFactory').SingleFactory.getInstance(__require('HoldemHistoryModel').HoldemHistoryModel).onPre();true",gameTarget);
      await delay(700);
    }
    assert.ok(replayCheck?.visible&&replayCheck.received,'native replay completes rendering');
    assert.equal(replayCheck.showdown,false,'test an uncontested no-show hand');
    assert.ok(replayCheck.players.every(p=>p.uid!==uid&&p.handPais.length===0),'spectator cannot see private holes');
    console.log('PASS_OBSERVER_REPLAY',JSON.stringify(replayCheck));
    const replayShot=await send('Page.captureScreenshot');fs.writeFileSync('cache/observer-replay.png',Buffer.from(replayShot.data,'base64'));
  }
  assert.equal(errors.length,0,'no uncaught browser exceptions');
  const shot=await send('Page.captureScreenshot');fs.writeFileSync('cache/native-login-fair.png',Buffer.from(shot.data,'base64'));
  const report={roomId:proof.gameRoomId,inning:proof.currentInning,nativeLogins:logins.length,overlayEnabled:false,queries,kickouts:0,scriptErrors:0,replayCheck,playerPanelCheck};
  fs.writeFileSync('cache/native-login-fair.json',JSON.stringify(report,null,2));console.log('PASS_NATIVE_LOGIN_FAIR',JSON.stringify(report));
}catch(error){
  const report={error:error.stack,errors,frames:frames.filter(f=>[1105,1205,1203,2102,2201,2206,9999].includes(f.msgid))};
  fs.writeFileSync('cache/native-login-fair-failure.json',JSON.stringify(report,null,2));
  console.log('BROWSER_FAILURE',JSON.stringify({error:error.message,errors,frames:report.frames.map(f=>({direction:f.direction,id:f.msgid,payload:f.msgid===1105?{userId:f.payload.userId,roomId:f.payload.roomId}:f.payload}))}));
  throw error;
}finally{socket?.close();browser.kill();}

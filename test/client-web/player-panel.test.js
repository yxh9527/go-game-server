import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {adaptPlayerPanelResponse,canonicalPanelProfile,loadPanelAvatar,updatePanelRecordCaption} from '../../client-web/src/player-panel-response.js';
const original=fs.readFileSync(new URL('../../static/client/2.0.1279/assets/main/index.88f4e.js',import.meta.url),'utf8');
const adapted=adaptPlayerPanelResponse(original);
const begin=adapted.indexOf("'chatPanel':[");
function method(name,next,context){
  const marker="Y['prototype']['"+name+"']=",start=adapted.indexOf(marker,begin)+marker.length,end=adapted.indexOf(",Y['prototype']['"+next+"']=",start);
  assert.ok(start>marker.length&&end>start);return vm.runInNewContext('('+adapted.slice(start,end)+')',context);
}
test('native player panel adapter is scoped, idempotent and compiles as the full original bundle',()=>{
  assert.notEqual(adapted,original);assert.equal(adaptPlayerPanelResponse(adapted),adapted);new vm.Script(adapted);
  assert.equal(adaptPlayerPanelResponse('unrelated bundle'),'unrelated bundle');
});

test('robot record labels show room lifetime and switching to a human restores seven-day captions',()=>{
  const value={},label={node:{},setKey(){}},count={node:value,string:'3 >'};
  const item={getChildByName:()=>value,getComponentsInChildren:()=>[label,count]};
  const panel={data:{recentRecordScope:'room'},menu_views_0:{children:[{}, {getChildByName:()=>({getChildByName:()=>item})}]}};
  updatePanelRecordCaption(panel,()=> '近七日牌局记录','Label');
  assert.equal(label.string,'本房间牌局记录');assert.equal(count.string,'3 >');
  assert.equal(label.beforI18nStringChangeFunc('近七日牌局记录'),'本房间牌局记录','late native translation cannot reset the robot caption');
  panel.data.recentRecordScope='seven-days';updatePanelRecordCaption(panel,()=> '近七日牌局记录','Label');
  assert.equal(label.string,'近七日牌局记录');
  assert.equal(label.beforI18nStringChangeFunc('Human translated caption'),'Human translated caption');
  const a=adapted.indexOf("'RecordCenterRoomCardListView':["),marker="am['prototype']['init']=",b=adapted.indexOf(marker,a)+marker.length,c=adapted.indexOf(",am['prototype']['start']=",b);
  assert.ok(c>b);let text;
  const init=vm.runInNewContext('('+adapted.slice(b,c)+')',{cc:{Widget:'widget'},X:{GameID:{}},ae:{default:{getLangText:()=> '近七日牌局记录'}}});
  const view={toggle_showMyself:{node:{parent:{}}},label_score_lbl:{node:{parent:{}}},recordScv:{getComponent:()=>({})},gameInfoReport:{},title:{set string(v){text=v;}},reqRoomData(){}};
  init.call(view,{roomType:19,gameRoomId:1},{playerId:90000001,recentRecordScope:'room'},true);assert.equal(text,'本房间牌局记录');
  init.call(view,{roomType:19,gameRoomId:1},{playerId:42,recentRecordScope:'seven-days'},true);assert.equal(text,'近七日牌局记录');
});

test('native Zjh room history renders three cards even without a report action',()=>{
  const a=adapted.indexOf("'RecordCenterRoomCardListItem':["),marker="ae['prototype']['initData']=",b=adapted.indexOf(marker,a)+marker.length,c=adapted.indexOf(",ae['prototype']['initOtherParam']=",b);
  const init=vm.runInNewContext('('+adapted.slice(b,c)+')',{}),row={reportNode:{node:{}},showCodeVerify:{}};
  init.call(row,{},25,{},null,null);assert.equal(row.handCardNum,3);
});
test('native advanced prop tab displays unavailable and returns to the ordinary tab',()=>{
  let tip,checks=0,visited=false;
  const handle=method('onMenu1Event','initView0',{M:{default:{showMoveTips:value=>{tip=value;}}},cc:{ToggleContainer:'toggle'}});
  const panel={menu_toggle_1:{getComponentInChildren:()=>({toggleItems:[{check(){checks++;}}]})},menu_views_1:{children:[{set active(v){visited=true;}}]}};
  handle.call(panel,{node:{getSiblingIndex:()=>1}});assert.ok(tip);assert.equal(checks,1);assert.equal(visited,false);
});
test('late native remark responses cannot overwrite the wrong or closed popup',()=>{
  const handle=method('onReceiveRemark','onUpdateList',{M:{default:{showMoveTips(){},getLangText(){}}}});
  const panel={data:null,initHeader(){assert.fail('closed panel');}};assert.doesNotThrow(()=>handle.call(panel,{targetUid:42}));
  panel.data={playerId:43};assert.doesNotThrow(()=>handle.call(panel,{targetUid:42}));assert.equal(panel.data.mark,undefined);
});
test('native ordinary prop clicks tolerate a closed popup and send only once for the captured target',()=>{
 const sent=[];
 const click=method('onClickEmojItem','onClickMarkButton',{
   cc:{app:{gameRoom:{getRoomInfo:()=>({banEmoji:false})}}},
   M:{default:{showMoveTips(){},getLangText(){}}},J:{default:{instance:{send:(id,payload)=>sent.push({id,payload})}}},
   K:{default:{SEND:{SEND_USER_CHAT:2103}}},N:{default:{userData:{uid:42}}},
 });
 const panel={node:{active:true},data:undefined,hide(){this.node.active=false;this.data=null;}};
 assert.doesNotThrow(()=>click.call(panel,{target:{name:'9'}}));assert.equal(sent.length,0);
 panel.data={playerId:43};panel.node.active=true;
 click.call(panel,{target:{name:'9'}});assert.equal(sent.length,1);assert.equal(sent[0].payload.content.toId,43);
 assert.doesNotThrow(()=>click.call(panel,{target:{name:'9'}}));assert.equal(sent.length,1);
});
test('native popup ignores empty and different-player updates without replacing its selected data',()=>{
 const update=method('onUpdateList','emoNumberBack',{});
 const data={playerId:42,name:'selected'},panel={data,node:{active:true},initHeader(){},initView0(){},initView1(){}};
 assert.doesNotThrow(()=>update.call(panel,undefined));assert.equal(panel.data,data);
 update.call(panel,{playerId:43,name:'late other player'});assert.equal(panel.data,data);
 update.call(panel,{playerId:42,name:'new selected'});assert.equal(panel.data.name,'new selected');
});
test('canonical popup identity comes from the selected seat without modifying the received profile',()=>{
 const data={playerId:43,name:'wrong name',imageUrl:'/wrong.png',totalHands:500};
 const profile=canonicalPanelProfile(data,{getSeatByID:()=>({uid:43,userInfo:{uid:43,name:'Seat Name',icon:'/avator/90024.png'}})});
 assert.equal(profile.name,'Seat Name');assert.equal(profile.imageUrl,'/avator/90024.png');assert.equal(profile.totalHands,500);
 assert.equal(data.name,'wrong name');assert.equal(canonicalPanelProfile(undefined,{}),null);
});
test('a delayed old avatar callback cannot overwrite the currently selected player',()=>{
 const callbacks=[],sprite={isValid:true,spriteFrame:'old'},panel={data:{playerId:42},node:{active:true}};
 loadPanelAvatar(panel,sprite,'42',(url,proxy)=>callbacks.push(proxy));
 panel.data={playerId:43};loadPanelAvatar(panel,sprite,'43',(url,proxy)=>callbacks.push(proxy));
 callbacks[1].spriteFrame='player43';callbacks[0].spriteFrame='player42';assert.equal(sprite.spriteFrame,'player43');
 panel.node.active=false;callbacks[1].spriteFrame='after-close';assert.equal(sprite.spriteFrame,'player43');
});
test('profile dispatch ignores empty and old-player replies before they can remove the selected seat listener',()=>{
 const start=adapted.indexOf("'NotificationCenter':["),marker="h['emit']=",a=adapted.indexOf(marker,start)+marker.length,b=adapted.indexOf(",h['on']=",a);
 const emit=vm.runInNewContext('('+adapted.slice(a,b)+')',{window:{__gogamePlayerPanelTarget:43}});
 const received=[],events={_handles:{8263:[{callback:data=>received.push(data.playerId)}]}};
 emit.call(events,8263,undefined);emit.call(events,8263,{playerId:42});emit.call(events,8263,{playerId:43});
 assert.deepEqual(received,[43]);
});
test('non-Holdem profile hides private options while Holdem retains its owner permission check',()=>{
 const cc={ToggleContainer:'toggle',ScrollView:'scroll',app:{gameRoom:{_conf:{roomType:25,isPrivateRoom:true,createUid:42},getIsOb:()=>true}}};
 const show=method('show','hide',{cc,N:{default:{userData:{uid:42}}}});
 const mask={},scroll={getComponent:()=>({enabled:true})},view={getChildByName:name=>name==='mask'?mask:scroll};
 const panel={data:{playerId:43,mark:0},node:{},panel:{},kong_panel:{},mark_panel:{},private_option_button:{active:true},private_option_dropdown_panel:{active:true},
   mark_button:{},menu_toggle_1:{},menu_views_1:{getChildByName:()=>view},
   initHeader(){},initMenu0(){},initMenu1(){},initMark(){},isSelf:()=>false,isShow:()=>false,isShowMark:()=>false,
   menu_toggle_0:{getComponentInChildren:()=>({toggleItems:[{node:{},check(){}},{check(){}}]}),getChildByName:()=>({})}};
 show.call(panel);assert.equal(panel.private_option_button.active,false);assert.equal(panel.private_option_dropdown_panel.active,false);
 cc.app.gameRoom._conf.roomType=19;show.call(panel);assert.equal(panel.private_option_button.active,true);
});

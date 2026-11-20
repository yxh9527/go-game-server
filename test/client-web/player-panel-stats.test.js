import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {panelGameStatRows,renderPanelGameStats,updatePanelGameTab,adaptPlayerPanelResponse} from '../../client-web/src/player-panel-response.js';

const data={playerId:42,totalHands:4,winPercent:25,joinPercent:50,flipManualBetPercent:25,tableJoinPercent:100,
  betOpportunityHands:3,manualBetHands:2,manualBetPercent:66.67,aboveMinimumBetHands:1,aboveMinimumBetPercent:33.33,
  manualGrabHands:3,manualGrabPercent:75,positiveGrabHands:1,positiveGrabPercent:25,
  doubleHands:1,doublePercent:25,splitHands:2,splitPercent:50,insuranceBuyHands:0,insuranceBuyPercent:0,
  clientArrangementHands:3,clientArrangementPercent:75,serverArrangementHands:1,serverArrangementPercent:25,extendedArrangementHands:1,extendedArrangementPercent:25,
  clientDiscardHands:3,clientDiscardPercent:75,serverDiscardHands:4,serverDiscardPercent:100};

test('native stat rows use each game vocabulary and the funded bet-opportunity denominator',()=>{
  const rows=type=>panelGameStatRows(data,type),value=(type,key)=>rows(type).find(row=>row.key===key)?.value;
  assert.equal(rows(19),null);assert.equal(rows(101),null);assert.equal(rows(999),null);
  assert.equal(value(24,'manualBetPercent'),'66.67%');assert.equal(value(24,'manualGrabPercent'),'75%');
  assert.equal(value(32,'manualBetPercent'),'66.67%');assert.equal(value(32,'manualGrabPercent'),undefined);
  assert.equal(value(25,'flipManualBetPercent'),'25%');assert.equal(value(25,'tableJoinPercent'),'100%');
  assert.equal(value(31,'manualBetPercent'),'--','blackjack uses all hands rather than banker-excluding opportunities');
  assert.equal(value(31,'doublePercent'),'25%');assert.equal(value(31,'splitPercent'),'50%');assert.equal(value(31,'insuranceBuyPercent'),'0%');
  assert.equal(value(27,'clientArrangementPercent'),'75%');assert.equal(value(27,'extendedArrangementPercent'),'25%');
  for(const type of [26,28,30]){assert.equal(value(type,'clientDiscardPercent'),'75%');assert.equal(value(type,'serverDiscardPercent'),'100%');assert.equal(value(type,'flipManualBetPercent'),undefined);}
  assert.equal(data.totalHands,4);
});

test('missing, legacy, corrupt or nonnumeric metrics display -- while genuine zero remains zero',()=>{
  for(const type of [24,25,26,27,28,30,31,32]){
    assert.ok(panelGameStatRows({},type).every(row=>row.value==='--'));
    const rows=panelGameStatRows({totalHands:0,winPercent:0,clientDiscardHands:0,clientDiscardPercent:0,serverDiscardHands:0,serverDiscardPercent:0},26);
    assert.deepEqual(rows.map(row=>row.value),['0','0%','0%','0%']);
  }
  for(const bad of [undefined,null,'50','<img>',NaN,Infinity,-1,101]){
    const rows=panelGameStatRows({...data,clientDiscardPercent:bad,winPercent:bad},26);
    assert.equal(rows[1].value,'--');assert.equal(rows[2].value,'--');
  }
  assert.equal(panelGameStatRows({...data,clientDiscardHands:5},26)[2].value,'--');
  assert.equal(panelGameStatRows({...data,clientDiscardHands:2},26)[2].value,'--');
});

test('robot behavior proportions validate against real room records without replacing its stable display total',()=>{
  const rows=panelGameStatRows({...data,isRobot:true,totalHands:500,recentRecordCount:4},26);
  assert.equal(rows[0].value,'500');assert.equal(rows[2].value,'75%');
  assert.equal(panelGameStatRows({...data,isRobot:true,totalHands:500,recentRecordCount:1},26)[2].value,'--');
});

function scene(){
  class Label{string='';}
  class ScrollView{stopAutoScroll(){this.stops=(this.stops||0)+1;}scrollToTop(){this.tops=(this.tops||0)+1;}}
  class Node{
    constructor(name){this.name=name;this.children=[];this.components=new Map();this.active=true;this.width=494;this.height=222;}
    addChild(child){this.children.push(child);child.parent=this;}
    getChildByName(name){return this.children.find(child=>child.name===name);}
    addComponent(Type){const component=new Type();component.node=this;this.components.set(Type,component);return component;}
    getComponent(Type){return this.components.get(Type)||null;}
    setPosition(x,y){this.x=x;this.y=y;}
    setContentSize(width,height){this.width=width;this.height=height;}
    setAnchorPoint(x,y){this.anchorX=x;this.anchorY=y;}
    destroy(){this.isValid=false;this.parent.children=this.parent.children.filter(c=>c!==this);}
  }
  const cc={Node,Label,ScrollView,Mask:class{},Button:class{},Layout:class{},instantiate:()=>{
    const item=new Node('clone');for(const key of ['title','value']){const node=new Node(key);node.addComponent(Label);item.addChild(node);}return item;
  }};
  const menu=new Node('views'),view=new Node('view_0'),base=new Node('base_info'),content=new Node('content');
  menu.addChild(view);view.addChild(base);view.addChild(new Node('mtt_info'));base.addChild(content);content.addChild(new Node('item_0'));
  return {cc,panel:{data:{...data},menu_views_0:menu},base,content};
}

test('native renderer reuses owned cells, preserves scroll on refresh and restores the original Holdem view',()=>{
  const {cc,panel,content}=scene();assert.equal(renderPanelGameStats(panel,cc,24,panelGameStatRows),true);
  const view=panel.__gogameNativeStats;assert.equal(view.items.length,6);assert.equal(content.active,false);assert.equal(view.hint.active,true);
  assert.equal(view.items[2].getChildByName('value').getComponent(cc.Label).string,'66.67%');
  const label=view.items[2].getChildByName('title').getComponent(cc.Label);assert.equal(label.beforI18nStringChangeFunc('old caption'),'手动下注率');
  view.content.y=158;renderPanelGameStats(panel,cc,24,panelGameStatRows);assert.equal(view.items.length,6);assert.equal(view.scroll.tops,1);assert.equal(view.content.y,158);
  panel.data={...data,playerId:43};renderPanelGameStats(panel,cc,24,panelGameStatRows);assert.equal(view.scroll.tops,2);
  renderPanelGameStats(panel,cc,26,panelGameStatRows);assert.equal(view.hint.active,false);assert.equal(view.items[4].active,false);assert.equal(view.items.length,6);
  assert.equal(renderPanelGameStats(panel,cc,19,panelGameStatRows),false);assert.equal(view.root.active,false);assert.equal(content.active,true);
  renderPanelGameStats(panel,cc,31,panelGameStatRows);assert.equal(view.root.active,true);assert.equal(content.active,false);
});

test('actual adapted native initView0 uses the renderer and remains idempotent and syntactically valid',()=>{
  const original=fs.readFileSync(new URL('../../static/client/2.0.1279/assets/main/index.88f4e.js',import.meta.url),'utf8'),adapted=adaptPlayerPanelResponse(original);
  new vm.Script(adapted);assert.equal(adaptPlayerPanelResponse(adapted),adapted);
  const marker="Y['prototype']['initView0']=",a=adapted.indexOf(marker,adapted.indexOf("'chatPanel':["))+marker.length,b=adapted.indexOf(",Y['prototype']['initView1']=",a);
  const {cc,panel}=scene();cc.app={gameRoom:{_conf:{roomType:27}}};
  const init=vm.runInNewContext('('+adapted.slice(a,b)+')',{cc});init.call(panel);
  assert.equal(panel.__gogameNativeStats.items[2].getChildByName('value').getComponent(cc.Label).string,'75%');
  assert.equal(panel.__gogameNativeStats.items[4].getChildByName('title').getComponent(cc.Label).string,'延时使用率');
});

test('native basic tab is visible for supported games and its caption survives late translations and returns to Holdem',()=>{
  const label={string:'德州基础数据',beforI18nStringChangeFunc:text=>text+'!'},node={getComponentsInChildren:()=>[label]};
  const panel={menu_toggle_0:{getComponentInChildren:()=>({toggleItems:[{node}]})}},cc={ToggleContainer:'toggles',Label:'label'};
  updatePanelGameTab(panel,cc,27);assert.equal(label.string,'游戏基础数据');assert.equal(label.beforI18nStringChangeFunc('德州基础数据'),'游戏基础数据');
  updatePanelGameTab(panel,cc,19);assert.equal(label.string,'德州基础数据');assert.equal(label.beforI18nStringChangeFunc('translated'),'translated!');
  const original=fs.readFileSync(new URL('../../static/client/2.0.1279/assets/main/index.88f4e.js',import.meta.url),'utf8'),adapted=adaptPlayerPanelResponse(original);
  const marker="Y['prototype']['isShow']=",a=adapted.indexOf(marker,adapted.indexOf("'chatPanel':["))+marker.length,b=adapted.indexOf(",Y['prototype']['",a);
  const room={_conf:{roomType:27}};const visible=vm.runInNewContext('('+adapted.slice(a,b)+')',{cc:{app:{gameRoom:room}},F:{GameID:{DZPK:19}}});
  for(const type of [19,24,25,26,27,28,30,31,32]){room._conf.roomType=type;assert.equal(visible(),true);}
  room._conf.roomType=58;assert.equal(visible(),false);
});

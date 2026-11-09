import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {adaptRoomUiResponse,preventSeatedRoomExit} from '../../client-web/src/room-ui-response.js';

const main=fs.readFileSync(new URL('../../static/client/2.0.1279/assets/main/index.88f4e.js',import.meta.url),'utf8');
const zjh=fs.readFileSync(new URL('../../static/client/2.0.1279/assets/Zjh/index.df153.js',import.meta.url),'utf8');

function onShowHandler(bundle,context){
  const marker="aE['prototype']['onShowBtnsClick']=";
  const method=bundle.indexOf(marker),start=method+marker.length,end=bundle.indexOf(",aE['prototype']['onSettingInGameClick']=",start);
  assert.ok(method>=0&&end>start);
  return vm.runInNewContext('('+bundle.slice(start,end)+')',context);
}

test('room options no-op after the current game room has been destroyed',()=>{
  const adapted=adaptRoomUiResponse(main);
  assert.equal(adaptRoomUiResponse(adapted),adapted);
  const click=onShowHandler(adapted,{cc:{app:{gameRoom:{getRoomInfo:()=>null}}}});
  const panel={btnLayer:{active:true},init(){assert.fail('must not initialize against a destroyed room');}};
  assert.doesNotThrow(()=>click.call(panel));
  assert.equal(panel.btnLayer.active,false);
});

test('room options retain their normal behavior while a room is active',()=>{
  const sent=[],dispatched=[],gameRoom={getRoomInfo:()=>({roomId:7}),getSitdownMembers:()=>[],isRoomEnded:false};
  const click=onShowHandler(adaptRoomUiResponse(main),{
    cc:{app:{gameRoom}},
    a2:{default:{instance:{send:(id,payload)=>sent.push({id,payload})}}},
    a3:{default:{SEND:{DATA_REPORT:1130}}},
  });
  const panel={btnLayer:{active:false},init(value){assert.equal(value,false);},playButtonClick(){},dispatchEventAll(value){dispatched.push(value);}};
  click.call(panel,null,false);
  assert.equal(panel.btnLayer.active,true);
  assert.deepEqual(dispatched,['set_GameTuoguan']);
  assert.equal(sent.length,0);
});

test('Zjh inning start diagnostic is logged without the console error stack',()=>{
  const adapted=adaptRoomUiResponse(zjh);
  assert.notEqual(adapted,zjh);
  assert.equal(adapted.includes("console['error']('----------',az)"),false);
  assert.equal(adaptRoomUiResponse(adapted),adapted);
  new vm.Script(adapted);
  assert.equal(fs.readFileSync(new URL('../../static/client/2.0.1279/assets/Zjh/index.df153.js',import.meta.url),'utf8'),zjh);
});

test('seated cash-game exits show a stand-first prompt, including after folding; observers and hundred exits proceed',()=>{
  for(const type of [19,24,25,26,27,28,30,31,32,50,51,52,58,59,60,62]){
    const tips=[],room={_conf:{roomType:type},getRoomInfo:()=>({roomType:type}),getMyMemberInfo:()=>({uid:42,lastOperation:6,folded:true})};
    const expected=type<50;
    assert.equal(preventSeatedRoomExit(room,message=>tips.push(message)),expected);
    assert.equal(tips.length,Number(expected));
    room.getMyMemberInfo=()=>null;assert.equal(preventSeatedRoomExit(room,()=>assert.fail('observer can exit')),false);
  }
});

test('native common exit button cannot open the old fold-and-leave confirmation while seated',()=>{
  const source=adaptRoomUiResponse(main),marker="aE['prototype']['onExitRoomClick']=",a=source.indexOf(marker)+marker.length,b=source.indexOf(",aE['prototype']",a);
  let tips=0;const click=vm.runInNewContext('('+source.slice(a,b)+')',{
    cc:{app:{gameRoom:{_conf:{roomType:25},getRoomInfo:()=>({roomType:25}),getMyMemberInfo:()=>({uid:42})}}},
    __require:name=>({default:{showMoveTips(message){assert.ok(message.includes('下局站起'));tips++;}}}),
    Z(){assert.fail('old confirmation must not run or send leave');},
  });
  click.call({});assert.equal(tips,1);assert.equal(adaptRoomUiResponse(source),source);
});

test('both native Qznn exit callbacks enforce the same stand-first rule',()=>{
  const qznn=fs.readFileSync(new URL('../../static/client/2.0.1279/assets/Qznn/index.134d5.js',import.meta.url),'utf8'),patched=adaptRoomUiResponse(qznn);
  new vm.Script(patched);assert.equal(adaptRoomUiResponse(patched),patched);
  const marker="this['mExitBtn']['SetClickCallback'](function(){",parts=patched.split(marker).slice(1);assert.equal(parts.length,2);
  for(const part of parts){
    let tips=0;const start=part.indexOf("var "),callback=part.slice(0,start);
    const run=vm.runInNewContext('(function(){'+callback+'})',{
      cc:{app:{gameRoom:{_conf:{roomType:24},getRoomInfo:()=>({roomType:24}),getMyMemberInfo:()=>({uid:42})}}},
      __require:()=>({default:{showMoveTips(){tips++;}}}),
    });
    run();assert.equal(tips,1);
  }
});

import {importHotModule} from "../../shared/hot-import.js";
import test from 'node:test';
import assert from 'node:assert/strict';
const {nativeHistorySnapshot}=await importHotModule(new URL("../../shared/native-history-snapshot.js",import.meta.url).href,"history-selected-test/shared/native-history-snapshot.test.js");
const {nativeHistoryDetail}=await importHotModule(new URL("../../shared/game-history-detail.js",import.meta.url).href,"history-selected-test/shared/native-history-snapshot.test.js");
const {queryNativeHistory}=await importHotModule(new URL("../../game-server/src/core/game-history.js",import.meta.url).href,"history-selected-test/shared/native-history-snapshot.test.js");

function legacy(type=24){
  return {id:'original',userId:42,agentId:7,currency:'CNY',roomId:700001,roomType:type,inning:3,endedAt:123456789,playMode:0,room:{ante:100,seeCardNo:3},
    detail:{firstGameList:[{uid:42,pos:0,userName:'original-own',handPais:[1,2,3,4,5],showCards:[1,2,3,4,5],score:100,banker:true},
      {uid:43,pos:1,userName:'original-peer',handPais:[6,7,8,9,10],showCards:[6,7,8,9,10],score:-100}],reportMsg:{reportFree:0,playerList:[]}}};
}

test('legacy final rows show original cards, names, scoring and look-card rule without inventing action history',()=>{
  const record=legacy(),original=structuredClone(record),snapshot=nativeHistorySnapshot(record);
  assert.equal(snapshot.finalOnly,true);assert.equal(snapshot.row.currentInningNum,3);assert.equal(snapshot.row.endTime,record.endedAt);
  assert.equal(snapshot.row.seeCardNo,3);assert.equal(snapshot.row.firstGameList[0].posType,1);assert.deepEqual(snapshot.row.firstGameList[1].cardTypePokers,[6,7,8,9,10]);
  assert.equal(nativeHistoryDetail(record),null,'missing action process cannot become a full HTTP replay');
  snapshot.row.firstGameList[0].handPais.length=0;assert.deepEqual(record,original);
});

test('legacy Jinhua conceals private opponent cards in all nested aliases and keeps only explicitly shown cards',()=>{
  const record=legacy(25),peer=record.detail.firstGameList[1];peer.showCards=[-1,-1,8];
  peer.cardTypeId=7;
  peer.cardTypeInfo={handCardList:[6,7,8]};peer.commonPoker=[6,7,8];peer.frontCards=[6,7,8];
  peer.operateList=[{gameState:3,cards:[6,7,8]},{gameState:5,nested:{handCards:[6,7,8]}}];
  const before=structuredClone(record),snapshot=nativeHistorySnapshot(record),visible=snapshot.row.firstGameList[1];
  for(const field of ['handPais','commonPoker','frontCards'])assert.deepEqual(visible[field],[-1,-1,8]);
  assert.equal(visible.cardTypeInfo,undefined);assert.deepEqual(visible.operateList[0].cards,[-1,-1,8]);
  assert.equal(visible.cardTypeId,0);
  assert.deepEqual(visible.operateList[1].nested.handCards,[-1,-1,8]);assert.deepEqual(record,before);
  assert.deepEqual(snapshot.row.firstGameList[0].handPais,[1,2,3,4,5]);
});

test('missing comparison or dealer original data stays unavailable instead of using the current room state',()=>{
  const sss=legacy(27);assert.equal(nativeHistorySnapshot(sss),null);
  sss.detail.compareResult={scoreMap:{42:100,43:-100},compareResults:[]};assert.deepEqual(nativeHistorySnapshot(sss).row.compareResult,sss.detail.compareResult);
  const blackjack=legacy(31);assert.equal(nativeHistorySnapshot(blackjack),null);
  blackjack.detail.dealerResults=[{handCards:[3,4],xiaZhuData:0}];
  const snapshot=nativeHistorySnapshot(blackjack);assert.equal(snapshot.row.firstGameList[0].banker,true);
  assert.deepEqual(snapshot.row.firstGameList[0].handResults,blackjack.detail.dealerResults);
  const unrelated=legacy();unrelated.userId=99;assert.equal(nativeHistorySnapshot(unrelated),null);
  const older=legacy();delete older.room.seeCardNo;older.detail.firstGameList[0].seeCardNo=2;
  assert.equal(nativeHistorySnapshot(older).row.seeCardNo,2,'saved per-player rule was ignored');
});

test('older string player-list format is accepted; init and unparseable details never substitute for log detail',()=>{
  const record=legacy(32);record.detail.firstGameList=JSON.stringify(record.detail.firstGameList);
  assert.equal(nativeHistorySnapshot(record).row.firstGameList.length,2);
  const throughEnd=legacy(32);throughEnd.detail.gameEndData=JSON.stringify({playerList:throughEnd.detail.firstGameList});delete throughEnd.detail.firstGameList;
  assert.equal(nativeHistorySnapshot(throughEnd).row.firstGameList[0].userName,'original-own');
  assert.equal(nativeHistorySnapshot({...record,detail:null,init:JSON.stringify(record.detail)}),null);
  assert.equal(nativeHistorySnapshot({...record,detail:'invalid'}),null);
});

test('all legacy native result formats can be queried after the hand and local history are removed',async()=>{
  for(const type of [24,25,26,27,28,30,31,32]){
    const record=legacy(type);
    if(type===27)record.detail.compareResult={scoreMap:{42:100,43:-100},compareResults:[]};
    if(type===31)record.detail.dealerResults=[{handCards:[3,4],xiaZhuData:0}];
    if([26,28,30].includes(type)){record.detail.resultList=structuredClone(record.detail.firstGameList);record.detail.bankerPos=0;}
    const original=structuredClone(record);
    const table={roomId:record.roomId,roomType:type,agentId:7,gameId:'legacy',playMode:1,ante:999,roomRules:{seeCardNo:4},hand:null,history:[]};
    const result=await queryNativeHistory({table,session:{userId:42,agentId:7,currency:'CNY'},runtime:{gateway:{getUserCenter:async()=>({records:[record]})}}},{});
    const row=type===24||type===27?result.dataInfo:type===31?{firstGameList:result.gameBackInfo.inningInfo[0]}:result.playBackList[0];
    assert.ok(row.firstGameList.length>=2,'native final result was empty for type '+type);
    assert.equal(row.firstGameList.find(player=>player.uid===42).userName,'original-own');
    if(type===24){assert.equal(result.seeCardNo,3);assert.equal(row.firstGameList[0].seeCardNo,3);}
    assert.equal(type===31?result.gameBackInfo.ante:result.ante,100,'old record used the current room stake');
    if(type===31)assert.equal(result.gameBackInfo.playMode,0,'old record used current casino mode');
    assert.deepEqual(record,original);
  }
});

test('new native snapshots preserve full replay detail without being downgraded to final-only',()=>{
  const record=legacy(32);record.detail.nativeHistory={row:{firstGameList:record.detail.firstGameList,currentInningNum:3},config:{roomType:'sgya'},events:[{uid:42,operationType:1,bet:100}]};
  const snapshot=nativeHistorySnapshot(record);assert.equal(snapshot.finalOnly,undefined);
  const detail=nativeHistoryDetail(record);assert.equal(JSON.parse(detail.exploitsInfoMsgs[0].roundList)[0].bet,100);
});

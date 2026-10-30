import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { encodeFrame, decodeFrame } from '../../game-server/src/codec.js';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function check(type) {
  const socket = new WebSocket('ws://127.0.0.1:11041'), frames = [];
  socket.on('message',data => { const frame=decodeFrame(data);if(frame)frames.push(frame); });
  const send=(id,payload)=>socket.send(encodeFrame(id,payload));
  const until=async(fn,description,timeout=7000)=>{
    const end=Date.now()+timeout;
    while(Date.now()<end){const value=fn();if(value)return value;await delay(100);}
    throw new Error('timeout '+type+' '+description);
  };
  const latest=id=>frames.findLast(f=>f.msgid===id)?.payload;
  try {
    await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
    send(1105,{userId:88020000+type,userToken:'dev-arcade-'+type,roomId:(type+50)*10000});
    await until(()=>latest(1205),'login');
    send(2102,{roomId:(type+50)*10000});await until(()=>latest(2201),'room type');
    assert.equal(latest(2201).roomType,type);
    send(6105,{roomType:type});await until(()=>latest(6205),'enter');
    const entry=latest(6205);assert.equal(Object.keys(entry.areaOdds).length,30);
    await until(()=>latest(6204)?.state===2||entry.state===2&&entry.countDown>7000,'betting',50000);
    send(6101,{roomType:type,params:[{areaId:1,total:1000}]});
    await until(()=>latest(6201),'bet');assert.equal(latest(6201).code,0);
    send(6111,{roomType:type,areaIds:[1]});await until(()=>latest(6211),'cancel');
    assert.equal(latest(6211).code,0);assert.equal(latest(6211).points,entry.points);
    const cursor=frames.length;
    send(6101,{roomType:type,params:[{areaId:13,total:100},{areaId:28,total:100}]});
    await until(()=>frames.slice(cursor).find(f=>f.msgid===6201),'normal/reverse bet');
    const receipt=frames.slice(cursor).find(f=>f.msgid===6201).payload;
    assert.equal(receipt.code,0);assert.equal(receipt.points,entry.points-200);
    const result=await until(()=>frames.slice(cursor).find(f=>f.msgid===6208&&Object.keys(f.payload.areaWinningScores||{}).length===2)?.payload,'personal settlement',50000);
    assert.equal(result.points,entry.points+result.realScore);
    assert.equal(result.winningAreas.includes(13),!result.winningAreas.includes(28));
    assert.equal(result.realScore,result.areaWinningScores[13]+result.areaWinningScores[28]);
    assert.equal(latest(6204).state,6);
    send(6121,{roomType:type});const list=await until(()=>latest(6221),'history list');assert.ok(list.list.includes(result.inning));
    send(6122,{gameRoomId:entry.roomId,currInning:result.inning});const detail=await until(()=>latest(6222),'history detail without roomType');
    assert.equal(detail.outerValue,result.outerValue);assert.equal(detail.innerValue,result.innerValue);
    assert.equal(detail.betDetailTableMap[13].realScore,result.areaWinningScores[13]);
    assert.ok(frames.some(f=>f.msgid===6202&&f.payload.allPlayerBets.some(b=>b.areaId!==13&&b.areaId!==28&&b.total>0)),'public robot bets');
    await until(()=>latest(6204)?.state===2&&latest(6204).inning>result.inning,'next round',30000);
    send(6105,{roomType:type});await delay(250);const next=latest(6205);
    assert.equal(Object.keys(next.ownBets).length,0);assert.equal(next.points,result.points);assert.equal(next.ways[1].ways.at(-1),result.innerValue);
    send(6106,{roomType:type});
    console.log('PASS_ARCADE_PROTOCOL',JSON.stringify({roomType:type,roomId:entry.roomId,inning:result.inning,points:result.points,realScore:result.realScore,nextInning:next.inning}));
  }finally{socket.close();}
}
await Promise.all([53,54,55,56,57].map(check));

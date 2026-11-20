import test from 'node:test';
import assert from 'node:assert/strict';
import {importHotModule} from '../../../shared/hot-import.js';
const {SeatGame}=await importHotModule(new URL('../../../game-server/src/core/SeatGame.js',import.meta.url).href,'seat-async-hooks');

function fixture(mode){
  const game=new SeatGame({id:'async-seat',kind:'normal',roomTypes:[19],minPeople:2,maxPeople:7}),table=game.createTable(700001,19,{carry_min:100,robot_behavior:{joinProbability:0,leaveProbability:0}});
  table.agentId=7;table.members=[{uid:42,pos:0,point:1000,bot:false},{uid:43,pos:1,point:1000,bot:false}];table.botTarget=0;
  table.phase=mode.endsWith('start')?'starting':'playing';table.startAt=0;
  if(mode.startsWith('mtt')){table.roomType=101;table.mtt={clock:{}};}
  if(mode==='expired-play')table.expiresAt=Date.now()-1;
  const ctx={table,io:{broadcast(){},forEachPlayer(){}},runtime:{}};return {game,table,ctx};
}

for(const mode of ['cash-play','cash-start','expired-play','mtt-play','mtt-start'])test(mode+': common seat tick returns the original asynchronous game hook',async()=>{
  const f=fixture(mode);let release,calls=0;const task=new Promise(resolve=>{release=resolve;});
  f.game.playTick=()=>{calls++;return task;};f.game.startRound=()=>{calls++;return task;};
  const pending=f.game.tick(f.ctx);assert.equal(pending,task,'seat parent discarded async hook');assert.equal(calls,1);release();await pending;
});

test('pending seat admission and paused matches still prevent engine hooks from starting',()=>{
  for(const mode of ['cash-play','mtt-play']){
    const f=fixture(mode);if(mode.startsWith('mtt'))f.table.mtt.paused=true;else f.table.admissionTask=Promise.resolve();
    f.game.playTick=()=>assert.fail('blocked hand advanced');f.game.startRound=()=>assert.fail('blocked hand started');assert.equal(f.game.tick(f.ctx),undefined);
  }
});

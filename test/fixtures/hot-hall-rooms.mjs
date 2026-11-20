import assert from 'node:assert/strict';
import {historyFixture} from './hot-history.mjs';
import {collectibleHallRoomFiles} from '../../shared/hot-entry-factory.js';
import * as decode from '../../hall/src/decode.js';

export const hallRoomFixture=()=>historyFixture(collectibleHallRoomFiles);
export const hallRoomRow=()=>({game_type:19,room_type:19,state:1,game_room_config_id:1901,room_index:2,play_mode:0,small_blind:10,big_blind:20,carry_min:500,payload:'{}'});

if(process.argv.includes('--hall-rooms-gc')){
  assert.equal(typeof global.gc,'function');
  const count=Number(process.argv.find(arg=>arg.startsWith('--revisions='))?.split('=')[1]||24);
  assert.ok(Number.isSafeInteger(count)&&count>=24&&count<=2000);
  const f=hallRoomFixture(),weak=[],row=hallRoomRow(),snapshot=structuredClone(row),samples=[];
  let first,expected;
  try{
    for(let revision=0;revision<count;revision++){
      f.write(revision);
      for(let index=0;index<f.sources.length;index++){
        const module=await f.load(index,revision);assert.equal(module.hotTestRevision,revision);
        const refs=[new WeakRef(module)];
        for(const value of Object.values(module))if(value&&(typeof value==='function'||typeof value==='object'))refs.push(new WeakRef(value));
        if(module.createRoomLogic){
          const logic=module.createRoomLogic(decode),payload=logic.enterRoomPayload(row,{},{});
          expected??=payload;assert.deepEqual(payload,expected);assert.equal(logic.findRoom([row],{roomType:19,gameRoomConfigId:1901}),row);
          if(revision===0)first=logic;else refs.push(new WeakRef(logic),new WeakRef(logic.findRoom));
        }
        if(module.createRoomPopulation){const population=await module.createRoomPopulation({},revision);assert.ok(population.decorate({roomType:19},row,100000).totalPeople>=8);refs.push(new WeakRef(population));}
        weak.push({revision,refs});await new Promise(resolve=>setImmediate(resolve));
      }
      if(revision%25===0||revision===count-1){global.gc();samples.push({revision,heapBytes:process.memoryUsage().heapUsed});}
    }
    for(let i=0;i<12;i++){await new Promise(resolve=>setImmediate(resolve));global.gc();}
    assert.ok(weak.filter(item=>item.revision>0&&item.revision<count-1).every(item=>item.refs.every(ref=>ref.deref()===undefined)),'released hall room graph retained');
    assert.equal(first.findRoom([row],{roomType:19,gameRoomConfigId:1901}),row);assert.deepEqual(row,snapshot);
    const stats=f.loader.stats();assert.equal(stats.activeEntries,4);assert.equal(stats.compiledEntries,4*count);assert.equal(stats.pendingEntries,0);
    console.log('PASS_HALL_ROOMS_GC',JSON.stringify({versions:count,stats,heapGrowthBytes:samples.at(-1).heapBytes-samples[0].heapBytes,samples}));
  }finally{f.close();}
}

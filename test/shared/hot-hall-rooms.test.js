import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {hallRoomFixture,hallRoomRow} from '../fixtures/hot-hall-rooms.mjs';
import * as decode from '../../hall/src/decode.js';
import {collectibleHallRoomFiles,collectibleModuleFiles} from '../../shared/hot-entry-factory.js';

test('hall room replacement keeps row identity, table visibility and entry settings',async()=>{
  assert.equal(collectibleHallRoomFiles.length,4);assert.equal(collectibleModuleFiles.length,242);
  const f=hallRoomFixture(),row=hallRoomRow(),hidden={...row,game_room_config_id:1902,force_show_card:1};
  const before=structuredClone([row,hidden]);
  try{
    f.write(0);const a=(await f.load('rooms.js',0)).createRoomLogic(decode);
    const original=a.enterRoomPayload(row,{}, {game_server:'ws://game'});
    f.write(1);const b=(await f.load('rooms.js',1)).createRoomLogic(decode);
    assert.notEqual(a.findRoom,b.findRoom);
    for(const logic of [a,b]){
      assert.equal(logic.findRoom([hidden,row],{roomType:19,forceShowCard:false}),row);
      assert.equal(logic.findRoom([hidden],{roomType:19,forceShowCard:false}),null);
      assert.deepEqual(logic.enterRoomPayload(row,{}, {game_server:'ws://game'}),original);
      assert.equal(logic.findRoom([row],{roomType:19,carryMin:1000}),null);
    }
    assert.deepEqual([row,hidden],before);
  }finally{f.close();}
});

test('population configuration changes reach new factories without mutating an old request',async()=>{
  const f=hallRoomFixture(),row=hallRoomRow(),at=Date.UTC(2026,10,20,4);
  try{
    f.write(0);const old=await (await f.load('room-population.js',0)).createRoomPopulation({},0);
    const before=old.decorate({roomType:19},row,at);
    const config=f.sources.find(item=>item.file.endsWith('room-population-config.js'));
    config.source=config.source.replace('enabled: true','enabled: false');
    f.write(1);const next=await (await f.load('room-population.js',1)).createRoomPopulation({},1);
    assert.equal(old.enabled,true);assert.equal(next.enabled,false);
    const room={roomType:19};assert.equal(next.decorate(room,row,at),room);
    assert.deepEqual(old.decorate({roomType:19},row,at),before);
  }finally{f.close();}
});

test('released hall selection and population source versions can be collected',()=>{
  const result=spawnSync(process.execPath,['--expose-gc','test/fixtures/hot-hall-rooms.mjs','--hall-rooms-gc'],{encoding:'utf8',windowsHide:true,timeout:60000});
  assert.equal(result.status,0,result.stderr||result.stdout);assert.match(result.stdout,/PASS_HALL_ROOMS_GC/);
});

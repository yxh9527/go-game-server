import test from 'node:test';
import assert from 'node:assert/strict';
import { seedRooms } from '../../cache/rpc/seed.js';
import * as decode from '../../hall/src/decode.js';
import { createRoomLogic } from '../../hall/src/rooms.js';
test('all 14 original niuniu tiers route by mode, ante, look count, classification and admission',()=>{
  const logic=createRoomLogic(decode), rows=seedRooms().filter(r=>r.room_type===24);
  assert.equal(rows.length,14);
  for(const row of rows){
    const payload=JSON.parse(row.payload);
    assert.equal(logic.findRoom(rows,payload),row);
    const entering=logic.enterRoomPayload(row,{},{});
    assert.equal(entering.key,payload.key);
    assert.equal(entering.seeCardNo,row.see_card_no);
  }
  assert.equal(logic.findRoom(rows,{roomType:24,ante:10,seeCardNo:3,carryMin:1000,roomClassification:2,playMode:3}),null);
});

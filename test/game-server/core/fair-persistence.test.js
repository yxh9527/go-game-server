import {importHotModule} from '../../../shared/hot-import.js';
import test from 'node:test';
import assert from 'node:assert/strict';
const {beginFairHand,finishFairHand,flushFairProof,deliverAfterFairProof,restoreFairProof,fairCodeDetail}=await importHotModule(new URL('../../../game-server/src/core/fair-code.js',import.meta.url).href,'room-runtime-regression');

test('formal proof is saved before releasing packets, retries the same commitment, and masks private cards after restoring',async()=>{
 const table={roomId:11,roomType:19,gameId:'holdem',agentId:7,currentInning:1,createdAt:1,members:[{uid:1,pos:0},{uid:2,pos:1}],observers:[],hand:{deck:Array.from({length:52},(_,i)=>i),board:[5,6,7]}};
 const writes=[],delivered=[],callbacks=[];let outage=true;
 const io={env:'prod',broadcast(){},wallet:{deliver:f=>callbacks.push(f)},writeFairProof:async record=>{writes.push(structuredClone(record));if(outage)throw Error('storage down')}};
 beginFairHand(io,table,table.members,2);deliverAfterFairProof(table,{close(){assert.fail('unexpected close')}},Buffer.from('private'),()=>delivered.push('cards'));
 assert.deepEqual(delivered,[]);callbacks[0]();await table.fairPersistence.task;assert.equal(writes.length,1);assert.deepEqual(delivered,[]);
 await flushFairProof(table);assert.equal(writes.length,1,'failed storage should not retry on every game tick');
 outage=false;await flushFairProof(table,table.fairPersistence.retryAt);assert.deepEqual(delivered,['cards']);assert.equal(writes[0].notarizationCode,writes[1].notarizationCode);
 finishFairHand(table,[{uid:1,showCards:[]},{uid:2,showCards:[]}]);await flushFairProof(table);
 const stored=writes.at(-1),record=restoreFairProof(stored),restored={currentInning:1,fairCodes:new Map([[1,record]])};
 const view=fairCodeDetail(restored,1,1);assert.ok(view.pokerList[0].secretKey);assert.equal(view.pokerList[2].secretKey,'');assert.equal(fairCodeDetail(restored,3,1),null);
 assert.equal(table.fairPersistence.pending.size,0);
});

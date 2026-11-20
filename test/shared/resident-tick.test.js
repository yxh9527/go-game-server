import test from 'node:test';
import assert from 'node:assert/strict';
import {runResidentTick} from '../../shared/resident-tick.js';

test('resident timer observes synchronous and asynchronous errors and permits later ticks',async()=>{
 const state={},errors=[];
 await runResidentTick(state,()=>{throw Error('sync')},error=>errors.push(error.message));
 await runResidentTick(state,async()=>{throw Error('async')},error=>errors.push(error.message));
 let completed=false;await runResidentTick(state,async()=>completed=true,error=>errors.push(error.message));
 assert.deepEqual(errors,['sync','async']);assert.equal(completed,true);assert.equal(state.task,null);
});

test('slow resident work is coalesced and later ticks pick up the current handler',async()=>{
 const state={};let release,runs=0;
 const held=new Promise(resolve=>release=resolve);
 let handler={async tick(){runs++;await held;}};
 const first=runResidentTick(state,()=>handler.tick(),assert.fail);
 for(let i=0;i<100;i++)assert.equal(runResidentTick(state,()=>handler.tick(),assert.fail),first);
 await Promise.resolve();assert.equal(runs,1);
 handler={tick(){runs+=10}};release();await first;
 await runResidentTick(state,()=>handler.tick(),assert.fail);assert.equal(runs,11);
});

test('a logging failure cannot leave an unhandled rejection or a permanently busy loop',async()=>{
 const state={};await runResidentTick(state,()=>Promise.reject(Error('RPC failed')),()=>{throw Error('logger failed')});
 assert.equal(state.task,null);
});

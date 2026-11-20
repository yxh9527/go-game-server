import test from 'node:test';
import assert from 'node:assert/strict';
import {createAdminSubmissions} from '../../match/src/admin-submissions.js';

test('repeated submits share one form lock and execute only the first operation',async()=>{
  const state=createAdminSubmissions(),form={};let calls=0,finish;
  const pending=state.submit(form,()=>{calls++;return new Promise(resolve=>{finish=resolve;});});
  assert.equal(state.submit(form,()=>{calls++;}),false);assert.equal(calls,1);assert.equal(state.stats().pendingForms,1);
  finish({saved:true});assert.deepEqual(await pending,{saved:true});assert.equal(state.stats().pendingForms,0);
  assert.equal(await state.submit(form,()=>{calls++;return 'next';}),'next');assert.equal(calls,2);
});

test('independent forms can submit concurrently and release only their own lock',async()=>{
  const state=createAdminSubmissions(),match={},ticket={};let finishMatch,finishTicket;
  const a=state.submit(match,()=>new Promise(resolve=>{finishMatch=resolve;}));
  const b=state.submit(ticket,()=>new Promise(resolve=>{finishTicket=resolve;}));
  assert.equal(state.stats().pendingForms,2);finishTicket('issued');assert.equal(await b,'issued');
  assert.equal(state.stats().pendingForms,1);assert.equal(state.submit(match,()=>assert.fail('duplicate match')),false);
  finishMatch('saved');assert.equal(await a,'saved');assert.equal(state.stats().pendingForms,0);
});

test('failed operations unlock the form without automatic retries and allow an explicit retry',async()=>{
  const state=createAdminSubmissions(),form={};let calls=0;
  await assert.rejects(state.submit(form,async()=>{calls++;throw Error('request failed');}),/request failed/);
  assert.equal(calls,1);assert.equal(state.stats().pendingForms,0);
  await assert.rejects(state.submit(form,()=>{calls++;throw Error('validation failed');}),/validation failed/);
  assert.equal(calls,2);assert.equal(state.stats().pendingForms,0);
  assert.equal(await state.submit(form,()=>{calls++;return 'explicit retry';}),'explicit retry');assert.equal(calls,3);
});

test('the lock is installed before synchronous event handlers can submit again',async()=>{
  const state=createAdminSubmissions(),form={};
  const result=state.submit(form,()=>{
    assert.equal(state.stats().pendingForms,1);
    assert.equal(state.submit(form,()=>assert.fail('nested submission executed')),false);
    return 'saved';
  });
  assert.equal(await result,'saved');assert.equal(state.stats().pendingForms,0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {createHandler} from '../../game-server/src/create-handler.js';
import {createRegistry} from '../../game-server/src/registry.js';
import {encodeFrame,decodeFrame} from '../../game-server/src/codec.js';
import {SEND} from '../../game-server/src/messages.js';

async function fixture(){
  const registry=createRegistry(),frames=[],logs=[],calls={credit:0,persist:0};
  const runtime={env:'dev',hotVersion:'leave-task-lifecycle',registry,configs:[],findConfig:()=>null,
    wallet:{async persist(){calls.persist++;},credit(){calls.credit++;assert.fail('an already credited exit was paid twice');}},log:{info(){},warn(){},error:(...args)=>logs.push(args)}};
  const handler=await createHandler(runtime),game=handler.games.byRoomType.get(19),table=game.createTable(700001,19,{small_blind:5,big_blind:10,carry_min:100});table.agentId=7;table.botTarget=0;
  registry.setTable(table.roomId,table,7,'holdem');const ws={readyState:1,send:raw=>frames.push(decodeFrame(raw))};
  const session={userId:42,agentId:7,roomId:table.roomId,gameId:'holdem',authenticated:true,inRoom:false,wallet:1000};registry.bind(ws,session);
  session.roomLeave={table,detached:true,credited:true,persisted:true,cash:500};
  return {runtime,handler,registry,ws,session,table,frames,logs,calls};
}

test('a finished original leave task is cleared by its waiter without changing the credited exit progress',async()=>{
  const f=await fixture(),progress=f.session.roomLeave;f.session.leaveTask=Promise.resolve();
  await f.handler.onMessage(f.ws,encodeFrame(SEND.SEND_LEVEL_OUT));assert.equal(f.session.leaveTask,undefined);assert.equal(f.session.roomLeave,progress);assert.equal(progress.credited,true);assert.equal(f.calls.credit,0);
  await f.handler.onMessage(f.ws,encodeFrame(SEND.SEND_LEVEL_OUT));assert.equal(f.session.roomLeave,undefined);assert.equal(f.calls.credit,0);assert.equal(f.session.wallet,1000);
});

test('a rejected original leave task is cleared and explicit retry resumes original progress without another credit',async()=>{
  const f=await fixture();let reject;f.session.leaveTask=new Promise((resolve,fail)=>{reject=fail;});
  const request=f.handler.onMessage(f.ws,encodeFrame(SEND.SEND_LEVEL_OUT)),failed=assert.rejects(request,/original exit failed/);await new Promise(resolve=>setImmediate(resolve));reject(Error('original exit failed'));await failed;
  assert.equal(f.session.leaveTask,undefined);assert.equal(f.session.roomLeave.credited,true);assert.equal(f.calls.credit,0);
  await f.handler.onMessage(f.ws,encodeFrame(SEND.SEND_LEVEL_OUT));assert.equal(f.session.roomLeave,undefined);assert.equal(f.calls.credit,0);assert.equal(f.session.wallet,1000);
});

test('background tick observes an unknown failed leave once and resumes only its remaining persistence',async()=>{
  const f=await fixture();let reject;f.session.roomLeave.persisted=false;f.session.leaveTask=new Promise((resolve,fail)=>{reject=fail;});
  await f.handler.tick();await f.handler.tick();assert.equal(f.calls.persist,0);assert.equal(f.calls.credit,0);
  reject(Error('old exit notification failed'));await new Promise(resolve=>setImmediate(resolve));assert.equal(f.logs.filter(row=>row[0]==='original room leave failed').length,1);assert.equal(f.session.leaveTask,undefined);
  await f.handler.tick();assert.equal(f.calls.persist,1);assert.equal(f.calls.credit,0);assert.equal(f.session.roomLeave,undefined);assert.equal(f.session.wallet,1000);
});

test('an old leave waiter cannot erase the newer task that a concurrent operation installed',async()=>{
  const f=await fixture();let release,releaseNext;const original=new Promise(resolve=>{release=resolve;}),next=new Promise(resolve=>{releaseNext=resolve;});f.session.leaveTask=original;
  const request=f.handler.onMessage(f.ws,encodeFrame(SEND.SEND_LEVEL_OUT));await new Promise(resolve=>setImmediate(resolve));f.session.leaveTask=next;release();await request;
  assert.equal(f.session.leaveTask,next);assert.equal(f.session.roomLeave.credited,true);assert.equal(f.calls.credit,0);
  const following=f.handler.onMessage(f.ws,encodeFrame(SEND.SEND_LEVEL_OUT));releaseNext();await following;assert.equal(f.session.leaveTask,undefined);
});

test('disconnect reports an original leave failure, then can finish cleanup on a later explicit attempt without repayment',async()=>{
  const f=await fixture();let reject;f.session.leaveTask=new Promise((resolve,fail)=>{reject=fail;});
  const closing=f.handler.onClose(f.ws),failed=assert.rejects(closing,/unfinished exit failed/);await new Promise(resolve=>setImmediate(resolve));reject(Error('unfinished exit failed'));await failed;
  assert.equal(f.session.leaveTask,undefined);assert.equal(f.registry.session(f.ws),f.session);assert.equal(f.session.roomLeave.credited,true);
  await f.handler.onClose(f.ws);assert.equal(f.registry.session(f.ws),null);assert.equal(f.session.roomLeave,undefined);assert.equal(f.calls.credit,0);assert.equal(f.session.wallet,1000);
});

test('handler replacement shares leave observation and the original credit operation object remains unchanged',async()=>{
  const f=await fixture(),progress=f.session.roomLeave;let release,credits=0,operation;
  progress.credited=false;f.runtime.wallet.credit=async(session,amount,meta)=>{credits++;operation=meta.operation;session.wallet+=amount;return {ok:true};};
  f.session.leaveTask=new Promise(resolve=>{release=resolve;});await f.handler.tick();const statuses=f.runtime.leaveTaskStatus;
  f.runtime.hotVersion+='-next';const next=await createHandler(f.runtime);await next.tick();assert.equal(f.runtime.leaveTaskStatus,statuses);assert.equal(credits,0);
  release();await new Promise(resolve=>setImmediate(resolve));await next.tick();assert.equal(credits,1);assert.equal(operation,progress);assert.equal(f.session.wallet,1500);assert.equal(f.session.roomLeave,undefined);
  await next.tick();assert.equal(credits,1);assert.equal(f.session.wallet,1500);
});

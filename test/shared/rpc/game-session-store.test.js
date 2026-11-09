import assert from 'node:assert/strict';
import test from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {createGameSessionStore,createInMemoryGameSessionBackend,GAME_SESSION_SCRIPT,GAME_SESSION_TTL_MS} from '../../../shared/rpc/game-session-store.js';

test('distributed lease store fences replacements and only admits a matching hundred overlay',async()=>{
 const backend=createInMemoryGameSessionBackend(),a=createGameSessionStore({backend,instanceId:'a'}),b=createGameSessionStore({backend,instanceId:'b'});
 const revoked=[];a.subscribe(message=>revoked.push(JSON.parse(message)));
 const primary={agentId:7,userId:42,roomId:700001,gameId:'holdem',roomType:19,inRoom:false,loginId:'login-a',socketId:'primary'};
 const first=await a.claim(primary,{identity:'device-a'});assert.equal(first.role,'primary');assert.equal(await a.verify(primary),true);
 assert.equal(await a.updateRoom(primary,{roomType:19}),true);
 primary.inRoom=true;assert.equal(await a.updateRoom(primary,{roomType:19}),true);
 const overlay={...primary,gameId:undefined,roomType:undefined,inRoom:false,loginId:'login-overlay',socketId:'overlay'};
 const paired=await b.claim(overlay,{identity:'device-a',allowPair:true});assert.equal(paired.loginId,first.loginId);assert.equal(paired.role,'hundred');
 assert.equal(await a.verify(primary),true);assert.equal(await b.verify({...overlay,loginId:paired.loginId}),true);
 const replacement={...primary,loginId:'login-b',socketId:'replacement'};
 await b.claim(replacement,{identity:'device-b'});
 assert.equal(await a.verify(primary),false);assert.equal(await b.verify({...overlay,loginId:first.loginId}),false);
 assert.equal(revoked.length,1);assert.equal(revoked[0].loginId,first.loginId);
 await a.release(primary);assert.equal(await b.verify(replacement),true);
});

test('closing an auxiliary keeps the primary owner and permits a replacement auxiliary on another node',async()=>{
 const backend=createInMemoryGameSessionBackend(),a=createGameSessionStore({backend,instanceId:'a'}),b=createGameSessionStore({backend,instanceId:'b'});
 const primary={agentId:7,userId:42,roomId:700001,gameId:'holdem',inRoom:true,loginId:'primary',socketId:'p'};
 await a.claim(primary,{identity:'same'});await a.updateRoom(primary,{roomType:19});
 const aux={agentId:7,userId:42,roomId:700001,loginId:'aux',socketId:'a'};
 const pair=await b.claim(aux,{identity:'same',allowPair:true});aux.loginId=pair.loginId;
 await b.release(aux);assert.equal(await a.verify(primary),true);
 const second={...aux,loginId:'aux-2',socketId:'b'};
 assert.equal((await b.claim(second,{identity:'same',allowPair:true})).role,'hundred');
 assert.equal(await a.verify(primary),true);
});

test('redis implementation uses atomic claim, fencing counter, ttl and cross-node revocation',async()=>{
 assert.equal(GAME_SESSION_TTL_MS,30000);
 assert.match(GAME_SESSION_SCRIPT,/INCR/);assert.match(GAME_SESSION_SCRIPT,/PUBLISH/);
 assert.match(GAME_SESSION_SCRIPT,/old\.primary\.identity==input\.identity/);
 assert.match(GAME_SESSION_SCRIPT,/redis\.call\('PEXPIRE'/);assert.match(GAME_SESSION_SCRIPT,/tonumber\(input\.attempt or 0\)<latest/);
 assert.match(GAME_SESSION_SCRIPT,/record\.primary\.socketId==input\.socketId/);
});

test('production-required session coordination fails closed without Redis',async()=>{
 const store=createGameSessionStore({redis:null,required:true,instanceId:'production'});
 const session={agentId:7,userId:42,loginId:'login',socketId:'socket'};
 await assert.rejects(store.beginAttempt(42),{code:'SESSION_STORE_UNAVAILABLE'});
 await assert.rejects(store.claim(session,{identity:'device',attempt:1}),{code:'SESSION_STORE_UNAVAILABLE'});
 await assert.rejects(store.withSession(session,async()=>{}),{code:'SESSION_STORE_UNAVAILABLE'});
});

test('a later login attempt fences a slower authenticated attempt before it can replace the current owner',async()=>{
 const backend=createInMemoryGameSessionBackend(),store=createGameSessionStore({backend,instanceId:'node'});
 const oldAttempt=await store.beginAttempt(42),newAttempt=await store.beginAttempt(42);
 const stale=await store.claim({agentId:7,userId:42,loginId:'slow',socketId:'slow'},
   {identity:'device',attempt:oldAttempt});
 assert.equal(stale.ok,false);assert.equal(stale.stale,true);
 const current=await store.claim({agentId:7,userId:42,loginId:'fast',socketId:'fast'},
   {identity:'device',attempt:newAttempt});
 assert.equal(current.ok,true);assert.equal(await store.verify({agentId:7,userId:42,loginId:'fast',socketId:'fast'}),true);
});

test('replacement waits for an already admitted game action and fences the old owner afterward',async()=>{
 const backend=createInMemoryGameSessionBackend(),a=createGameSessionStore({backend,instanceId:'a'}),b=createGameSessionStore({backend,instanceId:'b'});
 const attempt=await a.beginAttempt(42),old={agentId:7,userId:42,loginId:'old',socketId:'old'};
 await a.claim(old,{identity:'old',attempt});
 let releaseAction,startedAction,startedReplacement;
 const running=a.withSession(old,async()=>{startedAction?.();await new Promise(resolve=>{releaseAction=resolve;});return 'committed';});
 await new Promise(resolve=>{startedAction=resolve;});
 const attemptB=await b.beginAttempt(42),replacement={agentId:7,userId:42,loginId:'new',socketId:'new'};
 const claiming=b.claim(replacement,{identity:'new',attempt:attemptB}).then(value=>{startedReplacement?.();return value;});
 await delay(10);assert.equal(await a.verify(old),true,'lease identity remains stable while the old action owns the account lock');
 let replaced=false;startedReplacement=()=>{replaced=true;};
 assert.equal(replaced,false);releaseAction();assert.equal(await running,'committed');
 assert.equal((await claiming).ok,true);assert.equal(await a.verify(old),false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {historyFixture} from '../../fixtures/hot-history.mjs';
import {createAuthoritativeWallet} from '../../../game-server/src/wallet/authoritative.js';
import {createRegistry} from '../../../game-server/src/registry.js';

const games=[['holdem','HoldemGame'],['zjh','ZjhGame'],['niuniu','NiuniuGame'],['sss','SssGame'],['sgay','SgayGame'],['mahjong','MahjongGame'],['blackjack','BlackjackGame']];

function fixture(){
  // Keep real class source and dependencies. Only its direct engine is an
  // isolated controllable implementation, without changing business files.
  const files=games.flatMap(([id,Class])=>[Class+'.js','engine.js'].map(name=>fileURLToPath(new URL('../../../game-server/src/games/'+id+'/'+name,import.meta.url))));
  const f=historyFixture(files);
  for(const item of f.sources)if(item.file.endsWith('engine.js'))item.source=[
    'export const controls={};',
    'export function begin(...args){return controls.begin(...args);}',
    'export function beginHand(...args){return controls.begin(...args);}',
    'export function tick(...args){return controls.play(...args);}',
    'export function tickPlaying(...args){return controls.play(...args);}',
  ].join('\n');
  f.write(0);return f;
}

for(const [id,Class]of games)test(id+': real game wrapper propagates asynchronous engine start and play results and errors',async()=>{
  const f=fixture();try{
    const module=await f.load(id+'/'+Class+'.js',0),engine=await f.load(id+'/engine.js',0),game=new module[Class](),ctx={io:{},table:{playMode:0,hand:{original:true}}};
    let release,calls=0;const begin=new Promise(resolve=>{release=resolve;});
    engine.controls.begin=(io,table)=>{assert.equal(io,ctx.io);assert.equal(table,ctx.table);calls++;return begin;};
    assert.equal(game.startRound(ctx),begin,'wrapper dropped the engine start promise');assert.equal(calls,1);release('started');assert.equal(await begin,'started');
    const failure=Error('original engine rejected');engine.controls.play=(io,table,now)=>{assert.equal(io,ctx.io);assert.equal(table,ctx.table);assert.equal(now,12345);calls++;return Promise.reject(failure);};
    await assert.rejects(game.playTick(ctx,12345),error=>error===failure);assert.equal(calls,2);
    const startFailure=Error('original start rejected');engine.controls.begin=()=>Promise.reject(startFailure);await assert.rejects(game.startRound(ctx),error=>error===startFailure);
    engine.controls.begin=()=>undefined;engine.controls.play=()=>undefined;assert.equal(game.startRound(ctx),undefined);assert.equal(game.playTick(ctx,12345),undefined);
  }finally{f.close();}
});

test('blackjack waits for async engine terminal cleanup before calling and awaiting afterRound',async()=>{
  const f=fixture();try{
    const {BlackjackGame}=await f.load('blackjack/BlackjackGame.js',0),engine=await f.load('blackjack/engine.js',0),game=new BlackjackGame(),ctx={io:{},table:{playMode:0,hand:{original:true}}};
    let release,releaseCleanup,calls=0,completed=false;
    const gate=new Promise(resolve=>{release=resolve;}),cleanup=new Promise(resolve=>{releaseCleanup=resolve;});
    engine.controls.play=async()=>{await gate;ctx.table.hand=null;};game.afterRound=()=>{calls++;assert.equal(ctx.table.hand,null);return cleanup;};
    const pending=game.playTick(ctx,100).then(()=>{completed=true;});assert.equal(calls,0);assert.equal(completed,false);release();await new Promise(resolve=>setImmediate(resolve));
    assert.equal(calls,1);assert.equal(completed,false);releaseCleanup();await pending;assert.equal(completed,true);
    ctx.table.hand={original:true};engine.controls.play=async()=>{await Promise.resolve();throw Error('engine before end failed');};await assert.rejects(game.playTick(ctx,100),/engine before end failed/);assert.equal(calls,1);
  }finally{f.close();}
});

test('real Holdem wrapper and common SeatGame parent keep an async engine inside one authoritative transaction',async()=>{
  for(const failed of [false,true]){
    const f=fixture();try{
      const {HoldemGame}=await f.load('holdem/HoldemGame.js',0),engine=await f.load('holdem/engine.js',0),game=new HoldemGame(),registry=createRegistry(),sent=[],requests=[];
      let stored={balance:1000,revision:0,carry:null,ttlMs:0};
      const common={async cashRead(){return structuredClone(stored);},async cashApply(request){
        requests.push(structuredClone(request));assert.equal(request.accounts[0].revision,stored.revision);
        for(const step of request.steps){if(step.kind==='reserve')stored.carry={amount:step.amount,token:step.token,tableKey:step.tableKey,revision:1};else if(step.kind==='carryDelta'){stored.balance+=step.amount;stored.carry.amount+=step.amount;stored.carry.revision++;}else assert.fail('unexpected step '+step.kind);}
        stored.revision++;stored.ttlMs=300000;return {accounts:[{...request.accounts[0],...structuredClone(stored)}]};
      }};
      const wallet=createAuthoritativeWallet({common}),session={userId:42,agentId:7,currency:'CNY',authenticated:true},runtime={registry,wallet};registry.bind({},session);await wallet.load(session);
      const table={roomId:700001,roomType:19,gameId:'holdem',kind:'normal',cfg:{robot_behavior:{joinProbability:0,leaveProbability:0}},createdAt:Date.now(),expiresAt:Date.now()+28800000,carryMin:100,members:[],observers:[],currentInning:1},member={uid:42,pos:0,point:0,state:2,bot:false};table.agentId=7;table.members=[member];table.phase='playing';table.hand={original:true};table.botTarget=0;registry.setTable(table.roomId,table,7,'holdem');
      await wallet.run(()=>wallet.reserveCarry(session,member,table,500),runtime);let release,started;
      const gate=new Promise(resolve=>{release=resolve;}),entered=new Promise(resolve=>{started=resolve;});
      engine.controls.play=async()=>{member.point-=100;started();await gate;if(failed)throw Error('copied actual engine failed');table.phase='completed';wallet.deliver(()=>sent.push('confirmed'));};
      const ctx={table,runtime,io:{broadcast(){},forEachPlayer(){}}},running=wallet.run(()=>game.tick(ctx),runtime);await entered;assert.equal(requests.length,1);assert.deepEqual(sent,[]);release();
      if(failed)await assert.rejects(running,/copied actual engine failed/);else await running;
      assert.equal(requests.length,failed?1:2);assert.equal(stored.balance,failed?1000:900);assert.equal(member.point,failed?500:400);assert.equal(table.phase,failed?'playing':'completed');assert.deepEqual(sent,failed?[]:['confirmed']);
    }finally{f.close();}
  }
});

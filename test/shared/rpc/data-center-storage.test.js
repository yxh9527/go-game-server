import test from 'node:test';
import assert from 'node:assert/strict';
import * as grpc from '@grpc/grpc-js';
import * as loader from '@grpc/proto-loader';
import {fileURLToPath} from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';
import {loadEnv} from '../../../shared/rpc/env.js';
import {RpcAdapter,refreshDataAccess} from '../../../shared/rpc/adapters/rpcAdapter.js';
import {createDataCenterStore} from '../../../shared/rpc/implementations/prod/dataCenterStore.js';
import {getGogameStorageClient,closeGogameStorageClient} from '../../../shared/rpc/utils/gogameStorageGrpc.js';

async function fixture(t){
  const definition=loader.loadSync(fileURLToPath(new URL('../../../shared/rpc/proto/gogame.proto',import.meta.url)),{keepCase:true,defaults:true});
  const service=grpc.loadPackageDefinition(definition).datacenter.GogameStorageService;
  const server=new grpc.Server(),calls=[],events=[],locks=new Map();
  const rows=new Map([[9,{row:{id:9,agent_id:11,state:1},state:{registrations:{},outbox:[],seq:0}}]]);
  function authorized(call){return call.metadata.get('x-gogame-storage-token')[0]==='test-secret';}
  let rejectCommit=false,disconnectCommit=false;
  server.addService(service.service,{
    Call(call,reply){
      if(!authorized(call))return reply({code:grpc.status.PERMISSION_DENIED,message:'forbidden'});
      const {operation,payload}=call.request;calls.push({operation,payload:JSON.parse(payload)});
      if(operation==='getMatch')return reply(null,{phase:'result',payload:JSON.stringify(rows.get(JSON.parse(payload).id)?.row??null)});
      if(operation==='countUnusedTickets')return reply(null,{phase:'result',payload:'2'});
      if(operation==='listRooms')return reply(null,{phase:'result',payload:'[{"room_type":19}]'});
      if(operation==='listSchedules')return reply(null,{phase:'result',payload:'[{"id":3,"agent_id":11}]'});
      if(operation==='insertMatch')return reply(null,{phase:'result',payload:JSON.stringify({...JSON.parse(payload).row,id:10})});
      return reply({code:grpc.status.INVALID_ARGUMENT,message:'unsupported operation'});
    },
    MatchTransaction(call){
      if(!authorized(call)){call.emit('error',{code:grpc.status.PERMISSION_DENIED,message:'forbidden'});return;}
      let stage='begin',closed=false,release,document,chain=Promise.resolve();
      const unlock=()=>{release?.();release=null;};
      call.on('error',()=>{});
      call.on('cancelled',()=>{closed=true;if(stage==='working')events.push('rollback');unlock();});
      call.on('data',message=>{
        chain=chain.then(async()=>{
          if(closed)return;
          if(stage==='begin'){
            assert.equal(message.operation,'begin');const {id}=JSON.parse(message.payload);
            const before=locks.get(id)||Promise.resolve();let resolve;const held=new Promise(r=>{resolve=r;});locks.set(id,before.then(()=>held));
            await before;release=resolve;if(closed){unlock();return;}
            document=structuredClone(rows.get(id));
            if(!document){stage='absent';call.write({phase:'absent',payload:'null'});unlock();call.end();return;}
            stage='working';events.push('lock');call.write({phase:'snapshot',payload:JSON.stringify(document)});return;
          }
          assert.equal(stage,'working');assert.equal(message.operation,'commit');
          if(rejectCommit)throw Object.assign(new Error('storage failed'),{code:grpc.status.UNAVAILABLE});
          document=JSON.parse(message.payload);rows.set(document.row.id,document);events.push('commit');stage='committed';unlock();
          if(disconnectCommit){call.emit('error',{code:grpc.status.UNAVAILABLE,message:'acknowledgment lost'});return;}
          call.write({phase:'committed',payload:'null'});call.end();
        }).catch(error=>{events.push('rollback');closed=true;unlock();call.emit('error',error);});
      });
    },
  });
  const port=await new Promise((resolve,reject)=>server.bindAsync('127.0.0.1:0',grpc.ServerCredentials.createInsecure(),(error,port)=>error?reject(error):resolve(port)));
  const config={env:'prod',data_center:'127.0.0.1:'+port,data_center_token:'test-secret'};
  Object.defineProperty(config,'mysql',{get(){assert.fail('Node must not load database credentials');}});loadEnv(config);
  t.after(()=>{closeGogameStorageClient();loadEnv({env:'dev'});server.forceShutdown();});
  return {config,calls,events,rows,store:createDataCenterStore(),rejectCommit:v=>{rejectCommit=v;},loseAck:v=>{disconnectCommit=v;}};
}

test('production lobby fetches configuration and manager data only through authenticated data-center gRPC',async t=>{
  const f=await fixture(t),rpc=new RpcAdapter();
  assert.deepEqual(await rpc.lobby.listRooms(),[{room_type:19}]);
  assert.equal((await rpc.lobby.getMatch(9)).agent_id,11);
  assert.equal((await rpc.lobby.insertMatch({agent_id:11,init_point:1000})).id,10);
  assert.equal(await rpc.lobby.countUnusedTickets(10001),2);
  assert.equal((await f.store.listSchedules())[0].agent_id,11);
  assert.deepEqual(f.calls.map(c=>c.operation),['listRooms','getMatch','insertMatch','countUnusedTickets','listSchedules']);
  await assert.rejects(()=>rpc.lobby.getAward(1),error=>error.status===400);
  loadEnv({...f.config,data_center_token:'wrong'});
  await assert.rejects(()=>getGogameStorageClient().then(c=>c.call('listRooms')),error=>error.status===403);
  loadEnv({env:'prod',data_center:f.config.data_center});
  const token=process.env.GOGAME_DATA_CENTER_TOKEN;delete process.env.GOGAME_DATA_CENTER_TOKEN;
  try{await assert.rejects(()=>getGogameStorageClient(),/存储凭证/);}finally{if(token!==undefined)process.env.GOGAME_DATA_CENTER_TOKEN=token;}
});

test('streamed match transactions serialize concurrent updates and confirm journal commits',async t=>{
  const f=await fixture(t);
  const values=await Promise.all(Array.from({length:4},()=>f.store.withMatch(9,async({row,state})=>{
    state.seq++;state.registrations[10000+state.seq]={status:'refund_pending'};
    await new Promise(resolve=>setImmediate(resolve));row.current_player=state.seq;return state.seq;
  })));
  assert.deepEqual(values,[1,2,3,4]);assert.equal(f.rows.get(9).row.current_player,4);
  assert.equal(f.rows.get(9).state.seq,4);assert.equal(Object.keys(f.rows.get(9).state.registrations).length,4);
  assert.deepEqual(f.events,['lock','commit','lock','commit','lock','commit','lock','commit']);
  assert.equal(await f.store.withMatch(404,()=>assert.fail('missing match must not execute callback')),null);
});

test('hot reload upgrades existing adapter objects without losing resident references',async t=>{
  const f=await fixture(t),rpc=new RpcAdapter(),lobby=rpc.lobby,common=rpc.common;
  lobby.store={listRooms(){assert.fail('old direct database store must be replaced');}};
  common.persistScore=()=>assert.fail('old direct score writer must be replaced');
  await refreshDataAccess({env:'prod',hotVersion:'storage-hot-test',rpc});
  assert.equal(rpc.lobby,lobby);assert.equal(rpc.common,common);
  assert.deepEqual(await lobby.listRooms(),[{room_type:19}]);
  assert.equal((await lobby.getMatch(9)).id,9);
});

test('callback cancellation and failed commit never report successful persistence; lost acknowledgments stay uncertain',async t=>{
  const f=await fixture(t);
  await assert.rejects(()=>f.store.withMatch(9,({row})=>{row.state=4;throw new Error('wallet unavailable');}),/wallet unavailable/);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.rows.get(9).row.state,1);
  f.rejectCommit(true);
  await assert.rejects(()=>f.store.withMatch(9,({row})=>{row.state=4;}),error=>error.status===503);
  assert.equal(f.rows.get(9).row.state,1);
  f.rejectCommit(false);f.loseAck(true);
  await assert.rejects(()=>f.store.withMatch(9,({row})=>{row.state=4;}),error=>error.status===503);
  assert.equal(f.rows.get(9).row.state,4,'after losing commit acknowledgment, retry must read the authoritative result');
});

test('Node production trees contain no MySQL driver, SQL statements or MySQL connection configuration',async()=>{
  const root=fileURLToPath(new URL('../../../',import.meta.url));
  for(const dir of ['shared/rpc','hall/src','game-server/src','match/src']){
    for(const file of await fs.readdir(path.join(root,dir),{recursive:true})){
      if(!file.endsWith('.js'))continue;
      const source=await fs.readFile(path.join(root,dir,file),'utf8');
      assert.doesNotMatch(source,/mysql2|createMysqlStore|createMysqlTournamentStore|prodDeps\.(?:player|manager)/,dir+'/'+file);
      assert.doesNotMatch(source,/\b(?:SELECT\s+.+?\s+FROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET)\b/i,dir+'/'+file);
    }
  }
  const pkg=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
  assert.equal(pkg.dependencies.mysql2,undefined);
  for(const service of ['hall','game-server','match'])assert.doesNotMatch(await fs.readFile(path.join(root,service,'config.yaml'),'utf8'),/^mysql:/m);
});

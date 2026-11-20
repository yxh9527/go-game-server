import {randomUUID} from 'node:crypto';
import {scratchCandidates} from './control-plan.js';
import {kindOf,ERROR,prizeFromMask} from './rules.js';
import {list as persistedHistory} from './history.js';

const ownerKey=Symbol.for('gogame.scratch.rpc.tasks.v1');
const MAX_ACCOUNT_TASKS=8,MAX_PENDING_TASKS=256;
const uncertain=error=>error?.uncertain||[1,2,4,13,14].includes(Number(error?.code));
const fail=(message,code=ERROR.STORAGE)=>Object.assign(new Error(message),{code});
const publicTicket=ticket=>ticket&&typeof ticket==='object'&&!Array.isArray(ticket)&&Object.keys(ticket).every(key=>['serialFull','faceValue','gglKind'].includes(key));
function requestSnapshot(body){
  if(!body||typeof body!=='object'||Array.isArray(body))throw fail('Invalid scratch request',ERROR.INVALID);
  const copy={};
  for(const field of ['kind','faceValue','revealMode','serialFull','purchaseMode','searchType','bookTail','ticketTail','bookId7List','serialFulls']){
    const value=body[field];if(value===undefined)continue;
    if(field==='bookId7List'||field==='serialFulls'){
      if(!Array.isArray(value)||value.length>100||value.some(item=>typeof item!=='string'||item.length>80))throw fail('Invalid scratch ticket selection',ERROR.INVALID);
      copy[field]=Object.freeze(value.slice());
    }else if(field==='faceValue'){
      if(!Number.isSafeInteger(value)||value<=0)throw fail('Invalid scratch denomination',ERROR.INVALID);
      copy[field]=value;
    }else{
      if(typeof value!=='string'||value.length>160)throw fail('Invalid scratch request',ERROR.INVALID);
      copy[field]=value;
    }
  }
  return Object.freeze(copy);
}
function configSnapshot(table){
  const config=table.config,profile=config.reelProfile;
  // Ordinary reel configs are deeply frozen and can reuse their sampler.
  // Mutable caller configs need their own input snapshot across RPC waits.
  const frozen=profile&&Object.isFrozen(profile)&&Array.isArray(profile.strips)&&Object.isFrozen(profile.strips)&&profile.strips.every(Object.isFrozen);
  return {...config,denominations:config.denominations.slice(),winMultipliers:config.winMultipliers.slice(),reelProfile:frozen?profile:structuredClone(profile)};
}

export function createRpcScratchTickets(common,{routes}){
  const owner=common[ownerKey] ||= {tasks:new Map()};
  // Admission belongs to the same resident RPC owner as the original tails.
  // Recreating an adapter must not grant an account another pending allowance.
  owner.pendingCounts ||= new Map();
  owner.pendingTotal ??= 0;
  function scope(ctx){
    const {table,session}=ctx,route=routes.resolve(table.cfg.game_type,table.roomType),level=table.cfg.finance_level;
    if(![61,63].includes(Number(table.roomType))||!Number.isInteger(level)||level<0||!session?.userId||!session.currency)
      throw fail('Trusted scratch routing and pool level required');
    return {agent:Number(session.agentId),userId:Number(session.userId),gameId:route.number,level,currency:session.currency,
      roomId:table.roomId,gameRoomId:table.gameRoomId,roomType:table.roomType,kind:kindOf(table)};
  }
  function run(ctx,work,body){
    const key=ctx.session.agentId+':'+ctx.session.userId+':'+ctx.session.currency,before=owner.tasks.get(key),count=owner.pendingCounts.get(key)||0;
    // An older adapter may still own an uncounted tail during hot replacement.
    // Let it drain instead of starting a second queue or guessing its depth.
    if((before&&!count)||count>=MAX_ACCOUNT_TASKS||owner.pendingTotal>=MAX_PENDING_TASKS)
      return Promise.reject(fail('刮奖请求处理中，请稍后重试'));
    let request,admitted;
    try{request=body===undefined?undefined:requestSnapshot(body);admitted=JSON.stringify(scope(ctx));}catch(error){return Promise.reject(error);}
    owner.pendingCounts.set(key,count+1);owner.pendingTotal++;
    const task=(before||Promise.resolve()).catch(()=>{}).then(()=>{
      if(JSON.stringify(scope(ctx))!==admitted)throw fail('原请求账户或房间已变化，请重新操作');
      return work(request);
    });owner.tasks.set(key,task);
    const done=()=>{
      if(owner.tasks.get(key)===task)owner.tasks.delete(key);
      const remaining=owner.pendingCounts.get(key)-1;
      if(remaining)owner.pendingCounts.set(key,remaining);else owner.pendingCounts.delete(key);
      owner.pendingTotal--;
    };task.then(done,done);return task;
  }
  async function call(operation,input){
    try{return await common.scratch(operation,input);}catch(error){
      if(uncertain(error)||error?.businessCode===3){
        try{
          await common.scratch('state',scopeOnly(input));
          return await common.scratch(operation,input);
        }catch(retryError){throw fail('Scratch financial result requires confirmation');}
      }
      throw fail(error.message,error.businessCode===9?ERROR.BALANCE:ERROR.STORAGE);
    }
  }
  function scopeOnly(input){const {agent,userId,gameId,level,currency,roomId,gameRoomId,roomType,kind}=input;return {agent,userId,gameId,level,currency,roomId,gameRoomId,roomType,kind};}
  async function refresh(ctx,result,input){
    const matches=()=>!input||(Number(ctx.session.agentId)===input.agent&&Number(ctx.session.userId)===input.userId&&ctx.session.currency===input.currency);
    if(!matches())throw fail('原请求账户已变化，请刷新钱包');
    await ctx.runtime.wallet.load(ctx.session);
    if(!matches())throw fail('原请求账户已变化，请刷新钱包');
    return {...result,walletAmount:Number(ctx.session.wallet)};
  }
  async function issue(ctx,body,direct,accepted){
    ctx.runtime.wallet.guardExternalMoney(ctx.session);
    const {input,config}=accepted||{input:scope(ctx),config:configSnapshot(ctx.table)},state=await call('state',input);
    if(direct&&state.pendingTickets?.length)throw fail('Restore purchased tickets before buying another');
    let refs,serials;
    if(direct){
      const allocation=await call('allocate',input);refs=allocation.matchedSerials?.slice(0,1);serials=refs;
    }else{
      const book=body.purchaseMode==='FULL_BOOK';refs=book?body.bookId7List:body.serialFulls;
      if(!Array.isArray(refs)||!refs.length||refs.length>(book?5:100)||refs.some(ref=>typeof ref!=='string'||ref.length>80)||new Set(refs).size!==refs.length)
        throw fail('Invalid scratch ticket selection',ERROR.INVALID);
      if(book){
        // The authority's serial checksum is SHA-256(prefix)[0] % 10.
        const {createHash}=await import('node:crypto');
        serials=refs.flatMap(ref=>Array.from({length:20},(_,i)=>{const prefix=ref+'-'+String(i+1).padStart(2,'0');return prefix+'-'+createHash('sha256').update(prefix).digest()[0]%10;}));
      }else serials=refs.slice();
    }
    if(!serials?.length||serials.length>100)throw fail('No eligible scratch tickets',ERROR.INVALID);
    const roundIds=serials.map(()=> 'ggl-'+randomUUID());
    const candidates=['natural','win','lose'].map((id,i)=>({id,mode:['NATURAL','PLAYER_WIN','PLAYER_LOSE'][i],tickets:[]}));
    for(let i=0;i<serials.length;i++){
      const draw=scratchCandidates(config.reelProfile,body.faceValue);
      for(let j=0;j<3;j++)candidates[j].tickets.push({roundId:roundIds[i],serialFull:serials[i],huMask:draw[j].huMask,reelVersion:draw[j].reelVersion});
    }
    const result=await call('issue',{...input,requestId:'scratch-'+randomUUID(),faceValue:body.faceValue,refs,
      purchaseMode:direct?'RANDOM_SINGLE':body.purchaseMode,candidates});
    if(result.code!==0||!Array.isArray(result.newTickets)||result.newTickets.length!==serials.length
      ||result.newTickets.some((ticket,i)=>!publicTicket(ticket)||ticket.serialFull!==serials[i]||ticket.faceValue!==body.faceValue||ticket.gglKind!==input.kind.toUpperCase()))
      throw fail('Scratch authority returned an invalid paid ticket set');
    return refresh(ctx,result,input);
  }
  return Object.freeze({authoritative:true,
    state(ctx){return run(ctx,async()=>{
      const input=scope(ctx),config=configSnapshot(ctx.table),result=await call('state',input);
      if(result.code!==0||JSON.stringify(result.denominations)!==JSON.stringify(config.denominations)
        ||JSON.stringify(result.winMultipliers)!==JSON.stringify(config.winMultipliers)||!Array.isArray(result.pendingTickets)
        ||result.pendingTickets.some(ticket=>!publicTicket(ticket)||typeof ticket.serialFull!=='string'||!config.denominations.includes(ticket.faceValue)
          ||ticket.gglKind!==input.kind.toUpperCase()))throw fail('Scratch state disagrees with the configured game');
      return refresh(ctx,result,input);
    });},
    search(ctx,body){return run(ctx,request=>call('search',{...scope(ctx),searchType:request.searchType,bookTail:request.bookTail,ticketTail:request.ticketTail||''}),body);},
    purchase(ctx,body){return run(ctx,request=>issue(ctx,request,false),body);},
    reveal(ctx,body){return run(ctx,async request=>{
      const body=request,input=scope(ctx),config=configSnapshot(ctx.table);
      ctx.runtime.wallet.guardExternalMoney(ctx.session);let serial=body.serialFull;
      if(body.revealMode==='RANDOM_BUY_REVEAL'){
        if(serial!=='')throw fail('Immediate scratch request contains a serial',ERROR.INVALID);
        serial=(await issue(ctx,body,true,{input,config})).newTickets[0].serialFull;
      }else if(body.revealMode!=='SPECIFIED')throw fail('Invalid scratch reveal mode',ERROR.INVALID);
      if(typeof serial!=='string'||!serial||serial.length>80)throw fail('Invalid owned ticket serial',ERROR.INVALID);
      const result=await call('reveal',{...input,serialFull:serial});
      const prize=prizeFromMask(result.huMask,config.winMultipliers);
      if(result.code!==0||result.serialFull!==serial||!config.denominations.includes(result.faceValue)
        ||result.huCount!==prize.huCount||result.multiplier!==prize.multiplier||result.winAmount!==result.faceValue*prize.multiplier
        ||result.gglKind!==input.kind.toUpperCase()||!Number.isSafeInteger(result.purchaseRoomId)||result.purchaseRoomId<=0
        ||!Number.isSafeInteger(result.claimedAt)||result.claimedAt<=0)throw fail('Scratch prize response disagrees with the paid ticket');
      return refresh(ctx,result,input);
    },body);},
    history(ctx){return run(ctx,async()=>{
      return (await persistedHistory({...ctx,financialGameId:scope(ctx).gameId})).winInfo;
    });},
  });
}

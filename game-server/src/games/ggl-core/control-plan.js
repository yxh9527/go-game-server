import {createHash,randomUUID} from 'node:crypto';
import {compileReels} from '../../core/slots-reels.js';
import {prizeFromMask,DENOMINATIONS,WIN_MULTIPLIERS} from './rules.js';
import {scoreToMoney} from '../../wallet/money-format.js';

export function scratchCandidates(profile,faceValue,{rng}={}){
  if(!DENOMINATIONS.includes(faceValue))throw new Error('Invalid scratch denomination');
  if(!profile||profile.rows!==4||!Array.isArray(profile.strips)||profile.strips.length!==5||profile.strips.some(strip=>!Array.isArray(strip)||strip.some(symbol=>symbol>10)))throw new Error('Scratch reels must produce 20 symbols in 1..10');
  const sampler=compileReels(profile),possible=sampler.distribution();
  if(!possible.has(0)||!possible.has(20))throw new Error('Scratch reels must support no prize and the advertised top prize');
  const version=createHash('sha256').update(JSON.stringify({profile,winMultipliers:WIN_MULTIPLIERS,winSymbol:1})).digest('hex');
  const sample=(id,mode,spin)=>{
    const prize=prizeFromMask(spin.symbols),winAmount=faceValue*prize.multiplier;
    if(!Number.isSafeInteger(winAmount)||winAmount<0)throw new Error('Invalid scratch payout');
    return Object.freeze({id,mode,faceValue,winAmount,...prize,huMask:spin.symbols,stops:spin.stops,reelVersion:version});
  };
  return Object.freeze([
    sample('natural','NATURAL',sampler.sample(rng)),
    sample('win','PLAYER_WIN',sampler.sampleWhere(count=>count>0&&prizeForCount(count)>1,rng)),
    sample('lose','PLAYER_LOSE',sampler.sampleWhere(count=>count===0||prizeForCount(count)<1,rng)),
  ]);
}
function prizeForCount(count){return prizeFromMask([...Array(count).fill(1),...Array(20-count).fill(2)]).multiplier;}

export async function selectScratchPlan(common,{route,agentId,userId,currency,level,profile,faceValue,roundId='ggl-'+randomUUID()},options){
  if(!Number.isSafeInteger(route?.number)||!Number.isInteger(agentId)||agentId<0||!Number.isInteger(userId)||userId<=0||!Number.isInteger(level)||level<0)
    throw new Error('Trusted scratch finance routing is required');
  const candidates=scratchCandidates(profile,faceValue,options),request={requestId:randomUUID(),roundId,gameId:route.number,agent:agentId,userId,
    level,currencyType:currency,candidates:candidates.map(candidate=>({id:candidate.id,mode:candidate.mode,betAmount:scoreToMoney(faceValue),payout:scoreToMoney(candidate.winAmount)}))};
  const response=await common.finance('getPoolControlDecision',request,agentId);
  const selected=candidates.find(candidate=>candidate.id===response?.selectedCandidateId);
  if(response?.code!==0||!selected||!response.decisionId||response.mode!==selected.mode||response.maxPayout!==scoreToMoney(selected.winAmount))
    throw new Error('Pool control did not confirm a valid generated scratch candidate');
  // This is a read-only decision, not ownership, a reservation or a payout.
  // Issuance must persist precisely this result before a paid ticket is shown.
  return Object.freeze({roundId,gameId:route.number,agentId,userId,level,currency,decisionId:response.decisionId,selected,candidates});
}

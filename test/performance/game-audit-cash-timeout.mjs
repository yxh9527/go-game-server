// Isolated fault injection only: no Redis, data-center or resident server.
// Simulates an upstream commit whose acknowledgement is lost, followed by
// the next ordinary game-settlement attempt after local rollback.
import fs from 'node:fs';
import {createAuthoritativeWallet} from '../../game-server/src/wallet/authoritative.js';
import {createRegistry} from '../../game-server/src/registry.js';
let stored={balance:1000,revision:0,carry:null,ttlMs:0},loseReply=true;
const receipts=new Map(),requests=[];
const common={async cashRead(){return structuredClone(stored);},async cashApply(request){
  requests.push(request.id);
  if(receipts.has(request.id))return structuredClone(receipts.get(request.id));
  if(request.accounts[0].revision!==stored.revision)throw Object.assign(new Error('revision conflict'),{status:409});
  for(const step of request.steps)if(step.kind==='credit')stored.balance+=step.amount;
  stored.revision++;
  const result={accounts:[{...request.accounts[0],...structuredClone(stored)}]};
  receipts.set(request.id,result);
  if(loseReply){loseReply=false;throw Object.assign(new Error('commit applied, response timed out'),{status:504});}
  return result;
}};
const wallet=createAuthoritativeWallet({common}),registry=createRegistry();
const session={agentId:7,userId:42,currency:'CNY',authenticated:true};
registry.bind({},session);await wallet.load(session);
const table={roomId:500000,roomType:50,gameId:'hundred-holdem',members:[],hand:{settled:false}};
registry.setTable(table.roomId,table,7,table.gameId);
const runtime={registry,wallet};
const settle=()=>{if(!table.hand.settled){wallet.credit(session,200,{key:'same-round'});table.hand.settled=true;}};
let firstError;
try{await wallet.run(settle,runtime);}catch(error){firstError=error.message;}
const afterTimeout={balance:stored.balance,localSettled:table.hand.settled};
let subsequentError;try{await wallet.run(settle,runtime);}catch(error){subsequentError=error.code||error.message;}
const report={scenario:'upstream-applied-before-timeout',firstError,afterTimeout,expectedSinglePayoutBalance:1200,
  actualBalance:stored.balance,transactionIds:requests,subsequentError,duplicateCreditObserved:stored.balance!==1200};
fs.mkdirSync('cache',{recursive:true});fs.writeFileSync('cache/game-audit-cash-timeout.json',JSON.stringify(report,null,2));
console.log(JSON.stringify(report));

// Static-contract fault injection, not an online money test.
import fs from 'node:fs';
import {createAuthoritativeWallet} from '../../game-server/src/wallet/authoritative.js';
import {createRegistry} from '../../game-server/src/registry.js';
const go=fs.readFileSync('D:/project/gogames/data-center/dao/gogame_cash.go','utf8');
const limit=Number(/const cashMaxAccounts = (\d+)/.exec(go)?.[1]||/len\(request\.Accounts\) > (\d+)/.exec(go)?.[1]);
if(!limit)throw new Error('Could not identify the local data-center account limit');
const balances=new Map(),registry=createRegistry();let attempted=0;
const common={async cashRead(a){return {...balances.get(a.userId)};},async cashApply(request){
  attempted=request.accounts.length;
  if(attempted>limit)throw Object.assign(new Error('invalid cash transaction size or id'),{code:3,status:400});
  for(const step of request.steps){const a=request.accounts[step.account-1];balances.get(a.userId).balance+=step.amount;}
  for(const a of request.accounts)balances.get(a.userId).revision++;
  return {accounts:request.accounts.map(a=>({...a,...balances.get(a.userId)}))};
}};
const wallet=createAuthoritativeWallet({common}),sessions=[];
for(let userId=1;userId<=65;userId++){
  balances.set(userId,{balance:1000,revision:0,carry:null});
  const session={userId,agentId:7,authenticated:true};registry.bind({},session);await wallet.load(session);sessions.push(session);
}
const table={roomId:500000,roomType:50,gameId:'hundred-holdem',kind:'hundred',members:[],hand:{settled:false}};
registry.setTable(table.roomId,table,7,table.gameId);
let error;
try{await wallet.run(()=>{for(const s of sessions)wallet.credit(s,200);table.hand.settled=true;},{registry,wallet});}
catch(e){error=e.message;}
const result={source:'local gogames/data-center/dao/gogame_cash.go',upstreamAccountLimit:limit,
  simultaneousPayoutAccounts:attempted,settlementCommitted:table.hand.settled,error,
  allPayoutsExactlyOnce:[...balances.values()].every(a=>a.balance===1200&&a.revision===1),onlineServiceCalled:false};
fs.writeFileSync('cache/three-fixes-cash-capacity.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));

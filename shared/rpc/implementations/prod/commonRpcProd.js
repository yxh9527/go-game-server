import { getGogameStorageClient } from '../../utils/gogameStorageGrpc.js';
import { getLotteryClient } from '../../utils/lotteryGrpc.js';

function unavailable() {
  throw Object.assign(new Error('Authoritative wallet mutations are not configured'), { code: 'WALLET_UNAVAILABLE' });
}

export function currencyToScore(value) {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match) throw new Error('Invalid authoritative currency balance');
  const score = BigInt(match[1]) * 100n + BigInt((match[2] || '').padEnd(2, '0'));
  if (score > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Balance exceeds safe score range');
  return Number(score);
}

export class CommonRpcProd {
  constructor({lottery=getLotteryClient}={}){this.lottery=lottery;}
  async matchPayment(operation,plan,includeService=false){
    if(!['charge','refund','award','query'].includes(operation))throw new Error('Invalid tournament payment operation');
    return (await getGogameStorageClient()).call('matchPayment',{operation,plan,includeService});
  }
  async tournamentTickets(account){return (await getGogameStorageClient()).call('tournamentTickets',account);}
  async finance(method,request,agent=request.agent){
    const allowed=['bet','prePay','renewReservation','settlement','getRoundFinanceState','cancelBet','getPoolControlDecision'];
    if(!allowed.includes(method))throw new Error('Unsupported finance operation');
    return (await this.lottery(agent))[method](request);
  }
  async scratch(operation,input){
    if(!['state','search','allocate','issue','reveal','history'].includes(operation))throw new Error('Invalid scratch operation');
    const response=await (await this.lottery(input.agent)).scratchAction({operation,payload:JSON.stringify(input)});
    if(response.code!==0||response.success!==true)throw Object.assign(new Error(response.reason||'Scratch authority rejected request'),
      {code:'SCRATCH_AUTHORITY_REJECTED',businessCode:response.code,status:503});
    let result;try{result=JSON.parse(response.payload);}catch{throw Object.assign(new Error('Invalid scratch authority payload'),{status:503,uncertain:true});}
    if(!result||typeof result!=='object'||Array.isArray(result))throw new Error('Invalid scratch authority response');
    return result;
  }
  async cashRead(account) {
    return (await getGogameStorageClient()).call('cashRead', account);
  }
  async cashApply(request) {
    return (await getGogameStorageClient()).call('cashApply', request);
  }
  async getBalance(userId,agent) {
    const resp=await (await this.lottery(agent)).getBalance({userId:Number(userId)});
    if(resp.code!==0)throw Object.assign(new Error('Authoritative balance unavailable'),{code:resp.code,status:503});
    const balance=currencyToScore(resp.currency);
    if(String(balance)!==String(resp.currencyCent))throw new Error('Authoritative balance units disagree');
    return balance;
  }

  debit(_userId, _amount) {
    return unavailable();
  }

  credit(_userId, _amount) {
    return unavailable();
  }

  async persistScore(userId, score) {
    // Never overwrite the authoritative balance with a connection snapshot.
    return unavailable();
  }
}

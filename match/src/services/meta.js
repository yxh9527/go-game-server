import { rel } from "../rel.js";

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

export async function createMetaService(runtime) {
  const v = runtime.hotVersion;
  const { AppError } = await rel(import.meta.url, "../errors.js", v);
  const { validateAwardJSON } = await rel(import.meta.url, "../award.js", v);
  const { DEFAULT_CURRENCY } = await rel(import.meta.url, "../constants.js", v);
  const {ticketRateFraction}=await rel(import.meta.url,'../../../shared/tournament-payment.js',v);
  const {normalizeTournamentLevels}=await rel(import.meta.url,'../../../shared/tournament-blinds.js',v);
  const store = runtime.store;
  function ticketFields(body,old){
    const row={...old,...body},name=typeof row.name==='string'?row.name.trim():'';
    if(!name||name.length>128)throw new AppError(400,'门票名称须为 1 至 128 个字符');
    if(!/^[A-Z0-9]{1,12}$/.test(row.currency||DEFAULT_CURRENCY))throw new AppError(400,'无效币种');
    for(const key of ['price','match_id','num'])if(!Number.isSafeInteger(Number(row[key]||0))||Number(row[key]||0)<0)throw new AppError(400,'门票面值、比赛 ID 和发行量须为非负整数');
    if(old&&body.remain!==undefined&&Number(body.remain)!==Number(old.remain))throw new AppError(409,'剩余库存不可直接修改，请修改发行量');
    const num=Number(row.num||0),remain=old?Number(old.remain)+num-Number(old.num):num;
    if(remain<0)throw new AppError(409,'发行量不能低于已发放数量');
    return {name,price:Number(row.price||0),currency:row.currency||DEFAULT_CURRENCY,match_id:Number(row.match_id||0),num,remain};
  }
  function blindFields(body) {
    const name=typeof body.name==='string'?body.name.trim():'';
    if(!name||name.length>128)throw new AppError(400,'盲注名称须为 1 至 128 个字符');
    try {
      const input=typeof body.data==='string'?JSON.parse(body.data):body.data;
      const levels=normalizeTournamentLevels(input);
      return {name,data:JSON.stringify(levels)};
    } catch(error) { throw new AppError(400,error.message); }
  }
  async function publishMetadata(kind, row) {
    await runtime.bus?.publish('match', JSON.stringify({ event: 'match_metadata', data: JSON.stringify({ kind, row }) }));
    return row;
  }

  return {
    async listTickets() {
      return store.listTickets();
    },
    async createTicket(body) {
      const ts = nowSec();
      return store.insertTicket({
        ...ticketFields(body),
        create_time: ts,
        update_time: ts,
      });
    },
    async updateTicket(id, body) {
      const old = (await store.listTickets()).find((row) => Number(row.id) === Number(id));
      if (!old) {
        throw new AppError(404, "not found");
      }
      const saved = await store.updateTicket(id, {
        ...ticketFields(body,old),
        update_time: nowSec(),
      });
      if (!saved) {
        throw new AppError(404, "not found");
      }
      return saved;
    },
    async deleteTicket(id){return store.deleteTicket(id);},
    async issueTickets(id,body,actor){
      const userId=Number(body.userId),count=Number(body.count);
      if(!Number.isSafeInteger(userId)||userId<=0||!Number.isSafeInteger(count)||count<1||count>1000||!actor.agentId||typeof body.requestId!=='string'||! /^[a-zA-Z0-9:_-]{1,128}$/.test(body.requestId))throw new AppError(400,'发券需代理、玩家、1 至 1000 张数量及请求编号');
      const profile=await runtime.rpc?.gateway?.getLoginData(userId);
      if(!profile||Number(profile.agentId)!==actor.agentId)throw new AppError(403,'玩家不属于所选代理');
      return store.issueTickets({id,userId,count,agentId:actor.agentId,requestId:body.requestId});
    },
    async listRates() {
      return store.listRates();
    },
    async upsertRate(body) {
      if (!body.currency) {
        throw new AppError(400, "currency required");
      }
      if(!/^[A-Z0-9]{1,12}$/.test(body.currency))throw new AppError(400,'invalid currency');
      try{ticketRateFraction(body.rate);}catch(error){throw new AppError(400,error.message);}
      const ts = nowSec();
      return store.upsertRate({
        currency: body.currency,
        rate: body.rate,
        create_time: ts,
        update_time: ts,
      });
    },
    async listAwards() {
      return store.listAwards();
    },
    async createAward(body) {
      try {
        validateAwardJSON(body.detail);
      } catch (err) {
        throw new AppError(400, err.message);
      }
      const ts = nowSec();
      return publishMetadata('award', await store.insertAward({
        name: body.name,
        detail: body.detail,
        create_time: ts,
        update_time: ts,
      }));
    },
    async updateAward(id, body) {
      const old = await store.getAward(id);
      if (!old) {
        throw new AppError(404, "not found");
      }
      const detail = body.detail ?? old.detail;
      try {
        validateAwardJSON(detail);
      } catch (err) {
        throw new AppError(400, err.message);
      }
      return publishMetadata('award', await store.updateAward(id, {
        name: body.name ?? old.name,
        detail,
        update_time: nowSec(),
      }));
    },
    async listBlinds() {
      return store.listBlinds();
    },
    async createBlinds(body) {
      const ts = nowSec();
      return publishMetadata('blinds', await store.insertBlinds({
        ...blindFields(body),
        create_time: ts,
        update_time: ts,
      }));
    },
    async updateBlinds(id, body) {
      const list = await store.listBlinds();
      const old = list.find((row) => Number(row.id) === Number(id));
      if (!old) {
        throw new AppError(404, "not found");
      }
      return publishMetadata('blinds', await store.updateBlinds(id, {
        ...blindFields({...old,...body}),
        update_time: nowSec(),
      }));
    },
    async deleteBlinds(id) {
      if(!Number.isSafeInteger(id)||id<=0)throw new AppError(400,'invalid blinds id');
      // Production repeats this check under the same database lock as deletion.
      if((await store.listMatches()).some(row=>Number(row.blinds_id)===id))throw new AppError(409,'盲注已被比赛引用，不能删除');
      if(runtime.env==='dev'){
        for(const row of runtime.tournamentMemory?.schedules?.values()||[]){
          const payload=typeof row.payload==='string'?JSON.parse(row.payload):row.payload;
          if(Number(payload?.blinds_id)===id)throw new AppError(409,'盲注已被排期引用，不能删除');
        }
      }
      const row=await store.deleteBlinds(id);
      if(!row)throw new AppError(404,'not found');
      return publishMetadata('blinds',{...row,deleted:true});
    },
  };
}

import { getDataCenterClient } from "../../utils/dataCenterGrpc.js";
import { getGogameStorageClient } from '../../utils/gogameStorageGrpc.js';
import {playerPanelPersistedRecords} from '../../../player-panel.js';

function check(response){
  if(!response||!Number.isInteger(response.code))throw Object.assign(new Error('Invalid data-center response'),{status:503});
  if(response.code!==0)throw Object.assign(new Error(response.message||'Data-center rejected request'),{code:response.code,status:response.code===3?503:403});
  return response;
}

export class GatewayRpcProd {
  async getScratchHistory(query){return (await getGogameStorageClient()).call('scratchHistory',query);}
  async fairProof(action,input){return (await getGogameStorageClient()).call('fairProof'+action[0].toUpperCase()+action.slice(1),input);}
  async smartTask(action,input){return (await getGogameStorageClient()).call('smartTask'+action[0].toUpperCase()+action.slice(1),input);}
  async playerPanel(action,input){return (await getGogameStorageClient()).call('playerPanel'+action[0].toUpperCase()+action.slice(1),input);}
  async getUserCenter(query) {
    return (await getGogameStorageClient()).call('userCenter',query);
  }
  async writeUserCenter(records) {
    const storage=await getGogameStorageClient();
    const confirm=(receipt,count)=>{if(receipt?.indexed!==true||receipt.durable!==true||receipt.stored!==count)throw Object.assign(new Error('data-center ES indexing acknowledgement missing'),{status:503});};
    const replays=records.filter(r=>r.detail?.replay).map(({replayOnly,...record})=>record);
    const attempts=[];
    if(replays.length)attempts.push(async()=>confirm(await storage.call('holdemReplayWrite',{records:replays}),replays.length));
    const cash=records.filter(r=>!r.replayOnly),hands=playerPanelPersistedRecords(cash);
    if(cash.length)attempts.push(async()=>confirm(await storage.call('userCenterWrite',{records:cash}),cash.length));
    if(hands.length)attempts.push(async()=>{
      const receipt=await storage.call('playerPanelWrite',{records:hands});
      if(receipt?.stored!==hands.length)throw Object.assign(new Error('data-center player statistics acknowledgement missing'),{status:503});
    });
    let failure;
    for(const attempt of attempts){try{await attempt();}catch(error){failure||=error;}}
    if(failure)throw failure;
    return {stored:records.length,durable:true};
  }
  async authenticate(token, userId) {
    const client = await getDataCenterClient();
    const resp = await client.authenticate({
      token: String(token || ""),
      gameId: 0,
      entryUserId: Number(userId) || 0,
    });
    return {
      success: resp.code===0&&Boolean(resp.success)&&Number(resp.userId)===Number(userId),
      userId: Number(resp.userId || 0),
      isReEnter: Boolean(resp.isReEnter),
      message: resp.message || "",
    };
  }

  async getLoginData(userId) {
    const client = await getDataCenterClient();
    const resp = await client.getLoginData({ userId: Number(userId) || 0 });
    const profile = check(resp).profile;
    if(!profile||Number(profile.userId)!==Number(userId)||!Number.isSafeInteger(Number(profile.agentId)))
      throw Object.assign(new Error('Login profile identity mismatch'),{status:503});
    return {
      userId: Number(profile.userId || userId || 0),
      userName: profile.userName || "",
      userIcon: profile.userIcon,
      agentId: Number(profile.agentId || 0),
      topAgentId: Number(profile.topAgentId || 0),
      currency: profile.currency,
      walletAmount: 0,
    };
  }

  async validateToken(token, userId) {
    const client = await getDataCenterClient();
    const resp = await client.validateToken({
      token: String(token || ""),
      userId: Number(userId) || 0,
    });
    if(resp.code===3)check(resp);
    return resp.code===0&&Boolean(resp.valid);
  }

  async getRecords(query = {}) {
    const client = await getDataCenterClient();
    return client.getRecords({
      UserId: Number(query.userId) || 0,
      Symbol: String(query.symbol || ""),
      Hash: String(query.hash || ""),
      Currency: String(query.currency || ""),
      GameId: Number(query.gameId) || 0,
      StartTime: Number(query.startTime) || 0,
      EndTime: Number(query.endTime) || 0,
      Page: Math.max(1, Number(query.page) || 1),
      Size: Math.min(100, Math.max(1, Number(query.size) || 20)),
    });
  }

  async getRecordDetail(query = {}) {
    const client = await getDataCenterClient();
    return client.getRecordDetail({
      recordId: String(query.recordId || ""),
      userId: Number(query.userId) || 0,
      gameId: Number(query.gameId) || 0,
    });
  }
}

export function createMemoryPlayerNotes(){
  const notes=new Map(),used=new Map(),key=scope=>[scope.agentId,scope.userId,scope.targetId].join(':');
  const dayKey=scope=>[scope.agentId,scope.userId,Math.floor((Date.now()+8*3600000)/86400000)].join(':');
  return {
    async get(scope){return {...notes.get(key(scope))||{remarkName:'',remarkMessage:'',mark:0}};},
    async set(scope,patch){const value={...await this.get(scope),...patch};notes.set(key(scope),value);return {...value};},
    async quota(scope){return Math.max(0,20-(used.get(dayKey(scope))||0));},
    async consume(scope){const current=used.get(dayKey(scope))||0;if(current>=20)throw Object.assign(new Error('今日免费道具次数已用完'),{status:409});used.set(dayKey(scope),current+1);return 19-current;},
  };
}

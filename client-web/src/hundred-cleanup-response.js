export function unavailableCleanupSocket(error){
  const message=String(error&&error.message||error);
  return message.includes('当前没有hundredDomain百人服地址')||message.includes('当前无可用房间服');
}

export function prepareSocketLogin(socket,args,primary,standaloneHundred,notify){
  if(socket.channel!==2){
    if(socket.__gogamePrimarySocket!==socket._socket){socket.__gogamePrimarySocket=socket._socket;socket.__gogamePrimaryLoginReady=false;}
    return false;
  }
  const raw=socket._socket,primaryRaw=primary?._socket;
  const hasPrimary=!!primaryRaw&&[0,1].includes(primaryRaw.readyState);
  if(raw&&raw.__gogameAuxiliaryOnly===undefined)raw.__gogameAuxiliaryOnly=hasPrimary||!standaloneHundred;
  socket.__gogameAuxiliaryOnly=raw?.__gogameAuxiliaryOnly??(hasPrimary||!standaloneHundred);
  if(!hasPrimary||primary.__gogamePrimaryLoginReady)return false;
  if(socket.__gogameDeferredLogin?.raw===raw)return true;
  socket.__gogameDeferredLogin?.cancel();
  const event='gogame:primary-login-ready';
  const pending={raw,done:false,cancel(){
    if(this.done)return;this.done=true;raw?.removeEventListener?.('close',closed);
    if(socket.__gogameDeferredLogin===this)delete socket.__gogameDeferredLogin;
    Promise.resolve().then(()=>{notify.offByTargetName(event,pending);notify.offByTargetName('gogame:primary-login-ended',pending);});
  }};
  function closed(){pending.cancel();}
  socket.__gogameDeferredLogin=pending;
  notify.on(event,()=>{
    if(pending.done)return;
    if(socket._socket!==raw){pending.cancel();return;}
    if(!primary.__gogamePrimaryLoginReady)return;
    pending.cancel();socket.sendLogin.apply(socket,args);
  },pending);
  notify.on('gogame:primary-login-ended',()=>{pending.cancel();socket.close(true,true);},pending);
  raw?.addEventListener?.('close',closed);
  return true;
}

// Unregister is a teardown operation. Once its original connection is gone,
// there is no subscription on that connection left to acknowledge. Capture
// it once so an in-flight request stays on its original connection.
export function unregisterHundredRooms(viewModel,notify,protocol,transport,isUnavailable){
  const response=protocol.Response.MB_UNREG_ROOMS_RES;
  let socket;
  try{socket=transport.roomSocket;}catch(error){
    if(!isUnavailable(error))return Promise.reject(error);
    viewModel.__gogameUnregister?.finish();
    notify.offByTargetName(response,viewModel);
    return Promise.resolve(0);
  }
  const raw=socket&&socket._socket,previous=viewModel.__gogameUnregister;
  if(previous&&previous.socket===socket&&previous.raw===raw)return previous.promise;
  previous?.finish();
  notify.offByTargetName(response,viewModel);
  if(!socket||typeof socket.getRoomSocketIsOpen==='function'&&!socket.getRoomSocketIsOpen()
    ||raw&&typeof raw.readyState==='number'&&raw.readyState!==1)return Promise.resolve(0);
  let resolve,reject,done=false;
  const promise=new Promise((ok,fail)=>{resolve=ok;reject=fail;});
  const task={socket,raw,promise,finish(error){
    if(done)return;done=true;
    raw?.removeEventListener?.('close',closed);
    // Native emit iterates a live listener array. Remove our listener after
    // dispatch so parallel cleanup acknowledgements are not skipped.
    Promise.resolve().then(()=>notify.offByTargetName(response,task));
    if(viewModel.__gogameUnregister===task){
      delete viewModel.__gogameUnregister;
    }
    error?reject(error):resolve(0);
  }};
  function closed(){task.finish();}
  viewModel.__gogameUnregister=task;
  try{
    // Listen first: a synchronous acknowledgement must not be missed.
    // NotificationCenter ignores a Component whose node was destroyed.
    // The request object remains valid even when the departing view does not.
    notify.on(response,()=>task.finish(),task);
    raw?.addEventListener?.('close',closed);
    if(!done)socket.send(protocol.Request.MB_UNREG_ROOMS_REQ);
  }catch(error){task.finish(isUnavailable(error)?undefined:error);}
  return promise;
}

export function adaptHundredCleanupResponse(source){
  if(!source.includes('GOGAME_AUXILIARY_LOGIN_V2')){
    source=source.replace("Z['prototype']['sendLogin']=function(a0,a1){",
      "Z['prototype']['sendLogin']=function(a0,a1){/* GOGAME_AUXILIARY_LOGIN_V2 */if(("+prepareSocketLogin.toString()+")(this,Array['prototype']['slice']['call'](arguments),this['channel']===2?__require('RoomSocket')['default']['ins']:null,W['default']['isInBairenQpGame'],K['default']))return;");
    source=source.replace("ac['plat']=ad,ac['abFlag']=0x2","ac['auxiliaryOnly']=!!this['__gogameAuxiliaryOnly'],ac['plat']=ad,ac['abFlag']=0x2");
    source=source.replace("Z['prototype']['onMessageBack2']=function(a0,a1){",
      "Z['prototype']['onMessageBack2']=function(a0,a1){if(this['channel']===1&&a0===1205){this['__gogamePrimaryLoginReady']=!!(a1&&a1['opType']>=0);K['default']['emit'](this['__gogamePrimaryLoginReady']?'gogame:primary-login-ready':'gogame:primary-login-ended');}");
    source=source.replace("Z['prototype']['close']=function(a0,a1){",
      "Z['prototype']['close']=function(a0,a1){this['__gogamePrimaryLoginReady']=false;this['__gogamePrimarySocket']=null;if(this['channel']===1)K['default']['emit']('gogame:primary-login-ended');if(this['__gogameDeferredLogin'])this['__gogameDeferredLogin']['cancel']();");
  }
  source=source.replace("D['prototype']['commandExit']=function(){this['model']['exitRequest']();}",
    "D['prototype']['commandExit']=function(){var model=this['model'];if(model)model['exitRequest']();}");
  const auxiliaryStart=source.indexOf("'RoomSocket2':[");
  if(auxiliaryStart>=0){
    const auxiliaryEnd=source.indexOf("'RoomSocketBase':[",auxiliaryStart);
    if(auxiliaryEnd>auxiliaryStart){
      let module=source.slice(auxiliaryStart,auxiliaryEnd).replace(
        "l['prototype']['onMessageBack2']=function(m,p){h['default']['isInBairenQpGame']?",
        "l['prototype']['onMessageBack2']=function(m,p){(m===6225||h['default']['isInBairenQpGame'])?");
      if(!module.includes('GOGAME_AUXILIARY_CLOSE_V1'))module=module.replace(
        "l['prototype']['onMessageBack2']=function(m,p){",
        "l['prototype']['onMessageBack2']=function(m,p){/* GOGAME_AUXILIARY_CLOSE_V1 */if(m===1203&&p&&p['reason']==='primary-closed'&&p['auxiliary']===true){this['close'](true,true);return;}");
      source=source.slice(0,auxiliaryStart)+module+source.slice(auxiliaryEnd);
    }
  }
  const start=source.indexOf("K['prototype']['sendUnregRoomsReq']=");
  if(start<0)return source;
  const end=source.indexOf(",K['prototype']['sendRoomBetReq']=",start);
  if(end<start||source.slice(start,end).includes('GOGAME_HUNDRED_CLEANUP_V1'))return source;
  const replacement="K['prototype']['sendUnregRoomsReq']=function(){/* GOGAME_HUNDRED_CLEANUP_V1 */return ("+
    unregisterHundredRooms.toString()+")(this,C['default'],E['BRMBDef'],F['default'],("+unavailableCleanupSocket.toString()+"));}";
  return source.slice(0,start)+replacement+source.slice(end);
}

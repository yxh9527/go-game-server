export function unavailableCleanupSocket(error){
  const message=String(error&&error.message||error);
  return message.includes('当前没有hundredDomain百人服地址')||message.includes('当前无可用房间服');
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
  source=source.replace("D['prototype']['commandExit']=function(){this['model']['exitRequest']();}",
    "D['prototype']['commandExit']=function(){var model=this['model'];if(model)model['exitRequest']();}");
  const auxiliaryStart=source.indexOf("'RoomSocket2':[");
  if(auxiliaryStart>=0){
    const auxiliaryEnd=source.indexOf("'RoomSocketBase':[",auxiliaryStart);
    if(auxiliaryEnd>auxiliaryStart){
      const module=source.slice(auxiliaryStart,auxiliaryEnd).replace(
        "l['prototype']['onMessageBack2']=function(m,p){h['default']['isInBairenQpGame']?",
        "l['prototype']['onMessageBack2']=function(m,p){(m===6225||h['default']['isInBairenQpGame'])?");
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

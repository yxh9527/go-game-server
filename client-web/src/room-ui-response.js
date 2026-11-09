const menuMethod="aE['prototype']['onShowBtnsClick']=function(aF,aG){";
const menuGuard="/* GOGAME_ROOM_UI_V1 */aE['prototype']['onShowBtnsClick']=function(aF,aG){if(!cc['app']||!cc['app']['gameRoom']||typeof cc['app']['gameRoom']['getRoomInfo']!=='function'||!cc['app']['gameRoom']['getRoomInfo']()){if(this['btnLayer'])this['btnLayer']['active']=!1;return;}";
const zjhDiagnostic="console['error']('----------',az)";

export function preventSeatedRoomExit(room,showTip){
  if(!room||room.isMttRoom||room._conf?.isMtt)return false;
  const type=Number(room.getRoomInfo?.()?.roomType)||Number(room._conf?.roomType);
  if(![19,24,25,26,27,28,30,31,32].includes(type)||!room.getMyMemberInfo?.())return false;
  showTip('请先点击“下局站起”，离桌后再退出牌局');
  return true;
}

export function adaptRoomUiResponse(source){
  if(typeof source!=='string')return source;
  let result=source;
  if(result.includes(menuMethod)&&!result.includes('GOGAME_ROOM_UI_V1'))
    result=result.replace(menuMethod,menuGuard);
  if(result.includes(zjhDiagnostic))
    result=result.replace(zjhDiagnostic,"console['log']('----------',az)");
  // BairenModule.init logs every ordinary host initialization as an error.
  // Preserve actual failures and only lower this unconditional diagnostic.
  result=result.replace("case 0x0:this['error'](X),this['clearOldGame'](X)",
    "case 0x0:this['log'](X),this['clearOldGame'](X)");
  if(!result.includes('GOGAME_SEATED_EXIT_V1')){
    const check="/* GOGAME_SEATED_EXIT_V1 */if(("+preventSeatedRoomExit.toString()+")(cc['app']['gameRoom'],function(message){__require('GameUtils')['default']['showMoveTips'](message);}))return;";
    result=result.replace("aE['prototype']['onExitRoomClick']=function(){",
      "aE['prototype']['onExitRoomClick']=function(){"+check);
    result=result.split("this['mExitBtn']['SetClickCallback'](function(){")
      .join("this['mExitBtn']['SetClickCallback'](function(){"+check);
  }
  return result;
}

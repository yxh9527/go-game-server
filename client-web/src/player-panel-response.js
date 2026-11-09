export function canonicalPanelProfile(data,room){
  if(!data||!Number.isSafeInteger(Number(data.playerId))||Number(data.playerId)<=0)return null;
  var id=Number(data.playerId),seat=room&&typeof room.getSeatByID==='function'?room.getSeatByID(id):null;
  if(!seat&&room&&typeof room.getRoomInfo==='function'){
    var info=room.getRoomInfo();seat=info&&Array.isArray(info.memberList)?info.memberList.find(function(p){return Number(p.uid)===id;}):null;
  }
  var profile=Object.assign({},data),identity=seat&&seat.userInfo||seat;
  profile.playerId=id;
  if(identity){profile.name=String(identity.name||seat.name||data.name||id);profile.imageUrl=String(identity.icon||seat.icon||data.imageUrl||'');profile.regionCode=identity.regionCode||data.regionCode||'CN';}
  return profile;
}

export function loadPanelAvatar(panel,sprite,url,load){
  var id=Number(panel.data.playerId),revision=(panel.__avatarRevision||0)+1;panel.__avatarRevision=revision;
  var current=function(){return panel.__avatarRevision===revision&&panel.data&&Number(panel.data.playerId)===id&&(!panel.node||panel.node.active!==false);};
  if(panel.__avatarUrl!==url){sprite.spriteFrame=null;panel.__avatarUrl=url;}
  var proxy=Object.create(sprite);
  Object.defineProperty(proxy,'isValid',{get:function(){return sprite.isValid!==false&&current();}});
  Object.defineProperty(proxy,'spriteFrame',{get:function(){return sprite.spriteFrame;},set:function(value){if(current())sprite.spriteFrame=value;}});
  Object.defineProperty(proxy,'url',{value:url,writable:true});
  load(String(url||''),proxy);
}

export function updatePanelRecordCaption(panel,getText,Label){
  var view=panel.menu_views_0&&panel.menu_views_0.children[1],content=view&&view.getChildByName('content');
  var item=content&&content.getChildByName('item_3');if(!item)return;
  var value=item.getChildByName('value');
  item.getComponentsInChildren(Label).forEach(function(label){
    if(label.node===value)return;
    if(typeof label.setKey==='function'&&!label.__gogameRecordCaption){
      var before=label.beforI18nStringChangeFunc;label.__gogameRecordCaption=true;
      label.beforI18nStringChangeFunc=function(text){
        if(panel.data&&panel.data.recentRecordScope==='room')return '本房间牌局记录';
        return before?before.call(label,text):text;
      };
    }
    label.string=panel.data&&panel.data.recentRecordScope==='room'?'本房间牌局记录':getText('common','last_7_days_records');
  });
}

export function adaptPlayerPanelResponse(source){
  const start=source.indexOf("'chatPanel':[");if(start<0)return source;
  const end=source.indexOf("'chatSelf':[",start);if(end<start)return source;
  let module=source.slice(start,end);
  if(module.includes('GOGAME_PLAYER_PANEL_V2'))return source;
  if(module.includes('GOGAME_PLAYER_PANEL'))throw new Error('Player panel adapter expects the original asset');
  module=module.replace("'chatPanel':[","'chatPanel':[/* GOGAME_PLAYER_PANEL_V2 */");
  const canonical='('+canonicalPanelProfile.toString()+')';
  module=module.replace("Y['prototype']['init']=function(Z){",
    "Y['prototype']['init']=function(Z){if(!Z||!Number.isSafeInteger(Number(Z['playerId']))||Number(Z['playerId'])<=0)return;if(typeof window!=='undefined'&&window.__gogamePlayerPanelTarget&&Number(window.__gogamePlayerPanelTarget)!==Number(Z['playerId']))return;Z="+canonical+"(Z,cc['app']['gameRoom']);this['__giftSent']=false;");
  module=module.replace("Y['prototype']['show']=function(){",
    "Y['prototype']['show']=function(){if(!this['data']||!this['data']['playerId'])return;if(this['private_option_dropdown_panel'])this['private_option_dropdown_panel']['active']=false;");
  module=module.replace("this['private_option_button']['active']=cc['app']['gameRoom']['_conf']['isPrivateRoom']",
    "this['private_option_button']['active']=Number(cc['app']['gameRoom']['_conf']['roomType'])===19&&cc['app']['gameRoom']['_conf']['isPrivateRoom']");
  module=module.replace("Y['prototype']['onClickPrivateOptionButton']=function(){",
    "Y['prototype']['onClickPrivateOptionButton']=function(){if(Number(cc['app']['gameRoom']['_conf']['roomType'])!==19){this['private_option_dropdown_panel']['active']=false;return;}");
  module=module.replace("Y['prototype']['onClickItem_3']=function(){",
    "Y['prototype']['onClickItem_3']=function(){if(!this['data']||this['data']['recentRecordsAvailable']===false){M['default']['showMoveTips']('暂无本房间真实牌局记录');return;}");
  module=module.replace("Y['prototype']['initView1']=function(){",
    "Y['prototype']['initView1']=function(){("+updatePanelRecordCaption.toString()+")(this,function(group,key){return M['default']['getLangText'](group,key);},cc['Label']);");
  module=module.replace("Y['prototype']['onUpdateList']=function(Z){",
    "Y['prototype']['onUpdateList']=function(Z){if(!this['data']||!Z||Number(Z['playerId'])!==Number(this['data']['playerId']))return;if(typeof window!=='undefined'&&window.__gogamePlayerPanelTarget&&Number(window.__gogamePlayerPanelTarget)!==Number(Z['playerId']))return;Z="+canonical+"(Z,typeof cc!=='undefined'&&cc['app']&&cc['app']['gameRoom']);");
  module=module.replace("Y['prototype']['onClickEmojItem']=function(Z){",
    "Y['prototype']['onClickEmojItem']=function(Z){var __profileTarget=Number(this['data']&&this['data']['playerId']);if(!Number.isSafeInteger(__profileTarget)||__profileTarget<=0||this['__giftSent']||(this['node']&&this['node']['active']===false)||!Z||!Z['target'])return;if(typeof window!=='undefined'&&window.__gogamePlayerPanelTarget&&Number(window.__gogamePlayerPanelTarget)!==__profileTarget)return;");
  module=module.replace("'toId':+this['data']['playerId']","'toId':__profileTarget");
  module=module.replace("J['default']['instance']['send'](K['default']['SEND']['SEND_USER_CHAT'],",
    "this['__giftSent']=true,J['default']['instance']['send'](K['default']['SEND']['SEND_USER_CHAT'],");
  module=module.replace("M['default']['loadBase64Img'](this['data']['imageUrl'],this['head_sprite']['getComponent'](cc['Sprite']))",
    '('+loadPanelAvatar.toString()+")(this,this['head_sprite']['getComponent'](cc['Sprite']),this['data']['imageUrl'],function(url,target){M['default']['loadBase64Img'](url,target);})");
  module=module.replace("Y['prototype']['onMenu1Event']=function(Z){var a0=Z['node']['getSiblingIndex']();",
    "Y['prototype']['onMenu1Event']=function(Z){var a0=Z['node']['getSiblingIndex']();if(a0===1){M['default']['showMoveTips']('高级道具暂未开放');this['menu_toggle_1']['getComponentInChildren'](cc['ToggleContainer'])['toggleItems'][0]['check']();return;}");
  module=module.replace("Y['prototype']['onReceiveRemark']=function(Z){",
    "Y['prototype']['onReceiveRemark']=function(Z){if(!this['data']||!Z||Number(Z['targetUid'])!==Number(this['data']['playerId']))return;");
  let result=source.slice(0,start)+module+source.slice(end);
  const recordsStart=result.indexOf("'RecordCenterRoomCardListView':[");
  const recordsEnd=result.indexOf("':[function",recordsStart+40);
  if(recordsStart>=0&&recordsEnd>recordsStart){
    const records=result.slice(recordsStart,recordsEnd).replace("this['title']['string']=ae['default']['getLangText']('common','last_7_days_records')",
      "this['title']['string']=ap['recentRecordScope']==='room'?'本房间牌局记录':ae['default']['getLangText']('common','last_7_days_records')");
    result=result.slice(0,recordsStart)+records+result.slice(recordsEnd);
  }
  const rowStart=result.indexOf("'RecordCenterRoomCardListItem':[");
  const rowEnd=result.indexOf("':[function",rowStart+40);
  if(rowStart>=0&&rowEnd>rowStart){
    const row=result.slice(rowStart,rowEnd).replace("this['label_endTime']['string']=ai,",
      "this['label_endTime']['string']=this['data']['endTime']?ai:'未记录时间',")
      .replace("},ae['prototype']['initOtherParam']=", "if(Number(ah)===25)this['handCardNum']=3;},ae['prototype']['initOtherParam']=");
    result=result.slice(0,rowStart)+row+result.slice(rowEnd);
  }
  result=result.replace("P['user_info']=function(R){","P['user_info']=function(R){if(typeof window!=='undefined'&&R&&Number(R['uid'])>0)window.__gogamePlayerPanelTarget=Number(R['uid']);");
  const notifyStart=result.indexOf("'NotificationCenter':["),notifyEnd=result.indexOf("'NotificationTime':[",notifyStart);
  if(notifyStart>=0&&notifyEnd>notifyStart){
    const notify=result.slice(notifyStart,notifyEnd).replace("h['emit']=function(j){",
      "h['emit']=function(j){if(Number(j)===8263){var __profile=arguments[1];if(!__profile||!Number.isSafeInteger(Number(__profile['playerId']))||Number(__profile['playerId'])<=0)return;if(typeof window!=='undefined'&&window.__gogamePlayerPanelTarget&&Number(window.__gogamePlayerPanelTarget)!==Number(__profile['playerId']))return;}");
    result=result.slice(0,notifyStart)+notify+result.slice(notifyEnd);
  }
  return result;
}

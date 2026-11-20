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

export function panelGameStatRows(data,roomType){
  var type=Number(roomType);if(![24,25,26,27,28,30,31,32].includes(type))return null;
  data=data||{};
  var integer=function(value){return Number.isSafeInteger(value)&&value>=0;};
  var total=data.isRobot?data.recentRecordCount:data.totalHands;
  var rate=function(field,count,denominator){
    var value=data[field];if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>100)return '--';
    if(count){var n=data[count],d=denominator===undefined?total:data[denominator];
      if(!integer(n)||!integer(d)||n>d||Math.abs(value-(d?Math.round(n/d*10000)/100:0))>0.000001)return '--';}
    return String(value)+'%';
  };
  var rows=[{key:'totalHands',label:'总手数',value:integer(data.totalHands)?String(data.totalHands):'--'},
    {key:'winPercent',label:'净盈利局占比',value:rate('winPercent')}];
  var add=function(label,field,count,denominator){rows.push({key:field,label:label,value:rate(field,count,denominator)});};
  if(type===25){add('主动下注率','joinPercent');add('加注率','flipManualBetPercent');add('本桌主动下注率','tableJoinPercent');}
  if(type===24||type===32){add('手动下注率','manualBetPercent','manualBetHands','betOpportunityHands');add('高于最低档下注率','aboveMinimumBetPercent','aboveMinimumBetHands','betOpportunityHands');
    if(type===24){add('手动抢庄率','manualGrabPercent','manualGrabHands');add('主动叫分抢庄率','positiveGrabPercent','positiveGrabHands');}}
  if(type===31){add('手动下注率','manualBetPercent','manualBetHands');add('加倍局占比','doublePercent','doubleHands');add('分牌局占比','splitPercent','splitHands');add('买保险局占比','insuranceBuyPercent','insuranceBuyHands');}
  if(type===27){add('客户端提交率','clientArrangementPercent','clientArrangementHands');add('自动理牌率','serverArrangementPercent','serverArrangementHands');add('延时使用率','extendedArrangementPercent','extendedArrangementHands');}
  if(type===26||type===28||type===30){add('客户端出牌局占比','clientDiscardPercent','clientDiscardHands');add('自动出牌局占比','serverDiscardPercent','serverDiscardHands');}
  return rows;
}

export function updatePanelGameTab(panel,cc,roomType){
  var menu=panel.menu_toggle_0,toggle=menu&&menu.getComponentInChildren(cc.ToggleContainer),node=toggle&&toggle.toggleItems[0]&&toggle.toggleItems[0].node;
  if(!node||typeof node.getComponentsInChildren!=='function')return;
  var native=[24,25,26,27,28,30,31,32].includes(Number(roomType));
  node.getComponentsInChildren(cc.Label).forEach(function(label){
    if(!label.__gogameGameTab){
      var before=label.beforI18nStringChangeFunc;label.__gogameGameTab={original:label.string};
      label.beforI18nStringChangeFunc=function(text){return label.__gogameGameTab.native?'游戏基础数据':before?before.call(label,text):text;};
    }
    label.__gogameGameTab.native=native;label.string=native?'游戏基础数据':label.__gogameGameTab.original;
  });
}

export function renderPanelGameStats(panel,cc,roomType,rowsFor){
  var rows=rowsFor(panel.data,roomType),old=panel.__gogameNativeStats;
  if(!rows){if(old){old.root.active=false;old.original.active=old.originalActive;}return false;}
  var view=panel.menu_views_0&&panel.menu_views_0.children[0],base=view&&view.getChildByName('base_info');
  var original=base&&base.getChildByName('content'),template=original&&original.getChildByName('item_0');
  if(!template)return false;
  base.active=true;var mtt=view.getChildByName('mtt_info');if(mtt)mtt.active=false;
  if(!old||old.base!==base){
    if(old&&old.root&&old.root.isValid!==false)old.root.destroy();
    var root=new cc.Node('gogame_native_stats');root.setContentSize(base.width,base.height);base.addChild(root);
    var viewport=new cc.Node('viewport');root.addChild(viewport);viewport.addComponent(cc.Mask);
    var content=new cc.Node('content');content.setAnchorPoint(0,1);viewport.addChild(content);
    var scroll=viewport.addComponent(cc.ScrollView);scroll.content=content;scroll.horizontal=false;scroll.vertical=true;scroll.inertia=true;scroll.cancelInnerEvents=true;
    var hint=new cc.Node('more');root.addChild(hint);var hintLabel=hint.addComponent(cc.Label);hintLabel.fontSize=20;hintLabel.lineHeight=24;hintLabel.string='上滑查看更多';
    old=panel.__gogameNativeStats={base:base,root:root,viewport:viewport,content:content,scroll:scroll,hint:hint,items:[],original:original,originalActive:original.active};
  }
  original.active=false;old.root.active=true;
  var width=base.width,height=base.height,more=rows.length>4,viewportHeight=height-(more?24:0),cellHeight=viewportHeight/2;
  var identity=String(roomType)+':'+String(panel.data&&panel.data.playerId),reset=old.identity!==identity||old.width!==width||old.height!==height||old.count!==rows.length;
  old.root.setContentSize(width,height);old.viewport.setContentSize(width,viewportHeight);old.viewport.setPosition(0,more?12:0);
  old.hint.active=more;old.hint.setPosition(0,-height/2+12);
  old.content.setContentSize(width,Math.ceil(rows.length/2)*cellHeight);
  rows.forEach(function(row,index){
    var item=old.items[index];if(!item){item=cc.instantiate(template);item.name='stat_'+index;old.content.addChild(item);old.items.push(item);}
    item.active=true;item.setPosition((index%2+0.5)*width/2,-(Math.floor(index/2)+0.5)*cellHeight);item.setContentSize(width/2,cellHeight);
    var title=item.getChildByName('title').getComponent(cc.Label),value=item.getChildByName('value').getComponent(cc.Label);
    // I18n labels may update after opening. Keep each generated caption tied
    // to the current row without changing the original prefab's labels.
    title.__gogameStatCaption=row.label;title.beforI18nStringChangeFunc=function(){return this.__gogameStatCaption;};title.string=row.label;value.string=row.value;
    var extra=item.getChildByName('PreRaiseExtraBtn');if(extra)extra.active=false;
    var button=item.getComponent(cc.Button);if(button)button.interactable=false;
  });
  old.items.forEach(function(item,index){if(index>=rows.length)item.active=false;});
  if(reset){old.scroll.stopAutoScroll();old.content.setPosition(-width/2,viewportHeight/2);old.scroll.scrollToTop(0);}
  old.identity=identity;old.width=width;old.height=height;old.count=rows.length;
  var layout=panel.menu_views_0.getComponent(cc.Layout);if(layout)layout.updateLayout();
  return true;
}

export function adaptPlayerPanelResponse(source){
  const start=source.indexOf("'chatPanel':[");if(start<0)return source;
  const end=source.indexOf("'chatSelf':[",start);if(end<start)return source;
  let module=source.slice(start,end);
  if(module.includes('GOGAME_PLAYER_PANEL_V2'))return source;
  if(module.includes('GOGAME_PLAYER_PANEL'))throw new Error('Player panel adapter expects the original asset');
  module=module.replace("'chatPanel':[","'chatPanel':[/* GOGAME_PLAYER_PANEL_V2 */");
  const canonical='('+canonicalPanelProfile.toString()+')';
  module=module.replace("Y['prototype']['initView0']=function(){",
    "Y['prototype']['initView0']=function(){if(("+renderPanelGameStats.toString()+")(this,cc,cc['app']['gameRoom']['_conf']['roomType'],("+panelGameStatRows.toString()+")))return;");
  module=module.replace("Y['prototype']['init']=function(Z){",
    "Y['prototype']['init']=function(Z){if(!Z||!Number.isSafeInteger(Number(Z['playerId']))||Number(Z['playerId'])<=0)return;if(typeof window!=='undefined'&&window.__gogamePlayerPanelTarget&&Number(window.__gogamePlayerPanelTarget)!==Number(Z['playerId']))return;Z="+canonical+"(Z,cc['app']['gameRoom']);this['__giftSent']=false;");
  module=module.replace("Y['prototype']['show']=function(){",
    "Y['prototype']['show']=function(){if(!this['data']||!this['data']['playerId'])return;if(this['private_option_dropdown_panel'])this['private_option_dropdown_panel']['active']=false;("+updatePanelGameTab.toString()+")(this,cc,cc['app']['gameRoom']['_conf']['roomType']);");
  module=module.replace("Y['prototype']['isShow']=function(){",
    "Y['prototype']['isShow']=function(){if([24,25,26,27,28,30,31,32].includes(Number(cc['app']['gameRoom']['_conf']['roomType'])))return true;");
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

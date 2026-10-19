const fs = require('node:fs');
const path = require('node:path');

const [source, target] = process.argv.slice(2);
if (!source || !target) {
  throw new Error('Usage: node port-communication-logs.js <source> <target>');
}

let code = fs.readFileSync(source, 'utf8');

function replaceOnce(needle, replacement, label) {
  const first = code.indexOf(needle);
  if (first < 0 || code.indexOf(needle, first + needle.length) >= 0) {
    throw new Error('Expected one occurrence for ' + label);
  }
  code = code.slice(0, first) + replacement + code.slice(first + needle.length);
}

const loggerBootstrap =
  "window['__gogameNativeLog']=window['__gogameNativeLog']||(window['console']&&window['console']['log']?window['console']['log']['bind'](window['console']):function(){});window['__gogameNativeLogInstalled']||(window['__gogameNativeLogInstalled']=!0x0,window['__gogameNativeLog']('[GoGame] JSON communication logger installed'));";

if (!code.startsWith("window['__require']")) {
  throw new Error('Unexpected bundle header');
}
code = loggerBootstrap + code;

replaceOnce(
  "A['qos']=this['config']['qos'],this['client']['send'](A);",
  "A['qos']=this['config']['qos'],window['__gogameNativeLog']('[MqttBridge] send',A['destinationName'],JSON['stringify'](z)),this['client']['send'](A);",
  'MQTT publish'
);

const mqttModule = code.indexOf("'MqttBridge':[function");
const mqttReceiveStart = "this['client']['onMessageArrived']=function(x){";
const mqttReceiveEnd = "},this['client']['connect'](";
const mqttStart = code.indexOf(mqttReceiveStart, mqttModule);
const mqttEnd = mqttStart < 0 ? -1 : code.indexOf(mqttReceiveEnd, mqttStart);
if (mqttModule < 0 || mqttStart < 0 || mqttEnd < 0) {
  throw new Error('Could not locate MqttBridge receive callback');
}
const mqttReceive =
  "this['client']['onMessageArrived']=function(x){var y=x&&x['payloadString']?x['payloadString']:'';try{y=JSON['stringify'](JSON['parse'](y));}catch(z){y=JSON['stringify'](y);}window['__gogameNativeLog']('[MqttBridge] recv',(null==x?void 0x0:x['destinationName'])||'',y),v['onMessage']((null==x?void 0x0:x['destinationName'])||'',x&&x['payloadString']?x['payloadString']:'');}";
code = code.slice(0, mqttStart) + mqttReceive + code.slice(mqttEnd + 1);

const roomLogStart = "if(cc['sys']['isNative'])console['log']";
const roomLogEnd = ",Z['prototype']['writeBuffer']";
const roomStart = code.indexOf(roomLogStart);
const roomEnd = roomStart < 0 ? -1 : code.indexOf(roomLogEnd, roomStart);
if (roomStart < 0 || roomEnd < 0) {
  throw new Error('Could not locate RoomSocketBase log formatter');
}
code =
  code.slice(0, roomStart) +
  "window['__gogameNativeLog'](a6+'\\x20'+a2+'\\x20'+a7+'\\x20'+a8+'\\x20data='+JSON['stringify'](a3));}" +
  code.slice(roomEnd);

const chatSendStart = "w['prototype']['send']=function(x,y){";
const chatSendEnd = ",w['prototype']['close']=function(x)";
const sendStart = code.indexOf(chatSendStart);
const sendEnd = sendStart < 0 ? -1 : code.indexOf(chatSendEnd, sendStart);
if (sendStart < 0 || sendEnd < 0) {
  throw new Error('Could not locate ChatSocket send method');
}
const chatSend =
  "w['prototype']['send']=function(x,y){if(!this['_isConnecting']&&this['_isConnected']&&null!=this['_socket']){try{var z=this['writeBuffer'](x,y);}catch(A){return;}try{x==m['default']['CHAT_SEND']['PING']||this['_noPrint'][x]||window['__gogameNativeLog']('[ChatSocket] send',this['_socket']['url'],JSON['stringify'](y)),this['_socket']['send'](z);}catch(B){}}}";
code = code.slice(0, sendStart) + chatSend + code.slice(sendEnd);

const chatRecvStart = "w['prototype']['onMessageBack']=function(x){";
const chatRecvEnd = ",w['prototype']['writeBuffer']=function(x,y)";
const recvStart = code.indexOf(chatRecvStart);
const recvEnd = recvStart < 0 ? -1 : code.indexOf(chatRecvEnd, recvStart);
if (recvStart < 0 || recvEnd < 0) {
  throw new Error('Could not locate ChatSocket receive method');
}
const chatReceive =
  "w['prototype']['onMessageBack']=function(x){if(!this['_isConnecting']){var y='';try{null!=(x=this['readBuffer'](x['data']))['content']&&(y=JSON['parse'](x['content']));}catch(z){return;}x['msgid']==m['default']['CHAT_PUSH']['PING']||this['_noPrint'][x['msgid']]||window['__gogameNativeLog']('[ChatSocket] recv',this['_socket']['url'],JSON['stringify'](y));switch(x['msgid']){case 0x270f:y['msgCode'],p['default']['showMoveTips'](y['errorMsg']);default:k['default']['emit'](x['msgid'],y);}}}";
code = code.slice(0, recvStart) + chatReceive + code.slice(recvEnd);

fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, code, 'utf8');
process.stdout.write('Wrote transformed A bundle: ' + target + '\n');

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('the supplied native common model consumes 9212 as a number across repeated carry and stand updates',()=>{
  const source=fs.readFileSync(new URL('../../static/client/2.0.1279/assets/main/index.88f4e.js',import.meta.url),'utf8');
  const match=source.match(/\['updateGamePoint'\]=function\((\w+)\)\{([A-Za-z_$][\w$]*)\['default'\]\['walletAmount'\]=\1,null!=\2\['default'\]\['clubData'\]&&\(\2\['default'\]\['clubData'\]\['walletAmount'\]=\1\);\}/);
  assert.ok(match,'verify the common native wallet consumer when changing the supplied bundle');
  const data={walletAmount:100000,clubData:{walletAmount:100000}},context=vm.createContext({[match[2]]:{default:data}});
  const update=vm.runInContext('('+match[0].slice(match[0].indexOf('function'))+')',context);
  update({uid:42,point:100000});assert.equal(Number.isFinite(data.walletAmount),false,'old envelope must reproduce native balance corruption');
  for(let cycle=0;cycle<20;cycle++){
    update(100000-cycle*10);assert.equal(data.walletAmount,100000-cycle*10);assert.equal(data.clubData.walletAmount,data.walletAmount);
    assert.ok(Number.isFinite(data.walletAmount/100),'native money controls require a numeric wallet');
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { currencyToScore } from '../../../shared/rpc/implementations/prod/commonRpcProd.js';

test('production display currency converts exactly to the integer units used by cash RPC',()=>{
  for(const [input,expected] of [['0.00',0],['1',100],['1.2',120],['99.99',9999],['90071992547409.91',Number.MAX_SAFE_INTEGER]])assert.equal(currencyToScore(input),expected);
  for(const invalid of [undefined,NaN,'-1.00','1.234','90071992547409.92'])assert.throws(()=>currencyToScore(invalid));
});

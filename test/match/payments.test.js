import test from 'node:test';
import assert from 'node:assert/strict';
import {createMatchPayments} from '../../match/src/payments.js';

test('uncertain production payments query the original plan without issuing another money request',async()=>{
  for(const [operation,status,field] of [['charge','charged','receipt'],['refund','refunded','refund'],['award','paid','receipt']]){
    const calls=[],plan={key:'match:7:9:42:1'},receipt={key:plan.key};
    const common={async matchPayment(op,input,includeService){calls.push({op,input,includeService});if(op!=='query')throw Object.assign(new Error('lost reply'),{status:503});return {status,[field]:receipt};}};
    assert.deepEqual(await createMatchPayments(common)[operation](plan,false),receipt);
    assert.deepEqual(calls.map(c=>c.op),[operation,'query']);assert.ok(calls.every(c=>c.input===plan));
    if(operation==='refund')assert.equal(calls[0].includeService,true);
  }
  const payments=createMatchPayments({async matchPayment(op){if(op==='query')return {status:'prepared'};throw Object.assign(new Error('not confirmed'),{status:503});}});
  await assert.rejects(()=>payments.charge({key:'original'}),/not confirmed/);
});

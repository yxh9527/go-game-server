import test from 'node:test';
import assert from 'node:assert/strict';
import {terminationRequest} from '../../match/src/termination-request.js';

test('termination audit uses the authenticated agent scope and a bounded reason without credentials',()=>{
  const scope={agentId:7,kind:'agent',token:'private',agent_id:999};
  assert.deepEqual(terminationRequest(scope,'  operator requested stop  '),{reason:'operator requested stop',actor:{agentId:7,kind:'agent'}});
  for(const reason of ['',null,{},' '.repeat(10),'x'.repeat(301)])assert.throws(()=>terminationRequest(scope,reason),e=>e.status===400);
  for(const actor of [null,{agentId:0,kind:'agent'},{agentId:7,kind:'player'}])assert.throws(()=>terminationRequest(actor,'stop'),e=>e.status===403);
});

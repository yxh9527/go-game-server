import {importHotModule} from '../../shared/hot-import.js';
import test from 'node:test';
import assert from 'node:assert/strict';
const {lateRegistrationOpen}=await importHotModule(new URL('../../shared/tournament-registration.js',import.meta.url).href,'tournament-regression');

test('late registration closes at the first configured time or level limit and requires a trusted level',()=>{
  const row={state:2,start_time:100000,delay_register_level:2,delay_register_time:120};
  assert.equal(lateRegistrationOpen(row,{currentBlindLv:2},219999),true);
  assert.equal(lateRegistrationOpen(row,{currentBlindLv:2},220000),false);
  assert.equal(lateRegistrationOpen(row,{currentBlindLv:3},150000),false);
  assert.equal(lateRegistrationOpen(row,{currentBlindLv:1,nextBlindAt:149999},150000),false,'stale level snapshots cannot authorize a charge');
  assert.equal(lateRegistrationOpen(row,undefined,150000),false);
  assert.equal(lateRegistrationOpen({...row,delay_register_time:0},{currentBlindLv:2},999999),true);
  assert.equal(lateRegistrationOpen({...row,delay_register_level:0},undefined,150000),true);
  assert.equal(lateRegistrationOpen({...row,delay_register_time:0,delay_register_level:0},{currentBlindLv:1},150000),false);
  assert.equal(lateRegistrationOpen({...row,state:4},{currentBlindLv:1},150000),false);
});

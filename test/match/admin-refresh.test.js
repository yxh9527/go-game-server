import test from 'node:test';
import assert from 'node:assert/strict';
import {createAdminRefresh} from '../../match/src/admin-refresh.js';

function fixture(){
  let view='matches',scope=1;
  const refresh=createAdminRefresh({view:()=>view,scope:()=>scope,assertScope:expected=>{if(expected!==scope)throw Object.assign(Error('stale scope'),{staleAdminRequest:true});},
    stale:()=>Object.assign(Error('stale view'),{staleAdminRequest:true})});
  return {refresh,view(next){view=next;refresh.invalidate();},identity(){scope++;refresh.invalidate();}};
}

test('foreground list reading blocks background polling and releases its own ownership',()=>{
  const {refresh}=fixture(),ticket=refresh.foreground();
  assert.equal(refresh.background(),null);assert.deepEqual(refresh.stats(),{foregroundReads:1,backgroundReads:0});
  refresh.assertCurrent(ticket);refresh.finish(ticket);
  const poll=refresh.background();assert.ok(poll);assert.equal(refresh.background(),null);
  refresh.assertCurrent(poll);refresh.finish(poll);assert.deepEqual(refresh.stats(),{foregroundReads:0,backgroundReads:0});
});

test('foreground refresh supersedes an earlier poll without an old completion unlocking the new request',()=>{
  const {refresh}=fixture(),poll=refresh.background(),manual=refresh.foreground();
  assert.throws(()=>refresh.assertCurrent(poll),{staleAdminRequest:true});
  refresh.finish(poll);assert.deepEqual(refresh.stats(),{foregroundReads:1,backgroundReads:0});
  refresh.assertCurrent(manual);assert.equal(refresh.background(),null);refresh.finish(manual);
  assert.ok(refresh.background());
});

test('newer manual reads supersede older ones, while late cleanup cannot release the newest ticket',()=>{
  const {refresh}=fixture(),first=refresh.foreground(),second=refresh.foreground();
  assert.throws(()=>refresh.assertCurrent(first),{staleAdminRequest:true});refresh.finish(first);
  refresh.assertCurrent(second);assert.equal(refresh.background(),null);
  refresh.finish(second);assert.deepEqual(refresh.stats(),{foregroundReads:0,backgroundReads:0});
});

test('leaving and returning to the same tab never revives the old list request',()=>{
  const f=fixture(),old=f.refresh.foreground();f.view('blinds');f.view('matches');
  const fresh=f.refresh.foreground();assert.throws(()=>f.refresh.assertCurrent(old),{staleAdminRequest:true});
  f.refresh.finish(old);f.refresh.assertCurrent(fresh);assert.equal(f.refresh.stats().foregroundReads,1);
  f.refresh.finish(fresh);
});

test('identity changes invalidate current reads and diagnostic snapshots cannot alter ownership',()=>{
  const f=fixture(),old=f.refresh.background();f.identity();
  assert.throws(()=>f.refresh.assertCurrent(old),{staleAdminRequest:true});
  assert.deepEqual(f.refresh.stats(),{foregroundReads:0,backgroundReads:0});
  const current=f.refresh.foreground(),snapshot=f.refresh.stats();snapshot.foregroundReads=0;
  assert.equal(f.refresh.stats().foregroundReads,1);f.refresh.finish(old);f.refresh.assertCurrent(current);f.refresh.finish(current);
});

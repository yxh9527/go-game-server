import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {adminPage} from '../../match/src/admin-page.js';
import {createAdminSubmissions} from '../../match/src/admin-submissions.js';

function fixture(){
  const attrs=new Map(),button={disabled:false},notices=[],state=createAdminSubmissions();
  const form={dataset:{},querySelectorAll:()=>[button],setAttribute:(key,value)=>attrs.set(key,value),getAttribute:key=>attrs.get(key),removeAttribute:key=>attrs.delete(key)};
  const source=adminPage.match(/<script>([\s\S]*?)<\/script>/)[1];
  const functions=source.slice(source.indexOf('function updateEditorControls('),source.indexOf('async function editorRequest('));
  const context=vm.createContext({adminSubmissions:state,run:work=>work(),notice:message=>notices.push(message)});
  vm.runInContext(functions,context);
  return {form,button,notices,state,context};
}

test('unfinished editor rejects a programmatic submit without sending any request',()=>{
  const f=fixture();let calls=0;
  f.context.setEditorLoading(f.form,true);
  assert.equal(f.button.disabled,true);
  assert.equal(f.context.submitForm(f.form,()=>{calls++;}),false);
  assert.equal(calls,0);assert.equal(f.state.stats().pendingForms,0);assert.equal(f.notices.length,1);
  f.context.setEditorLoading(f.form,false);assert.equal(f.button.disabled,false);
});

test('a previous save completing cannot enable the button of a newer unfinished editor',async()=>{
  const f=fixture();let finish;
  const pending=f.context.submitForm(f.form,()=>new Promise(resolve=>{finish=resolve;}));
  assert.equal(f.button.disabled,true);assert.equal(f.form.getAttribute('aria-busy'),'true');
  f.context.setEditorLoading(f.form,true);finish();await pending;
  assert.equal(f.button.disabled,true);assert.equal(f.form.getAttribute('aria-busy'),undefined);
  assert.equal(f.state.stats().pendingForms,0);
  f.context.setEditorLoading(f.form,false);assert.equal(f.button.disabled,false);
});

test('metadata completing cannot unlock a save that is still in progress',async()=>{
  const f=fixture();let finish;
  const pending=f.context.submitForm(f.form,()=>new Promise(resolve=>{finish=resolve;}));
  f.context.setEditorLoading(f.form,true);f.context.setEditorLoading(f.form,false);
  assert.equal(f.button.disabled,true);assert.equal(f.state.stats().pendingForms,1);
  assert.equal(f.context.submitForm(f.form,()=>assert.fail('duplicate save')),false);
  finish();await pending;assert.equal(f.button.disabled,false);assert.equal(f.state.stats().pendingForms,0);
});

test('failed saves release busy state while preserving a newer loading guard',async()=>{
  const f=fixture();let fail;
  const pending=f.context.submitForm(f.form,()=>new Promise((_,reject)=>{fail=reject;}));
  f.context.setEditorLoading(f.form,true);fail(Error('save failed'));
  await assert.rejects(pending,/save failed/);
  assert.equal(f.button.disabled,true);assert.equal(f.form.getAttribute('aria-busy'),undefined);assert.equal(f.state.stats().pendingForms,0);
  f.context.setEditorLoading(f.form,false);assert.equal(f.button.disabled,false);
});

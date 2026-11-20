// A resident timer may call a handler whose work becomes asynchronous after a
// business update. Observe rejections and never queue another copy while busy.
export function runResidentTick(state,work,onError){
  if(state.task)return state.task;
  const task=Promise.resolve().then(work).catch(error=>{
    try{onError(error);}catch{/* A failing logger must not create another rejection. */}
  }).finally(()=>{if(state.task===task)state.task=null;});
  state.task=task;return task;
}

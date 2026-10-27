const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function functionSource(name) {
  let start = html.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' exists');
  if (html.slice(start - 6, start) === 'async ') start -= 6;
  const brace = html.indexOf('{', start);
  let depth = 0, quote = '', escaped = false, line = false, block = false;
  for (let i = brace; i < html.length; i++) {
    const c = html[i], n = html[i + 1];
    if (line) { if (c === '\n') line = false; continue; }
    if (block) { if (c === '*' && n === '/') { block = false; i++; } continue; }
    if (quote) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === quote) quote = ''; continue; }
    if (c === '/' && n === '/') { line = true; i++; continue; }
    if (c === '/' && n === '*') { block = true; i++; continue; }
    if (['"', "'", '`'].includes(c)) { quote = c; continue; }
    if (c === '{') depth++;
    if (c === '}' && --depth === 0) return html.slice(start, i + 1);
    if (c !== '}') continue;
  }
  throw new Error('Unclosed ' + name);
}

function fixture() {
  const calls = { end:0, finish:0, focus:0, routes:[], cleanups:[], errors:[] };
  const dialogs = [];
  const focused = {isConnected:true, focus() { calls.focus++; }};
  const body = {appendChild(dialog) { dialogs.push(dialog); }};
  const context = {
    pl:{sessionId:'TEST-END',code:'TEST22',sessionLabel:'TEST_<종료>'},
    document:{body,activeElement:focused,fullscreenElement:null,createElement() {
      return {open:false,innerHTML:'',listeners:{},setAttribute() {},
        addEventListener(name,fn) {this.listeners[name]=fn;},
        showModal() {this.open=true;},close() {this.open=false;this.listeners.close?.();},
        remove() {this.removed=true;},querySelector() {return {focus(){}};}};
    }},
    esc(value) {return String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');},
    onCleanup(fn) {calls.cleanups.push(fn);},
    confirm() {throw new Error('Native confirmation must not be used');},
    async plExitStageFullscreen() {},
    store:{async endSession() {calls.end++;},async finishClassPlan() {calls.finish++;return {revision:2};}},
    pendingAllocationRemove() {},toast() {},go(route) {calls.routes.push(route);},
    console:{error(error) {calls.errors.push(error.message);}}
  };
  for (const name of ['plDismissEndSessionDialog','plRenderEndSessionDialog','plConfirmSessionEnd','plEndDialogAnswer','plEndSession']) {
    vm.runInNewContext(functionSource(name),context);
  }
  return {context,calls,dialogs,state:context.pl};
}
const tick = () => new Promise(setImmediate);

test('end-dialog: explicit DOM confirmation preserves cancel and never calls native confirm', async () => {
  const {context,calls,dialogs,state}=fixture();
  const ending=context.plEndSession();
  assert.equal(calls.end,0);
  assert.match(dialogs[0].innerHTML,/진행을 종료할까요\?/);
  assert.match(dialogs[0].innerHTML,/학생 화면은 종료 안내로 바뀌고, 기록은 그대로 남습니다/);
  assert.match(dialogs[0].innerHTML,/취소/);
  assert.match(dialogs[0].innerHTML,/종료 확인/);
  assert.match(dialogs[0].innerHTML,/TEST22/);
  assert.match(dialogs[0].innerHTML,/TEST_&lt;종료&gt;/);
  context.plEndDialogAnswer(false);
  await ending;
  assert.equal(calls.end,0);
  assert.equal(state.endingSession,false);
  assert.equal(dialogs[0].removed,true);
  assert.equal(calls.focus,1);
});

test('end-dialog: duplicate clicks save once and busy dialog blocks cancellation', async () => {
  const {context,calls,dialogs,state}=fixture();
  let complete;
  context.store.endSession=()=>{calls.end++;return new Promise(resolve=>{complete=resolve;});};
  const ending=context.plEndSession();
  await context.plEndSession();
  assert.equal(dialogs.length,1);
  context.plEndDialogAnswer(true);
  context.plEndDialogAnswer(true);
  await tick();
  assert.equal(calls.end,1);
  assert.match(dialogs[0].innerHTML,/종료 처리 중/);
  assert.match(dialogs[0].innerHTML,/disabled/);
  context.plEndDialogAnswer(false);
  assert.equal(dialogs[0].open,true);
  complete();await ending;
  assert.equal(state.sessionEnded,true);
  assert.deepEqual(calls.routes,['live/TEST-END']);
  assert.equal(dialogs[0].removed,true);
});

test('end-dialog: Escape and route cleanup cancel pending confirmation without writes', async () => {
  for (const route of [false,true]) {
    const {context,calls,dialogs}=fixture();
    const ending=context.plEndSession();
    if (route) {context.pl=null;calls.cleanups.forEach(fn=>fn());}
    else {let prevented=false;dialogs[0].listeners.cancel({preventDefault(){prevented=true;}});assert.equal(prevented,true);}
    await ending;
    assert.equal(calls.end,0);assert.equal(dialogs[0].removed,true);
  }
});

test('end-dialog: failed save is visible and retries the same confirmed session', async () => {
  const {context,calls,dialogs,state}=fixture();
  context.store.endSession=async()=>{calls.end++;if(calls.end===1)throw new Error('offline <TEST>');};
  const first=context.plEndSession();context.plEndDialogAnswer(true);
  await assert.rejects(first,/offline/);
  assert.match(dialogs[0].innerHTML,/role="alert"/);
  assert.match(dialogs[0].innerHTML,/offline &lt;TEST&gt;/);
  assert.match(dialogs[0].innerHTML,/다시 시도/);
  assert.notEqual(state.sessionEnded,true);
  assert.equal(state.endingSession,false);
  await context.plEndSession();
  assert.equal(calls.end,2);assert.equal(state.sessionEnded,true);
});

test('end-dialog: plan finalization failure preserves terminal state and exposes a retry', async () => {
  const {context,calls,dialogs,state}=fixture();
  Object.assign(state,{classPlanAttached:true,classPlanId:'TEST-PLAN',classPlanRevision:1});
  context.store.finishClassPlan=async()=>{calls.finish++;if(calls.finish===1)throw new Error('finish offline');return {revision:2};};
  const first=context.plEndSession();context.plEndDialogAnswer(true);
  await assert.rejects(first,/finish offline/);
  assert.equal(state.sessionEnded,true);
  assert.match(dialogs[0].innerHTML,/수업은 종료됐지만/);
  assert.equal(calls.routes.length,0);
  await context.plEndSession();
  assert.equal(state.classPlanFinished,true);assert.equal(calls.finish,2);
});

test('end-dialog: cancelling while an image completes leaves its question queued and no pending flight', async () => {
  const {context,calls,state}=fixture();
  let releaseImage;
  Object.assign(state,{set:{settings:{autoPause:false}},live:{q:-1},dueQuestions:[],
    flatQuestions:[{type:'choice',imgUp:true}]});
  context.loadQuestionImage=()=>new Promise(resolve=>{releaseImage=resolve;});
  vm.runInNewContext(functionSource('plOpenQuestion'),context);
  const opening=context.plOpenQuestion(0);
  const ending=context.plEndSession();
  releaseImage('TEST image');
  assert.equal(await opening,false);
  context.plEndDialogAnswer(false);await ending;
  assert.equal(state.pendingLiveQuestion,-1);
  assert.equal(state.endingSession,false);
  assert.equal(calls.end,0);
  assert.deepEqual(Array.from(state.dueQuestions),[0]);
});

test('end-dialog: fallback fullscreen Escape is left to the dialog cancel handler', async () => {
  const {context,state,dialogs}=fixture();
  let fullscreenExits=0, prevented=false;
  state.stageFallback=true;
  context.plExitStageFullscreen=()=>{fullscreenExits++;};
  vm.runInNewContext(functionSource('plHandleStageKeydown'),context);
  const ending=context.plEndSession();
  context.plHandleStageKeydown({key:'Escape',preventDefault(){prevented=true;}});
  assert.equal(prevented,false);
  assert.equal(fullscreenExits,0);
  dialogs[0].listeners.cancel({preventDefault(){}});await ending;
  assert.equal(state.endingSession,false);
});

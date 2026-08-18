const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../auth-core.js');

function readIndex() {
  return fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
}

function extractFunction(source, name) {
  const start = source.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'Expected function ' + name);
  const brace = source.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = brace; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === "'" || char === '"' || char === '`') { quote = char; continue; }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error('Expected complete function ' + name);
}

test('a verified Google account with an enabled allowance is a teacher', () => {
  assert.equal(core.teacherState(null, null).status, 'signed-out');
  assert.equal(
    core.teacherState({ uid: 'u1', email: 'a@school.kr', emailVerified: true, isAnonymous: false,
      providerData: [{ providerId: 'google.com' }] }, null).status,
    'unapproved'
  );
  assert.deepEqual(
    core.teacherState(
      { uid: 'u1', email: 'a@school.kr', emailVerified: true, isAnonymous: false,
        providerData: [{ providerId: 'google.com' }] },
      { enabled: true, role: 'teacher' }
    ),
    { status: 'teacher', uid: 'u1', email: 'a@school.kr', role: 'teacher' }
  );
});

test('anonymous and unverified accounts are not teachers', () => {
  assert.equal(
    core.isTeacher(core.teacherState({ uid: 's', isAnonymous: true }, { enabled: true, role: 'admin' })),
    false
  );
  assert.equal(
    core.isTeacher(core.teacherState({ uid: 'u', email: 'x@y', emailVerified: false,
      providerData: [{ providerId: 'google.com' }] }, { enabled: true, role: 'teacher' })),
    false
  );
});

test('student join does not require the Google teacher sign-in', () => {
  const html = readIndex();
  assert.match(html, /function ensureAnonymousStudent/);
  assert.match(html, /function requireTeacher/);
  assert.doesNotMatch(extractFunction(html, 'screenJoin'), /signInWithPopup/);
});

test('a verified non-Google provider cannot receive a teacher role', () => {
  const state = core.teacherState({
    uid: 'password-user', email: 'teacher@school.kr', emailVerified: true, isAnonymous: false,
    providerData: [{ providerId: 'password' }]
  }, { enabled: true, role: 'admin' });

  assert.equal(state.status, 'signed-out');
  assert.equal(core.isTeacher(state), false);
  assert.equal(core.isAdmin(state), false);
});

test('the admin route uses the admin-only access gate', () => {
  const router = extractFunction(readIndex(), 'router');
  assert.match(router, /case 'admin':\s*requireAdmin\(screenAdmin\)/);
});

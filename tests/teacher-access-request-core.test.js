const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../teacher-access-request-core.js');

const user = {
  uid: 'teacher-a',
  email: ' Teacher@School.KR ',
  displayName: '김교사',
  emailVerified: true,
  isAnonymous: false,
  providerData: [{ providerId: 'google.com' }]
};

function request(overrides = {}) {
  return Object.assign(core.buildRequest(user, {
    organization: '1학년',
    note: '보건 수업',
    status: 'approved',
    revision: 99,
    decidedByUid: 'caller-admin',
    decisionReason: 'caller reason'
  }, 1000), overrides);
}

function expectInvalidBuild(candidate, pattern) {
  assert.throws(() => core.buildRequest(candidate, { organization: '', note: '' }, 1000), pattern);
}

test('verified Google user creates the literal normalized pending request', () => {
  assert.deepEqual(core.buildRequest(user, { organization: '1학년', note: '보건 수업' }, 1000), {
    uid: 'teacher-a', emailCanonical: 'teacher@school.kr', displayName: '김교사',
    organization: '1학년', note: '보건 수업', status: 'pending', revision: 1,
    createdAtMs: 1000, updatedAtMs: 1000
  });
});

test('buildRequest derives identity and ignores caller privileged fields', () => {
  const input = {
    uid: 'attacker', email: 'attacker@example.com', displayName: '공격자',
    organization: '1학년', note: '보건 수업', status: 'approved', revision: 42,
    decidedAtMs: 20, decidedByUid: 'admin', decisionReason: 'forged'
  };
  const built = core.buildRequest(user, input, 1000);
  assert.equal(built.uid, 'teacher-a');
  assert.equal(built.emailCanonical, 'teacher@school.kr');
  assert.equal(built.displayName, '김교사');
  assert.equal(built.status, 'pending');
  assert.equal(built.revision, 1);
  assert.deepEqual(input, {
    uid: 'attacker', email: 'attacker@example.com', displayName: '공격자',
    organization: '1학년', note: '보건 수업', status: 'approved', revision: 42,
    decidedAtMs: 20, decidedByUid: 'admin', decisionReason: 'forged'
  });
});

test('buildRequest requires a verified Google identity and bounded profile fields', () => {
  expectInvalidBuild({ ...user, isAnonymous: true }, /anonymous|인증/);
  expectInvalidBuild({ ...user, emailVerified: false }, /verified|인증/);
  expectInvalidBuild({ ...user, providerData: [{ providerId: 'password' }] }, /Google|google/);
  expectInvalidBuild({ ...user, displayName: '' }, /이름|name/);
  expectInvalidBuild({ ...user, displayName: 'x'.repeat(81) }, /이름|name/);
  assert.throws(() => core.buildRequest(user, { organization: 'x'.repeat(121), note: '' }, 1000), /조직|organization/);
  assert.throws(() => core.buildRequest(user, { organization: '', note: 'x'.repeat(501) }, 1000), /메모|note/);
});

test('validateRequest reports valid and invalid request documents', () => {
  assert.deepEqual(core.validateRequest(request()), { ok: true, errors: [] });
  for (const [field, value] of [
    ['status', 'unknown'], ['revision', 0], ['revision', 1.5],
    ['displayName', ''], ['displayName', '   '], ['displayName', 'x'.repeat(81)],
    ['organization', 'x'.repeat(121)], ['note', 'x'.repeat(501)]
  ]) {
    const result = core.validateRequest(request({ [field]: value }));
    assert.equal(result.ok, false, `expected ${field} to be rejected`);
    assert.ok(result.errors.length > 0);
  }
});

test('canCancel only allows the owner to cancel a pending request', () => {
  const pending = request({ status: 'pending' });
  assert.equal(core.canCancel(pending, 'teacher-a'), true);
  assert.equal(core.canCancel(pending, 'other-user'), false);
  assert.equal(core.canCancel(request({ status: 'approved' }), 'teacher-a'), false);
  assert.equal(core.canCancel(request({ status: 'rejected' }), 'teacher-a'), false);
});

test('nextDecision returns an immutable approved decision with bounded audit fields', () => {
  const before = request({ status: 'pending' });
  const decided = core.nextDecision(before, {
    status: 'approved', reason: 'x'.repeat(200)
  }, { uid: 'admin-1' }, 2000);
  assert.deepEqual(decided, {
    ...before,
    status: 'approved', revision: 2, decidedAtMs: 2000,
    decidedByUid: 'admin-1', decisionReason: 'x'.repeat(200), updatedAtMs: 2000
  });
  assert.deepEqual(before, request({ status: 'pending' }));
  assert.throws(() => core.nextDecision(before, { status: 'approved', reason: 'x'.repeat(201) }, { uid: 'admin-1' }, 2000), /사유|reason/);
});

test('nextDecision rejects stale or invalid decisions and missing admins', () => {
  const pending = request({ status: 'pending' });
  for (const decision of ['cancelled', 'pending', 'unknown', { status: 'cancelled' }]) {
    assert.throws(() => core.nextDecision(pending, decision, { uid: 'admin-1' }, 2000), /결정|decision|상태/);
  }
  assert.throws(() => core.nextDecision(request({ status: 'approved' }), 'rejected', { uid: 'admin-1' }, 2000), /pending|대기/);
  assert.throws(() => core.nextDecision(pending, 'approved', {}, 2000), /admin|관리자/);
  assert.throws(() => core.nextDecision(pending, 'approved', { uid: '' }, 2000), /admin|관리자/);
});

test('teacherStatus maps lifecycle allowance states and accepts legacy enabled', () => {
  assert.equal(core.teacherStatus({ status: 'active' }), 'active');
  assert.equal(core.teacherStatus({ status: 'suspended' }), 'suspended');
  assert.equal(core.teacherStatus({ status: 'deletion_pending' }), 'deletion_pending');
  assert.equal(core.teacherStatus({ enabled: true }), 'active');
  assert.equal(core.teacherStatus({ enabled: false }), 'unapproved');
  assert.equal(core.teacherStatus(null), 'unapproved');
  assert.equal(core.teacherStatus({ status: 'pending' }), 'unapproved');
});

test('index loads the browser core alongside local scripts', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /<script src="teacher-access-request-core\.js"><\/script>/);
});

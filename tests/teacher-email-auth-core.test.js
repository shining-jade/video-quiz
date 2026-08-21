const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../teacher-email-auth-core');

test('signup canonicalizes email and requires name and 8 character password', () => {
  assert.deepEqual(Core.normalizeSignup({
    displayName: ' 홍교사 ', email: ' Teacher@Example.COM ', password: '12345678'
  }), { displayName: '홍교사', email: 'teacher@example.com', password: '12345678' });
  assert.throws(() => Core.normalizeSignup({ displayName: '', email: 'a@b.co', password: '12345678' }));
  assert.throws(() => Core.normalizeSignup({ displayName: '교사', email: 'a@b.co', password: '1234567' }));
});

test('login canonicalizes email and requires an 8 character password', () => {
  assert.deepEqual(Core.normalizeLogin({ email: ' Teacher@Example.COM ', password: '12345678' }), {
    email: 'teacher@example.com', password: '12345678'
  });
  assert.throws(() => Core.normalizeLogin({ email: 'teacher@example.com', password: '1234567' }));
});

test('password reset never discloses whether an account exists', () => {
  assert.equal(Core.safeAuthMessage('reset', { code: 'auth/user-not-found' }), Core.RESET_SENT_MESSAGE);
  assert.equal(Core.safeAuthMessage('reset', null), Core.RESET_SENT_MESSAGE);
});

test('authentication failures use bounded Korean messages', () => {
  assert.match(Core.safeAuthMessage('login', { code: 'auth/popup-closed-by-user' }), /취소/);
  assert.match(Core.safeAuthMessage('login', { code: 'auth/wrong-password' }), /이메일 또는 비밀번호/);
  assert.match(Core.safeAuthMessage('login', { code: 'auth/too-many-requests' }), /잠시 후/);
  assert.match(Core.safeAuthMessage('login', { code: 'auth/network-request-failed' }), /네트워크/);
  assert.match(Core.safeAuthMessage('verification-resend', null), /인증 메일/);
  assert.match(
    Core.safeAuthMessage('signup', { code: 'auth/account-exists-with-different-credential' }),
    /기존 로그인 방식/
  );
});

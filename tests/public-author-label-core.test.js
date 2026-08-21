const test = require('node:test');
const assert = require('node:assert/strict');

const Core = require('../public-author-label-core.js');

test('public author labels keep ordinary Korean names and normalize surrounding whitespace', () => {
  assert.deepEqual(Core.validate('  김 교사  ', {
    emailCanonical: 'teacher@school.kr', uid: 'teacher-a'
  }), { ok: true, value: '김 교사', errors: [] });
  assert.equal(Core.requireSafe('홍교사'), '홍교사');
});

test('public author labels reject blank, email-shaped, owner-email, UID-like, and exact UID values', () => {
  const identity = { emailCanonical: 'teacher@school.kr', uid: 'teacher-a' };
  for (const value of [
    '', 'teacher@example.com', 'teacher@school.kr',
    'AbCDefghijklmnopqrst1234', 'teacher-a'
  ]) {
    const result = Core.validate(value, identity);
    assert.equal(result.ok, false, value);
    assert.throws(() => Core.requireSafe(value, identity), /표시 이름|display|public/i);
  }
});

test('public author labels reject an exact normalized owner email regardless of surrounding whitespace', () => {
  const result = Core.validate(' Teacher@School.KR ', {
    emailCanonical: 'teacher@school.kr', uid: 'teacher-a'
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes('owner-email'));
});

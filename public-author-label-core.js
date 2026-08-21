(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) root.PublicAuthorLabelCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const EMAIL_SHAPED = /^[^\s@]+@[^\s@]+$/;
  const UID_LIKE = /^[A-Za-z0-9_-]{20,128}$/;

  function canonicalEmail(value) {
    return String(value == null ? '' : value).trim().toLowerCase();
  }

  function validate(value, identity = {}) {
    const label = typeof value === 'string' ? value.trim() : '';
    const emailCanonical = canonicalEmail(identity.emailCanonical || identity.email);
    const uid = typeof identity.uid === 'string' ? identity.uid : '';
    const errors = [];
    if (!label || label.length > 80) errors.push('length');
    if (label && EMAIL_SHAPED.test(label)) errors.push('email-shaped');
    if (label && emailCanonical && label.toLowerCase() === emailCanonical) {
      errors.push('owner-email');
    }
    if (label && uid && label === uid) errors.push('owner-uid');
    if (label && UID_LIKE.test(label)) errors.push('uid-like');
    return { ok: errors.length === 0, value: label, errors };
  }

  function requireSafe(value, identity) {
    const result = validate(value, identity);
    if (!result.ok) {
      throw new Error('공개 표시 이름에는 이메일 또는 UID 형태의 계정 식별자를 사용할 수 없습니다.');
    }
    return result.value;
  }

  function isSafe(value, identity) {
    return validate(value, identity).ok;
  }

  return { validate, requireSafe, isSafe };
});

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TeacherEmailAuthCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const RESET_SENT_MESSAGE = '입력한 이메일을 확인해 주세요.';

  function canonicalEmail(value) {
    return String(value || '').trim().toLowerCase();
  }

  function validateEmail(email) {
    if (!email.includes('@') || email.length > 254) {
      throw new Error('유효한 이메일을 입력해 주세요.');
    }
  }

  function validatePassword(password) {
    if (password.length < 8) {
      throw new Error('비밀번호는 8자 이상이어야 합니다.');
    }
  }

  function normalizeSignup(input) {
    const values = input || {};
    const displayName = String(values.displayName || '').trim();
    const email = canonicalEmail(values.email);
    const password = String(values.password || '');

    if (!displayName || displayName.length > 80) {
      throw new Error('이름은 1~80자여야 합니다.');
    }
    validateEmail(email);
    validatePassword(password);
    return { displayName, email, password };
  }

  function normalizeLogin(input) {
    const values = input || {};
    const email = canonicalEmail(values.email);
    const password = String(values.password || '');

    validateEmail(email);
    validatePassword(password);
    return { email, password };
  }

  function safeAuthMessage(operation, error) {
    if (operation === 'reset' && (!error || error.code === 'auth/user-not-found')) {
      return RESET_SENT_MESSAGE;
    }

    const code = String(error && error.code || '');
    if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
      return '로그인이 취소되었습니다.';
    }
    if (['auth/wrong-password', 'auth/invalid-credential', 'auth/user-not-found'].includes(code)) {
      return '이메일 또는 비밀번호를 확인해 주세요.';
    }
    if (code === 'auth/too-many-requests') {
      return '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.';
    }
    if (code === 'auth/network-request-failed') {
      return '네트워크 연결을 확인한 뒤 다시 시도해 주세요.';
    }
    if (['auth/account-exists-with-different-credential', 'auth/credential-already-in-use'].includes(code)) {
      return '이 이메일은 다른 로그인 방식으로 이미 사용 중입니다. 기존 로그인 방식으로 먼저 로그인해 주세요.';
    }
    if (code === 'auth/email-already-in-use') {
      return '이 이메일은 이미 사용 중입니다. 기존 로그인 방식을 사용해 주세요.';
    }
    if (operation === 'verification-resend') {
      return error
        ? '인증 메일을 다시 보내지 못했습니다. 잠시 후 다시 시도해 주세요.'
        : '인증 메일을 다시 보냈습니다. 이메일을 확인해 주세요.';
    }
    return '인증 처리에 실패했습니다. 다시 시도해 주세요.';
  }

  return { normalizeSignup, normalizeLogin, safeAuthMessage, RESET_SENT_MESSAGE };
});

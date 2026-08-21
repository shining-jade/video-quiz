(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AuthCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function isGoogleSignIn(tokenResult) {
    const firebaseClaims = tokenResult && tokenResult.claims && tokenResult.claims.firebase;
    return !!firebaseClaims && firebaseClaims.sign_in_provider === 'google.com';
  }

  function isSupportedTeacherSignIn(tokenResult) {
    const firebaseClaims = tokenResult && tokenResult.claims && tokenResult.claims.firebase;
    return !!firebaseClaims && ['google.com', 'password'].includes(firebaseClaims.sign_in_provider);
  }

  function teacherState(user, allowance) {
    if (!user || user.isAnonymous) return { status: 'signed-out', uid: '', email: '', role: '' };
    if (!user.emailVerified) return { status: 'unverified', uid: user.uid, email: user.email || '', role: '' };
    if (!allowance || allowance.enabled !== true) return { status: 'unapproved', uid: user.uid, email: user.email || '', role: '' };
    const role = allowance.role === 'admin' ? 'admin' : 'teacher';
    return { status: role, uid: user.uid, email: user.email || '', role };
  }
  const isTeacher = state => !!state && (state.role === 'teacher' || state.role === 'admin');
  const isAdmin = state => !!state && state.role === 'admin';
  return { isGoogleSignIn, isSupportedTeacherSignIn, teacherState, isTeacher, isAdmin };
});

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AuthCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function isGoogleUser(user) {
    return !!user && !user.isAnonymous && Array.isArray(user.providerData) &&
      user.providerData.some(provider => provider && provider.providerId === 'google.com');
  }

  function teacherState(user, allowance) {
    if (!isGoogleUser(user)) return { status: 'signed-out', uid: '', email: '', role: '' };
    if (!user.emailVerified) return { status: 'unverified', uid: user.uid, email: user.email || '', role: '' };
    if (!allowance || allowance.enabled !== true) return { status: 'unapproved', uid: user.uid, email: user.email || '', role: '' };
    const role = allowance.role === 'admin' ? 'admin' : 'teacher';
    return { status: role, uid: user.uid, email: user.email || '', role };
  }
  const isTeacher = state => !!state && (state.role === 'teacher' || state.role === 'admin');
  const isAdmin = state => !!state && state.role === 'admin';
  return { isGoogleUser, teacherState, isTeacher, isAdmin };
});

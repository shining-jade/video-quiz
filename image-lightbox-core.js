(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ImageLightboxCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function create(onChange) {
    let state = { open: false, src: '', alt: '' };
    const snapshot = () => Object.assign({}, state);
    const emit = () => { if (typeof onChange === 'function') onChange(snapshot()); };
    return {
      current: snapshot,
      open(src, alt) {
        const value = String(src || '').trim();
        if (!value) return false;
        state = { open: true, src: value, alt: String(alt || '이미지') };
        emit();
        return true;
      },
      close() {
        if (!state.open) return false;
        state = { open: false, src: '', alt: '' };
        emit();
        return true;
      },
      keydown(key) {
        return String(key || '') === 'Escape' ? this.close() : false;
      }
    };
  }
  return { create };
});

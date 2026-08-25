(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.EditorHistoryCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

/**
 * Small, framework-free editor history store.
 *
 * Values are treated as JSON snapshots.  The store never exposes an internal
 * object, so callers may safely mutate a returned value without changing the
 * history.
 */
function clone(value) {
  try {
    return { success: true, value: JSON.parse(JSON.stringify(value)) };
  } catch (error) {
    return { success: false, error };
  }
}

function create(initial, { limit = 50 } = {}) {
  const first = clone(initial);
  if (!first.success) {
    throw first.error;
  }

  const max = Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 50);
  let value = first.value;
  let undoStack = [];
  let redoStack = [];
  let lastMeta = null;

  function snapshot() {
    const result = clone(value);
    return result.success ? result.value : value;
  }

  function isCoalesced(meta) {
    if (!meta || !lastMeta || !meta.key || meta.key !== lastMeta.key) return false;
    const windowMs = Number.isFinite(meta.coalesceMs) ? meta.coalesceMs : 600;
    if (!Number.isFinite(meta.at) || !Number.isFinite(lastMeta.at)) return false;
    return Math.abs(meta.at - lastMeta.at) <= windowMs;
  }

  return {
    record(next, meta = null) {
      const nextSnapshot = clone(next);
      if (!nextSnapshot.success) {
        return { ok: false, error: nextSnapshot.error };
      }
      if (!isCoalesced(meta)) {
        undoStack.push(snapshot());
        if (undoStack.length > max) undoStack.shift();
      }
      value = nextSnapshot.value;
      redoStack = [];
      lastMeta = meta && typeof meta === 'object' ? { ...meta } : null;
      return snapshot();
    },

    undo() {
      if (!undoStack.length) return snapshot();
      redoStack.push(snapshot());
      value = undoStack.pop();
      lastMeta = null;
      return snapshot();
    },

    redo() {
      if (!redoStack.length) return snapshot();
      undoStack.push(snapshot());
      value = redoStack.pop();
      lastMeta = null;
      return snapshot();
    },

    reset(saved) {
      const savedSnapshot = clone(saved);
      if (!savedSnapshot.success) return { ok: false, error: savedSnapshot.error };
      value = savedSnapshot.value;
      undoStack = [];
      redoStack = [];
      lastMeta = null;
      return snapshot();
    },

    current: snapshot,
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0
  };
}

return { create };
});

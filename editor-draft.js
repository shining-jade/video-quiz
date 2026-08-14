(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.EditorDraft = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function key(setId) {
    return 'vq_draft_' + (setId || 'new');
  }

  function snapshot(model, now) {
    const clean = {
      title: model.title,
      videoUrl: model.videoUrl,
      videoId: model.videoId,
      author: model.author,
      settings: model.settings,
      questions: model.questions,
      createdAt: model.createdAt,
      archived: model.archived
    };
    return {
      savedAt: Number(now) || Date.now(),
      model: JSON.parse(JSON.stringify(clean))
    };
  }

  function read(storage, setId) {
    try {
      const value = JSON.parse(storage.getItem(key(setId)) || 'null');
      return value && value.model && Number.isFinite(Number(value.savedAt)) ? value : null;
    } catch (error) {
      return null;
    }
  }

  function write(storage, setId, model, now) {
    const value = snapshot(model, now);
    storage.setItem(key(setId), JSON.stringify(value));
    return value;
  }

  function clear(storage, setId) {
    storage.removeItem(key(setId));
  }

  function isNewer(draft, savedAt) {
    return !!draft && Number(draft.savedAt) > (Number(savedAt) || 0);
  }

  return { key, snapshot, read, write, clear, isNewer };
});

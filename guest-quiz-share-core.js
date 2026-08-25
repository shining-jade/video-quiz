(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GuestQuizShareCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SHARE_ID = /^[A-Za-z0-9_-]{43}$/;
  const QUESTION_TYPES = new Set(['choice', 'multi', 'short', 'long', 'ox']);

  function fail(message) { throw new Error('Guest quiz share ' + message); }
  function text(value, name, maximum, allowEmpty) {
    if (typeof value !== 'string') fail(name + ' must be a string');
    const out = value.trim();
    if ((!allowEmpty && !out) || out.length > maximum) fail(name + ' is invalid');
    return out;
  }
  function finite(value, name, minimum, maximum) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
      fail(name + ' is invalid');
    }
    return value;
  }
  function integer(value, name, minimum, maximum) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(name + ' is invalid');
    return value;
  }
  function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.keys(value).forEach(key => deepFreeze(value[key]));
    return Object.freeze(value);
  }

  function randomToken(byteLength, cryptoApi) {
    if (!Number.isSafeInteger(byteLength) || byteLength < 32 || byteLength > 64) fail('byteLength is invalid');
    if (!cryptoApi || typeof cryptoApi.getRandomValues !== 'function') fail('crypto API is unavailable');
    const bytes = new Uint8Array(byteLength);
    cryptoApi.getRandomValues(bytes);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const encoded = typeof btoa === 'function'
      ? btoa(binary)
      : Buffer.from(bytes).toString('base64');
    return encoded.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function projectQuestion(question, videoKey, questionIndex, images) {
    if (!question || typeof question !== 'object' || !QUESTION_TYPES.has(question.type)) {
      fail('question type is invalid');
    }
    const key = videoKey + 'q' + questionIndex;
    const output = {
      questionKey: key,
      videoKey,
      type: question.type,
      t: finite(Number(question.t), 'question time', 0, 86400),
      text: text(question.text, 'question text', 4000, false)
    };
    if (question.type === 'choice' || question.type === 'multi' || question.type === 'ox') {
      if (!Array.isArray(question.choices) || question.choices.length < 2 || question.choices.length > 12) {
        fail('question choices are invalid');
      }
      output.choices = question.choices.map(choice => text(choice, 'choice', 1000, false));
    }
    if (question.type === 'multi') {
      if (!Array.isArray(question.answers) || !question.answers.length ||
          question.answers.some(answer => !Number.isSafeInteger(answer))) fail('question answers are invalid');
      output.answers = question.answers.slice();
    } else if (question.type === 'short') {
      const accepts = Array.isArray(question.accept) ? question.accept : [];
      output.accept = accepts.map(answer => text(answer, 'accepted answer', 1000, false));
      if (typeof question.answer === 'string') output.answer = text(question.answer, 'answer', 1000, true);
    } else if (question.type !== 'long') {
      output.answer = integer(question.answer, 'question answer', 0, output.choices.length - 1);
    }
    if (typeof question.explain === 'string' && question.explain.trim()) {
      output.explain = text(question.explain, 'explanation', 8000, true);
    }
    if (Number.isFinite(question.limitSec)) output.limitSec = finite(question.limitSec, 'question limit', 0, 600);
    if (question.imgUp && typeof images[key] === 'string') output.imageKey = key;
    const explainKey = key + 'e';
    if (question.explainImgUp && typeof images[explainKey] === 'string') output.explainImageKey = explainKey;
    return output;
  }

  function projectQuizSet(set, sourceImages) {
    if (!set || typeof set !== 'object') fail('set is invalid');
    if (!Array.isArray(set.videos) || !set.videos.length || set.videos.length > 50) fail('videos are invalid');
    const images = sourceImages && typeof sourceImages === 'object' ? sourceImages : {};
    const settings = set.settings && typeof set.settings === 'object' ? set.settings : {};
    const parent = {
      title: text(set.title, 'title', 200, false),
      description: text(typeof set.description === 'string' ? set.description : '', 'description', 2000, true),
      revealMode: ['manual', 'timer', 'instant', 'never'].includes(settings.revealMode) ? settings.revealMode : 'manual',
      limitSec: Number.isFinite(settings.limitSec) ? finite(settings.limitSec, 'limitSec', 0, 600) : 20,
      revealDelaySec: Number.isFinite(settings.revealDelaySec)
        ? finite(settings.revealDelaySec, 'revealDelaySec', 0, 3600) : 0,
      autoPause: settings.autoPause !== false,
      videoCount: set.videos.length,
      questionCount: 0,
      imageCount: 0,
      schemaVersion: 1
    };
    const videos = [];
    const questions = [];
    const projectedImages = {};
    set.videos.forEach((video, videoIndex) => {
      if (!video || typeof video !== 'object') fail('video is invalid');
      const videoKey = 'v' + videoIndex;
      const projectedVideo = {
        videoKey,
        videoId: text(video.videoId || video.id || '', 'videoId', 128, false),
        videoUrl: text(video.url || video.videoUrl || '', 'videoUrl', 2048, false),
        startSec: finite(Number(video.startSec || 0), 'video start', 0, 86400),
        endSec: video.endSec == null || video.endSec === ''
          ? null : finite(Number(video.endSec), 'video end', 0.001, 86400),
        schemaVersion: 1
      };
      if (projectedVideo.endSec != null && projectedVideo.endSec <= projectedVideo.startSec) {
        fail('video range is invalid');
      }
      videos.push(projectedVideo);
      const sourceQuestions = Array.isArray(video.questions) ? video.questions : [];
      if (sourceQuestions.length > 200) fail('questions are invalid');
      sourceQuestions.forEach((question, questionIndex) => {
        const projected = projectQuestion(question, videoKey, questionIndex, images);
        if (projected.t < projectedVideo.startSec ||
            (projectedVideo.endSec != null && projected.t > projectedVideo.endSec)) {
          fail('question time is outside video range');
        }
        questions.push(projected);
        for (const imageKey of [projected.imageKey, projected.explainImageKey]) {
          if (!imageKey) continue;
          const data = images[imageKey];
          if (typeof data !== 'string' || !data.startsWith('data:image/') || data.length > 1500000) {
            fail('image is invalid');
          }
          projectedImages[imageKey] = data;
        }
      });
    });
    parent.questionCount = questions.length;
    parent.imageCount = Object.keys(projectedImages).length;
    return deepFreeze({ parent, videos, questions, images: projectedImages });
  }

  function parseGuestRoute(shareId, query) {
    if (typeof shareId !== 'string' || !SHARE_ID.test(shareId) || typeof query !== 'string') return { invalid: true };
    const params = new URLSearchParams(query.replace(/^\?/, ''));
    if (Array.from(params.keys()).length) return { invalid: true };
    return { shareId };
  }

  function nextShareState(current, action, nowValue) {
    if (!action || typeof action !== 'object') fail('action is invalid');
    if (action.type === 'create') {
      if (current) fail(current.status === 'revoked' ? 'revoked identity requires a new share' : 'share already exists');
      if (!SHARE_ID.test(action.shareId || '')) fail('create is invalid');
      return deepFreeze({ shareId: action.shareId, status: 'active', revision: 1,
        createdAt: nowValue, updatedAt: nowValue, revokedAt: null });
    }
    if (!current || current.status !== 'active') fail('revoked or missing share cannot change');
    if (action.type === 'refresh') {
      const revision = integer(action.revision, 'revision', current.revision + 1, Number.MAX_SAFE_INTEGER);
      if (revision !== current.revision + 1) fail('revision must increment exactly once');
      return deepFreeze({ ...current, revision, updatedAt: nowValue });
    }
    if (action.type === 'revoke') {
      return deepFreeze({ ...current, status: 'revoked', updatedAt: nowValue, revokedAt: nowValue });
    }
    fail('action is invalid');
  }

  return Object.freeze({ randomToken, projectQuizSet, parseGuestRoute, nextShareState });
});

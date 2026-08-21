(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) root.PublicQuizLibraryCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const PUBLIC_KEYS = [
    'publicationId', 'sourceSetId', 'status', 'moderationStatus', 'revision',
    'title', 'description', 'authorDisplayName', 'videos', 'settings',
    'videoCount', 'questionCount', 'imageCount', 'publishedAtMs', 'updatedAtMs'
  ];
  const VIDEO_KEYS = ['videoId', 'videoUrl', 'startSec', 'endSec', 'questions'];
  const QUESTION_KEYS = [
    'type', 't', 'text', 'choices', 'answer', 'answers', 'accept', 'imgUp', 'imgUrl',
    'explain', 'explainImgUp', 'explainImgUrl', 'limitSec'
  ];
  const SETTINGS_KEYS = ['revealMode', 'limitSec', 'revealDelaySec', 'autoPause'];
  const STATUSES = new Set(['building', 'published', 'withdrawn', 'moderated']);
  const MODERATION_STATUSES = new Set(['clear', 'moderated']);
  const QUESTION_TYPES = new Set(['choice', 'multi', 'ox', 'short', 'long']);
  const REVEAL_MODES = new Set(['instant', 'timer', 'manual', 'never']);
  const MAX_VIDEOS = 50;
  const MAX_QUESTIONS = 500;
  const MAX_IMAGES = 300;
  const MAX_TITLE = 200;
  const MAX_DESCRIPTION = 1000;
  const MAX_AUTHOR = 80;
  const MAX_TEXT = 1000;
  const MAX_CHOICES = 20;
  const MAX_URL = 2048;

  function own(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
  }

  function isObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function safeInteger(value) {
    return Number.isSafeInteger(value) && value >= 0;
  }

  function canonicalId(value) {
    return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
  }

  function cleanText(value, name, min, max) {
    if (typeof value !== 'string') throw new Error(name + ' must be a string.');
    const cleaned = value.trim();
    if (cleaned.length < min || cleaned.length > max) {
      throw new Error(name + ' has an invalid length.');
    }
    return cleaned;
  }

  function copyIfString(source, key, max) {
    if (!own(source, key) || source[key] === undefined || source[key] === null) return undefined;
    return cleanText(source[key], key, 1, max);
  }

  function projectionSettings(source) {
    const input = isObject(source) ? source : {};
    const settings = {
      revealMode: own(input, 'revealMode') ? input.revealMode : 'timer',
      limitSec: own(input, 'limitSec') ? input.limitSec : 20,
      revealDelaySec: own(input, 'revealDelaySec') ? input.revealDelaySec : 5,
      autoPause: own(input, 'autoPause') ? input.autoPause : true
    };
    const errors = validateSettings(settings, 'settings');
    if (errors.length) throw new Error(errors.join(' '));
    return settings;
  }

  function projectionQuestion(source) {
    if (!isObject(source)) throw new Error('question must be an object.');
    const type = typeof source.type === 'string' ? source.type : 'choice';
    const question = {
      type,
      t: source.t,
      text: source.text,
      choices: Array.isArray(source.choices) ? source.choices.map(value => String(value).trim()) : [],
      answer: own(source, 'answer') ? source.answer : 0
    };
    if (type === 'multi') question.answers = Array.isArray(source.answers) ? source.answers.slice() : [];
    if (type === 'short') question.accept = Array.isArray(source.accept)
      ? source.accept.map(value => String(value).trim()) : [];
    ['imgUp', 'explainImgUp'].forEach(key => {
      if (own(source, key)) question[key] = source[key] === true;
    });
    ['imgUrl', 'explain', 'explainImgUrl'].forEach(key => {
      const value = copyIfString(source, key, key === 'explain' ? MAX_TEXT : MAX_URL);
      if (value !== undefined) question[key] = value;
    });
    if (own(source, 'limitSec')) question.limitSec = source.limitSec;
    const errors = validateQuestion(question, 'question');
    if (errors.length) throw new Error(errors.join(' '));
    return question;
  }

  function projectionVideo(source) {
    if (!isObject(source)) throw new Error('video must be an object.');
    const video = {
      videoId: source.videoId,
      videoUrl: source.videoUrl,
      startSec: source.startSec === undefined ? 0 : source.startSec,
      endSec: source.endSec === undefined || source.endSec === '' ? null : source.endSec,
      questions: Array.isArray(source.questions) ? source.questions.map(projectionQuestion) : []
    };
    const errors = validateVideo(video, 'video');
    if (errors.length) throw new Error(errors.join(' '));
    return video;
  }

  function buildProjection(set, context) {
    if (!isObject(set) || !isObject(context)) throw new Error('set and context are required.');
    const setId = context.setId;
    if (!canonicalId(setId)) throw new Error('setId must be canonical.');
    const videos = Array.isArray(set.videos) ? set.videos.map(projectionVideo) : [];
    if (videos.length < 1 || videos.length > MAX_VIDEOS) throw new Error('videos must contain 1 to ' + MAX_VIDEOS + ' entries.');
    const questionCount = videos.reduce((count, video) => count + video.questions.length, 0);
    if (questionCount < 1 || questionCount > MAX_QUESTIONS) {
      throw new Error('questions must contain 1 to ' + MAX_QUESTIONS + ' entries.');
    }
    const imageCount = set.imageCount === undefined ? 0 : set.imageCount;
    if (!safeInteger(imageCount) || imageCount > MAX_IMAGES) throw new Error('imageCount must be a safe bounded count.');
    const nowMs = context.nowMs;
    if (!safeInteger(nowMs)) throw new Error('nowMs must be a safe timestamp.');
    const projection = {
      publicationId: setId,
      sourceSetId: setId,
      status: 'building',
      moderationStatus: 'clear',
      revision: cleanText(context.revision, 'revision', 1, 200),
      title: cleanText(set.title, 'title', 1, MAX_TITLE),
      description: set.description === undefined || set.description === null
        ? '' : cleanText(set.description, 'description', 0, MAX_DESCRIPTION),
      authorDisplayName: cleanText(context.authorDisplayName, 'authorDisplayName', 1, MAX_AUTHOR),
      videos,
      settings: projectionSettings(set.settings),
      videoCount: videos.length,
      questionCount,
      imageCount,
      publishedAtMs: null,
      updatedAtMs: nowMs
    };
    const validation = validateProjection(projection);
    if (!validation.ok) throw new Error(validation.errors.join(' '));
    return projection;
  }

  function validateUnknownKeys(value, allowed, path, errors) {
    if (!isObject(value)) {
      errors.push(path + ' must be an object.');
      return false;
    }
    Object.keys(value).forEach(key => {
      if (!allowed.includes(key)) errors.push('unknown field: ' + path + '.' + key);
    });
    return true;
  }

  function validateString(value, name, min, max, errors) {
    if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) {
      errors.push(name + ' has an invalid length.');
      return false;
    }
    return true;
  }

  function validateNumber(value, name, min, max, errors) {
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      errors.push(name + ' must be a safe integer from ' + min + ' to ' + max + '.');
      return false;
    }
    return true;
  }

  function validateSettings(value, path) {
    const errors = [];
    if (!validateUnknownKeys(value, SETTINGS_KEYS, path, errors)) return errors;
    if (!REVEAL_MODES.has(value.revealMode)) errors.push(path + '.revealMode is invalid.');
    validateNumber(value.limitSec, path + '.limitSec', 0, 600, errors);
    validateNumber(value.revealDelaySec, path + '.revealDelaySec', 0, 600, errors);
    if (typeof value.autoPause !== 'boolean') errors.push(path + '.autoPause must be boolean.');
    return errors;
  }

  function validateQuestion(value, path) {
    const errors = [];
    if (!validateUnknownKeys(value, QUESTION_KEYS, path, errors)) return errors;
    if (!QUESTION_TYPES.has(value.type)) errors.push(path + '.type is invalid.');
    if (typeof value.t !== 'number' || !Number.isFinite(value.t) || value.t < 0) {
      errors.push(path + '.t must be a non-negative finite number.');
    }
    validateString(value.text, path + '.text', 1, MAX_TEXT, errors);
    if (!Array.isArray(value.choices) || value.choices.length > MAX_CHOICES) {
      errors.push(path + '.choices is malformed.');
    } else if (value.type === 'choice' || value.type === 'multi' || value.type === 'ox') {
      if (value.choices.length < 2 || value.choices.some(choice => typeof choice !== 'string' || !choice.trim())) {
        errors.push(path + '.choices must contain at least two non-empty choices.');
      }
    } else if (value.choices.length !== 0) {
      errors.push(path + '.choices must be empty for text questions.');
    }
    if (!Number.isSafeInteger(value.answer) || value.answer < 0 ||
        (Array.isArray(value.choices) && value.choices.length && value.answer >= value.choices.length)) {
      errors.push(path + '.answer is invalid.');
    }
    if (value.type === 'multi') {
      if (!Array.isArray(value.answers) || value.answers.length < 1 ||
          value.answers.some(answer => !Number.isSafeInteger(answer) || answer < 0 || answer >= value.choices.length) ||
          new Set(value.answers).size !== value.answers.length) {
        errors.push(path + '.answers is invalid.');
      }
    } else if (own(value, 'answers')) {
      errors.push(path + '.answers is only allowed for multi questions.');
    }
    if (value.type === 'short') {
      if (!Array.isArray(value.accept) || value.accept.length < 1 || value.accept.length > 20 ||
          value.accept.some(item => typeof item !== 'string' || !item.trim() || item.trim().length > 100)) {
        errors.push(path + '.accept is invalid.');
      }
    } else if (own(value, 'accept')) {
      errors.push(path + '.accept is only allowed for short questions.');
    }
    ['imgUp', 'explainImgUp'].forEach(key => {
      if (own(value, key) && typeof value[key] !== 'boolean') errors.push(path + '.' + key + ' must be boolean.');
    });
    ['imgUrl', 'explainImgUrl'].forEach(key => {
      if (own(value, key) && !validateString(value[key], path + '.' + key, 1, MAX_URL, errors)) return;
    });
    if (own(value, 'explain')) validateString(value.explain, path + '.explain', 1, MAX_TEXT, errors);
    if (own(value, 'limitSec')) validateNumber(value.limitSec, path + '.limitSec', 0, 600, errors);
    return errors;
  }

  function validateVideo(value, path) {
    const errors = [];
    if (!validateUnknownKeys(value, VIDEO_KEYS, path, errors)) return errors;
    if (typeof value.videoId !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(value.videoId)) {
      errors.push(path + '.videoId must be a canonical YouTube id.');
    }
    if (typeof value.videoUrl !== 'string' || value.videoUrl.length < 1 || value.videoUrl.length > MAX_URL ||
        !/^https:\/\//.test(value.videoUrl)) {
      errors.push(path + '.videoUrl is invalid.');
    }
    if (typeof value.startSec !== 'number' || !Number.isFinite(value.startSec) || value.startSec < 0) {
      errors.push(path + '.startSec is invalid.');
    }
    if (value.endSec !== null && (typeof value.endSec !== 'number' || !Number.isFinite(value.endSec) ||
        value.endSec <= value.startSec)) {
      errors.push(path + '.endSec is invalid.');
    }
    if (!Array.isArray(value.questions) || value.questions.length < 1) {
      errors.push(path + '.questions is malformed.');
    } else {
      value.questions.forEach((question, index) => {
        errors.push(...validateQuestion(question, path + '.questions[' + index + ']'));
      });
    }
    return errors;
  }

  function validateProjection(value) {
    const errors = [];
    if (!validateUnknownKeys(value, PUBLIC_KEYS, 'projection', errors)) return { ok: false, errors };
    ['publicationId', 'sourceSetId'].forEach(key => {
      if (!canonicalId(value[key])) errors.push(key + ' must be canonical.');
    });
    if (value.publicationId !== value.sourceSetId) errors.push('publicationId and sourceSetId must match.');
    if (!STATUSES.has(value.status)) errors.push('status is invalid.');
    if (!MODERATION_STATUSES.has(value.moderationStatus)) errors.push('moderationStatus is invalid.');
    validateString(value.revision, 'revision', 1, 200, errors);
    validateString(value.title, 'title', 1, MAX_TITLE, errors);
    validateString(value.description, 'description', 0, MAX_DESCRIPTION, errors);
    validateString(value.authorDisplayName, 'authorDisplayName', 1, MAX_AUTHOR, errors);
    if (!Array.isArray(value.videos) || value.videos.length < 1 || value.videos.length > MAX_VIDEOS) {
      errors.push('videos must contain 1 to ' + MAX_VIDEOS + ' entries.');
    } else {
      value.videos.forEach((video, index) => errors.push(...validateVideo(video, 'videos[' + index + ']')));
    }
    errors.push(...validateSettings(value.settings, 'settings'));
    const actualQuestionCount = Array.isArray(value.videos)
      ? value.videos.reduce((count, video) => count + (Array.isArray(video && video.questions) ? video.questions.length : 0), 0)
      : 0;
    validateNumber(value.videoCount, 'videoCount', 1, MAX_VIDEOS, errors);
    validateNumber(value.questionCount, 'questionCount', 1, MAX_QUESTIONS, errors);
    validateNumber(value.imageCount, 'imageCount', 0, MAX_IMAGES, errors);
    if (Array.isArray(value.videos) && value.videoCount !== value.videos.length) errors.push('videoCount does not match videos.');
    if (value.questionCount !== actualQuestionCount) errors.push('questionCount does not match videos.');
    if (value.publishedAtMs !== null && !safeInteger(value.publishedAtMs)) errors.push('publishedAtMs is invalid.');
    if (!safeInteger(value.updatedAtMs)) errors.push('updatedAtMs is invalid.');
    if (value.status === 'published' && value.publishedAtMs === null) errors.push('published projection requires publishedAtMs.');
    if (value.status !== 'moderated' && value.moderationStatus !== 'clear') errors.push('only moderated projections may be moderated.');
    return { ok: errors.length === 0, errors };
  }

  function requireProjection(value) {
    const result = validateProjection(value);
    if (!result.ok) throw new Error(result.errors.join(' '));
    return value;
  }

  function copyPatch(projection) {
    const value = requireProjection(projection);
    return {
      publicationId: value.publicationId,
      sourceTitle: value.title,
      sourceAuthorDisplayName: value.authorDisplayName,
      visibility: 'private',
      collaboratorCount: 0,
      imageCount: value.imageCount,
      lifecycleState: 'active'
    };
  }

  function publicSummary(projection) {
    const value = requireProjection(projection);
    return {
      publicationId: value.publicationId,
      title: value.title,
      description: value.description,
      authorDisplayName: value.authorDisplayName,
      videoCount: value.videoCount,
      questionCount: value.questionCount,
      updatedAtMs: value.updatedAtMs
    };
  }

  return { PUBLIC_KEYS, buildProjection, validateProjection, copyPatch, publicSummary };
});

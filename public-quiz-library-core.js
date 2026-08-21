(function (root, factory) {
  const playlist = typeof module === 'object' && module.exports
    ? require('./playlist-core.js') : root && root.PlaylistCore;
  const api = factory(playlist);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) root.PublicQuizLibraryCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (playlist) {
  const PUBLIC_KEYS = Object.freeze([
    'publicationId', 'sourceSetId', 'status', 'moderationStatus', 'revision',
    'title', 'description', 'authorDisplayName', 'videos', 'settings',
    'videoCount', 'questionCount', 'imageCount', 'publishedAt', 'updatedAt'
  ]);
  const PUBLIC_PARENT_KEYS = Object.freeze([
    'publicationId', 'sourceSetId', 'status', 'moderationStatus', 'revision',
    'title', 'description', 'authorDisplayName',
    'revealMode', 'limitSec', 'revealDelaySec', 'autoPause',
    'videoCount', 'questionCount', 'imageCount', 'publishedAt', 'updatedAt'
  ]);
  const VIDEO_KEYS = ['videoId', 'videoUrl', 'startSec', 'endSec', 'questions'];
  const QUESTION_KEYS = [
    'type', 't', 'text', 'choices', 'answer', 'answers', 'accept', 'imgUp', 'imgUrl',
    'explain', 'explainImgUp', 'explainImgUrl', 'limitSec'
  ];
  const SETTINGS_KEYS = ['revealMode', 'limitSec', 'revealDelaySec', 'autoPause'];
  const VIDEO_PART_KEYS = [
    'videoKey', 'videoId', 'videoUrl', 'startSec', 'endSec', 'revision', 'buildToken'
  ];
  const QUESTION_PART_KEYS = QUESTION_KEYS.concat([
    'questionKey', 'videoKey', 'revision', 'buildToken'
  ]);
  const STATUSES = new Set(['building', 'published', 'withdrawn', 'moderated']);
  const MODERATION_STATUSES = new Set(['clear', 'moderated']);
  const QUESTION_TYPES = new Set(['choice', 'multi', 'ox', 'short', 'long']);
  const REVEAL_MODES = new Set(['instant', 'timer', 'manual', 'never']);
  const MAX_VIDEOS = 50;
  const MAX_QUESTIONS = 500;
  const MAX_TITLE = 200;
  const MAX_DESCRIPTION = 1000;
  const MAX_AUTHOR = 80;
  const MAX_TEXT = 1000;
  const MAX_CHOICES = 6;
  const MAX_CHOICE_TEXT = 200;
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

  function timestampMillis(value) {
    try {
      const millis = value instanceof Date
        ? value.getTime()
        : value && typeof value.toMillis === 'function'
          ? value.toMillis()
          : value && Number.isInteger(value.seconds) && Number.isInteger(value.nanoseconds) &&
              value.nanoseconds >= 0 && value.nanoseconds < 1_000_000_000
            ? value.seconds * 1000 + value.nanoseconds / 1_000_000
            : null;
      return typeof millis === 'number' && Number.isFinite(millis) && millis >= 0
        ? millis : null;
    } catch (_) {
      return null;
    }
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

  function canonicalHttps(value) {
    return typeof value === 'string'
      ? value.replace(/^https:\/\//i, 'https://')
      : value;
  }

  function copyIfString(source, key, max, https) {
    if (!own(source, key) || source[key] === undefined || source[key] === null) return undefined;
    const value = cleanText(source[key], key, 1, max);
    return https ? canonicalHttps(value) : value;
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
      const value = copyIfString(
        source, key, key === 'explain' ? MAX_TEXT : MAX_URL, key !== 'explain'
      );
      if (value !== undefined) question[key] = value;
    });
    if (own(source, 'limitSec')) question.limitSec = source.limitSec;
    const errors = validateQuestion(question, 'question');
    if (errors.length) throw new Error(errors.join(' '));
    return question;
  }

  function projectionVideo(source, durationSec) {
    if (!isObject(source)) throw new Error('video must be an object.');
    const video = {
      videoId: source.videoId,
      videoUrl: canonicalHttps(source.videoUrl),
      startSec: source.startSec === undefined ? 0 : source.startSec,
      endSec: source.endSec === undefined || source.endSec === '' ? null : source.endSec,
      questions: Array.isArray(source.questions) ? source.questions.map(projectionQuestion) : []
    };
    const errors = validateVideo(video, 'video');
    if (errors.length) throw new Error(errors.join(' '));
    if (!playlist || typeof playlist.validateVideo !== 'function') {
      throw new Error('PlaylistCore.validateVideo is required.');
    }
    if (playlist.validateVideo(video, durationSec).length) {
      throw new Error('video playback range is invalid.');
    }
    return video;
  }

  function sourceDuration(set, index) {
    const source = Array.isArray(set.videos) && set.videos.length
      ? set.videos[index] : index === 0 ? set : null;
    return source && source.durationSec;
  }

  function buildProjection(set, context) {
    if (!isObject(set) || !isObject(context)) throw new Error('set and context are required.');
    const setId = context.setId;
    if (!canonicalId(setId)) throw new Error('setId must be canonical.');
    if (!playlist || typeof playlist.normalizeVideos !== 'function') {
      throw new Error('PlaylistCore.normalizeVideos is required.');
    }
    const normalizedVideos = playlist.normalizeVideos(set);
    const videos = Array.isArray(normalizedVideos)
      ? normalizedVideos.map((video, index) => projectionVideo(video, sourceDuration(set, index))) : [];
    if (videos.length < 1 || videos.length > MAX_VIDEOS) throw new Error('videos must contain 1 to ' + MAX_VIDEOS + ' entries.');
    const questionCount = videos.reduce((count, video) => count + video.questions.length, 0);
    if (questionCount < 1 || questionCount > MAX_QUESTIONS) {
      throw new Error('questions must contain 1 to ' + MAX_QUESTIONS + ' entries.');
    }
    const imageCount = set.imageCount === undefined ? 0 : set.imageCount;
    if (!safeInteger(imageCount)) throw new Error('imageCount must be a safe count.');
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
      publishedAt: null,
      updatedAt: new Date(nowMs)
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
    if (Array.isArray(value.choices) && value.choices.some(choice =>
      typeof choice !== 'string' || choice.length > MAX_CHOICE_TEXT
    )) {
      errors.push(path + '.choices must contain strings up to ' + MAX_CHOICE_TEXT + ' characters.');
    }
    if (value.type === 'ox' && Array.isArray(value.choices) && value.choices.length !== 2) {
      errors.push(path + '.choices must contain exactly two OX choices.');
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
      if (!own(value, key)) return;
      if (!validateString(value[key], path + '.' + key, 1, MAX_URL, errors)) return;
      if (!/^https:\/\//.test(value[key])) errors.push(path + '.' + key + ' must use canonical https://.');
    });
    if (own(value, 'explain')) validateString(value.explain, path + '.explain', 1, MAX_TEXT, errors);
    if (own(value, 'limitSec')) validateNumber(value.limitSec, path + '.limitSec', 0, 600, errors);
    return errors;
  }

  function youtubeIdFromUrl(value) {
    try {
      const parsed = new URL(value);
      const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
      if (host === 'youtu.be') return parsed.pathname.split('/').filter(Boolean)[0] || '';
      if (host !== 'youtube.com' && host !== 'm.youtube.com') return '';
      const queryId = parsed.searchParams.get('v');
      if (queryId) return queryId;
      const segments = parsed.pathname.split('/').filter(Boolean);
      return ['embed', 'shorts', 'live'].includes(segments[0]) ? (segments[1] || '') : '';
    } catch (_) {
      return '';
    }
  }

  function validateVideo(value, path) {
    const errors = [];
    if (!validateUnknownKeys(value, VIDEO_KEYS, path, errors)) return errors;
    if (typeof value.videoId !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(value.videoId)) {
      errors.push(path + '.videoId must be a canonical YouTube id.');
    }
    if (typeof value.videoUrl !== 'string' || value.videoUrl.length < 1 || value.videoUrl.length > MAX_URL ||
        !/^https:\/\//.test(value.videoUrl) || youtubeIdFromUrl(value.videoUrl) !== value.videoId) {
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
        if (question && typeof question.t === 'number' && Number.isFinite(question.t) &&
            (question.t < value.startSec || (value.endSec !== null && question.t > value.endSec))) {
          errors.push(path + '.questions[' + index + '] is outside the clip.');
        }
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
    validateNumber(value.imageCount, 'imageCount', 0, Number.MAX_SAFE_INTEGER, errors);
    if (Array.isArray(value.videos) && value.videoCount !== value.videos.length) errors.push('videoCount does not match videos.');
    if (value.questionCount !== actualQuestionCount) errors.push('questionCount does not match videos.');
    const publishedAtMs = value.publishedAt === null ? null : timestampMillis(value.publishedAt);
    const updatedAtMs = timestampMillis(value.updatedAt);
    if (value.publishedAt !== null && publishedAtMs === null) errors.push('publishedAt is invalid.');
    if (updatedAtMs === null) errors.push('updatedAt is invalid.');
    if (value.status !== 'building' && value.publishedAt === null) errors.push('visible history requires publishedAt.');
    if (publishedAtMs !== null && updatedAtMs !== null && updatedAtMs < publishedAtMs) {
      errors.push('updatedAt cannot precede publishedAt.');
    }
    if ((value.status === 'moderated') !== (value.moderationStatus === 'moderated')) {
      errors.push('moderationStatus must match status.');
    }
    return { ok: errors.length === 0, errors };
  }

  function parentSettings(value) {
    return {
      revealMode: value && value.revealMode,
      limitSec: value && value.limitSec,
      revealDelaySec: value && value.revealDelaySec,
      autoPause: value && value.autoPause
    };
  }

  function validateParent(value) {
    const errors = [];
    if (!validateUnknownKeys(value, PUBLIC_PARENT_KEYS, 'parent', errors)) {
      return { ok: false, errors };
    }
    ['publicationId', 'sourceSetId'].forEach(key => {
      if (!canonicalId(value[key])) errors.push(key + ' must be canonical.');
    });
    if (value.publicationId !== value.sourceSetId) {
      errors.push('publicationId and sourceSetId must match.');
    }
    if (!STATUSES.has(value.status)) errors.push('status is invalid.');
    if (!MODERATION_STATUSES.has(value.moderationStatus)) errors.push('moderationStatus is invalid.');
    validateString(value.revision, 'revision', 1, 200, errors);
    validateString(value.title, 'title', 1, MAX_TITLE, errors);
    validateString(value.description, 'description', 0, MAX_DESCRIPTION, errors);
    validateString(value.authorDisplayName, 'authorDisplayName', 1, MAX_AUTHOR, errors);
    errors.push(...validateSettings(parentSettings(value), 'settings'));
    validateNumber(value.videoCount, 'videoCount', 1, MAX_VIDEOS, errors);
    validateNumber(value.questionCount, 'questionCount', 1, MAX_QUESTIONS, errors);
    validateNumber(value.imageCount, 'imageCount', 0, Number.MAX_SAFE_INTEGER, errors);
    const publishedAtMs = value.publishedAt === null ? null : timestampMillis(value.publishedAt);
    const updatedAtMs = timestampMillis(value.updatedAt);
    if (value.publishedAt !== null && publishedAtMs === null) errors.push('publishedAt is invalid.');
    if (updatedAtMs === null) errors.push('updatedAt is invalid.');
    if (value.status !== 'building' && value.publishedAt === null) {
      errors.push('visible history requires publishedAt.');
    }
    if (publishedAtMs !== null && updatedAtMs !== null && updatedAtMs < publishedAtMs) {
      errors.push('updatedAt cannot precede publishedAt.');
    }
    if ((value.status === 'moderated') !== (value.moderationStatus === 'moderated')) {
      errors.push('moderationStatus must match status.');
    }
    return { ok: errors.length === 0, errors };
  }

  function validateBinding(value, path, errors) {
    if (typeof value.revision !== 'string' || !value.revision.trim() || value.revision.length > 200) {
      errors.push(path + '.revision is invalid.');
    }
    if (typeof value.buildToken !== 'string' || !value.buildToken || value.buildToken.length > 200) {
      errors.push(path + '.buildToken is invalid.');
    }
  }

  function validateVideoPart(value, key) {
    const errors = [];
    if (!validateUnknownKeys(value, VIDEO_PART_KEYS, 'video', errors)) return errors;
    if (!/^v(0|[1-9][0-9]*)$/.test(key) || value.videoKey !== key) {
      errors.push('video.videoKey is invalid.');
    }
    validateBinding(value, 'video', errors);
    const video = {
      videoId: value.videoId,
      videoUrl: value.videoUrl,
      startSec: value.startSec,
      endSec: value.endSec,
      questions: [{ type: 'long', t: value.startSec, text: 'binding', choices: [], answer: 0 }]
    };
    errors.push(...validateVideo(video, 'video').filter(error => !/questions\[0\]/.test(error)));
    return errors;
  }

  function validateQuestionPart(value, key) {
    const errors = [];
    if (!validateUnknownKeys(value, QUESTION_PART_KEYS, 'question', errors)) return errors;
    const match = /^v(0|[1-9][0-9]*)q(0|[1-9][0-9]*)$/.exec(key);
    if (!match || value.questionKey !== key || value.videoKey !== (match && 'v' + match[1])) {
      errors.push('question binding key is invalid.');
    }
    validateBinding(value, 'question', errors);
    const question = Object.fromEntries(QUESTION_KEYS
      .filter(name => own(value, name)).map(name => [name, value[name]]));
    errors.push(...validateQuestion(question, 'question'));
    return errors;
  }

  function requireProjection(value) {
    const result = validateProjection(value);
    if (!result.ok) throw new Error(result.errors.join(' '));
    return value;
  }

  function requireParent(value) {
    const result = validateParent(value);
    if (!result.ok) throw new Error(result.errors.join(' '));
    return value;
  }

  function flattenProjection(projection, buildToken) {
    const value = requireProjection(projection);
    const token = cleanText(buildToken, 'buildToken', 1, 200);
    const parent = {
      publicationId: value.publicationId,
      sourceSetId: value.sourceSetId,
      status: value.status,
      moderationStatus: value.moderationStatus,
      revision: value.revision,
      title: value.title,
      description: value.description,
      authorDisplayName: value.authorDisplayName,
      revealMode: value.settings.revealMode,
      limitSec: value.settings.limitSec,
      revealDelaySec: value.settings.revealDelaySec,
      autoPause: value.settings.autoPause,
      videoCount: value.videoCount,
      questionCount: value.questionCount,
      imageCount: value.imageCount,
      publishedAt: value.publishedAt,
      updatedAt: value.updatedAt
    };
    const videos = {};
    const questions = {};
    value.videos.forEach((video, videoIndex) => {
      const videoKey = 'v' + videoIndex;
      videos[videoKey] = {
        videoKey,
        videoId: video.videoId,
        videoUrl: video.videoUrl,
        startSec: video.startSec,
        endSec: video.endSec,
        revision: value.revision,
        buildToken: token
      };
      video.questions.forEach((question, questionIndex) => {
        const questionKey = videoKey + 'q' + questionIndex;
        questions[questionKey] = {
          ...Object.fromEntries(QUESTION_KEYS
            .filter(name => own(question, name)).map(name => [name, question[name]])),
          questionKey,
          videoKey,
          revision: value.revision,
          buildToken: token
        };
      });
    });
    return { parent: requireParent(parent), videos, questions };
  }

  function assembleProjection(parentValue, videoValues, questionValues) {
    const parent = requireParent(parentValue);
    const videoEntries = Object.entries(videoValues || {});
    const questionEntries = Object.entries(questionValues || {});
    if (videoEntries.length !== parent.videoCount) throw new Error('video count mismatch.');
    if (questionEntries.length !== parent.questionCount) throw new Error('question count mismatch.');
    const videos = videoEntries.map(([key, value]) => {
      const errors = validateVideoPart(value, key);
      if (errors.length || value.revision !== parent.revision) {
        throw new Error((errors.length ? errors : ['video revision mismatch.']).join(' '));
      }
      return [Number(key.slice(1)), key, value];
    }).sort((left, right) => left[0] - right[0]);
    videos.forEach(([index], position) => {
      if (index !== position) throw new Error('video keys must be contiguous.');
    });
    const groupedQuestions = new Map(videos.map(([, key]) => [key, []]));
    questionEntries.forEach(([key, value]) => {
      const errors = validateQuestionPart(value, key);
      if (errors.length || value.revision !== parent.revision || !groupedQuestions.has(value.videoKey)) {
        throw new Error((errors.length ? errors : ['question revision or video binding mismatch.']).join(' '));
      }
      const index = Number(key.slice(key.indexOf('q') + 1));
      groupedQuestions.get(value.videoKey).push([index, value]);
    });
    const reconstructedVideos = videos.map(([, key, video]) => {
      const parts = groupedQuestions.get(key).sort((left, right) => left[0] - right[0]);
      if (!parts.length) throw new Error('each video must contain a question.');
      parts.forEach(([index], position) => {
        if (index !== position) throw new Error('question keys must be contiguous.');
      });
      return {
        videoId: video.videoId,
        videoUrl: video.videoUrl,
        startSec: video.startSec,
        endSec: video.endSec,
        questions: parts.map(([, question]) => Object.fromEntries(QUESTION_KEYS
          .filter(name => own(question, name)).map(name => [name, question[name]])))
      };
    });
    return requireProjection({
      publicationId: parent.publicationId,
      sourceSetId: parent.sourceSetId,
      status: parent.status,
      moderationStatus: parent.moderationStatus,
      revision: parent.revision,
      title: parent.title,
      description: parent.description,
      authorDisplayName: parent.authorDisplayName,
      videos: reconstructedVideos,
      settings: parentSettings(parent),
      videoCount: parent.videoCount,
      questionCount: parent.questionCount,
      imageCount: parent.imageCount,
      publishedAt: parent.publishedAt,
      updatedAt: parent.updatedAt
    });
  }

  function copyPatch(projection) {
    const value = requireProjection(projection);
    return {
      publicationId: value.publicationId,
      sourceTitle: value.title,
      sourceAuthorDisplayName: value.authorDisplayName,
      visibility: 'private',
      collaboratorCount: 0,
      imageCount: 0,
      lifecycleState: 'active'
    };
  }

  function publicSummary(projection) {
    const parentValidation = validateParent(projection);
    const value = parentValidation.ok ? projection : requireProjection(projection);
    return {
      publicationId: value.publicationId,
      title: value.title,
      description: value.description,
      authorDisplayName: value.authorDisplayName,
      videoCount: value.videoCount,
      questionCount: value.questionCount,
      updatedAtMs: timestampMillis(value.updatedAt)
    };
  }

  return {
    PUBLIC_KEYS,
    PUBLIC_PARENT_KEYS,
    buildProjection,
    validateProjection,
    validateParent,
    flattenProjection,
    assembleProjection,
    copyPatch,
    publicSummary
  };
});

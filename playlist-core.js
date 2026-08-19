(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PlaylistCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const n = value => Math.max(0, Number(value) || 0);

  function normalizeVideos(raw) {
    const source = Array.isArray(raw && raw.videos) && raw.videos.length
      ? raw.videos
      : [{ videoUrl: raw && raw.videoUrl, videoId: raw && raw.videoId,
           questions: raw && raw.questions }];
    return source.map(video => ({
      videoUrl: video.videoUrl || '', videoId: video.videoId || '',
      startSec: n(video.startSec),
      endSec: video.endSec == null || video.endSec === '' ? null : n(video.endSec),
      questions: (video.questions || []).filter(Boolean).map(q => Object.assign({}, q))
    }));
  }

  function timelineRatio(time, startSec, endSec) {
    const start = n(startSec), end = Math.max(start, n(endSec));
    if (end === start) return 0;
    return Math.max(0, Math.min(1, (n(time) - start) / (end - start)));
  }

  function flattenQuestions(videos) {
    const flat = [];
    (videos || []).forEach((video, videoIndex) => {
      (video.questions || []).forEach((question, questionIndex) => flat.push(Object.assign({}, question, {
        key: `v${videoIndex}q${questionIndex}`,
        number: flat.length + 1, videoIndex, questionIndex
      })));
    });
    return flat;
  }

  function validateVideo(video, durationSec) {
    const start = n(video.startSec), end = video.endSec == null ? Number(durationSec) : n(video.endSec);
    if (Number.isFinite(end) && end <= start) return ['醫낅즺 ?쒓컙? ?쒖옉 ?쒓컙蹂대떎 ?ㅼ뿬???⑸땲??'];
    if (Number.isFinite(durationSec) && end > durationSec) return ['醫낅즺 ?쒓컙???곸긽 湲몄씠瑜??섏뒿?덈떎.'];
    const outside = (video.questions || []).findIndex(q => n(q.t) < start || (Number.isFinite(end) && n(q.t) > end));
    return outside < 0 ? [] : [`${outside + 1}踰?臾명빆???ъ깮 援ш컙 諛뽰뿉 ?덉뒿?덈떎.`];
  }

  function nextPlaybackState(videos, videoIndex) {
    const next = videoIndex + 1;
    return next >= (videos || []).length
      ? { done: true, videoIndex, startSec: null }
      : { done: false, videoIndex: next, startSec: n(videos[next].startSec) };
  }

  function clone(value) {
    if (value == null) return value;
    return JSON.parse(JSON.stringify(value));
  }

  function playbackDomain(video) {
    const finiteNonNegative = value => {
      if (value == null || value === '') return null;
      const number = Number(value);
      return Number.isFinite(number) && number >= 0 ? number : null;
    };
    const normalizedStart = finiteNonNegative(video && video.startSec);
    const legacyStart = finiteNonNegative(video && video.start);
    const start = normalizedStart != null ? normalizedStart : (legacyStart != null ? legacyStart : 0);
    const normalizedEnd = finiteNonNegative(video && video.endSec);
    const legacyEnd = finiteNonNegative(video && video.end);
    let end = normalizedEnd != null ? normalizedEnd : legacyEnd;
    if (end == null) {
      const duration = finiteNonNegative(video && video.durationSec);
      if (duration > 0) end = start + duration;
    }
    return { start, end: end != null && end > start ? end : null };
  }

  function moveQuestion(rawVideos, rawImages, from, to) {
    const videos = clone(Array.isArray(rawVideos) ? rawVideos : []);
    const images = clone(rawImages && typeof rawImages === 'object' && !Array.isArray(rawImages) ? rawImages : {});
    const validPosition = position => position && Number.isInteger(position.videoIndex) &&
      Number.isInteger(position.questionIndex) && position.videoIndex >= 0 && position.questionIndex >= 0;
    if (!validPosition(from) || !validPosition(to) || !videos[from.videoIndex] || !videos[to.videoIndex]) {
      return { videos, images, moved: false };
    }
    const sourceQuestions = Array.isArray(videos[from.videoIndex].questions)
      ? videos[from.videoIndex].questions : [];
    if (from.questionIndex >= sourceQuestions.length ||
        (from.videoIndex === to.videoIndex && from.questionIndex === to.questionIndex)) {
      return { videos, images, moved: false };
    }
    const questionImages = new WeakMap();
    videos.forEach((video, videoIndex) => {
      (video && video.questions || []).forEach((question, questionIndex) => {
        const canonical = 'v' + videoIndex + 'q' + questionIndex;
        const legacy = String(questionIndex);
        if (Object.prototype.hasOwnProperty.call(images, canonical)) questionImages.set(question, images[canonical]);
        else if (videoIndex === 0 && Object.prototype.hasOwnProperty.call(images, legacy)) {
          questionImages.set(question, images[legacy]);
        }
      });
    });
    const movedQuestion = sourceQuestions.splice(from.questionIndex, 1)[0];
    let targetIndex = to.questionIndex;
    if (from.videoIndex === to.videoIndex && to.questionIndex > from.questionIndex) targetIndex -= 1;
    const destinationLength = from.videoIndex === to.videoIndex
      ? sourceQuestions.length : (videos[to.videoIndex].questions || []).length;
    targetIndex = Math.max(0, Math.min(targetIndex, destinationLength));
    if (from.videoIndex !== to.videoIndex) {
      const oldDomain = playbackDomain(rawVideos[from.videoIndex]);
      const newDomain = playbackDomain(rawVideos[to.videoIndex]);
      const span = oldDomain.end != null ? oldDomain.end - oldDomain.start : 0;
      const newSpan = newDomain.end != null ? newDomain.end - newDomain.start : 0;
      const ratio = span > 0 && Number.isFinite(Number(movedQuestion.t))
        ? Math.max(0, Math.min(1, (Number(movedQuestion.t) - oldDomain.start) / span)) : 0;
      movedQuestion.t = Math.round(newDomain.start + (newSpan > 0 ? ratio * newSpan : 0));
    }
    videos[to.videoIndex].questions = Array.isArray(videos[to.videoIndex].questions)
      ? videos[to.videoIndex].questions : [];
    videos[to.videoIndex].questions.splice(targetIndex, 0, movedQuestion);
    const normalizedImages = {};
    videos.forEach((video, videoIndex) => (video.questions || []).forEach((question, questionIndex) => {
      if (question && typeof question === 'object' && questionImages.has(question)) {
        normalizedImages['v' + videoIndex + 'q' + questionIndex] = questionImages.get(question);
      }
    }));
    return { videos, images: normalizedImages, moved: true };
  }

  return { normalizeVideos, flattenQuestions, timelineRatio, validateVideo, nextPlaybackState, moveQuestion };
});

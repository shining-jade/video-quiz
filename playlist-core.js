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

  return { normalizeVideos, flattenQuestions, timelineRatio, validateVideo, nextPlaybackState };
});

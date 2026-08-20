(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.QuizPreviewCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function normalizedText(value) {
    return String(value == null ? '' : value)
      .trim().toLowerCase().replace(/\s+/g, '')
      .replace(/[.,!?~·'"’”\-–—()[\]]/g, '');
  }

  function create(question, options) {
    const q = Object.assign({}, question || {});
    const targetTime = Math.max(0, Number(q.t) || 0);
    const startSec = Math.max(0, Number(options && options.startSec) || 0);
    return {
      phase: 'video',
      question: q,
      targetTime,
      startAt: Math.max(startSec, targetTime - 3),
      answer: q.type === 'multi' ? [] : null,
      correct: undefined,
      explanation: ''
    };
  }

  function advance(state, currentTime) {
    if (!state || state.phase !== 'video' || Number(currentTime) < state.targetTime) return state;
    return Object.assign({}, state, { phase: 'question' });
  }

  function select(state, answer) {
    return Object.assign({}, state, { answer: Array.isArray(answer) ? answer.slice() : answer });
  }

  function isSelected(state, index) {
    if (!state || state.answer == null) return false;
    return state.question && state.question.type === 'multi'
      ? Array.isArray(state.answer) && state.answer.indexOf(index) >= 0
      : state.answer === index;
  }

  function grade(question, answer) {
    const type = question && question.type || 'choice';
    if (type === 'long') return null;
    if (type === 'short') {
      const got = normalizedText(answer);
      return !!got && (question.accept || []).some(value => normalizedText(value) === got);
    }
    if (type === 'multi') {
      const want = (question.answers || []).slice().map(Number).sort((a, b) => a - b).join(',');
      const got = (Array.isArray(answer) ? answer : []).slice().map(Number).sort((a, b) => a - b).join(',');
      return !!want && want === got;
    }
    return Number(answer) === Number(question && question.answer);
  }

  function submit(state) {
    const question = state && state.question || {};
    return Object.assign({}, state, {
      phase: 'result',
      correct: grade(question, state && state.answer),
      explanation: String(question.explain || '')
    });
  }

  function continuePlayback(state) {
    return Object.assign({}, state, { phase: 'continued' });
  }

  return { create, advance, select, isSelected, submit, continuePlayback, grade };
});

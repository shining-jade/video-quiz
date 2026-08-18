(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MigrationCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);

  function normalizeEmail(email) {
    return String(email || '').trim().toLowerCase();
  }

  function responseLeakPaths(value, prefix) {
    if (!value || typeof value !== 'object') return [];
    const base = prefix || '';
    return Object.entries(value).flatMap(([key, child]) => {
      const path = base ? base + '.' + key : key;
      if (key === 'ok' || key === 'score') return [path];
      return responseLeakPaths(child, path);
    });
  }

  function legacyCorrectness(answer) {
    const hasOk = own(answer, 'ok');
    const hasScore = own(answer, 'score');
    if (!hasOk && !hasScore) return { present: false };

    const okEmpty = !hasOk || answer.ok == null;
    const scoreEmpty = !hasScore || answer.score == null;
    const okValid = typeof answer.ok === 'boolean';
    const scoreValid = typeof answer.score === 'boolean' || answer.score === 0 || answer.score === 1;
    if (!okEmpty && !okValid) {
      return { error: 'Legacy ok value is not a boolean.' };
    }
    if (!scoreEmpty && !scoreValid) {
      return { error: 'Legacy score cannot be represented as a boolean grade.' };
    }
    const fromOk = okValid ? answer.ok : null;
    const fromScore = scoreValid ? !!answer.score : null;
    if (fromOk !== null && fromScore !== null && fromOk !== fromScore) {
      return { error: 'Legacy ok and score contain conflicting grades.' };
    }
    if (fromOk === null && fromScore === null) return { present: false };
    return { present: true, ok: fromOk !== null ? fromOk : fromScore };
  }

  function prepareLegacyResponse(responseId, response) {
    const original = response && typeof response === 'object' ? response : {};
    const leaks = responseLeakPaths(original);
    if (original.uid != null && original.uid !== responseId) {
      return { status: 'failed', reason: 'Response uid does not match its document id.', response: original, grades: [] };
    }
    if (!leaks.length) {
      return { status: 'skip', response: original, grades: [] };
    }
    if (!original.answers || typeof original.answers !== 'object' || Array.isArray(original.answers)) {
      return { status: 'failed', reason: 'Legacy grading exists outside the answers map.', response: original, grades: [] };
    }

    const next = { ...original, uid: responseId, answers: { ...original.answers } };
    const grades = [];
    for (const [questionKey, value] of Object.entries(original.answers)) {
      const answer = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
      if (!answer) continue;
      const answerLeaks = responseLeakPaths(answer);
      if (!answerLeaks.length) continue;
      if (answerLeaks.some(path => path.includes('.'))) {
        return { status: 'failed', reason: 'Legacy grading exists below an answer leaf.', response: original, grades: [] };
      }
      if (!/^(0|[1-9]\d*)$/.test(questionKey)) {
        return { status: 'failed', reason: 'Legacy grade has an invalid question index.', response: original, grades: [] };
      }
      const questionIndex = Number(questionKey);
      if (!Number.isSafeInteger(questionIndex)) {
        return { status: 'failed', reason: 'Legacy grade has an invalid question index.', response: original, grades: [] };
      }
      const correctness = legacyCorrectness(answer);
      if (correctness.error) {
        return { status: 'failed', reason: correctness.error, response: original, grades: [] };
      }
      const revision = answer.revision;
      if (correctness.present &&
          (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision <= 0)) {
        return {
          status: 'failed',
          reason: 'Correctness-bearing legacy grade requires an explicit positive integer revision.',
          response: original,
          grades: []
        };
      }
      const sanitized = { ...answer };
      delete sanitized.ok;
      delete sanitized.score;
      next.answers[questionKey] = sanitized;
      if (correctness.present) {
        grades.push({
          id: responseId + '__' + questionIndex,
          uid: responseId,
          questionIndex,
          revision,
          ok: correctness.ok
        });
      }
    }

    const remaining = responseLeakPaths(next);
    if (remaining.length) {
      return { status: 'failed', reason: 'Legacy grading remains outside supported answer leaves.', response: original, grades: [] };
    }
    return { status: 'migrate', response: next, grades };
  }

  return {
    normalizeEmail,
    prepareLegacyResponse,
    responseLeakPaths
  };
});

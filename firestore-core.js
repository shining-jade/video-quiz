(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FirestoreCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function timestampMillis(value) {
    if (value == null) return null;
    if (typeof value === 'number') return value;
    if (typeof value.toMillis === 'function') return value.toMillis();
    return null;
  }

  function offsetFromRoundTrip(serverMillis, startedAt, finishedAt) {
    return serverMillis - (startedAt + finishedAt) / 2;
  }

  function responseDocsToQuestionMaps(docs) {
    const out = {};
    Object.keys(docs || {}).forEach(studentId => {
      Object.entries((docs[studentId] && docs[studentId].answers) || {}).forEach(([question, answer]) => {
        (out[question] || (out[question] = {}))[studentId] = answer;
      });
    });
    return out;
  }

  function buildBoard(students, responseDocs) {
    const board = {};
    Object.keys(students || {}).forEach(id => {
      const answers = (responseDocs[id] && responseDocs[id].answers) || {};
      board[id] = Object.values(answers).filter(answer => answer && answer.ok === true).length;
    });
    return board;
  }

  async function claimFirstAvailableCode(codes, claim) {
    for (const code of codes) if (await claim(code)) return code;
    throw new Error('사용 가능한 반 코드를 만들지 못했습니다. 다시 시도해 주세요.');
  }

  function chunk(items, size) {
    if (!Number.isInteger(size) || size < 1) throw new Error('분할 크기는 양수여야 합니다');
    const groups = [];
    for (let i = 0; i < items.length; i += size) groups.push(items.slice(i, i + size));
    return groups;
  }

  return {
    timestampMillis,
    offsetFromRoundTrip,
    responseDocsToQuestionMaps,
    buildBoard,
    claimFirstAvailableCode,
    chunk
  };
});

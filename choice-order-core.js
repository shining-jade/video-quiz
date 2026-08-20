(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ChoiceOrderCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function move(question, fromIndex, toIndex) {
    if (!question || question.type === 'ox' || !Array.isArray(question.choices)) return null;
    const from = Number(fromIndex);
    const to = Number(toIndex);
    const length = question.choices.length;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from >= length || to < 0 || to >= length || from === to) return null;

    const order = Array.from({ length }, (_, index) => index);
    const removed = order.splice(from, 1)[0];
    order.splice(to, 0, removed);
    const newIndex = new Map(order.map((oldIndex, index) => [oldIndex, index]));
    const result = Object.assign({}, question, { choices: order.map(index => question.choices[index]) });
    if (Number.isInteger(question.answer) && newIndex.has(question.answer)) result.answer = newIndex.get(question.answer);
    if (Array.isArray(question.answers)) {
      result.answers = question.answers.filter(index => newIndex.has(index)).map(index => newIndex.get(index)).sort((a, b) => a - b);
    }
    return result;
  }

  return { move };
});

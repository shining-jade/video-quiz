(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.QuizTriggerCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const finite = value => Number.isFinite(Number(value));

  function create(rawQuestions, options) {
    const questions = Array.isArray(rawQuestions) ? rawQuestions.map((question, index) => ({
      index,
      t: Number(question && question.t),
      videoIndex: Number(question && question.videoIndex)
    })) : [];
    const rearmSeconds = Math.max(0, finite(options && options.rearmSeconds)
      ? Number(options.rearmSeconds) : 1);
    let statuses = questions.map(() => 'upcoming');

    const matching = videoIndex => questions.filter(question =>
      question.videoIndex === Number(videoIndex) && finite(question.t));
    const snapshot = () => statuses.slice();

    function advance(input) {
      const value = input || {};
      const videoIndex = Number(value.videoIndex);
      const previousTime = Number(value.previousTime);
      const currentTime = Number(value.currentTime);
      const rearmed = [];
      const enqueue = [];
      if (!Number.isInteger(videoIndex) || !finite(previousTime) || !finite(currentTime)) {
        return { state: snapshot(), enqueue, rearmed };
      }

      matching(videoIndex).forEach(question => {
        if (statuses[question.index] === 'completed' && currentTime <= question.t - rearmSeconds) {
          statuses[question.index] = 'rearmed';
          rearmed.push(question.index);
        }
      });

      if (Number.isInteger(value.openIndex) && questions[value.openIndex] &&
          questions[value.openIndex].videoIndex === videoIndex &&
          statuses[value.openIndex] !== 'completed') {
        statuses[value.openIndex] = 'open';
      }

      if (previousTime < currentTime) {
        matching(videoIndex).filter(question => {
          const status = statuses[question.index];
          return (status === 'upcoming' || status === 'rearmed') &&
            previousTime < question.t && question.t <= currentTime;
        }).sort((left, right) => left.t - right.t || left.index - right.index).forEach(question => {
          statuses[question.index] = 'queued';
          enqueue.push(question.index);
        });
      }
      return { state: snapshot(), enqueue, rearmed };
    }

    function open(index) {
      if (!Number.isInteger(index) || !questions[index] || statuses[index] === 'completed') return false;
      statuses[index] = 'open';
      return true;
    }

    function complete(index) {
      if (!Number.isInteger(index) || !questions[index]) return false;
      if (statuses[index] !== 'open' && statuses[index] !== 'queued') return false;
      statuses[index] = 'completed';
      return true;
    }

    function resetVideo(videoIndex) {
      matching(videoIndex).forEach(question => {
        if (statuses[question.index] === 'queued' || statuses[question.index] === 'open') {
          statuses[question.index] = 'upcoming';
        }
      });
      return snapshot();
    }

    function reset() {
      statuses = questions.map(() => 'upcoming');
      return snapshot();
    }

    return { advance, open, complete, resetVideo, reset, state: snapshot };
  }

  return { create };
});

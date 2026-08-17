(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TeacherStage = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function clampBubblePosition(position, bubbleSize, stageSize, padding) {
    const gap = Number.isFinite(padding) ? padding : 16;
    const maxX = Math.max(gap, stageSize.width - bubbleSize.width - gap);
    const maxY = Math.max(gap, stageSize.height - bubbleSize.height - gap);
    return {
      x: Math.min(maxX, Math.max(gap, position.x)),
      y: Math.min(maxY, Math.max(gap, position.y))
    };
  }

  return { clampBubblePosition };
});

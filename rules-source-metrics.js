'use strict';

function measureRulesSource(source) {
  if (typeof source !== 'string') throw new TypeError('Rules source must be a string.');
  const lineBreak = /\r\n|\r|\n/g;
  const lines = source === '' ? 0 : (source.match(lineBreak) || []).length +
    (/(?:\r\n|\r|\n)$/.test(source) ? 0 : 1);
  const functions = (source.match(/\bfunction\s+[A-Za-z_][A-Za-z0-9_]*\s*\(/g) || []).length;
  return { bytes: Buffer.byteLength(source, 'utf8'), lines, functions };
}

module.exports = { measureRulesSource };

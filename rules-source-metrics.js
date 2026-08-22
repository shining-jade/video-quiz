'use strict';

function executableRulesSource(source) {
  let result = '';
  let index = 0;
  let quote = '';
  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];
    if (quote) {
      if (character === '\\') {
        result += '  ';
        index += 2;
      } else {
        result += character === '\n' || character === '\r' ? character : ' ';
        if (character === quote) quote = '';
        index += 1;
      }
      continue;
    }
    if (character === '\'' || character === '"') {
      quote = character;
      result += ' ';
      index += 1;
    } else if (character === '/' && next === '/') {
      result += '  ';
      index += 2;
      while (index < source.length && source[index] !== '\n' && source[index] !== '\r') {
        result += ' ';
        index += 1;
      }
    } else if (character === '/' && next === '*') {
      result += '  ';
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        result += source[index] === '\n' || source[index] === '\r' ? source[index] : ' ';
        index += 1;
      }
      if (index < source.length) {
        result += '  ';
        index += 2;
      }
    } else {
      result += character;
      index += 1;
    }
  }
  return result;
}

function measureRulesSource(source) {
  if (typeof source !== 'string') throw new TypeError('Rules source must be a string.');
  const lineBreak = /\r\n|\r|\n/g;
  const lines = source === '' ? 0 : (source.match(lineBreak) || []).length +
    (/(?:\r\n|\r|\n)$/.test(source) ? 0 : 1);
  const functions = (executableRulesSource(source)
    .match(/\bfunction\s+[A-Za-z_][A-Za-z0-9_]*\s*\(/g) || []).length;
  return { bytes: Buffer.byteLength(source, 'utf8'), lines, functions };
}

module.exports = { measureRulesSource };

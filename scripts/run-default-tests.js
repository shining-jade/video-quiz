#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function defaultTestFiles(testDirectory = path.resolve(__dirname, '../tests')) {
  return fs.readdirSync(testDirectory)
    .filter(name => name.endsWith('.test.js') && name !== 'rules-source-budget.test.js')
    .sort()
    .map(name => path.join(testDirectory, name));
}

function main() {
  const result = spawnSync(process.execPath, ['--test', ...defaultTestFiles()], {
    stdio: 'inherit'
  });
  return Number.isInteger(result.status) ? result.status : 1;
}

if (require.main === module) process.exitCode = main();

module.exports = { defaultTestFiles, main };

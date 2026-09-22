'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

const EXPECTED_ROOT = '/Users/padbol2022/PADBOL-LAB-DEEPSEEK/padbol-backend-canonical';

function git(...args) {
  return execFileSync('git', args, { cwd: EXPECTED_ROOT, encoding: 'utf8' }).trim();
}

assert.equal(
  fs.realpathSync(git('rev-parse', '--show-toplevel')),
  fs.realpathSync(EXPECTED_ROOT),
  'Deploy bloqueado: repositorio backend no oficial',
);
assert.equal(git('branch', '--show-current'), 'main', 'Deploy bloqueado: rama no autorizada');
assert.equal(git('status', '--porcelain'), '', 'Deploy bloqueado: hay cambios sin commit');
assert.match(git('remote', 'get-url', 'origin'), /Gus-Padbol\/padbol-backend\.git$/, 'Deploy bloqueado: remote incorrecto');

console.log(JSON.stringify({
  ok: true,
  root: EXPECTED_ROOT,
  branch: 'main',
  head: git('rev-parse', 'HEAD'),
}, null, 2));

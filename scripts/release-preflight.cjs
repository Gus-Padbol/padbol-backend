'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const EXPECTED_ROOT = '/Users/padbol2022/PADBOL-LAB-DEEPSEEK/padbol-backend-canonical';

function checkCleanWorktree(root) {
  root = fs.realpathSync(root);
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  const worktreesDir = path.join(root, '.worktrees');
  const commonDir = fs.realpathSync(path.resolve(root, git('rev-parse', '--git-common-dir').trim()));
  const records = git('worktree', 'list', '--porcelain', '-z').split('\0\0').filter(Boolean).map((record) => {
    const fields = record.split('\0');
    const value = (prefix) => fields.find((field) => field.startsWith(prefix))?.slice(prefix.length) || null;
    return { path: path.resolve(value('worktree ')), branch: value('branch ')?.replace(/^refs\/heads\//, '') || null,
      head: value('HEAD '), detached: fields.includes('detached'), prunable: fields.some((field) => field.startsWith('prunable')) };
  });
  const registered = new Set(records.map((record) => record.path));

  let dir;
  try { dir = fs.lstatSync(worktreesDir); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (dir) {
    assert.ok(dir.isDirectory() && !dir.isSymbolicLink(), 'Deploy bloqueado: .worktrees no es un directorio real');
    for (const entry of fs.readdirSync(worktreesDir)) {
      const full = path.join(worktreesDir, entry);
      const stat = fs.lstatSync(full);
      assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && registered.has(full),
        `Deploy bloqueado: entrada no registrada en .worktrees: ${entry}`);
      assert.ok(fs.lstatSync(path.join(full, '.git')).isFile(),
        `Deploy bloqueado: worktree inválido: ${entry}`);
      const top = execFileSync('git', ['-C', full, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
      assert.equal(fs.realpathSync(top), fs.realpathSync(full), `Deploy bloqueado: worktree inválido: ${entry}`);
      const common = execFileSync('git', ['-C', full, 'rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim();
      assert.equal(fs.realpathSync(path.resolve(full, common)), commonDir, `Deploy bloqueado: worktree de otro repositorio: ${entry}`);
    }
  }

  const status = git('status', '--porcelain=v1', '-z').split('\0').filter(Boolean);
  const changes = status.filter((entry) => !(entry.startsWith('?? ') &&
    (entry.slice(3) === '.worktrees/' || entry.slice(3).startsWith('.worktrees/'))));
  assert.equal(changes.length, 0, 'Deploy bloqueado: hay cambios sin commit');

  return records.map(({ path: worktreePath, branch, head, detached, prunable }) => {
    let state = 'no disponible';
    if (!prunable) {
      try {
        const status = execFileSync('git', ['-C', worktreePath, 'status', '--porcelain=v1', '-z'],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        state = status ? 'con cambios' : 'limpio';
      } catch { state = 'no disponible'; }
    }
    return { ruta: worktreePath, rama: branch, head, detached, estado: state };
  });
}

function preflight() {
  const git = (...args) => execFileSync('git', args, { cwd: EXPECTED_ROOT, encoding: 'utf8' }).trim();
  assert.equal(fs.realpathSync(git('rev-parse', '--show-toplevel')), fs.realpathSync(EXPECTED_ROOT), 'Deploy bloqueado: repositorio backend no oficial');
  assert.equal(git('branch', '--show-current'), 'main', 'Deploy bloqueado: rama no autorizada');
  const worktrees = checkCleanWorktree(EXPECTED_ROOT);
  assert.match(git('remote', 'get-url', 'origin'), /Gus-Padbol\/padbol-backend\.git$/, 'Deploy bloqueado: remote incorrecto');
  console.log(JSON.stringify({ ok: true, root: EXPECTED_ROOT, branch: 'main', head: git('rev-parse', 'HEAD'), worktrees }, null, 2));
}

if (require.main === module) preflight();
module.exports = { checkCleanWorktree };

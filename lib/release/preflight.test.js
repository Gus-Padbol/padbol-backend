import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const { checkCleanWorktree } = createRequire(import.meta.url)('../../scripts/release-preflight.cjs');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'repo');
  fs.mkdirSync(root);
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Fixture');
  fs.writeFileSync(path.join(root, 'product.txt'), 'original');
  git('add', 'product.txt'); git('commit', '-m', 'fixture');
  return { root, git };
}
function worktree(f) {
  fs.mkdirSync(path.join(f.root, '.worktrees'), { recursive: true });
  f.git('worktree', 'add', '-b', 'candidate', path.join(f.root, '.worktrees', 'candidate'));
}

test('permite únicamente worktrees registrados, incluso si contienen trabajo pendiente', (t) => {
  const f = fixture(t); worktree(f);
  fs.writeFileSync(path.join(f.root, '.worktrees', 'candidate', 'pending.txt'), 'preserve');
  assert.doesNotThrow(() => checkCleanWorktree(f.root));
});
test('bloquea archivos y directorios no registrados junto a un worktree válido', (t) => {
  const f = fixture(t); worktree(f);
  fs.writeFileSync(path.join(f.root, '.worktrees', 'unexpected'), 'keep');
  assert.throws(() => checkCleanWorktree(f.root), /no registrada/);
  fs.unlinkSync(path.join(f.root, '.worktrees', 'unexpected'));
  fs.mkdirSync(path.join(f.root, '.worktrees', 'unregistered'));
  assert.throws(() => checkCleanWorktree(f.root), /no registrada/);
});
test('bloquea enlaces simbólicos en .worktrees y el propio directorio', (t) => {
  const f = fixture(t); worktree(f);
  fs.symlinkSync(path.join(f.root, '.worktrees', 'candidate'), path.join(f.root, '.worktrees', 'link'));
  assert.throws(() => checkCleanWorktree(f.root), /no registrada/);
  fs.unlinkSync(path.join(f.root, '.worktrees', 'link'));
  fs.renameSync(path.join(f.root, '.worktrees'), path.join(f.root, 'other'));
  fs.symlinkSync(path.join(f.root, 'other'), path.join(f.root, '.worktrees'));
  assert.throws(() => checkCleanWorktree(f.root), /directorio real/);
});
test('bloquea cambios propios, staged y no versionados', (t) => {
  const f = fixture(t); worktree(f);
  fs.writeFileSync(path.join(f.root, 'product.txt'), 'modified');
  assert.throws(() => checkCleanWorktree(f.root), /cambios sin commit/);
  f.git('add', 'product.txt');
  assert.throws(() => checkCleanWorktree(f.root), /cambios sin commit/);
  f.git('reset', '--hard', 'HEAD');
  fs.writeFileSync(path.join(f.root, 'new-product.txt'), 'new');
  assert.throws(() => checkCleanWorktree(f.root), /cambios sin commit/);
});
test('bloquea entrada registrada dañada', (t) => {
  const f = fixture(t); worktree(f);
  fs.unlinkSync(path.join(f.root, '.worktrees', 'candidate', '.git'));
  assert.throws(() => checkCleanWorktree(f.root));
});

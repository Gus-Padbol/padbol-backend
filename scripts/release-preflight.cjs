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

// An isolated release worktree must remain inside the canonical repository,
// be registered with it, and explicitly identify branch, commit and target.
// The target branch is checked against its live remote before release.
function checkReleaseCandidate({ canonicalRoot, candidateRoot, branch, expectedCommit, target, qaDeployedCommit, readRemoteHead }) {
  const canonical = fs.realpathSync(canonicalRoot);
  const candidate = fs.realpathSync(candidateRoot);
  const gitAt = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  assert.ok(['qa', 'production'].includes(target), 'Deploy bloqueado: destino explícito inválido');
  assert.ok(typeof branch === 'string' && /^candidate\/[a-z0-9][a-z0-9._/-]*$/.test(branch) && !branch.includes('..'),
    'Deploy bloqueado: rama candidata explícita requerida');
  assert.match(String(expectedCommit || ''), /^[0-9a-f]{40}$/, 'Deploy bloqueado: commit completo requerido');
  assert.equal(fs.realpathSync(gitAt(canonical, 'rev-parse', '--show-toplevel')), canonical, 'Deploy bloqueado: raíz canónica inválida');
  const rootGit = fs.realpathSync(path.resolve(canonical, gitAt(canonical, 'rev-parse', '--git-common-dir')));
  assert.equal(rootGit, fs.realpathSync(path.join(canonical, '.git')), 'Deploy bloqueado: repositorio canónico inválido');
  const container = path.join(canonical, '.worktrees');
  assert.ok(fs.lstatSync(container).isDirectory() && !fs.lstatSync(container).isSymbolicLink(), 'Deploy bloqueado: directorio de worktrees inválido');
  assert.equal(path.dirname(candidate), fs.realpathSync(container), 'Deploy bloqueado: candidato fuera del directorio oficial');
  assert.ok(!fs.lstatSync(candidateRoot).isSymbolicLink(), 'Deploy bloqueado: candidato simbólico');
  assert.equal(fs.realpathSync(gitAt(candidate, 'rev-parse', '--show-toplevel')), candidate, 'Deploy bloqueado: raíz candidata inválida');
  const common = fs.realpathSync(path.resolve(candidate, gitAt(candidate, 'rev-parse', '--git-common-dir')));
  assert.equal(common, rootGit, 'Deploy bloqueado: candidato de otro repositorio');
  const records = gitAt(canonical, 'worktree', 'list', '--porcelain', '-z').split('\0\0').filter(Boolean);
  const record = records.map(r => r.split('\0')).find(fields => fields.includes(`worktree ${candidate}`));
  assert.ok(record && record.includes(`branch refs/heads/${branch}`) && !record.includes('detached'), 'Deploy bloqueado: worktree o rama no registrada');
  assert.equal(gitAt(candidate, 'branch', '--show-current'), branch, 'Deploy bloqueado: rama no autorizada');
  const head = gitAt(candidate, 'rev-parse', 'HEAD');
  assert.equal(head, expectedCommit, 'Deploy bloqueado: commit distinto del previsto');
  assert.equal(gitAt(candidate, 'status', '--porcelain=v1', '-z'), '', 'Deploy bloqueado: hay cambios sin commit en candidato');
  assert.match(gitAt(candidate, 'remote', 'get-url', 'origin'), /^(?:https:\/\/github\.com\/|git@github\.com:)Gus-Padbol\/padbol-backend\.git$/, 'Deploy bloqueado: remote incorrecto');
  const remoteBranch = target === 'qa' ? 'codex/qa-nextgen-admin-20261006' : 'main';
  const localRef = `refs/remotes/origin/${remoteBranch}`;
  const remoteRef = `refs/heads/${remoteBranch}`;
  const base = gitAt(candidate, 'rev-parse', '--verify', `${localRef}^{commit}`);
  let live;
  try {
    live = readRemoteHead ? readRemoteHead(remoteRef) : gitAt(candidate, 'ls-remote', '--exit-code', 'origin', remoteRef).split(/\s+/)[0];
  } catch { throw new Error('Deploy bloqueado: no se pudo verificar el remoto en vivo'); }
  assert.match(String(live || ''), /^[0-9a-f]{40}$/, 'Deploy bloqueado: respuesta de remoto inválida');
  assert.equal(base, live, 'Deploy bloqueado: referencia local no coincide con remoto en vivo');
  try { gitAt(candidate, 'merge-base', '--is-ancestor', base, head); }
  catch { throw new Error(`Deploy bloqueado: candidato no incluye origin/${remoteBranch}`); }
  if (target === 'qa') {
    assert.match(String(qaDeployedCommit || ''), /^[0-9a-f]{40}$/, 'Deploy bloqueado: commit desplegado de QA completo requerido');
    try { gitAt(candidate, 'merge-base', '--is-ancestor', qaDeployedCommit, base); }
    catch { throw new Error('Deploy bloqueado: remoto QA no incluye el commit desplegado'); }
    try { gitAt(candidate, 'merge-base', '--is-ancestor', qaDeployedCommit, head); }
    catch { throw new Error('Deploy bloqueado: candidato no incluye el commit desplegado de QA'); }
  }
  return { ok: true, root: candidate, canonicalRoot: canonical, branch, head, remoteBranch, remoteHead: live, qaDeployedCommit: target === 'qa' ? qaDeployedCommit : null, target };
}

function preflight() {
  const cwd = fs.realpathSync(process.cwd());
  const canonical = fs.realpathSync(EXPECTED_ROOT);
  // Ensure the reviewed script is the one from the checkout being validated.
  assert.equal(fs.realpathSync(path.dirname(__dirname)), cwd, 'Deploy bloqueado: script y checkout diferentes');
  if (cwd !== canonical) {
    const result = checkReleaseCandidate({ canonicalRoot: canonical, candidateRoot: cwd,
      branch: process.env.PADBOL_RELEASE_BRANCH, expectedCommit: process.env.PADBOL_RELEASE_COMMIT,
      target: process.env.PADBOL_RELEASE_TARGET, qaDeployedCommit: process.env.PADBOL_RELEASE_QA_DEPLOYED_COMMIT });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const git = (...args) => execFileSync('git', args, { cwd: canonical, encoding: 'utf8' }).trim();
  assert.equal(fs.realpathSync(git('rev-parse', '--show-toplevel')), canonical, 'Deploy bloqueado: repositorio backend no oficial');
  assert.equal(git('branch', '--show-current'), 'main', 'Deploy bloqueado: rama no autorizada');
  const worktrees = checkCleanWorktree(canonical);
  assert.match(git('remote', 'get-url', 'origin'), /^(?:https:\/\/github\.com\/|git@github\.com:)Gus-Padbol\/padbol-backend\.git$/, 'Deploy bloqueado: remote incorrecto');
  console.log(JSON.stringify({ ok: true, root: canonical, branch: 'main', head: git('rev-parse', 'HEAD'), worktrees }, null, 2));
}

if (require.main === module) preflight();
module.exports = { checkCleanWorktree, checkReleaseCandidate };

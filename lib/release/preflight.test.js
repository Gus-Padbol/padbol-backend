import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const { checkCleanWorktree, checkReleaseCandidate } = createRequire(import.meta.url)('../../scripts/release-preflight.cjs');

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
  const inventory = checkCleanWorktree(f.root);
  const entry = inventory.find((item) => item.rama === 'candidate');
  assert.equal(entry.ruta, fs.realpathSync(path.join(f.root, '.worktrees', 'candidate')));
  assert.match(entry.head, /^[0-9a-f]{40}$/);
  assert.equal(entry.estado, 'con cambios');
  assert.equal(entry.detached, false);
  assert.doesNotMatch(JSON.stringify(inventory), /pending\.txt|preserve/);
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

test('registra trabajo limpio y desconectado, y registros no disponibles', (t) => {
  const f = fixture(t); worktree(f);
  let inventory = checkCleanWorktree(f.root);
  assert.equal(inventory.find((item) => item.rama === 'candidate').estado, 'limpio');
  execFileSync('git', ['-C', path.join(f.root, '.worktrees', 'candidate'), 'checkout', '--detach'], { stdio: 'ignore' });
  inventory = checkCleanWorktree(f.root);
  assert.equal(inventory.find((item) => item.detached).rama, null);
  const external = path.join(path.dirname(f.root), 'external');
  f.git('worktree', 'add', '--detach', external);
  fs.rmSync(external, { recursive: true });
  inventory = checkCleanWorktree(f.root);
  assert.equal(inventory.find((item) => item.ruta === fs.realpathSync(path.dirname(f.root)) + '/external').estado, 'no disponible');
});


function candidateFixture(t) {
  const f = fixture(t);
  f.git('remote', 'add', 'origin', 'https://github.com/Gus-Padbol/padbol-backend.git');
  f.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  f.git('update-ref', 'refs/remotes/origin/codex/qa-nextgen-admin-20261006', 'HEAD');
  fs.mkdirSync(path.join(f.root, '.worktrees'));
  const candidate = path.join(f.root, '.worktrees', 'release');
  f.git('worktree', 'add', '-b', 'candidate/release', candidate);
  const head = execFileSync('git', ['rev-parse', 'HEAD'], {cwd:candidate,encoding:'utf8'}).trim();
  return { ...f, candidate, args: {canonicalRoot:f.root, candidateRoot:candidate, branch:'candidate/release', expectedCommit:head, target:'qa', qaDeployedCommit:head, readRemoteHead:() => execFileSync('git',['rev-parse','refs/remotes/origin/codex/qa-nextgen-admin-20261006'],{cwd:f.root,encoding:'utf8'}).trim()} };
}

test('aprueba worktree oficial limpio, sin modificar cambios ajenos del principal', t => {
  const f = candidateFixture(t);
  fs.writeFileSync(path.join(f.root,'product.txt'), 'ajeno');
  fs.mkdirSync(path.join(f.root,'experiments'));
  fs.writeFileSync(path.join(f.root,'experiments','keep.txt'), 'preservar');
  const result = checkReleaseCandidate(f.args);
  assert.equal(result.branch, 'candidate/release');
  assert.equal(result.head, f.args.expectedCommit);
  assert.equal(result.target, 'qa');
  assert.equal(fs.readFileSync(path.join(f.root,'product.txt'),'utf8'), 'ajeno');
  assert.equal(fs.readFileSync(path.join(f.root,'experiments','keep.txt'),'utf8'), 'preservar');
});
test('rechaza árbol candidato sucio, rama, commit o destino equivocados', t => {
  const f = candidateFixture(t);
  assert.throws(() => checkReleaseCandidate({...f.args, branch:'candidate/other'}), /rama no registrada/);
  assert.throws(() => checkReleaseCandidate({...f.args, expectedCommit:'a'.repeat(40)}), /commit distinto/);
  assert.throws(() => checkReleaseCandidate({...f.args, target:'unknown'}), /destino explícito/);
  fs.writeFileSync(path.join(f.candidate,'new.txt'), 'pendiente');
  assert.throws(() => checkReleaseCandidate(f.args), /cambios sin commit/);
});
test('rechaza otro origen o un origen que no esté incorporado', t => {
  const f = candidateFixture(t);
  f.git('remote','set-url','origin','https://attacker.example/Gus-Padbol/padbol-backend.git');
  assert.throws(() => checkReleaseCandidate(f.args), /remote incorrecto/);
  f.git('remote','set-url','origin','https://github.com/Gus-Padbol/padbol-backend.git');
  fs.writeFileSync(path.join(f.root,'new-source.txt'), 'new');
  f.git('add','new-source.txt'); f.git('commit','-m','new remote main');
  f.git('update-ref','refs/remotes/origin/codex/qa-nextgen-admin-20261006','HEAD');
  assert.throws(() => checkReleaseCandidate(f.args), /no incluye origin/);
});
test('rechaza worktree externo, enlace y repositorio distinto', t => {
  const f = candidateFixture(t);
  const external = path.join(path.dirname(f.root), 'external');
  f.git('worktree','add','-b','candidate/external',external);
  assert.throws(() => checkReleaseCandidate({...f.args,candidateRoot:external,branch:'candidate/external'}), /fuera del directorio/);
  const linked = path.join(f.root,'.worktrees','linked');
  fs.symlinkSync(f.candidate,linked);
  assert.throws(() => checkReleaseCandidate({...f.args,candidateRoot:linked}), /simbólico/);
  const other = path.join(f.root,'.worktrees','other'); fs.mkdirSync(other);
  execFileSync('git',['init',other],{stdio:'ignore'});
  assert.throws(() => checkReleaseCandidate({...f.args,candidateRoot:other}), /otro repositorio/);
});

test('rechaza cambios staged y HEAD desconectado en candidato', t => {
  const f = candidateFixture(t);
  fs.writeFileSync(path.join(f.candidate,'product.txt'),'staged');
  execFileSync('git',['add','product.txt'],{cwd:f.candidate});
  assert.throws(() => checkReleaseCandidate(f.args), /cambios sin commit/);
  execFileSync('git',['reset','--hard','HEAD'],{cwd:f.candidate,stdio:'ignore'});
  execFileSync('git',['checkout','--detach'],{cwd:f.candidate,stdio:'ignore'});
  assert.throws(() => checkReleaseCandidate(f.args), /rama no registrada/);
});


test('exige remoto QA actualizado y el commit desplegado', t => {
  const f = candidateFixture(t);
  assert.throws(() => checkReleaseCandidate({...f.args, readRemoteHead: () => 'a'.repeat(40)}), /no coincide/);
  assert.throws(() => checkReleaseCandidate({...f.args, readRemoteHead: () => { throw Error('offline'); }}), /remoto en vivo/);
  assert.throws(() => checkReleaseCandidate({...f.args, qaDeployedCommit: ''}), /commit desplegado/);
  assert.throws(() => checkReleaseCandidate({...f.args, qaDeployedCommit: 'a'.repeat(40)}), /remoto QA no incluye/);
});
test('producción exige main actualizado e incorporado', t => {
  const f = candidateFixture(t);
  const args = {...f.args, target:'production', readRemoteHead: ref => { assert.equal(ref, 'refs/heads/main'); return execFileSync('git',['rev-parse','refs/remotes/origin/main'],{cwd:f.root,encoding:'utf8'}).trim(); }};
  assert.equal(checkReleaseCandidate(args).remoteBranch, 'main');
  assert.throws(() => checkReleaseCandidate({...args, readRemoteHead: () => 'a'.repeat(40)}), /no coincide/);
});

test('release runtime blocks unpatched and overriding Node versions without changing server startup',()=>{
 const {checkNodeRuntime}=createRequire(import.meta.url)('../../scripts/release-preflight.cjs');
 for(const version of ['20.11.0','22.22.99','22.23.3','22.23.4-rc.1','24.14.1','24.22.1','garbage'])assert.throws(()=>checkNodeRuntime(version),/Deploy bloqueado/);
 for(const version of ['22.23.4','22.23.5','22.24.0'])assert.equal(checkNodeRuntime(version).node,version);
 const root=new URL('../../',import.meta.url);const pkg=JSON.parse(fs.readFileSync(new URL('package.json',root),'utf8')),lock=JSON.parse(fs.readFileSync(new URL('package-lock.json',root),'utf8'));
 assert.equal(pkg.engines.node,'>=22.23.4 <23');assert.equal(lock.packages[''].engines.node,pkg.engines.node);assert.equal(fs.readFileSync(new URL('.node-version',root),'utf8').trim(),'22.23.4');
});

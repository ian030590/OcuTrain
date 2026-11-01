import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const baseEnv = { ...process.env };
for (const key of spawnSync('git', ['rev-parse', '--local-env-vars'], { cwd: root, encoding: 'utf8' }).stdout.trim().split(/\r?\n/)) {
  delete baseEnv[key];
}

function run(cwd, command, args, env = {}) {
  return spawnSync(command, args, { cwd, encoding: 'utf8', env: { ...baseEnv, ...env } });
}

function git(cwd, ...args) {
  const result = run(cwd, 'git', args);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function fixture(t) {
  const directory = mkdtempSync(resolve(tmpdir(), 'pre-push-ci-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(resolve(directory, 'scripts'));
  copyFileSync(resolve(root, 'scripts/install-git-hooks.mjs'), resolve(directory, 'scripts/install-git-hooks.mjs'));
  return directory;
}

test('pre-push runs CI and a failing suite prevents the remote update', (t) => {
  const directory = fixture(t);
  const remote = resolve(directory, 'remote.git');
  git(directory, 'init', '--bare', remote);
  git(directory, 'init', '--initial-branch=main');
  mkdirSync(resolve(directory, '.githooks'));
  copyFileSync(resolve(root, '.githooks/pre-push'), resolve(directory, '.githooks/pre-push'));
  writeFileSync(resolve(directory, 'package.json'), JSON.stringify({
    private: true, scripts: { 'test:ci': 'node scripts/gate.cjs' },
  }));
  writeFileSync(resolve(directory, 'scripts/gate.cjs'),
    "require('node:fs').appendFileSync('ci.log', 'ci\\n'); process.exit(process.env.FAIL_CI ? 1 : 0);\n");
  const installed = run(directory, process.execPath, ['scripts/install-git-hooks.mjs'], { CI: '' });
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  assert.equal(git(directory, 'config', '--local', '--get', 'core.hooksPath'), '.githooks');
  git(directory, 'add', 'package.json');
  git(directory, '-c', 'user.name=Hook Test', '-c', 'user.email=hook@example.invalid', 'commit', '-m', 'fixture');
  git(resolve(directory, 'scripts'), 'push', remote, 'HEAD:refs/heads/main');
  assert.equal(readFileSync(resolve(directory, 'ci.log'), 'utf8'), 'ci\n');
  const published = git(directory, '--git-dir', remote, 'rev-parse', 'refs/heads/main');
  git(directory, '-c', 'user.name=Hook Test', '-c', 'user.email=hook@example.invalid', 'commit', '--allow-empty', '-m', 'blocked');
  const blocked = run(directory, 'git', ['push', remote, 'HEAD:refs/heads/main'], { FAIL_CI: '1' });
  assert.notEqual(blocked.status, 0, blocked.stderr || blocked.stdout);
  assert.equal(readFileSync(resolve(directory, 'ci.log'), 'utf8'), 'ci\nci\n');
  assert.equal(git(directory, '--git-dir', remote, 'rev-parse', 'refs/heads/main'), published);
});

test('installation leaves CI and source archives without hooks configuration', (t) => {
  const directory = fixture(t);
  const archive = run(directory, process.execPath, ['scripts/install-git-hooks.mjs'], { CI: '' });
  assert.equal(archive.status, 0, archive.stderr || archive.stdout);
  git(directory, 'init');
  const ci = run(directory, process.execPath, ['scripts/install-git-hooks.mjs'], { CI: 'true' });
  assert.equal(ci.status, 0, ci.stderr || ci.stdout);
  assert.notEqual(run(directory, 'git', ['config', '--local', '--get', 'core.hooksPath']).status, 0);
});

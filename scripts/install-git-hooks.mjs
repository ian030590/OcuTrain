import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

if (!process.env.CI && existsSync(resolve(root, '.git'))) {
  chmodSync(resolve(root, '.githooks/pre-push'), 0o755);
  execFileSync('git', ['config', '--local', 'core.hooksPath', '.githooks'], { cwd: root, stdio: 'inherit' });
}

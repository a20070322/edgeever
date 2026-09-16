import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { manageSkills, skillTargets, packageVersion } from '../src/skills.mjs';

async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'edgeever-skills-'));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}
const result = async (action, directory, ...flags) => (await manageSkills([action, '--dir', directory, ...flags])).results[0];

test('target directories respect tool-specific data roots', () => {
  const targets = skillTargets({ CODEX_HOME: '/isolated/codex', CLAUDE_CONFIG_DIR: '/isolated/claude', KIMI_CODE_HOME: '/isolated/kimi' }, '/unused');
  assert.equal(targets.codex, join('/isolated/codex', 'skills'));
  assert.equal(targets.claude, join('/isolated/claude', 'skills'));
  assert.equal(targets.kimi, join('/isolated/kimi', 'skills'));
  assert.equal(skillTargets({}, '/home/test').kimi, join('/home/test', '.kimi-code/skills'));
});

test('install is idempotent; updates replace only unchanged managed copies and keep backups', () => fixture(async root => {
  const dir = join(root, 'skills');
  assert.equal((await result('status', dir)).status, 'not-installed');
  assert.equal((await result('update', dir)).status, 'not-installed');
  assert.equal((await result('install', dir)).status, 'installed');
  assert.equal((await result('install', dir)).status, 'current');
  const marker = join(dir, 'edgeever/.edgeever-install.json');
  const installed = JSON.parse(await readFile(marker, 'utf8'));
  installed.version = '0.0.1'; await writeFile(marker, JSON.stringify(installed));
  assert.equal((await result('status', dir)).status, 'outdated');
  assert.equal((await result('install', dir)).status, 'outdated');
  const updated = await result('update', dir);
  assert.equal(updated.status, 'updated');
  assert.equal(JSON.parse(await readFile(join(updated.backup, '.edgeever-install.json'), 'utf8')).version, '0.0.1');
  assert.equal((await result('status', dir)).installedVersion, packageVersion);
}));

test('modified and added files survive refusal and forced update backup', () => fixture(async root => {
  const dir = join(root, 'skills'); await result('install', dir);
  const path = join(dir, 'edgeever/SKILL.md');
  const original = await readFile(path, 'utf8');
  await writeFile(path, 'my custom skill');
  await writeFile(join(dir, 'edgeever/custom.txt'), 'my extra file');
  assert.equal((await result('update', dir)).status, 'modified');
  assert.equal(await readFile(path, 'utf8'), 'my custom skill');
  const forced = await result('update', dir, '--force');
  assert.equal(forced.status, 'updated');
  assert.equal(await readFile(join(forced.backup, 'SKILL.md'), 'utf8'), 'my custom skill');
  assert.equal(await readFile(join(forced.backup, 'custom.txt'), 'utf8'), 'my extra file');
  assert.equal(await readFile(path, 'utf8'), original);
}));

test('unmanaged skills are preserved; invalid target/options never install elsewhere', () => fixture(async root => {
  const dir = join(root, 'skills'); await mkdir(join(dir, 'edgeever'), { recursive: true });
  await writeFile(join(dir, 'edgeever/SKILL.md'), 'existing skill');
  assert.equal((await result('install', dir)).status, 'unmanaged');
  assert.equal((await result('update', dir)).status, 'unmanaged');
  assert.equal(await readFile(join(dir, 'edgeever/SKILL.md'), 'utf8'), 'existing skill');
  await assert.rejects(manageSkills(['install', '--target', '../elsewhere']), /Unknown/);
  await assert.rejects(manageSkills(['install']), /Specify/);
  await assert.rejects(manageSkills(['install', '--target', 'codex', '--dir', dir]), /Choose/);
  assert.equal((await result('install', dir, '--force')).status, 'updated');
}));

test('symlinks and concurrent installer lock cannot overwrite existing files', { skip: process.platform === 'win32' }, () => fixture(async root => {
  const dir = join(root, 'skills'), outside = join(root, 'outside');
  await mkdir(dir); await mkdir(outside); await writeFile(join(outside, 'SKILL.md'), 'outside');
  await symlink(outside, join(dir, 'edgeever'));
  assert.equal((await result('install', dir, '--force')).status, 'blocked');
  assert.equal(await readFile(join(outside, 'SKILL.md'), 'utf8'), 'outside');
  await rm(join(dir, 'edgeever'));
  await mkdir(join(dir, '.edgeever-install.lock'));
  assert.equal((await result('install', dir)).status, 'error');
  assert.deepEqual(await readdir(dir), ['.edgeever-install.lock']);
}));

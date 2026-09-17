import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { encodeNote, decodeNote } from '../src/file-workspace/metadata.mjs';

const exec = promisify(execFile);
const packageRoot = fileURLToPath(new URL('../', import.meta.url));

test('packed CLI installs independently and supports profiles, HTTP, files and conflicts under Node', async () => {
  const root = await mkdtemp(join(tmpdir(), 'edgeever-npm-'));
  const env = { ...process.env, EDGEEVER_CONFIG: join(root, 'config.json'), CODEX_HOME: join(root, 'codex'), CLAUDE_CONFIG_DIR: join(root, 'claude'), KIMI_CODE_HOME: join(root, 'kimi') };
  delete env.EDGEEVER_URL; delete env.EDGEEVER_TOKEN;
  let server;
  try {
    const packed = JSON.parse((await exec('npm', ['pack', '--json', '--pack-destination', root], { cwd: packageRoot })).stdout)[0];
    const shipped = packed.files.map(f => f.path);
    for (const required of ['LICENSE', 'bin/edgeever.mjs', 'src/file-workspace/attachments.mjs', 'skills/edgeever/SKILL.md', 'skills/edgeever/agents/openai.yaml']) assert.ok(shipped.includes(required));
    assert.ok(shipped.every(p => !p.includes('node_modules') && !p.startsWith('test/') && !p.includes('config.json')));
    const prefix = join(root, 'installed');
    await exec('npm', ['install', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', join(root, packed.filename)]);
    const bin = join(prefix, 'node_modules', 'knowledge-workbench-edgeever-cli', 'bin', 'edgeever.mjs');
    const run = async (...args) => (await exec(process.execPath, [bin, ...args], { cwd: root, env })).stdout;
    assert.match(await run('--help'), /edgeever workspace sync/);
    assert.equal((await run('--version')).trim(), '0.6.0');
    const installedSkills = JSON.parse(await run('skill', 'install', '--target', 'all'));
    assert.deepEqual(installedSkills.results.map(r => r.status), ['installed', 'installed', 'installed']);
    assert.deepEqual(JSON.parse(await run('skill', 'status')).results.map(r => r.status), ['current', 'current', 'current']);
    const codexSkill = join(env.CODEX_HOME, 'skills/edgeever/SKILL.md');
    await writeFile(codexSkill, 'customized');
    await assert.rejects(run('skill', 'update', '--target', 'all'), e => e.code === 2 && JSON.parse(e.stdout).results[0].status === 'modified');
    assert.equal(await readFile(codexSkill, 'utf8'), 'customized');
    if (process.platform !== 'win32') {
      assert.match((await exec(join(prefix, 'node_modules/.bin/edgeever'), ['--help'], { env })).stdout, /EdgeEver CLI/);
    }
    let memo = { id: 'memo_test', notebookId: 'nb_test', title: '测试', contentMarkdown: '# Original\n', revision: 1, contentHash: 'server-hash' };
    const notebookRows = [{ id: 'nb_test', name: '测试笔记本', parentId: null }, { id: 'nb_other', name: '移动目标', parentId: null }];
    let capable = true;
    server = createServer(async (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      const reply = data => res.end(JSON.stringify(data));
      if (req.headers.authorization !== 'Bearer test-token') { res.statusCode = 401; return reply({ error: { message: 'Unauthorized' } }); }
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/api/v1/file-workspace') return reply({ protocolVersion: 1, atomicRevisionWrites: capable, attachmentSync: capable, workspaceId: 'ws_test' });
      if (url.pathname === '/api/v1/notebooks') {
        if(req.method === 'POST') {
          let text='';for await(const chunk of req)text+=chunk;
          const notebook={id:`nb_created_${notebookRows.length}`, ...JSON.parse(text)};
          notebookRows.push(notebook);return reply({notebook});
        }
        return reply({notebooks:notebookRows});
      }
      if (url.pathname === '/api/v1/memos') return reply({ memos: [memo], nextCursor: null });
      if (url.pathname.endsWith('/resources') && req.method === 'POST') {
        let body = ''; for await (const chunk of req) body += chunk;
        assert.match(req.headers['content-type'], /multipart\/form-data/);
        assert.match(body, /upload-content/);
        return reply({ resource: { id: 'res_test' } });
      }
      if (url.pathname === '/api/v1/memos/memo_test') return reply({ memo });
      res.statusCode = 404; reply({ error: { message: 'Not found' } });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    await run('profile', 'set', 'test', '--url', url, '--token', 'test-token');
    assert.ok(!(await run('profile', 'list')).includes('test-token'));
    if (process.platform !== 'win32') assert.equal((await stat(env.EDGEEVER_CONFIG)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await run('--profile', 'test', 'notebooks')).notebooks[0].id, 'nb_test');
    const createArgs=['--profile','test','create-notebook','--path','迭代/260924','--parent','nb_test','--parents'];
    assert.equal(JSON.parse(await run(...createArgs,'--dry-run')).status,'preview');
    assert.equal(notebookRows.length,2);
    const created=JSON.parse(await run(...createArgs));assert.equal(created.steps.length,2);
    assert.equal(JSON.parse(await run(...createArgs)).notebookId,created.notebookId);
    assert.equal(notebookRows.length,4);
    const upload = join(root, 'upload.txt'); await writeFile(upload, 'upload-content');
    assert.equal(JSON.parse(await run('--profile', 'test', 'upload', '--memo', memo.id, '--file', upload)).resource.id, 'res_test');
    const workspace = join(root, 'notes');
    await run('--profile', 'test', 'workspace', 'link', workspace, '--all');
    await run('--profile', 'test', 'workspace', 'sync', workspace, '--pull-only');
    const state = JSON.parse(await readFile(join(workspace, '.edgeever/state.json'), 'utf8'));
    const notePath = resolve(workspace, state.entries[memo.id].path);
    assert.equal(decodeNote(await readFile(notePath, 'utf8')).body, memo.contentMarkdown);
    await writeFile(notePath, encodeNote('# Local edit\n', memo.id));
    assert.equal(JSON.parse(await run('workspace', 'status', workspace))[0].status, 'modified');
    const dry = JSON.parse(await run('--profile', 'test', 'workspace', 'sync', workspace, '--dry-run'));
    assert.equal(dry.results[0].status, 'would-push');
    memo = { ...memo, revision: 2, contentMarkdown: '# Remote edit\n' };
    await assert.rejects(run('--profile', 'test', 'workspace', 'sync', workspace), e => e.code === 2 && JSON.parse(e.stdout).results[0].status === 'conflict');
    assert.equal(decodeNote(await readFile(notePath, 'utf8')).body, '# Local edit\n');
    const conflictList = JSON.parse(await run('workspace', 'conflicts', workspace));
    assert.equal(conflictList.length, 1);
    const draft = JSON.parse(await run('--profile', 'test', 'workspace', 'resolve', workspace, '--memo', memo.id, '--use', 'merge'));
    await assert.rejects(run('--profile', 'test', 'workspace', 'resolve', workspace, '--memo', memo.id, '--continue'), e => /markers/.test(e.stderr));
    await writeFile(join(workspace, draft.draft), 'Human merged\n');
    assert.equal(JSON.parse(await run('--profile', 'test', 'workspace', 'resolve', workspace, '--memo', memo.id, '--continue')).status, 'ready-to-push');
    assert.deepEqual(JSON.parse(await run('workspace', 'conflicts', workspace)), []);
    assert.equal(decodeNote(await readFile(notePath, 'utf8')).body, 'Human merged\n');
    await assert.rejects(run('--profile', 'test', 'workspace', 'resolve', workspace, '--memo', memo.id, '--interactive'), e => /terminal/.test(e.stderr));
    // Optional release check against the actual previously shipped package.
    if (process.env.EDGEEVER_PREVIOUS_TGZ) {
      const oldPrefix = join(root, 'previous');
      await exec('npm', ['install', '--prefix', oldPrefix, '--ignore-scripts', '--no-audit', '--no-fund', process.env.EDGEEVER_PREVIOUS_TGZ]);
      const oldBin = join(oldPrefix, 'node_modules/knowledge-workbench-edgeever-cli/bin/edgeever.mjs');
      const oldRun = async (...args) => (await exec(process.execPath, [oldBin, '--profile', 'test', 'workspace', ...args], { cwd: root, env })).stdout;
      const upgrade = join(root, 'upgrade');
      memo = { ...memo, contentMarkdown: 'first\n\nmiddle\n\nlast\n' };
      await oldRun('link', upgrade, '--all'); await oldRun('sync', upgrade, '--pull-only');
      const prior = JSON.parse(await readFile(join(upgrade, '.edgeever/state.json'), 'utf8')).entries[memo.id];
      await writeFile(join(upgrade, prior.path), encodeNote('LOCAL\n\nmiddle\n\nlast\n', memo.id));
      memo = { ...memo, revision: memo.revision + 1, contentMarkdown: 'first\n\nmiddle\n\nREMOTE\n' };
      await assert.rejects(oldRun('sync', upgrade, '--pull-only'), e => e.code === 2);
      const merged = JSON.parse(await run('--profile', 'test', 'workspace', 'sync', upgrade, '--pull-only', '--auto-merge')).results[0];
      assert.equal(merged.status, 'merged-local');
      assert.equal(decodeNote(await readFile(join(upgrade, prior.path), 'utf8')).body, 'LOCAL\n\nmiddle\n\nREMOTE\n');
      assert.equal(JSON.parse(await run('workspace', 'status', upgrade))[0].status, 'modified');
    }
    capable = false;
    await assert.rejects(run('--profile', 'test', 'workspace', 'link', join(root, 'unsupported'), '--all'), e => e.code === 1 && /Server lacks/.test(e.stderr));
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

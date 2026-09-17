import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { spawn } from 'node:child_process';
import { posix } from 'node:path';
import { conflicts, resolveConflict } from './core.mjs';
import { read, safePath } from './files.mjs';

export async function editDraft(root, draft, editor) {
  const path = await safePath(root, draft);
  const command = editor || (process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'notepad.exe' : 'vi');
  // --editor names one executable, never a shell expression from note content.
  const args = !editor && process.platform === 'darwin' ? ['-W', path] : [path];
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: false });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(Error(`Editor exited with ${code}`)));
  });
}
export async function interactiveResolve(root, client, id, editor) {
  if (!stdin.isTTY || !stdout.isTTY) throw Error('--interactive requires a terminal; use --use merge and --continue in scripts');
  const rl = createInterface({ input: stdin, output: stdout });
  let draft = (await conflicts(root)).find(c => c.id === id);
  try {
    for (;;) {
      stdout.write('\n1 查看三方内容 / Compare\n2 生成或刷新合并草稿 / Merge\n3 编辑草稿 / Edit\n4 保留本地全文 / Keep local\n5 采用云端全文 / Use remote\n6 确认草稿（不上传） / Continue\n7 跳过 / Skip\n');
      const answer = (await rl.question('选择 / Choose: ')).trim();
      try {
        if (answer === '7') return { id, status: 'skipped' };
        if (answer === '2' || (!draft && ['1', '3'].includes(answer))) {
          draft = await resolveConflict(root, client, id, 'merge');
          stdout.write(`Draft: ${await safePath(root, draft.draft)}\nOverlaps: ${draft.overlaps}; local binary changes: ${draft.binaryPending}\n`);
          if (answer === '2') continue;
        }
        if (answer === '1') {
          for (const name of ['base.md', 'local.md', 'remote.md']) stdout.write(`\n--- ${name} ---\n${await read(root, posix.join(posix.dirname(draft.draft), name))}\n`);
        } else if (answer === '3') await editDraft(root, draft.draft, editor);
        else if (answer === '4' || answer === '5') {
          const choice = answer === '4' ? 'local' : 'remote';
          if ((await rl.question(`采用 ${choice} 全文并替代另一方的修改？输入 yes / Replace other side with ${choice}? yes: `)).trim() === 'yes') return await resolveConflict(root, client, id, choice);
        } else if (answer === '6') return await resolveConflict(root, client, id, 'continue');
      } catch (error) { stdout.write(`未完成 / Not resolved: ${error.message}\n`); }
    }
  } finally { rl.close(); }
}

import { diff3Merge } from 'node-diff3';

export const hasConflictMarkers = text => /^(?:<{7}|>{7}|\|{7})(?:\s|$)|^={7}\s*$/m.test(text);
const lines = text => text.match(/[^\n]*\n|[^\n]+$/g) || [];
const section = text => text && !text.endsWith('\n') ? text + '\n' : text;
export function mergeText(base, local, remote) {
  let content = '', conflicts = 0;
  for (const block of diff3Merge(lines(local), lines(base), lines(remote), { excludeFalseConflicts: true })) {
    if (block.ok) content += block.ok.join('');
    else {
      conflicts++;
      content = section(content) + '<<<<<<< LOCAL\n' + section(block.conflict.a.join('')) +
        '||||||| BASE\n' + section(block.conflict.o.join('')) + '=======\n' +
        section(block.conflict.b.join('')) + '>>>>>>> REMOTE\n';
    }
  }
  return { content, conflicts };
}

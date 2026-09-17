import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeNote, decodeNote } from '../src/file-workspace/metadata.mjs';

test('managed metadata leaves original Markdown/YAML bytes unchanged on upload', () => {
  for (const body of ['# Plain\n', '---\ntitle: "hello" # user comment\nlabels: [a, b]\ntext: |\n  multi\n  line\n---\n# Body\n', '---\r\ntitle: 中文\r\n---\r\nbody\r\n', '---\n---\nempty YAML', '\uFEFF---\na: 1\n...\nbody']) {
    const local = encodeNote(body, 'memo_123');
    assert.deepEqual(decodeNote(local), { id: 'memo_123', body });
  }
});

test('malformed or ambiguous identity and reserved user metadata stop instead of guessing', () => {
  for (const local of ['---\nedgeever:\n  memo_id: [one,two]\n---\nbody', '---\nedgeever:\n  memo_id: memo_a\nedgeever:\n  memo_id: memo_b\n---\nbody', '---\nedgeever:\n  memo_id: ../path\n---\nbody']) assert.throws(() => decodeNote(local));
  assert.throws(() => encodeNote('---\nedgeever: user-owned\n---\nbody', 'memo_a'), /reserved/);
  assert.equal(decodeNote('# Plain untracked').id, null);
});

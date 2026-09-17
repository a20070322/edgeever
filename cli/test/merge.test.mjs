import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeText, hasConflictMarkers } from '../src/file-workspace/merge.mjs';

test('line merging preserves whitespace, CRLF and missing final newline', () => {
  const base='alpha\r\nkeep  \r\nomega';
  assert.deepEqual(mergeText(base, 'LOCAL\r\nkeep  \r\nomega', 'alpha\r\nkeep  \r\nREMOTE'), { content:'LOCAL\r\nkeep  \r\nREMOTE', conflicts:0 });
  assert.deepEqual(mergeText('x','same','same'),{content:'same',conflicts:0});
  assert.deepEqual(mergeText('','new\n',''),{content:'new\n',conflicts:0});
});
test('overlapping changes expose all three sides and unresolved markers', () => {
  const result=mergeText('Friday','Saturday','Sunday');
  assert.equal(result.conflicts,1);
  for(const word of ['Friday','Saturday','Sunday']) assert.ok(result.content.includes(word));
  assert.ok(hasConflictMarkers(result.content));
  assert.ok(!hasConflictMarkers('Saturday morning\n'));
});

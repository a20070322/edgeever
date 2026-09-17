import { parseDocument, isMap, isScalar } from 'yaml';

function frontMatter(text) {
  const opening = /^(?:\uFEFF)?---[ \t]*\r?\n/.exec(text);
  if (!opening) return null;
  const rest = text.slice(opening[0].length);
  const closing = /^(?:---|\.\.\.)[ \t]*\r?(?:\n|$)/m.exec(rest);
  if (!closing) return null;
  const yaml = rest.slice(0, closing.index);
  const doc = parseDocument(yaml, { uniqueKeys: true, strict: true });
  if (doc.errors.length) throw Error(`Invalid YAML front matter: ${doc.errors[0].message}`);
  if (doc.contents && (!isMap(doc.contents) || doc.contents.flow)) throw Error('Front matter must be a block YAML mapping');
  return { opening: opening[0], yaml, closing: closing[0], tail: rest.slice(closing.index + closing[0].length), doc };
}

export function decodeNote(text) {
  const fm = frontMatter(text);
  const pair = fm?.doc.contents?.items.find(item => isScalar(item.key) && item.key.value === 'edgeever');
  if (!pair) return { id: null, body: text };
  const node = pair.value;
  if (!isMap(node) || node.flow || node.items.some(p => !['memo_id', 'preserve_front_matter'].includes(p.key?.value))) throw Error('Invalid edgeever metadata');
  const id = node.get('memo_id');
  if (typeof id !== 'string' || !/^[\w-]+$/.test(id)) throw Error('Invalid edgeever.memo_id');
  const preserve = node.get('preserve_front_matter');
  if (preserve !== undefined && typeof preserve !== 'boolean') throw Error('Invalid preserve_front_matter flag');
  const start = pair.key.range[0];
  // Metadata is a top-level block; remove its full lines, preserving all other YAML bytes.
  const lineStart = fm.yaml.lastIndexOf('\n', start - 1) + 1;
  const end = node.range[2];
  const remaining = fm.yaml.slice(0, lineStart) + fm.yaml.slice(end);
  return { id, body: preserve || remaining.trim() ? fm.opening + remaining + fm.closing + fm.tail : fm.tail };
}

export function encodeNote(body, id) {
  if (!/^[\w-]+$/.test(id)) throw Error('Invalid memo ID');
  const fm = frontMatter(body);
  if (fm?.doc.contents?.items.some(item => item.key?.value === 'edgeever')) throw Error('The edgeever front-matter key is reserved; rename the remote/user key before syncing');
  const newline = fm?.opening.endsWith('\r\n') ? '\r\n' : '\n';
  const metadata = `edgeever:${newline}  memo_id: ${id}${newline}${fm ? `  preserve_front_matter: true${newline}` : ''}`;
  return fm ? fm.opening + metadata + fm.yaml + fm.closing + fm.tail : `---\n${metadata}---\n${body}`;
}

# CLI Markdown file workspace (notes and attachments)

For standalone Node.js/npm installation, see the [CLI README](../cli/README.md). After installation, replace `bun scripts/edgeever.mjs` below with `edgeever`; the legacy script entry remains compatible.

Chinese: [本地工作目录](file-workspace.zh-CN.md).

Expose selected existing notes as real Markdown files for Codex, Claude Code and editors. The database remains authoritative; Git is not required. This client uses the server API, not desktop SQLite, so unsynced desktop changes are not visible.

## Usage

The standalone npm package requires Node.js 22+; repository scripts can also use Bun. Synchronization requires the updated server. Reuse CLI profiles or EDGEEVER_URL / EDGEEVER_TOKEN. Minimum token scopes: read:notebooks, read:memos, write:memos, read:resources, write:resources. Keep credentials outside the workspace and source control.

```bash
export EDGEEVER_URL=http://127.0.0.1:8787
# Supply EDGEEVER_TOKEN securely, or use --profile.
bun scripts/edgeever.mjs notebooks
bun scripts/edgeever.mjs workspace link ./notes --notebooks nb_a,nb_b --exclude nb_private
bun scripts/edgeever.mjs workspace sync ./notes
bun scripts/edgeever.mjs workspace status ./notes
# Edit existing Markdown files, then:
bun scripts/edgeever.mjs workspace sync ./notes --dry-run
bun scripts/edgeever.mjs workspace sync ./notes
```

Use --all for the entire workspace; --shallow disables recursive inclusion. Exclusions always include descendants and win over inclusions. Relink with --replace-scope to change selection while retaining files and baselines. --pull-only never uploads local edits. Stable ID digests distinguish duplicate names. Existing paths remain stable after remote renames; local renaming does not rename a remote note. Status works offline without credentials. Server URL and workspace identity must match.

## Conflicts and recovery

.edgeever/state.json stores IDs, paths, revisions, hashes and baseline text, not tokens. Do not edit it manually. Conflicts retain local text and write the remote copy under .edgeever/conflicts. Replaced files are retained under .edgeever/history; this data may also be sensitive.

```bash
# Adopt remote content, retaining prior local text; can restore a missing file.
bun scripts/edgeever.mjs workspace resolve ./notes --memo memo_id --use remote
# Review/merge the local file first, then explicitly rebase it on current remote:
bun scripts/edgeever.mjs workspace resolve ./notes --memo memo_id --use local
bun scripts/edgeever.mjs workspace sync ./notes
```

Choosing local explicitly authorizes the current local text for the next push and may replace remote edits; review it first. Resolve never pushes. Subsequent sync still checks revision. After a crash, verify the process has exited before removing .edgeever/lock. Avoid editing the same file during sync: detection and retained history mitigate races but are not OS-level editor locks.

Exit codes: 0 success, 1 failure, 2 sync needs attention (conflict, missing file, occupied path). Synchronization is per-note, not an atomic transaction over the whole folder; completed progress survives a later failure.

## Initial limits

- Existing note bodies only. New files are untracked, never automatically imported.
- Local deletion, narrower selection and remote scope removal never propagate deletion.
- Metadata remains managed through existing API/CLI tools; front matter is not treated as business commands.
- Diagram notes can be pulled but not pushed as plain text; use diagram tools.
- Standard Markdown images, attachment links and reference definitions are mapped both ways; code is untouched. Embedded HTML resources, inter-note Markdown links and external websites are not mirrored.
- Paginates selected notebooks and reads details; no persisted delta cursor or large-library performance claim.
- Manual sync only: no background watcher, desktop UI, OS mount or automatic three-way merge.
- Existing Markdown/rich-text conversion rules apply. Long plain-text testing does not establish lossless round trips for every extension node.

## Server and validation

GET /api/v1/file-workspace reports identity and atomic revision support. Older servers without the capability are rejected. Writes use existing edit sessions and PATCH. An initial guarded statement in the atomic batch uses the existing revision >= 0 CHECK constraint to reject stale reads and roll back snapshots, metadata, content, indexes and audit together. No migration is added. Rolling the server back makes this CLI refuse synchronization.

Run bun test scripts/file-workspace/core.test.mjs. Tests use temporary folders, real Hono routes, the SQLite adapter and all existing migrations, covering selection, long notes, conflicts, retries, path safety and concurrent transactions. Windows filesystem and deployed Cloudflare compatibility remain unverified. Full-repository typecheck currently encounters unrelated missing extension/site dependencies; distinguish it from the focused API typecheck.


## Attachments and upgrade

Referenced server resources are downloaded to attachments/<resource-ID>/<hash>-filename and projected as relative Markdown URLs. Downloads require authentication and verify SHA-256 and size. Tokens never follow redirects or go to external URLs. Local paths must remain inside the workspace; symlinks and file:// are rejected. Maximum file size is 100 MiB; this is not multipart or streaming-to-disk support.

Add an image/PDF and a standard local Markdown link. Sync uploads it, substitutes /api/v1/resources/<ID>/blob in the submitted text, and retains the local relative link. Binary edits create new resources. Removing a file/reference never deletes remote resources. A referenced missing local file blocks pushing and appears as attachment-error in status. Only resources referenced by the note are downloaded, not orphan resources.

State migrates to v2 with a .edgeever/state-v1.backup.json backup. Local hash/base and serverHash/serverBase are separate. Resource path/ID/SHA mappings and upload receipts are retained. Do not run the old CLI against an upgraded folder. Before rollback preserve new edits and the entire .edgeever directory, then restore the pre-upgrade workspace snapshot.

Uploads are journaled before the request; receipts persist before saving the note. Retrying a failed note save reuses the receipt. A lost upload response is reconciled against that memo's resources by filename, SHA and size. If the outcome remains uncertain, synchronization stops rather than blindly re-uploading. Wait for the original request to finish, then retry; do not edit the journal or force another upload while uncertain. Unreferenced uploaded resources are retained, not automatically garbage-collected.

--dry-run performs no uploads/downloads and does not update note files or baselines. --pull-only never uploads local files but downloads referenced remote resources. Binary edits concurrent with remote note edits enter the note conflict flow. Servers must advertise attachmentSync in /file-workspace; upgrade the local service first.


Only after verifying the original upload has finished without a matching server resource, run workspace uploads <directory>, then workspace retry-upload <directory> --key <key> and sync. The original journal is retained. Authorizing retry while the original request is running can leave duplicate resources; this is not the normal retry path.

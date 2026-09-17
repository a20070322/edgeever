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

Use --all for the entire workspace; --shallow disables recursive inclusion. Exclusions always include descendants and win over inclusions. Relink with --replace-scope to change selection while retaining files and baselines. --pull-only never uploads local edits. Readable filenames use numbered suffixes on collision; note identity lives in YAML front matter. Existing paths remain stable after remote renames; local renaming does not rename a remote note. Status works offline without credentials. Server URL and workspace identity must match.

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

- New files are untracked until explicitly imported with `workspace import`; sync never automatically creates notes.
- Local deletion, narrower selection and remote scope removal never propagate deletion.
- Only the reserved `edgeever` front-matter mapping identifies notes. Other front matter is preserved as content, not interpreted as business commands.
- Diagram notes can be pulled but not pushed as plain text; use diagram tools.
- Standard Markdown images, attachment links and reference definitions are mapped both ways; code is untouched. Embedded HTML resources, inter-note Markdown links and external websites are not mirrored.
- Paginates selected notebooks and reads details; no persisted delta cursor or large-library performance claim.
- Manual sync only: no background watcher, desktop UI or OS mount. Opt-in text merging is available through --auto-merge.
- Existing Markdown/rich-text conversion rules apply. Long plain-text testing does not establish lossless round trips for every extension node.

## Server and validation

GET /api/v1/file-workspace reports identity and atomic revision support. Older servers without the capability are rejected. Writes use existing edit sessions and PATCH. An initial guarded statement in the atomic batch uses the existing revision >= 0 CHECK constraint to reject stale reads and roll back snapshots, metadata, content, indexes and audit together. No migration is added. Rolling the server back makes this CLI refuse synchronization.

Run `npm ci --prefix cli`, then `bun test scripts/file-workspace/core.test.mjs`. Tests use temporary folders, real Hono routes, the SQLite adapter and all existing migrations, covering selection, long notes, conflicts, retries, path safety and concurrent transactions. Windows filesystem and deployed Cloudflare compatibility remain unverified. Full-repository typecheck currently encounters unrelated missing extension/site dependencies; distinguish it from the focused API typecheck.


## Attachments and upgrade

Referenced server resources are downloaded to attachments/<resource-ID>/<hash>-filename and projected as relative Markdown URLs. Downloads require authentication and verify SHA-256 and size. Tokens never follow redirects or go to external URLs. Local paths must remain inside the workspace; symlinks and file:// are rejected. Maximum file size is 100 MiB; this is not multipart or streaming-to-disk support.

Add an image/PDF and a standard local Markdown link. Sync uploads it, substitutes /api/v1/resources/<ID>/blob in the submitted text, and retains the local relative link. Binary edits create new resources. Removing a file/reference never deletes remote resources. A referenced missing local file blocks pushing and appears as attachment-error in status. Only resources referenced by the note are downloaded, not orphan resources.

State v1/v2 requires explicit migration to v3 as described below. Local hash/base and serverHash/serverBase are separate. Resource path/ID/SHA mappings and upload receipts are retained. Do not run the old CLI against an upgraded folder. Before rollback preserve new edits and the entire .edgeever directory, then restore the pre-upgrade workspace snapshot.

Uploads are journaled before the request; receipts persist before saving the note. Retrying a failed note save reuses the receipt. A lost upload response is reconciled against that memo's resources by filename, SHA and size. If the outcome remains uncertain, synchronization stops rather than blindly re-uploading. Wait for the original request to finish, then retry; do not edit the journal or force another upload while uncertain. Unreferenced uploaded resources are retained, not automatically garbage-collected.

--dry-run performs no uploads/downloads and does not update note files or baselines. --pull-only never uploads local files but downloads referenced remote resources. Binary edits concurrent with remote note edits enter the note conflict flow. Servers must advertise attachmentSync in /file-workspace; upgrade the local service first.


Only after verifying the original upload has finished without a matching server resource, run workspace uploads <directory>, then workspace retry-upload <directory> --key <key> and sync. The original journal is retained. Authorizing retry while the original request is running can leave duplicate resources; this is not the normal retry path.

## CLI 0.3: document identity and migration

This release requires only a CLI upgrade when the server already supports file-workspace and attachments. Each tracked file contains:

```yaml
---
edgeever:
  memo_id: memo_example
---
```

Keep this ID when renaming or moving a file within its workspace. Sync follows the ID and repairs missing relative binary attachment links using the previous path; it does not move the remote note between notebooks. Inter-note Markdown links are not rewritten. Duplicate, changed, missing or unknown IDs block the affected notes. The state file still binds the server/workspace and stores conflict baselines; front matter alone cannot bind an arbitrary copied note. Managed metadata is stripped before upload. Existing user front matter is retained, with a managed `preserve_front_matter` flag when needed.

Upgrade an existing folder explicitly:

```bash
edgeever workspace migrate ./notes --dry-run
edgeever workspace migrate ./notes
```

Migration preserves edits, replaces legacy hash-suffixed paths with collision-safe readable paths, and backs up the original state and tracked file bytes under `.edgeever/migrations/v3-<id>/`. It does not write to the server. If interrupted, rerun migrate; changed files block recovery instead of being overwritten. Do not use the old CLI on v3 folders. To roll back, preserve current edits and restore the original files and state from the backup into their original paths, removing generated replacement files only after checking them.

Import a new text note explicitly into a notebook within the linked scope:

```bash
edgeever workspace import ./notes --file new-note.md --notebook nb_example
```

The filename is retained; the default title is its basename. Import text first, then add local attachments and sync. If creation succeeds but its response is lost, inspect the notebook and confirm the created note's ID; use the same import command with `--memo memo_confirmed`. It verifies notebook and content before binding. Do not blindly create again; an uncertain request may already have created the note.

## Remote notebook moves (0.3.1)

Sync now relocates tracked notes between CLI-managed directories when their remote notebook changes, including folders left stale by 0.3.0. Use `workspace sync <directory> --dry-run --pull-only` to preview, then `workspace sync <directory> --pull-only` to apply without uploading content. Do not delete local files or relink: `--replace-scope` retains existing bindings and cannot reset their paths.

Local edits and conflict baselines survive relocation; attachment links are rebased, and occupied filenames receive a numbered suffix. Explicit local moves observed by this version and newly imported paths remain local overrides. Older overrides inside managed directories cannot always be distinguished. This fix handles notes moving between notebooks; renaming or reparenting the notebook itself is not covered.

Original bytes are retained in `.edgeever/history/moves/`. A pending `.edgeever/pending-move.json` is resumed by the next sync before scanning IDs. If source/destination changed, recovery stops and preserves the journal and backup; inspect them before recovery, and do not delete state or retry with an older CLI. If rolling back the CLI, first complete recovery and back up the full folder. Windows filesystem behavior remains unverified.

## Automatic and human conflict resolution (0.4.0)

```bash
edgeever --profile cloud workspace sync ./notes --auto-merge --dry-run
edgeever --profile cloud workspace sync ./notes --auto-merge
edgeever workspace conflicts ./notes
# Human terminal menu (compare, draft, editor, choose a side, confirm or skip):
edgeever --profile cloud workspace resolve ./notes --memo MEMO_ID --interactive
# Script/editor workflow:
edgeever --profile cloud workspace resolve ./notes --memo MEMO_ID --use merge
# Edit the returned draft path, remove conflict markers, then:
edgeever --profile cloud workspace resolve ./notes --memo MEMO_ID --continue
edgeever --profile cloud workspace sync ./notes
```

`--auto-merge` opts into deterministic, line-based three-way merging using the last baseline, current local text and latest remote text. Non-overlapping/identical changes merge; conflicting changes stay pending. `--dry-run` does not modify files or baselines. `--pull-only --auto-merge` saves a successful local merge without uploading. New/modified local binaries require explicit human resolution; binary bytes are not merged. Diagrams remain read-only.

Each text conflict saves base/local/remote snapshots and a plain-body `merge.md` under `.edgeever/conflicts/`. Repeated sync preserves that draft and blocks the affected note until resolved. Relative attachment links in the draft are interpreted relative to the tracked note, not the draft directory; keep those links or use the supplied remote variant when selecting an attachment. Remove `<<<<<<< LOCAL`, `||||||| BASE`, `=======`, `>>>>>>> REMOTE` markers and unwanted alternatives. Do not copy managed `edgeever` metadata into the draft. `resolve --continue` checks the original local file/attachment fingerprint and remote revision/content/notebook before installing the result; it does not upload. If inputs changed, run `--use merge` to create a fresh draft; earlier drafts remain available to copy your work from. Sync checks the remote version again at upload.

`--use merge --edit [--editor <executable>]` opens the draft; the interactive menu can also open it. The editor option is one executable path/name, not a shell command with arguments. Defaults: macOS `open -W`, Windows Notepad, other platforms `vi`. Close the editor to return. The menu requires a TTY. The compare option shows all three snapshots. `--use local|remote` explicitly chooses an entire side and clears the pending conflict; choosing local can discard remote edits on the next sync. Resolve and sync reject unresolved marker lines (including literal marker examples, which must be indented or removed before syncing).

Missing local files can be restored individually with `resolve --memo ID --use remote` after reviewing backups, then synced. Do not delete `.edgeever/state.json` or tracked files to reset paths. `link --replace-scope` intentionally preserves bindings and baselines. A `(2)` directory can reflect any occupied local path, including an old empty directory; it does not prove duplicate remote notebooks. 0.3.1+ follows notes moved between notebooks, but notebook renaming/reparenting remains outside this fix. This release adds no server changes. Preserve the workspace and `.edgeever` before rollback, and complete pending resolutions using this version: older clients do not honor its active conflict records.

## Deleted notebook directories (0.6.0)

After sync, the CLI checks managed directory IDs against the full workspace notebook list, rechecking before cleanup. A deleted notebook's empty local directory is removed with an empty-directory-only operation, deepest first. Live notebooks, excluded/out-of-scope notebooks and unmanaged directories are retained. Files (including hidden files) prevent removal and produce `directory-retained-not-empty`; no recursive deletion occurs. Local Markdown and note baselines remain protected by the existing retention rules. A directly linked notebook that disappeared produces `scope-notebook-missing` instead of aborting the whole sync. `--dry-run` reports `would-remove-directory` and accounts for planned note moves; it writes no files or mappings. `--pull-only` also performs empty-directory cleanup. This does not implement notebook rename/reparent mirroring or deleting nonempty local folders.

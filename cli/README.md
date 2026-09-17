# EdgeEver CLI for Knowledge Workbench

Standalone Node.js CLI extracted from the customized EdgeEver checkout. It uses the same implementation as the repository's legacy scripts. Requires Node.js 22 or newer; Bun, the server source tree and a build step are not required to run the installed package.

## Install locally (not published to npm)

From this directory:

```sh
npm ci
npm test
npm pack --pack-destination /tmp
npm install -g /tmp/knowledge-workbench-edgeever-cli-0.6.0.tgz
edgeever --help
```

The `/tmp` examples are for macOS/Linux. On Windows use an existing temporary directory. The package name is provisional; no npm name ownership or publication is claimed. `npm install -g knowledge-workbench-edgeever-cli` and registry-based `npx` require a separate publication first.

## Configure and use

```sh
edgeever profile set cloud --url https://your.edgeever.host --token 'YOUR_NEW_TOKEN'
edgeever --profile cloud notebooks
edgeever --profile cloud search 'meeting'
edgeever --profile cloud get memo_id
edgeever --profile cloud update memo_id --body-file ./note.md
edgeever --profile cloud workspace link ./notes --notebooks nb_id
edgeever --profile cloud workspace sync ./notes --pull-only
edgeever workspace status ./notes
# After editing local files, review before uploading:
edgeever --profile cloud workspace sync ./notes --dry-run
edgeever --profile cloud workspace sync ./notes
```

Use the instance base URL, without `/mcp`. Profiles live in `~/.edgeever/config.json`; `EDGEEVER_CONFIG` overrides that path. Existing profiles remain compatible. `EDGEEVER_URL` and `EDGEEVER_TOKEN` override the selected profile. Keep credentials outside repositories; entering a literal token in a terminal can leave it in shell history. Profiles use owner-only permissions on creation on POSIX systems.

Basic commands use the existing REST API. Workspace synchronization requires our server-side `/api/v1/file-workspace` capability with atomic revision writes and attachment synchronization; a stock official image is not assumed to provide it. Required sync scopes: `read:notebooks`, `read:memos`, `write:memos`, `read:resources`, `write:resources`.

Use a different local directory for each server/workspace. Local new Markdown files require explicit `workspace import`; deletions are not propagated; synchronization is manual. Exit codes: 0 success, 1 error, 2 reported synchronization conflicts. Run `edgeever --help` for all commands.

## Development and verification

This directory is an independent npm package, deliberately outside the Bun workspace globs, so extracting the CLI does not change the server Docker build. `bin/edgeever.mjs` launches `src/cli.mjs`; `src/file-workspace/` owns the synchronization core. The old `scripts/edgeever.mjs` and `scripts/file-workspace/*.mjs` forward to this package.

`npm test` packs a tarball, installs it into a fresh temporary directory, and exercises the installed CLI against a local HTTP fixture: profile persistence, authentication, multipart upload, Markdown pull, dry run, conflict preservation and unsupported-server rejection. It needs npm registry/cache access to install dependencies. It does not replace real server integration tests or Windows testing. Existing Bun/Hono/SQLite integration tests remain at `scripts/file-workspace/core.test.mjs` in the parent repository.

AGPL-3.0-only. Original EdgeEver license and copyright notices are retained in LICENSE.

## Bundled agent skill

Version 0.2.0 bundles `skills/edgeever/` with the same CLI version. Installation does not read or copy tokens and does not contact your EdgeEver instance. npm install/update has no postinstall hook; install skills explicitly:

```sh
edgeever skill install --target all
edgeever skill status
# After upgrading the CLI using a newer .tgz or a published npm version:
edgeever skill update --target all
# Or select just one tool:
edgeever skill install --target kimi
# Other tools that support SKILL.md: provide their skills parent directory.
edgeever skill install --dir /absolute/path/to/tool/skills
```

| Target | Default user skill directory | Override |
| --- | --- | --- |
| `codex` | `~/.codex/skills/edgeever` | `$CODEX_HOME/skills/edgeever` |
| `claude` | `~/.claude/skills/edgeever` | `$CLAUDE_CONFIG_DIR/skills/edgeever` |
| `kimi` | `~/.kimi-code/skills/edgeever` | `$KIMI_CODE_HOME/skills/edgeever` |

`all` means exactly these three targets, including tools not yet installed. `--dir` and `--target` are mutually exclusive. For newer Codex/shared-agent setups that use `~/.agents/skills`, pass that directory with `--dir`; avoid duplicate copies in both paths. Codex's legacy user directory follows the bundled skill installer convention. Kimi and Claude paths follow their [Kimi](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/skills.html) and [Claude Code](https://code.claude.com/docs/en/skills) documentation. Start a new agent session to load the skill; copying files does not prove a running session has loaded it.

`status` compares file hashes and CLI versions. `install` preserves existing installations; use `update` for an older managed copy. `update` does not install missing copies. Modified or unmanaged copies are preserved with exit code 2. Review them before using `--force` with install/update: it moves the old directory to `.edgeever-skill-backups/` alongside the skills parent directory, reports its backup path, then installs the bundled skill. Links at the destination or within a managed copy are blocked even with `--force`. Normal updates also retain a backup. Do not place backups in an agent's scanned skill directory.

Skill updates use the installed CLI's bundled files, never fetch a new CLI version. The package has not been published to npm. Additional tests cover version upgrades, local modifications, unmanaged copies, backup preservation, directory selection and installer locks; the packed-package test installs all three targets into isolated temporary data roots.


## Document IDs and readable paths (0.3.0)

Tracked Markdown contains a YAML header:

```markdown
---
edgeever:
  memo_id: memo_example
---
# Note body
```

Only the managed metadata is stripped before upload. Existing user front matter is retained; `preserve_front_matter: true` may appear inside `edgeever` to preserve an original header. The `edgeever` key is reserved. New local paths use readable names; collisions are disambiguated with ` (2)` etc. IDs, not filenames, determine note identity. Renaming/moving a file within the linked workspace updates its local mapping, not remote titles/notebooks. Missing or duplicate IDs and malformed/unbound metadata are reported without guessing or overwriting notes. Moving a note repairs missing relative binary attachment links; Markdown links to other notes are not automatically rewritten.

Before using an old v1/v2 workspace:

```sh
edgeever --profile cloud workspace migrate /path/to/notes --dry-run
edgeever --profile cloud workspace migrate /path/to/notes
edgeever --profile cloud workspace sync /path/to/notes --dry-run
```

Migration verifies instance identity but makes no server writes. Original files and state are backed up under `.edgeever/migrations/`; local edits, remote revision and content baselines are retained. Existing untracked files are not overwritten. Interrupted migrations resume with the same command, using the saved journal. Changed destinations cause a stop and preserve both copies. Keep the workspace idle while migrating. To roll back, retain the current workspace, restore backed-up original files at the paths in the backed-up state, and restore that state; do not run an older CLI on v3 state. Binary resources and upload journals remain in the workspace.

To create a note from a local file while retaining its filename:

```sh
edgeever --profile cloud workspace import /path/to/notes --file 260924.md --notebook nb_id --title 'Iteration 260924'
```

Import creates the note and binds that same file. The selected notebook must be in scope. New local attachments must be added after import; existing server references or known resource mappings are allowed. A create request with an uncertain outcome is not automatically retried. Find the confirmed server note, then repeat import with `--memo memo_id`; the CLI checks full content and notebook before binding. If the server did not create a note but the outcome remains uncertain, stop and inspect the import journal rather than clearing it or blindly creating again. An interrupted saved receipt can be resumed by repeating import. New files without IDs otherwise remain untracked.

No server upgrade is required for 0.3.0 when the existing file-workspace capabilities are available. This version does not add background watching or deletion propagation. Run `npm ci --prefix cli` before the repository's Bun integration tests, because the CLI now owns its YAML dependency.

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

## Create notebooks (0.5.0)

```bash
edgeever --profile cloud create-notebook --name "260924" --parent NOTEBOOK_ID
edgeever --profile cloud create-notebook --path "Development/260924" --parent NOTEBOOK_ID --parents --dry-run
edgeever --profile cloud create-notebook --path "Development/260924" --parent NOTEBOOK_ID --parents
```

Requires `read:notebooks` and `write:notebooks` for creation. Without `--parent`, start at the workspace root. `--name` creates/reuses one literal name; `--path` splits on `/`. `--parents` creates missing ancestors; without it ancestors must already exist. Names are trimmed, 1–80 characters; empty/dot/control-character path segments are rejected. Matching is exact and case-sensitive within a parent. A unique existing match is reused; duplicate matches stop without guessing. Output includes each created/reused step and the final `notebookId`, suitable for `workspace import`. Dry-run makes no server changes (a temporary local operation lock is used).

Creation is sequential, not a server transaction. Failures report completed steps, leaving created notebooks intact. Journals and per-server locks live in `notebook-operations/` beside the CLI config, without credentials. After a lost response, rerun only to reconcile a visible unique match; if the result is still absent, the command stops as `uncertain` (exit 2). Only after verifying the original request has finished without creating a notebook, explicitly pass `--retry-uncertain`; its previous journal is retained. Separate machines/clients can still create duplicates concurrently: this is client-side reuse, not a server uniqueness guarantee. This command does not import local files or change workspace selection.

## Deleted notebook directories (0.6.0)

After sync, the CLI checks managed directory IDs against the full workspace notebook list, rechecking before cleanup. A deleted notebook's empty local directory is removed with an empty-directory-only operation, deepest first. Live notebooks, excluded/out-of-scope notebooks and unmanaged directories are retained. Files (including hidden files) prevent removal and produce `directory-retained-not-empty`; no recursive deletion occurs. Local Markdown and note baselines remain protected by the existing retention rules. A directly linked notebook that disappeared produces `scope-notebook-missing` instead of aborting the whole sync. `--dry-run` reports `would-remove-directory` and accounts for planned note moves; it writes no files or mappings. `--pull-only` also performs empty-directory cleanup. This does not implement notebook rename/reparent mirroring or deleting nonempty local folders.

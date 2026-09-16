# EdgeEver CLI for Knowledge Workbench

Standalone Node.js CLI extracted from the customized EdgeEver checkout. It uses the same implementation as the repository's legacy scripts. Requires Node.js 22 or newer; Bun, the server source tree and a build step are not required to run the installed package.

## Install locally (not published to npm)

From this directory:

```sh
npm ci
npm test
npm pack --pack-destination /tmp
npm install -g /tmp/knowledge-workbench-edgeever-cli-0.2.0.tgz
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

Use a different local directory for each server/workspace. Local new Markdown files are not automatically imported; deletions are not propagated; synchronization is manual. Exit codes: 0 success, 1 error, 2 reported synchronization conflicts. Run `edgeever --help` for all commands.

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

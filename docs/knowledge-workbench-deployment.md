# Knowledge Workbench deployment

This fork layers the file-workspace API, atomic note revision checks, attachment metadata endpoints and the standalone Node CLI on upstream EdgeEver 1.74.0 (`3c79414d8094f2cfde9c084a4f48a1d67bec86d6`). It does not add database migrations. The CLI package retains its independent version.

Run the manual **Build Knowledge Workbench image** workflow in `a20070322/edgeever`. It checks API types, affected integration tests and the npm package, then builds the Web/API container for Linux amd64. Images use `ghcr.io/a20070322/edgeever:kw-<full-commit-sha>`. The workflow also exports a checksum-protected Docker archive for hosts without registry access. No npm or upstream desktop/mobile Release is published by this workflow.

The upstream auto-sync job is excluded from this fork to prevent unattended replacement of custom code. Upstream upgrades must be reviewed and tested before advancing main. The 1.74.0 reachability probe at `/api/openapi.json` is retained; extension API documentation is in `file-workspace.openapi.json`.

Before deployment, back up the full production `/data` volume and Compose configuration outside the repository. Validate the new image against an isolated copy of the previous instance, including existing data readability and file-workspace pull/push/conflicts/attachments. Change only the production service image after validation. Keep the old image and backup available. A failed upgrade should restore the previous image; restore the data backup if a future version changes database state incompatibly. Never run two server instances against the same SQLite volume.

Runtime credentials, databases, note content and backup archives must not enter Git or public build artifacts. This fork's source remains under the upstream AGPL license.

## Verified deployment — 2026-09-16

- Fork: https://github.com/a20070322/edgeever
- Runtime commit: `a98478bcbb6ba75566471c54b2e297bafc04574a`.
- Successful build: https://github.com/a20070322/edgeever/actions/runs/35068407923
- Registry digest: `sha256:cc959d36d443e49e67bd3357fb21a3b220940a242b5b51875ea5462e334a6993`.
- Exported image archive SHA-256: `ce10531893f2a9053f8870cdaaaa8feb2bbc1b7510220bc9d834f5c3f7e9f678`.
- API typecheck, 60 affected tests, standalone npm tests and Linux amd64 container build passed.
- An isolated copy of the previous production instance passed existing-note reads, CLI link/pull/push, PDF upload/download with matching hash, and conflict preservation.
- Production retained migration `0048` and the same note/resource fingerprint. The authenticated capability endpoint returned 200 and a read-only CLI pull succeeded.
- The validation container and copied business data/temporary credentials were removed. Full cold backup, old image and the verified image archive remain on the deployment host. No Windows or live Cloudflare validation was performed.

The published image may require registry authentication depending on package visibility. This deployment loaded the verified Actions image archive instead of relying on the host's registry connection.

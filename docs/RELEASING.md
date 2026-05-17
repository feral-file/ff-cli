# Releasing ff-cli

How releases happen, how to cut one, and what to do when things go sideways.

## Cut a release (day-to-day)

1. **Bump `package.json` version** on `main` (or via a `chore: bump version to X.Y.Z` PR — the project has used both patterns).
2. **Push to `main`** so the tag created in step 3 points at the bump commit.
3. **Create a GitHub Release** with the tag equal to the version (e.g. tag `1.2.0` → `"version": "1.2.0"`). Use `gh release create 1.2.0 --title "v1.2.0" --notes "..."` or the web UI.
4. **The `release.yml` workflow fires automatically**, verifies tag == `package.json` version, runs CI, publishes to npm via OIDC, builds binary assets, uploads them to the release, and verifies the package landed on npm.

That's it. No tokens, no manual `npm publish`. The whole thing takes ~4 minutes end-to-end.

### Beta releases

For pre-release versions (e.g. `1.2.0-beta.0`):

- Mark the GitHub Release as a **pre-release**, and the version string in `package.json` must contain `beta`. Publishes go to the `beta` dist-tag.
- Or use **workflow dispatch** (Actions → Release → Run workflow) from `main` with a `version` input that contains `beta` and matches `package.json`.

## How publishing actually works

The `publish-npm` job in `release.yml` authenticates to npm via **GitHub Actions OIDC** (npm Trusted Publishing). Key pieces:

| Piece | Why |
|---|---|
| `permissions: id-token: write` on the job | Lets GitHub Actions mint an OIDC token at runtime. |
| `node-version: '24'` (only this job) | Node 22's bundled npm 10.x doesn't support OIDC publishing. Node 24 ships with npm 11.x. The package's `engines: node >=22` floor for consumers is unrelated. |
| `npm publish --provenance` | Generates a SLSA provenance attestation signed via sigstore, then submits the package + attestation to npm. |
| `package.json` `"repository": { "url": "git+https://github.com/feral-file/ff-cli.git" }` | npm cross-checks this against the provenance ("built from feral-file/ff-cli") and rejects the publish if it doesn't match. |
| **No `NPM_TOKEN` secret** | OIDC replaces the token entirely. The old secret is deleted; do not re-add. |

The trust relationship lives at https://www.npmjs.com/package/@feralfile/cli/access — publisher: GitHub Actions, org `feral-file`, repo `ff-cli`, workflow `release.yml`. Changing the workflow filename, repo, or org will break publishes until the trust config is updated.

## Bootstrapping a brand-new npm package

You will probably never do this again for `@feralfile/cli`, but if you ever publish a new scoped package (`@feralfile/something-else`), the chicken-and-egg sequence is:

1. **First publish must come from a logged-in human** (npm Trusted Publishing can only be configured against an existing package). Run `npm publish --access public` locally as a user with publish rights to the org. If your account has 2FA, pass `--otp 123456` inline — the browser auth flow needs a real TTY that `gh`/Claude/CI doesn't provide.
2. **Configure the trusted publisher** at `https://www.npmjs.com/package/<name>/access` once the package exists. Fields: Publisher = GitHub Actions, Organization = `feral-file`, Repository = `<repo>`, Workflow filename = `release.yml`.
3. **Confirm `package.json` has a matching `repository.url`** before letting CI publish, or `--provenance` will 422.
4. **Cut a small follow-up release through CI** to confirm the OIDC path works end-to-end before relying on it.
5. **Optionally harden**: flip "Publishing access" to "Require 2FA and disallow tokens" so the only way to publish is via the trusted publisher in CI — no laptops, no automation tokens.

## GitHub Actions workflows

- **`ci.yml`** — formatting, lint, tests, build on Node 22 across ubuntu/macos/windows. Called by `release.yml` and runs on PRs / pushes to `main`.
- **`build.yml`** — builds prebuilt binaries (macOS/Linux/Windows) and uploads them as workflow artifacts. Triggered manually or from `release.yml`.
- **`release.yml`** — orchestrates a release. Verifies version, runs CI, publishes to npm (Node 24 + OIDC + provenance), builds binaries, uploads release assets, verifies the package and assets are live. Triggers on published GitHub Releases or manual dispatch (beta only).
- **`codeql.yml`**, **`dependency-review.yml`** — security scanning.

## Binary release assets

The curl installer (`https://feralfile.com/ff-cli-install`) downloads prebuilt binaries from GitHub Releases. The release workflow builds and uploads them automatically. To build one locally:

**macOS / Linux:**

```bash
./scripts/release/build-asset.sh
```

**Windows (PowerShell):**

```powershell
.\scripts\release\build-asset-windows.ps1
```

Produces (names vary by OS/arch):

- `release/ff-cli-darwin-arm64.tar.gz` (and `.sha256`) on macOS
- `release/ff-cli-linux-x64.tar.gz` (and `.sha256`) on Linux
- `release/ff-cli-windows-x64.zip` (and `.sha256`) on Windows

## Release notes and breaking changes

GitHub Release text (and any user-facing summary you publish with the version) should state compatibility changes in plain language. **Do not rely on `package.json` `engines` alone**; npm and installers surface it inconsistently, and operators skim release notes first.

### Node.js engine floor (breaking)

`package.json` declares `"engines": { "node": ">=22" }`. Raising the floor from Node 18 (or 20) is a **breaking change** for:

- global installs and `npx @feralfile/cli` on older runtimes
- CI jobs and images pinned to Node 18 or 20
- anyone developing from source without upgrading Node

**For the release that first ships this requirement**, copy or adapt the following into the GitHub Release description (and repeat in the upgrade section of internal comms if needed):

> **Breaking — Node.js:** ff-cli now requires **Node.js 22 or newer** (`package.json` `engines`). Node 18 and Node 20 are no longer supported. Upgrade Node on your machines and in CI, or stay on an older ff-cli version until you can migrate.

Later releases only need to repeat this block if the engine floor changes again.

## Installer redirect

`https://feralfile.com/ff-cli-install` should redirect to:

```
https://raw.githubusercontent.com/feral-file/ff-cli/main/scripts/install.sh
```

The installer script then fetches the release assets from GitHub Releases.

## Environment overrides

- `FF_CLI_VERSION`: overrides the version label in logs
- `FF_CLI_NODE_VERSION`: Reserved in script headers for future use; current CI, npm `engines`, and release wrappers assume **Node.js 22+** (required by `dp1-js`).
- `FF_CLI_OUTPUT_DIR`: output directory (default: `./release`)

## Troubleshooting

### `404 Not Found - PUT https://registry.npmjs.org/@feralfile%2fcli`

npm hides "you don't have publish access" as a 404. Check:

1. The trusted publisher at https://www.npmjs.com/package/@feralfile/cli/access matches the *running* workflow: organization, repository, workflow filename, environment (or lack thereof).
2. The job has `permissions: id-token: write`.
3. You're not somehow still passing an `NPM_TOKEN` / `NODE_AUTH_TOKEN` env var — that flips npm into token-auth mode, and if the token isn't authorized for the scope you'll 404.

### `422 Unprocessable Entity ... "repository.url" is "", expected to match "https://github.com/feral-file/ff-cli" from provenance`

The SLSA provenance attestation records the source repo; npm requires `package.json`'s `repository.url` to match before accepting the publish. Add:

```json
"repository": {
  "type": "git",
  "url": "git+https://github.com/feral-file/ff-cli.git"
}
```

### `npm error code MODULE_NOT_FOUND ... Cannot find module 'promise-retry'`

You're trying to `npm install -g npm@latest` on top of a running npm. It overwrites its own files mid-execution and corrupts. Don't upgrade in place — use a Node version that already ships the npm you need. The `publish-npm` job runs Node 24 specifically for this reason.

### `EOTP — This operation requires a one-time password`

You're publishing manually from a laptop, and your npm account has 2FA enforced. Either pass `--otp 123456` inline (TOTP code from your authenticator), or run `npm publish` directly in a real terminal where the browser auth flow can complete. **CI never hits this** — OIDC is its own auth path and bypasses 2FA.

### `Version mismatch: package.json is X but tag is Y`

The `verify-version` job catches this. Fix `package.json` to match the tag and create a new release tag, or delete and recreate the release with the correct tag.

### Release fired but never reached npm

The tag is consumed even when publish fails (you can't republish the same version). Bump to the next patch version and cut a fresh release. Optionally `gh release delete <tag> --cleanup-tag` to remove the never-published tag from the release page.

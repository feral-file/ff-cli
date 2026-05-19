# ff-cli

A small Node.js CLI for building DP-1 playlists of digital art.

**Runtime:** Node.js 22 or newer (matches CI and the `dp1-js` dependency). That engine floor is a **breaking** change if you previously used Node 18 or 20—check the **GitHub Release** for the version you move to; release authors follow `docs/RELEASING.md` so the notes stay explicit.

ff-cli turns a simple prompt into a DP-1–conformant playlist you can preview on an Art Computer. The model orchestrates; deterministic tools do the real work (schema validation, indexing, JSON‑LD). If something comes back invalid, validation rejects it and we loop until it’s right.

## Install

```bash
npm i -g @feralfile/cli
```

## Install (curl)

```bash
curl -fsSL https://feralfile.com/ff-cli-install | bash
```

Installs a prebuilt binary for macOS/Linux (no Node.js required).

## One-off Usage (npx)

```bash
npx @feralfile/cli setup
npx @feralfile/cli chat
```

## Quick Start

**Set your LLM API key first (default Claude):** `export ANTHROPIC_API_KEY='sk-ant-your-api-key-here'`

```bash
ff-cli setup
ff-cli chat
ff-cli play "https://example.com/video.mp4" --skip-verify
```

If you need manual config actions instead of guided setup:

```bash
ff-cli config init
ff-cli config validate
```

## Find an artwork

`ff-cli find` resolves a URL, raw `chain:contract:tokenId`, or a wallet address into a playable DP-1 playlist. The focus is computational and generative art; PFP collections and pre-ERC-721 contracts have limits noted below.

```bash
# Most satisfying: paste a URL, play it on your FF1
ff-cli find https://www.artblocks.io/collection/ringers-by-dmitri-cherniak --play

# Tezos / hic et nunc via Objkt (the alias resolves to a KT1 contract)
ff-cli find https://objkt.com/tokens/hicetnunc/111068 --play

# Feral File artwork (public id can be hex or numeric — both forms resolve via /api/artworks)
ff-cli find https://feralfile.com/exhibitions/artwork/f0240e04d64717e319584957f6a83954b029254ad1260b6320472ea8c0c5b1cf --play

# Save without playing
ff-cli find ethereum:0xababababab20053426ad1c782de9ea8444358070:5001410 --output send-receive.json
```

Sources: Art Blocks, Objkt, fxhash (canonical `/gentk/...` and live `/iteration/{slug}`), OpenSea, SuperRare, Feral File, raw on-chain coords, wallet addresses. Run `ff-cli find --help` for the full input list.

**Known limitations**

- **CryptoPunks (original)** don't index — the contract predates ERC-721 ([ff-indexer-v2#83](https://github.com/feral-file/ff-indexer-v2/issues/83)).
- **Mainstream PFPs** (Azuki, BAYC, Pudgy Penguins) build a single-item playlist instead of a series — Raster's curation is effectively the series allowlist.
- **Indexer 502s on burst load** are intermittent ([ff-indexer-v2#82](https://github.com/feral-file/ff-indexer-v2/issues/82)) — retry clears or use `--limit N`.

## Dev Quick Start

**Set your LLM API key first (default Claude):** `export ANTHROPIC_API_KEY='sk-ant-your-api-key-here'`

```bash
npm ci
npm run dev -- setup
npm run dev -- chat
npm run dev -- play "https://example.com/video.mp4" --skip-verify
```

## Documentation

- Getting started and usage: `./docs/README.md`
- Configuration: `./docs/CONFIGURATION.md`
- Function calling architecture: `./docs/FUNCTION_CALLING.md`
- Examples: `./docs/EXAMPLES.md`
- SSH access: `ff-cli ssh enable|disable` in `./docs/README.md`

## Verification

GitHub Actions runs `.github/workflows/ci.yml` for pull requests, pushes to `main`/`master`, and reusable `workflow_call` jobs. CI uses Node.js 22, installs dependencies with `npm ci`, sets `ANTHROPIC_API_KEY=dummy`, and runs the repo-wide verification entrypoint:

```bash
ANTHROPIC_API_KEY=dummy npm run verify
```

Run the same command locally before opening a PR. It checks formatting, lint, tests, TypeScript build, playlist validation smoke, and config validation smoke without mutating source files.

Other GitHub Actions workflows:

- `.github/workflows/build.yml` builds release assets when called by release automation or manually dispatched.
- `.github/workflows/release.yml` reuses CI, verifies the release version, publishes npm, uploads assets, and checks the published release.
- `.github/workflows/dependency-review.yml` reviews dependency changes on pull requests.
- `.github/workflows/codeql.yml` runs CodeQL analysis on pull requests and pushes to `main`/`master`.

## Scripts

```bash
npm run dev            # Run CLI in dev (tsx)
npm run build          # Build TypeScript
npm run check          # Format check + lint + tests
npm run smoke          # Build + CLI smoke checks
npm run verify         # CI-equivalent validation entrypoint
npm run lint:fix       # Optional mutating lint fix; review changes before committing
```

## License

MIT

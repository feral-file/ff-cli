# ff-cli

A small Node.js CLI for building DP-1 playlists of digital art.

**Runtime:** Node.js 22 or newer (matches CI and the `dp1-js` dependency). That engine floor is a **breaking** change if you previously used Node 18 or 20—check the **GitHub Release** for the version you move to; release authors follow `docs/RELEASING.md` so the notes stay explicit.

ff-cli is a set of deterministic commands for building DP-1–conformant playlists and playing them on an Art Computer: schema validation, indexing, JSON‑LD, signing, and device delivery. There's no built-in chat — natural language belongs in your coding agent (Claude Code, Codex), which drives ff-cli through the `ff-control` skill (see [Use with Claude Code](#use-with-claude-code)). No LLM API key required.

## Install

```bash
npm i -g @feralfile/cli
```

This is the recommended path and the most reliable for the agent workflow — it installs a complete package (including `config.json.example` and the bundled `dp1-js`). Requires Node.js 22+.

## Install (curl)

```bash
curl -fsSL https://feralfile.com/ff-cli-install | bash
```

Installs a prebuilt binary for macOS/Linux. Node.js 22+ must still be on your PATH (the bundle runs under `node`). If a command fails right after install, prefer the npm install above.

## One-off Usage (npx)

```bash
npx @feralfile/cli setup
npx @feralfile/cli find https://www.artblocks.io/collection/ringers-by-dmitri-cherniak --play
```

## Quick Start

```bash
ff-cli setup
ff-cli find https://objkt.com/tokens/hicetnunc/111068 --play
ff-cli play "https://example.com/video.mp4" --skip-verify
```

If you need manual config actions instead of guided setup:

```bash
ff-cli config init
ff-cli config validate
```

### Non-interactive setup (agents / CI)

`ff-cli setup` is fully scriptable — no TTY required. It runs non-interactively when stdin is not a terminal, or when you pass `-y/--non-interactive`, and takes flags for every step:

```bash
# Generate a signing key and register a device in one shot, no prompts
ff-cli setup --non-interactive \
  --generate-key \
  --device-host http://192.168.1.50:1111 \
  --device-name "Living Room"

# Or supply your own key (base64 PKCS#8 DER, 32-byte seed as hex/base64, or PEM)
ff-cli setup -y --key "<private-key>" --role agent
```

Device pairing is also scriptable on its own: `ff-cli device add --host http://<ip>:1111 --name <name>` skips mDNS discovery entirely.

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

Sources: Art Blocks, Objkt, fxhash (canonical `/gentk/...`, live `/iteration/{slug}`, and project pages `/project/{slug}` / `/generative/{slug}`), OpenSea, SuperRare, Feral File, Neort (`/art/{id}`), raw on-chain coords, wallet addresses. Run `ff-cli find --help` for the full input list.

**Known limitations**

- **CryptoPunks (original)** don't index — the contract predates ERC-721 ([ff-indexer-v2#83](https://github.com/feral-file/ff-indexer-v2/issues/83)).
- **Mainstream PFPs** (Azuki, BAYC, Pudgy Penguins) build a single-item playlist instead of a series — Raster's curation is effectively the series allowlist.
- **Indexer 502s on burst load** are intermittent ([ff-indexer-v2#82](https://github.com/feral-file/ff-indexer-v2/issues/82)) — retry clears or use `--limit N`.

## Use with Claude Code

ff-cli ships a [Claude Code](https://docs.claude.com/en/docs/claude-code) skill at `skills/ff-control/SKILL.md`. Install it once:

```bash
git clone --depth=1 https://github.com/feral-file/ff-cli /tmp/ff-cli \
  && mkdir -p ~/.claude/skills \
  && cp -r /tmp/ff-cli/skills/ff-control ~/.claude/skills/
```

Claude Code will surface it when you ask to build a playlist, play an artwork or URL on an Art Computer, or publish to a feed. The skill validates config, builds, validates the playlist, and sends or publishes — reporting the failing command + exit code if anything breaks. Full prompt and exact flow: [`skills/ff-control/SKILL.md`](./skills/ff-control/SKILL.md).

## Use with Codex

ff-cli ships the same `ff-control` skill in Codex's native skill format. Install it once:

```bash
git clone --depth=1 https://github.com/feral-file/ff-cli /tmp/ff-cli \
  && mkdir -p ~/.codex/skills \
  && cp -r /tmp/ff-cli/skills/ff-control ~/.codex/skills/
```

Codex will surface it when you ask to build a playlist, play an artwork or URL on an Art Computer, or publish to a feed. The installed skill is `skills/ff-control/SKILL.md`, so the execution flow stays defined in one place. Codex metadata and exact flow: [`skills/ff-control/agents/openai.yaml`](./skills/ff-control/agents/openai.yaml), [`skills/ff-control/SKILL.md`](./skills/ff-control/SKILL.md).

## Dev Quick Start

```bash
npm ci
npm run dev -- setup
npm run dev -- find https://objkt.com/tokens/hicetnunc/111068 --play
npm run dev -- play "https://example.com/video.mp4" --skip-verify
```

> **npm 12+:** `npm ci`/`npm install` fail with `Fetching packages of type "git" have been disabled` because `@feralfile/source-resolver` is a git-URL dependency and npm 12 blocks those by default. Install with `npm ci --allow-git=all` until the resolver is published to the npm registry.

## Documentation

- Getting started and usage: `./docs/README.md`
- Configuration: `./docs/CONFIGURATION.md`
- Examples: `./docs/EXAMPLES.md`
- SSH access: `ff-cli ssh enable|disable` in `./docs/README.md`

## Verification

GitHub Actions runs `.github/workflows/ci.yml` for pull requests, pushes to `main`/`master`, and reusable `workflow_call` jobs. CI uses Node.js 22, installs dependencies with `npm ci`, and runs the repo-wide verification entrypoint:

```bash
npm run verify
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

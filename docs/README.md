# ff-cli Documentation

Build DP-1 (Display Protocol 1) playlists from NFT data with either natural language (AI‑driven) or deterministic parameters. This doc covers install, config, and day‑to‑day usage.

For project-level planning and future agentic work, see `./PROJECT_SPEC.md`.

## Install

```bash
npm i -g @feralfile/cli
```

`npm` and `npx` require **Node.js 22 or newer** (see `package.json` `engines`). When a release raises the Node floor, that is a **breaking** change for Node 18/20 users; the GitHub Release for that version should say so explicitly (see `./RELEASING.md` for maintainer guidance).

## Install (curl)

```bash
curl -fsSL https://feralfile.com/ff-cli-install | bash
```

Installs a prebuilt bundle for macOS/Linux. Node.js 22 or newer must still be available in `PATH`; the bundle avoids a global npm install, not the Node runtime requirement.

## Configure

```bash
# Guided setup (recommended)
ff-cli setup
```

See the full configuration reference here: `./CONFIGURATION.md`.

During setup, you can pick FF1 devices to add. Use `ff-cli device add` to add more devices later, and `ff-cli device list` to see what's configured. The first device is the default for `play` commands (override with `-d`).

Manual config path:

```bash
ff-cli config init
ff-cli config validate
```

### config.json structure (minimal)

```json
{
  "defaultModel": "claude",
  "models": {
    "claude": {
      "apiKey": "sk-ant-your-api-key-here",
      "baseURL": "https://api.anthropic.com/v1/",
      "model": "claude-sonnet-4-6",
      "supportsFunctionCalling": true
    },
    "grok": {
      "apiKey": "xai-your-api-key-here",
      "baseURL": "https://api.x.ai/v1",
      "model": "grok-beta",
      "supportsFunctionCalling": true
    },
    "gpt": {
      "apiKey": "sk-your-openai-key-here",
      "baseURL": "https://api.openai.com/v1",
      "model": "gpt-4o",
      "supportsFunctionCalling": true
    },
    "gemini": {
      "apiKey": "your-gemini-key-here",
      "baseURL": "https://generativelanguage.googleapis.com/v1beta/openai/",
      "model": "gemini-2.5-flash",
      "supportsFunctionCalling": true
    }
  },
  "defaultDuration": 10,
  "playlist": {
    "privateKey": "your_ed25519_private_key_hex_or_base64_here"
  },
  "feed": { "baseURLs": ["https://dp1-feed-operator-api-prod.autonomy-system.workers.dev/api/v1"] },
  "ff1Devices": {
    "devices": [
      {
        "name": "Living Room Display",
        "host": "http://192.168.1.100:1111"
      }
    ]
  }
}
```

### Environment variables (optional)

See `./CONFIGURATION.md` for environment variable mappings.

## Quick Start

```bash
# Chat
ff-cli chat

# Or natural language in one shot
ff-cli chat "Get 3 works from reas.eth" -o playlist.json

# Deterministic (no AI)
ff-cli build examples/params-example.json -o playlist.json
```

For development in this repo:

```bash
npm run build
node dist/index.js chat
```

If you're running from source without a build, use:

```bash
npm run dev -- chat
```

## Recommended Deterministic Flow (LLM + Tools)

The model orchestrates; deterministic tools keep us honest and DP1‑conformant.

1. Input: Share the essentials (contract + token IDs, or feed/URL names).
2. Orchestration: The LLM parses your prompt and calls tools that:
   - Fetch NFT metadata via OSS libs (`viem` for Ethereum, `@taquito/taquito` for Tezos)
   - Validate DP1 schema with `dp1-js`
   - Build a DP1 playlist envelope deterministically
   - Optionally sign with Ed25519 (canonical JSON via `dp1-js`)
3. Preview/send: Send to an FF1 on your LAN over HTTP (recommended). Point `ff1Devices.devices[].host` at a local relay if needed.
4. Publish: Optional feed/registry publishing via the `publish` command.

Notes:

- **Deterministic by design**: Validation rejects bad or hallucinated data; we loop until it's valid or stop.
- **OSS‑first**: `viem` and `@taquito/taquito`, with room for local caching.
- **Relay**: Swap the example host for a local Node/Hono relay; avoid vendor lock‑in.

## Commands (cheat sheet)

- `chat [content]` – AI-driven natural language playlists
  - Options: `-o, --output <file>`, `-m, --model <name>`, `-d, --device <name>`, `-v, --verbose`
- `build [params.json]` – Deterministic build from JSON or stdin
  - Options: `-o, --output <file>`, `-v, --verbose`
- `validate <file-or-url>` – Validate playlist structure only
- `verify <file-or-url>` – Validate structure and verify signatures. On failure, the CLI labels structure issues separately from signature verification. dp1-js uses `--public-key` (or a key derived from `playlist.privateKey` / `PLAYLIST_PRIVATE_KEY` when omitted) **only** for legacy flat `signature` verification; DP-1 v1.1.0 `signatures[]` envelopes are verified without relying on that argument. If deriving or normalizing key material fails, the CLI prints a warning on stderr and continues without it (legacy verification still requires a usable key when the playlist uses a flat `signature`). The derived key is emitted as PEM. Supported key forms: hex with optional `0x`, PEM, or 32-byte raw public key as hex or base64
- `sign <file>` – Sign playlist with a DP-1 v1.1.0 multi-signature envelope (private key string is forwarded to **`dp1-js`**; same hex or base64 PKCS#8 DER forms as `playlist.privateKey` in `./CONFIGURATION.md`). The command verifies the final envelope before writing output and refuses to persist tampered or otherwise unverifiable `signatures[]`.
  - Options: `-k, --key <privateKey>`, `-r, --role <role>`, `-o, --output <file>`
- `play <source>` – Play a playlist file, playlist URL, or media URL on an FF1 device (runs `verify` before sending; only the CLI-synthesized media URL fallback is auto-signed when a signing key is configured; use `--skip-verify` to bypass the gate)
  - Options: `-d, --device <name>`, `--skip-verify` (skip signature verification; not recommended)
- `find <input>` – Resolve a marketplace URL, raw `chain:contract:tokenId`, or wallet address into a playable DP-1 playlist
  - Sources: Art Blocks, Objkt, fxhash, OpenSea, SuperRare, Feral File, Neort, Verse, raw on-chain coordinates, and wallet addresses
  - Verse forms: `/items/ethereum/{contract}/{tokenId}` and `/series/{slug}`
  - Options: `-o, --output <path>`, `-l, --limit <n>`, `-p, --play`, `-d, --device <name>`, `--publish`, `-s, --server <index>`, `-y, --yes`, `--skip-verify`
- `publish <file>` – Publish a playlist to a feed server (runs `verify` before upload and rejects unsigned or broken playlists)
  - Options: `-s, --server <index>` (server index if multiple configured)
- `ssh <enable|disable>` – Manage SSH access on an FF1 device
  - Options: `-d, --device <name>`, `--pubkey <path>`, `--ttl <duration>`
- `device list` – List all configured FF1 devices
- `device add` – Add a new FF1 device (with mDNS discovery)
  - Options: `--host <host>`, `--name <name>`
- `device remove <name>` – Remove a configured FF1 device
- `device default <name>` – Set the default FF1 device (used when `-d` is omitted)
- `config <init|show|validate>` – Manage configuration

## Usage Highlights

### Natural language (AI)

```bash
npm run dev -- chat "Get 3 works from reas.eth"
npm run dev -- chat "Get 3 works from einstein-rosen.tez"
npm run dev -- chat "Get tokens 52932,52457 from Ethereum contract 0xb932a70A57673d89f4acfFBE830E8ed7f75Fb9e0" -o playlist.json
```

Feed playlists (for example `Unsupervised`, `Social Codes`) depend on your configured feed servers and network reachability.
Use exact or near-exact playlist titles for best results.

If you prompt with a bare EVM address (for example `from 0x...`), the CLI now tries owner-address lookup first, then automatically falls back to contract lookup when no owned tokens are found.

### One-shot complex prompt

The model reads your request via the intent parser and turns it into structured `requirements` and `playlistSettings` (including shuffle, durations, and device). You can do everything in one line:

```bash
# Mix sources, shuffle order, set per-item duration, and send to a named device
npm run dev -- chat "From Ethereum contract 0xb932a70A57673d89f4acfFBE830E8ed7f75Fb9e0 get tokens 52932,52457 and from reas.eth get 2 works; shuffle the order; 7 seconds per item; send to device 'Living Room Display'." -o playlist.json -v
```

How it works (at a glance):

- The intent parser maps your text to `requirements` (what to fetch) and `playlistSettings` (e.g., `durationPerItem`, `preserveOrder=false` for shuffle, `deviceName`, `feedServer`).
- Deterministic tools fetch NFT metadata, build a DP‑1 playlist, and verify it.
- If `deviceName` is present, the CLI will send the verified playlist to that FF1 device.
- If `feedServer` is present (via "publish to my feed"), the CLI will publish the playlist to the selected feed server.

Use `--model claude|grok|gpt|gemini` to switch models, or set `defaultModel` in `config.json`.

### Natural language publishing

The intent parser recognizes publishing keywords and can both display and publish in one command:

```bash
# Build and publish
npm run dev -- chat "Build playlist from Ethereum contract 0xb932a70A57673d89f4acfFBE830E8ed7f75Fb9e0 with tokens 52932 and 52457; publish to my feed" -o playlist.json -v

# Display on Art Computer AND publish to feed
npm run dev -- chat "Get 3 from Unsupervised; shuffle; send to my Art Computer and publish to feed" -o playlist.json -v
```

For Feral File built playlists, you can reference titles listed in the repository:
`https://github.com/feral-file/dp1-feed/tree/main/playlists`

Example:

```bash
npm run dev -- chat "Get 3 from Unsupervised"
```

Publishing keywords: "publish", "publish to my feed", "push to feed", "send to feed". The CLI will:

1. Detect the keyword and call `get_feed_servers`
2. If multiple servers → ask which one to use
3. Build → verify → publish automatically
4. Display playlist ID and server URL on success

If all configured feed servers are unreachable, the CLI now reports a feed availability error instead of "playlist not found".

### Deterministic (no AI)

```bash
npm run dev -- build params.json -o playlist.json
cat params.json | npm run dev -- build -o playlist.json
```

`params.json` should include `requirements` and optional `playlistSettings`. See `examples/params-example.json`.

### Validate, sign, and play

```bash
# Optional explicit validation (build flows already validate)
npm run dev -- validate playlist.json

# Sign (uses key and role from config, or overrides via --key / --role)
npm run dev -- sign playlist.json -o signed.json

# Play on configured default device (verifies playlists; only media URL fallbacks may be auto-signed)
npm run dev -- play playlist.json

# Play on a specific named device
npm run dev -- play playlist.json -d "Living Room Display"

# The play path performs a compatibility preflight check against the target FF1.
# If the device reports an unsupported FF1 OS version, the command fails with
# a clear version message before any cast request is sent.
# It also retries transient local-network errors (for example intermittent
# mDNS/Wi-Fi resolver failures) with a short backoff before returning a final error.

# Play a hosted DP-1 playlist
npm run dev -- play "https://cdn.example.com/playlist.json"

# Play a media URL directly
npm run dev -- play "https://example.com/video.mp4"

# Skip signature verification only if you must send a non-conformant payload (not recommended)
npm run dev -- play playlist.json --skip-verify
```

### SSH access

```bash
# Enable SSH access for 30 minutes
ff-cli ssh enable --pubkey ~/.ssh/id_ed25519.pub --ttl 30m -d "Living Room Display"

# Disable SSH access
ff-cli ssh disable -d "Living Room Display"

# `ff-cli ssh` also performs the same FF1 OS compatibility preflight used by `play`.
```

### Publish to feed server

```bash
# Publish to first configured feed server
npm run dev -- publish playlist.json

# Publish to specific server (if multiple configured)
npm run dev -- publish playlist.json -s 0
npm run dev -- publish playlist.json -s 1
```

The `publish` command:

- Verifies playlist signatures before upload
- Rejects unsigned or broken playlists
- Shows interactive server selection if multiple are configured
- Sends the verified playlist to the chosen feed server
- Returns the playlist ID on success

Configure feed servers in `config.json`:

```json
{
  "feedServers": [
    {
      "baseUrl": "http://localhost:8787/api/v1",
      "apiKey": "your-api-key-optional"
    },
    {
      "baseUrl": "https://feed.example.com/api/v1",
      "apiKey": "your-api-key-optional"
    }
  ]
}
```

### FF1 device management

```bash
# List configured devices
ff-cli device list

# Add a device (interactive with mDNS discovery)
ff-cli device add

# Add a device non-interactively
ff-cli device add --host 192.168.1.100 --name kitchen

# Remove a device by name
ff-cli device remove kitchen

# Set the default device (used when -d is omitted)
ff-cli device default office
```

Setup preserves existing devices when adding new ones. See selection rules and examples in `./CONFIGURATION.md`.

### Playlist signing (optional)

- Add `playlist.privateKey` (Ed25519 PKCS#8 DER as **hex** or **base64**, per `./CONFIGURATION.md`) and, optionally, `playlist.role` to `config.json`, or set `PLAYLIST_PRIVATE_KEY` and `PLAYLIST_ROLE`.
- The CLI passes that string to **`dp1-js`** for signing; the dependency decodes hex (`0x` optional) or base64 before loading the key.
- Signed playlists include a `signatures[]` envelope compliant with DP-1 v1.1.0 (via **`dp1-js`**).

## Constraints

- Max 20 items total across all requirements
- Per-source caps enforced in utilities
- Duration per item defaults to 10s (configurable)

## Links

- Function calling details: `./FUNCTION_CALLING.md`
- Examples: `./EXAMPLES.md`
- Release assets: `./RELEASING.md`
- DP1 spec: `https://github.com/display-protocol/dp1`

# Function Calling Architecture

How ff-cli uses AI function calling to build playlists deterministically. The model orchestrates function calls; tools enforce schema and assemble the DP-1 envelope.

## Overview

Natural language requests become structured parameters. An AI orchestrator then calls functions to fetch items, build a DP-1 playlist, validate structure (`verify_playlist`), optionally sign, and send to a device.

Pipeline:

```
Intent Parser → Orchestrator (function calls) → Utilities → DP-1 Playlist
```

Key files:

- `src/intent-parser/` – Parses user text into `requirements` + `playlistSettings`
- `src/ai-orchestrator/index.js` – Function schemas and orchestration logic
- `src/utilities/` – Concrete implementations used by the orchestrator
- `src/main.ts` – Bridges CLI commands to parser/orchestrator/utilities

## Function Schemas (AI‑visible)

Defined in `src/ai-orchestrator/index.js` as tool schemas for OpenAI‑compatible clients.

- `query_requirement(requirement, duration)`
  - Types: `build_playlist`, `feral_file_artwork`, `fetch_feed`, `query_address`
  - For `build_playlist`: requires `blockchain`, `contractAddress`, `tokenIds`, optional `quantity`
  - For `feral_file_artwork`: requires `artworkId`, either a Feral File public artwork id or `/exhibitions/artwork/{id}` URL
  - For `query_address`: requires `ownerAddress`, optional `quantity` (random selection)
  - For `fetch_feed`: requires `playlistName`, `quantity`

- `search_feed_playlist(playlistName)` → fuzzy-match across configured feeds
- `fetch_feed_playlist_items(playlistName, quantity, duration)`
- `build_playlist(items, title?, slug?, shuffle?)` → returns DP-1 playlist
- `verify_playlist(playlist)` → DP-1 parse/structure validation only (must precede send; use CLI `verify` for signatures)
- `verify_addresses(addresses[])` → validates Ethereum (0x...) and Tezos (tz.../KT1) address formats
- `send_to_device(playlist, deviceName?)`
- `resolve_domains(domains[], displayResults?)` → ENS/TNS resolution

Notes enforced by the orchestrator:

- Always pass complete requirement objects (no truncating addresses/token IDs)
- Resolve domains (`.eth`, `.tez`) before `query_address`
- Build, then `verify_playlist` (structure) before sending to devices
- Shuffle is controlled by `playlistSettings.preserveOrder`

## Implementations (server‑side)

Located in `src/utilities/` and wired in `src/ai-orchestrator/index.js`:

- `buildDP1Playlist({ items, title, slug })` → `src/utilities/playlist-builder.js`
- `sendPlaylistToDevice({ playlist, deviceName })` → `src/utilities/ff1-device.ts`
- `resolveDomains({ domains, displayResults })` → `src/utilities/domain-resolver.ts`
- `verifyPlaylist({ playlist })` in `functions.js` → delegates to `validatePlaylist` in `playlist-verifier.ts` (structure/parse only)
- `verifyAddresses({ addresses })` → `src/utilities/functions.js` (uses `address-validator.ts`)
- Feed utilities: `feed-fetcher.js`

## Deterministic Paths

Two options are available:

1. No-AI deterministic build (recommended for automation): Use CLI `build` command with a JSON file or stdin containing:

```json
{
  "requirements": [
    { "type": "fetch_feed", "playlistName": "Social Codes", "quantity": 3 },
    { "type": "feral_file_artwork", "artworkId": "https://feralfile.com/exhibitions/artwork/..." },
    {
      "type": "build_playlist",
      "blockchain": "ethereum",
      "contractAddress": "0x...",
      "tokenIds": ["1", "2"],
      "quantity": 2
    }
  ],
  "playlistSettings": { "durationPerItem": 10, "preserveOrder": true, "title": "My Mix" }
}
```

This path bypasses the intent parser/orchestrator and calls utilities directly. Validation and sensible defaults are applied in `src/main.ts`.

2. AI‑orchestrated deterministic build (recommended for prompts): Use `chat` with `--verbose` to see tool calls. The orchestrator enforces complete requirement objects, then runs `verify_playlist` (structure only) before sending.

## Extending Functionality (OSS‑first)

1. Add a new function in `src/utilities/` (prefer OSS libs: `viem` for Ethereum, `@taquito/taquito` for Tezos; add local caching where it helps)
2. Export and wire it in `src/utilities/index.js`
3. Add a corresponding schema in `src/ai-orchestrator/index.js`
4. Update this doc if user‑facing behavior changes
5. Run `npm run lint:fix`

## Validation & Constraints

- Verify via `dp1-js` for DP-1 conformance (canonical JSON + Ed25519 signing supported)
- Enforce max item counts and ordering/shuffle rules during build
- Batch domain resolution; report failures without crashing the flow

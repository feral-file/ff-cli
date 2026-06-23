# Examples

Copy‑pasteable commands that work with the current CLI. ff-cli is deterministic: there's no built-in chat. Natural language belongs in your coding agent (Claude Code, Codex), which drives these commands via the `ff-control` skill. No LLM API key required.

## Setup

```bash
npm install
npm run dev -- setup
```

Manual config path:

```bash
npm run dev -- config init
npm run dev -- config validate
```

## Use with a coding agent

ff-cli ships a [Claude Code](https://docs.claude.com/en/docs/claude-code) / Codex skill at `skills/ff-control/SKILL.md`. Once installed, ask your agent in plain language ("Get 3 works from reas.eth and play on Living Room", "Build a playlist from this Objkt URL and publish to my feed") and it translates the request into `ff-cli find` or `ff-cli build` and runs the validate → play/publish flow for you.

Recommended local install path:

```bash
git clone --depth=1 https://github.com/feral-file/ff-cli /tmp/ff-cli \
  && mkdir -p ~/.claude/skills \
  && cp -r /tmp/ff-cli/skills/ff-control ~/.claude/skills/
```

The rest of this doc shows the deterministic commands the skill (or you) drives directly.

## Find an artwork

`ff-cli find` resolves a marketplace URL, raw `chain:contract:tokenId`, or wallet address into a playable DP-1 playlist. Sources: Art Blocks, Objkt, fxhash, OpenSea, SuperRare, Feral File, Neort, Verse, raw on-chain coordinates, and wallet addresses.

```bash
# Paste a URL and play it on your FF1
npm run dev -- find https://www.artblocks.io/collection/ringers-by-dmitri-cherniak --play

# Tezos / hic et nunc via Objkt (the alias resolves to a KT1 contract)
npm run dev -- find https://objkt.com/tokens/hicetnunc/111068 --play

# Feral File artwork (public id may be hex or numeric)
npm run dev -- find https://feralfile.com/exhibitions/artwork/f0240e04d64717e319584957f6a83954b029254ad1260b6320472ea8c0c5b1cf --play

# Save without playing
npm run dev -- find ethereum:0xababababab20053426ad1c782de9ea8444358070:5001410 -o send-receive.json

# Single on-chain token by coordinates
npm run dev -- find ethereum:0xb932a70A57673d89f4acfFBE830E8ed7f75Fb9e0:52932 -o token.json

# Tezos token by coordinates
npm run dev -- find tezos:KT1BcNnzWze3vCviwiETYNwcFSwjv6RihZEQ:22 -o tez-token.json

# Wallet address (owner lookup); cap the number of tokens with --limit
npm run dev -- find 0xaeE022552B539dB18297D7481b6D547C622488B3 -l 10 -o wallet.json

# Limit a large series to the first N tokens
npm run dev -- find https://www.artblocks.io/collection/ringers-by-dmitri-cherniak -l 5 -o ringers.json

# Build and publish to a configured feed server
npm run dev -- find https://objkt.com/tokens/hicetnunc/111068 --publish

# Build, play on a named device, and skip interactive prompts
npm run dev -- find https://objkt.com/tokens/hicetnunc/111068 --play -d "Living Room Display" -y
```

OpenSea and Verse accept both item and collection/series URLs:

```bash
# OpenSea collection (Ethereum); slug resolved from the public page, no API key
npm run dev -- find https://opensea.io/collection/your-collection-slug -l 5 -o opensea.json

# Verse series
npm run dev -- find https://verse.works/series/your-series-slug -l 5 -o verse.json
```

Run `npm run dev -- find --help` for the full input list and options.

## Build from structured params

Use `ff-cli build` when you already have the contract, token IDs, feed names, or artwork ids and want explicit control over ordering, durations, and title. The input is a JSON object with `requirements` and optional `playlistSettings`.

```bash
# From a file
npm run dev -- build examples/params-example.json -o playlist.json

# From stdin
cat examples/params-example.json | npm run dev -- build -o playlist.json
```

Each requirement has a `type`:

- `build_playlist` — `blockchain`, `contractAddress`, `tokenIds`, optional `quantity`
- `feral_file_artwork` — `artworkId` (a Feral File public artwork id or `/exhibitions/artwork/{id}` URL)
- `query_address` — `ownerAddress`, optional `quantity` (random selection)
- `fetch_feed` — `playlistName`, `quantity`

`playlistSettings` may set `title`, `durationPerItem`, `preserveOrder` (set `false` to shuffle), and `deviceName`.

### From a contract + token IDs

```bash
cat > /tmp/eth-tokens.json <<'JSON'
{
  "requirements": [
    {
      "type": "build_playlist",
      "blockchain": "ethereum",
      "contractAddress": "0xb932a70A57673d89f4acfFBE830E8ed7f75Fb9e0",
      "tokenIds": ["52932", "52457"]
    }
  ],
  "playlistSettings": {
    "title": "ETH Tokens",
    "preserveOrder": false,
    "durationPerItem": 7
  }
}
JSON

npm run dev -- build /tmp/eth-tokens.json -o playlist-eth.json -v
```

Tezos works the same way with `"blockchain": "tezos"` and a `KT1...` contract:

```bash
cat > /tmp/tez-tokens.json <<'JSON'
{
  "requirements": [
    {
      "type": "build_playlist",
      "blockchain": "tezos",
      "contractAddress": "KT1BcNnzWze3vCviwiETYNwcFSwjv6RihZEQ",
      "tokenIds": ["22", "8"]
    }
  ],
  "playlistSettings": { "title": "Tezos Tokens", "preserveOrder": false }
}
JSON

npm run dev -- build /tmp/tez-tokens.json -o playlist-tez.json -v
```

### From a wallet address

```bash
cat > /tmp/wallet.json <<'JSON'
{
  "requirements": [
    {
      "type": "query_address",
      "ownerAddress": "0xaeE022552B539dB18297D7481b6D547C622488B3",
      "quantity": 5
    }
  ],
  "playlistSettings": { "title": "From a wallet", "preserveOrder": false }
}
JSON

npm run dev -- build /tmp/wallet.json -o playlist-wallet.json -v
```

### From a feed playlist

Feed playlist queries require reachable feed servers in your config. Reference exhibition titles from the official playlist repository: `https://github.com/feral-file/dp1-feed/tree/main/playlists`.

```bash
cat > /tmp/feed.json <<'JSON'
{
  "requirements": [
    { "type": "fetch_feed", "playlistName": "Unsupervised", "quantity": 3 }
  ],
  "playlistSettings": { "title": "From a feed", "preserveOrder": false }
}
JSON

npm run dev -- build /tmp/feed.json -o playlist-feed.json -v
```

### From a Feral File artwork

```bash
cat > /tmp/ff-artwork.json <<'JSON'
{
  "requirements": [
    {
      "type": "feral_file_artwork",
      "artworkId": "https://feralfile.com/exhibitions/artwork/f0240e04d64717e319584957f6a83954b029254ad1260b6320472ea8c0c5b1cf"
    }
  ],
  "playlistSettings": { "title": "Feral File Artwork" }
}
JSON

npm run dev -- build /tmp/ff-artwork.json -o playlist.json
```

### Mixing sources in one playlist

Combine multiple requirements; shuffle with `preserveOrder: false` and set per-item timing with `durationPerItem`.

```bash
cat > /tmp/mixed.json <<'JSON'
{
  "requirements": [
    {
      "type": "build_playlist",
      "blockchain": "tezos",
      "contractAddress": "KT1BcNnzWze3vCviwiETYNwcFSwjv6RihZEQ",
      "tokenIds": ["22", "8"]
    },
    {
      "type": "build_playlist",
      "blockchain": "ethereum",
      "contractAddress": "0xb932a70A57673d89f4acfFBE830E8ed7f75Fb9e0",
      "tokenIds": ["52932", "52457"]
    },
    { "type": "fetch_feed", "playlistName": "Unsupervised", "quantity": 3 },
    { "type": "query_address", "ownerAddress": "reas.eth", "quantity": 1 }
  ],
  "playlistSettings": {
    "title": "Mixed",
    "preserveOrder": false,
    "durationPerItem": 6,
    "deviceName": "Living Room Display"
  }
}
JSON

npm run dev -- build /tmp/mixed.json -o playlist-mixed.json -v
```

## Validate / Sign / Play

```bash
# Validate playlist structure
npm run dev -- validate playlist.json
npm run dev -- validate "https://cdn.example.com/playlist.json"

# Validate structure AND verify signatures
npm run dev -- verify playlist.json

# Sign playlist (uses key/role from config, or override via --key / --role)
npm run dev -- sign playlist.json -o signed.json

# Play on the configured default device
npm run dev -- play playlist.json

# Play on a specific named device
npm run dev -- play signed.json -d "Living Room Display"

# Play a hosted DP-1 playlist
npm run dev -- play "https://cdn.example.com/playlist.json"

# Play a media URL directly
npm run dev -- play "https://example.com/video.mp4"

# Skip verification only if you must send a non-conformant payload (not recommended)
npm run dev -- play playlist.json --skip-verify
```

> **No feed server is required to cast.** A device can play any static, signed DP-1 playlist hosted at a public URL — sign it (`sign`), upload the JSON anywhere that serves it over HTTPS (S3, Supabase Storage, a static host, etc.), then `ff-cli play "<url>"`. The DP-1 Feed server ([Publish to Feed Server](#publish-to-feed-server) below) adds discovery and curation, but is optional for simply playing your own playlists.

## Publish to Feed Server

Publish validated playlists to a DP-1 feed server for sharing and discovery.

### Configuration

Add feed servers to `config.json`:

```json
{
  "feedServers": [
    {
      "baseUrl": "http://localhost:8787/api/v1",
      "apiKey": "your-api-key"
    },
    {
      "baseUrl": "https://feed.example.com/api/v1",
      "apiKey": "your-api-key"
    }
  ]
}
```

### Publish Commands

```bash
# Interactive: list servers and ask which to use
npm run dev -- publish playlist.json

# Direct: publish to specific server (server index 0)
npm run dev -- publish playlist.json -s 0

# Show help
npm run dev -- publish --help
```

### Flow

1. **Verify** - Playlist structure and signatures checked; unsigned or broken playlists are rejected
2. **Select Server** - If multiple servers, choose which one (interactive or via `-s` flag)
3. **Publish** - Send the verified playlist to the selected feed server
4. **Confirm** - Returns playlist ID and server details

### Example Output

```
$ npm run dev -- publish playlist.json

📡 Publishing playlist to feed server...

Multiple feed servers found. Select one:
  0: http://localhost:8787/api/v1
  1: https://feed.example.com/api/v1

Select server (0-based index): 0

✅ Playlist published successfully!
   Playlist ID: 84e028f8-ea12-4779-a496-64f95f0486cd
   Server: http://localhost:8787/api/v1
   Status: Published to feed server (created)
```

### Error Handling

**Validation failed:**

```
❌ Failed to publish playlist
   Playlist validation failed: dpVersion: Required; id: Required
```

**File not found:**

```
❌ Failed to publish playlist
   Playlist file not found: /path/to/playlist.json
```

**API error:**

```
❌ Failed to publish playlist
   Failed to publish: {"error":"unauthorized","message":"Invalid API key"}
```

## Complete Flow (build → validate → sign → play → publish)

```bash
# 1. Build a playlist (via find or build)
npm run dev -- find https://objkt.com/tokens/hicetnunc/111068 -o playlist.json

# 2. Validate it
npm run dev -- validate playlist.json

# 3. Sign it
npm run dev -- sign playlist.json -o signed.json

# 4. Play it on a device
npm run dev -- play signed.json -d "Living Room Display"

# 5. Publish to a feed server
npm run dev -- publish signed.json -s 0
```

`ff-cli find` can collapse build + play + publish into one command:

```bash
npm run dev -- find https://objkt.com/tokens/hicetnunc/111068 --play -d "Living Room Display" --publish
```

## FF1 device management

```bash
# List configured devices
npm run dev -- device list

# Add a device interactively (with mDNS discovery)
npm run dev -- device add

# Add a device non-interactively
npm run dev -- device add --host 192.168.1.100 --name kitchen

# Remove a device by name
npm run dev -- device remove kitchen

# Set the default device (used when -d is omitted)
npm run dev -- device default office
```

## Troubleshooting

```bash
# Show current configuration
npm run dev -- config show

# Reinitialize config
npm run dev -- config init

# Validate configuration
npm run dev -- config validate
```

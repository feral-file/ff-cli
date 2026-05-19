# Examples

Copy‑pasteable commands that work with the current CLI.

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

## OpenClaw skill prompt

If you want OpenClaw to run ff-cli end-to-end without confirmation, start from:

`skills/ff-control/SKILL.md`

Recommended local install path:

```bash
mkdir -p ~/.openclaw/skills
ln -sfn ~/Work/ff-cli/skills/ff-control ~/.openclaw/skills/ff-control
```

Compatibility copy (same prompt):

`examples/openclaw-ff-skill.md`

Paste that prompt into your OpenClaw skill config, then test with plain requests like:

```bash
"Get 3 works from reas.eth and send to Living Room"
"Get 3 from Unsupervised and publish to my feed"
```

## Natural Language

```bash
# Interactive chat
npm run dev chat

# One-shot requests
npm run dev -- chat "Get 3 works from reas.eth" -o playlist.json
npm run dev -- chat "Get 3 works from einstein-rosen.tez"
npm run dev -- chat "Get tokens 52932,52457 from Ethereum contract 0xb932a70A57673d89f4acfFBE830E8ed7f75Fb9e0" -v
npm run dev -- chat "Make a playlist of 10 works from 0xaeE022552B539dB18297D7481b6D547C622488B3" -v

# Switch model
npm run dev -- chat "your request" --model grok
npm run dev -- chat "your request" --model gpt
npm run dev -- chat "your request" --model gemini

# Model names must match keys in config.json under `models`.
```

## Deterministic Build (no AI)

```bash
# From file
npm run dev -- build examples/params-example.json -o playlist.json

# From stdin
cat examples/params-example.json | npm run dev -- build -o playlist.json
```

Build from a Feral File public artwork id or artwork URL:

```bash
cat > /tmp/ff-artwork.json <<'JSON'
{
  "requirements": [
    {
      "type": "feral_file_artwork",
      "artworkId": "https://feralfile.com/exhibitions/artwork/f0240e04d64717e319584957f6a83954b029254ad1260b6320472ea8c0c5b1cf"
    }
  ],
  "playlistSettings": {
    "title": "Feral File Artwork"
  }
}
JSON

npm run dev -- build /tmp/ff-artwork.json -o playlist.json
```

## AI‑Orchestrated Deterministic Flow (prompts)

```bash
# Show tool‑call progress and validation
npm run dev -- chat "Build a playlist of my works from reas.eth plus 3 from Unsupervised" -v -o playlist.json

# Build from a Feral File artwork URL
npm run dev -- chat "Build a playlist from https://feralfile.com/exhibitions/artwork/f0240e04d64717e319584957f6a83954b029254ad1260b6320472ea8c0c5b1cf" -v -o playlist.json

# Switch model if desired
npm run dev -- chat "Build playlist from Ethereum address 0xaeE022552B539dB18297D7481b6D547C622488B3 and 2 from Unsupervised" --model gpt -v
```

### One‑shot complex prompt

The CLI can parse rich requests and do it all in one go: fetch, build a DP‑1 playlist, shuffle, set durations, and send to a named device.

```bash
# Example: combine sources, shuffle, set 6s per item, and send to device
npm run dev -- chat "Get tokens 52932,52457 from contract 0xb932a70A57673d89f4acfFBE830E8ed7f75Fb9e0 and 2 from reas.eth; shuffle; 6 seconds each; send to 'Living Room Display'." -o playlist.json -v
```

## Feral File Built Playlists

Use exhibition titles from the official playlist repository:
`https://github.com/feral-file/dp1-feed/tree/main/playlists`

```bash
# Fetch from a built playlist title
npm run dev -- chat "Get 3 from Unsupervised" -v

# Mix a built playlist with wallet/domain sources
npm run dev -- chat "Get 3 from Unsupervised and 2 from reas.eth" -v -o playlist.json
```

Notes:

- Feed playlist queries require reachable feed servers in your config.
- If no feeds are reachable, feed playlist examples will fail even if the title exists.
- Bare EVM prompts (`from 0x...`) now fall back from owner lookup to contract lookup when needed.

## Natural Language: Display and Publish

The CLI recognizes publishing keywords like "publish", "publish to my feed", "push to feed", "send to feed" and automatically publishes after building.

### Basic Publishing

```bash
# Build and publish
npm run dev -- chat "Build playlist from Ethereum contract 0xb932a70A57673d89f4acfFBE830E8ed7f75Fb9e0 with tokens 52932 and 52457; publish to my feed" -o playlist.json -v

# With feed selection (if multiple servers configured)
# The CLI will ask: "Which feed server? 1) https://dp1-feed-operator-api-prod.autonomy-system.workers.dev/api/v1 2) http://localhost:8787"
npm run dev -- chat "Get 3 from Unsupervised and publish to feed" -v

# Publish existing playlist (defaults to ./playlist.json)
npm run dev chat
# Then type: "publish playlist"

# Publish specific playlist file
npm run dev chat
# Then type: "publish the playlist ./playlist-temp.json"
```

### Combined: Display + Publish

```bash
# Display on Art Computer AND publish to feed
npm run dev -- chat "Build playlist from contract 0xb932a70A57673d89f4acfFBE830E8ed7f75Fb9e0 with tokens 52932 and 52457; mix them up; send to my Art Computer and publish to my feed" -o playlist.json -v

# With explicit device name
npm run dev -- chat "Get 5 from Unsupervised, shuffle, display on 'Living Room', and publish to feed" -v
```

### How It Works

**Mode 1: Build and Publish** (when sources are mentioned)

1. Intent parser detects "publish" keywords with sources/requirements
2. Calls `get_feed_servers` to retrieve configured servers
3. If 1 server → uses it automatically; if 2+ servers → asks user to pick
4. Builds playlist → validates structure → publishes automatically

**Mode 2: Publish Existing File** (e.g., "publish playlist")

1. Intent parser detects "publish playlist" or similar phrases
2. Calls `get_feed_servers` to retrieve configured servers
3. If 1 server → uses it automatically; if 2+ servers → asks user to pick
4. Publishes the playlist from `./playlist.json` (or specified path)

Output shows:

- Playlist build progress (Mode 1 only)
- Device sending (if requested): `✓ Sent to device: Living Room`
- Publishing status: `✓ Published to feed server`
- Playlist ID: `Playlist ID: 84e028f8-...`

## Validate / Sign / Send

```bash
# Validate playlist
npm run dev -- validate playlist.json
npm run dev -- validate "https://cdn.example.com/playlist.json"

# Sign playlist
npm run dev -- sign playlist.json -o signed.json

# Send to device
npm run dev -- send playlist.json -d "Living Room Display"
npm run dev -- send "https://cdn.example.com/playlist.json" -d "Living Room Display"
```

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

1. **Validate** - Playlist structure checked (`validate`-style parse; use `verify` for signatures)
2. **Select Server** - If multiple servers, choose which one (interactive or via `-s` flag)
3. **Publish** - Send validated playlist to selected feed server
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

## Validate / Sign / Send / Publish (Complete Flow)

```bash
# 1. Create a playlist (via chat or build)
npm run dev -- chat "Get 3 works from reas.eth" -o playlist.json

# 2. Validate it
npm run dev -- validate playlist.json

# 3. Sign it
npm run dev -- sign playlist.json -o signed.json

# 4. Send to device
npm run dev -- send signed.json -d "My Display"

# 5. Publish to feed server
npm run dev -- publish signed.json -s 0
```

## Troubleshooting

```bash
# Show current configuration
npm run dev -- config show

# Reinitialize config
npm run dev -- config init
```

### Natural‑language one‑shot examples (proven)

- **ETH contract + token IDs (shuffle/mix, generic device)**
  - Format:
    ```bash
    npm run dev -- chat "Compose a playlist from Ethereum contract <0x...> with tokens <id> and <id>; [shuffle|mix]; [send to device|send to '<device>']" -o <output.json> -v
    ```
  - Example:
    ```bash
    npm run dev -- chat "Compose a playlist from Ethereum contract 0xb932a70A57673d89f4acfFBE830E8ed7f75Fb9e0 with tokens 52932 and 52457; mix them up; send to device" -o playlist-eth.json -v
    ```

- **TEZ contract + token IDs (shuffle, named device)**
  - Format:
    ```bash
    npm run dev -- chat "Build a playlist from Tezos contract <KT1...> with tokens <id> and <id>; shuffle; send to '<device>'" -o <output.json> -v
    ```
  - Example:
    ```bash
    npm run dev -- chat "Build a playlist from Tezos contract KT1BcNnzWze3vCviwiETYNwcFSwjv6RihZEQ with tokens 22 and 8; shuffle; send to 'Living Room'" -o playlist-tez.json -v
    ```

- **Owner address (ENS → ETH), shuffled**
  - Format:
    ```bash
    npm run dev -- chat "Create a playlist from address <ens> (<n> items); [shuffle|mix]; [send/push to my device]" -o <output.json> -v
    ```
  - Example:
    ```bash
    npm run dev -- chat "Create a playlist from address reas.eth (5 items); shuffle; push to my device" -o playlist-ens.json -v
    ```

- **Owner address (Tezos tz1), shuffled**
  - Format:
    ```bash
    npm run dev -- chat "Create a playlist from Tezos address <tz1...> (<n> items); [shuffle|mix]; [send to device]" -o <output.json> -v
    ```
  - Example:
    ```bash
    npm run dev -- chat "Create a playlist from Tezos address tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb (3 items); mix them up; send to device" -o playlist-tz1.json -v
    ```

- **Feed playlists (named), shuffled**
  - Format:
    ```bash
    npm run dev -- chat "[Create|Build] a playlist from feed '<name>' (<n> items); shuffle; [send to device]" -o <output.json> -v
    ```
  - Examples:
    ```bash
    npm run dev -- chat "Create a playlist from feed 'Unsupervised' (3 items); shuffle; send to device" -o playlist-feed1.json -v
    npm run dev -- chat "Build a playlist from feed 'Unsupervised' (3 items); shuffle; send to device" -o playlist-feed2.json -v
    ```

- **Mixed in one prompt (ETH + TEZ + feed + ENS), shuffled, named device**
  - Format:
    ```bash
    npm run dev -- chat "Compose a playlist: Tezos <KT1...> tokens <id>, <id>; Ethereum <0x...> tokens <id>, <id>; <n> from '<feed>'; <m> from <ens>; shuffle; send to '<device>'" -o <output.json> -v
    ```
  - Example:
    ```bash
    npm run dev -- chat "Compose a playlist: Tezos KT1BcNnzWze3vCviwiETYNwcFSwjv6RihZEQ tokens 22, 8; Ethereum 0xb932a70A57673d89f4acfFBE830E8ed7f75Fb9e0 tokens 52932, 52457; 3 from 'Unsupervised'; 1 from reas.eth; shuffle; send to 'Living Room'" -o playlist-mixed.json -v
    ```

- **Multiple instructions in one prompt (incremental), shuffled**
  - Format:
    ```bash
    npm run dev -- chat "Create a playlist from Ethereum contract <0x...> tokens <id>, <id>; then add <n> from '<feed>'; then add <m> from <ens>; shuffle; [send/push to my device]" -o <output.json> -v
    ```
  - Example:
    ```bash
    npm run dev -- chat "Create a playlist from Ethereum contract 0xb932a70A57673d89f4acfFBE830E8ed7f75Fb9e0 tokens 52932, 52457; then add 2 from 'Unsupervised'; then add 1 from reas.eth; shuffle; push to my device" -o playlist-multi.json -v
    ```

- **Synonym variants for the same ETH case**
  - Format:
    ```bash
    npm run dev -- chat "[Build|Create|Compose] a playlist from Ethereum contract <0x...> tokens <id> and <id>; send to device" -o <output.json> -v
    ```
  - Examples:
    ```bash
    npm run dev -- chat "Build a playlist from Ethereum contract 0xb932a70A57673d89f4acfFBE830E8ed7f75Fb9e0 tokens 52932 and 52457; send to device" -o playlist-eth-build.json -v
    npm run dev -- chat "Create a playlist from Ethereum contract 0xb932a70A57673d89f4acfFBE830E8ed7f75Fb9e0 tokens 52932 and 52457; send to device" -o playlist-eth-create.json -v
    ```

- **Device targeting: generic vs named**
  - Format:
    ```bash
    npm run dev -- chat "Compose a playlist from <ens/address> (<n> items); send to device" -o <output.json> -v
    npm run dev -- chat "Compose a playlist from <ens/address> (<n> items); send to '<device>'" -o <output.json> -v
    ```
  - Examples:
    ```bash
    npm run dev -- chat "Compose a playlist from reas.eth (3 items); send to device" -o playlist-generic-device.json -v
    npm run dev -- chat "Compose a playlist from reas.eth (3 items); send to 'Living Room'" -o playlist-named-device.json -v
    ```

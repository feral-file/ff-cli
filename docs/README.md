# ff-cli Documentation

ff-cli is a set of deterministic commands for building DP-1 (Display Protocol 1) playlists and playing them on an Art Computer. There's no built-in chat — natural language belongs in your coding agent (Claude Code, Codex), which drives ff-cli through the `ff-control` skill. No LLM API key required. This doc covers install, config, and day‑to‑day usage.

For project-level planning and future agentic work, see `./PROJECT_SPEC.md`.

## Install

```bash
npm i -g @feralfile/cli
```

`npm` and `npx` require **Node.js 22 or newer** (see `package.json` `engines`). When a release raises the Node floor, that is a **breaking** change for Node 18/20 users; the GitHub Release for that version should say so explicitly (see `./RELEASING.md` for maintainer guidance).

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
  "defaultDuration": 10,
  "playlist": {
    "privateKey": "your_ed25519_private_key_hex_or_base64_here",
    "curatorName": "YOUR_CURATOR_NAME"
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
# Resolve a URL, on-chain coords, or wallet and build a playlist
ff-cli find https://www.artblocks.io/collection/ringers-by-dmitri-cherniak -o playlist.json

# Build and play it on your FF1 in one step
ff-cli find https://objkt.com/tokens/hicetnunc/111068 --play

# Build from pre-structured params (JSON file or stdin)
ff-cli build examples/params-example.json -o playlist.json
```

For development in this repo:

```bash
npm run build
node dist/index.js find https://objkt.com/tokens/hicetnunc/111068 --play
```

If you're running from source without a build, use:

```bash
npm run dev -- find https://objkt.com/tokens/hicetnunc/111068 --play
```

## Two ways to build a playlist

ff-cli is deterministic: no chat, no model orchestration. There are two entry points for assembling a playlist.

1. **`ff-cli find "<input>"`** — resolve a marketplace URL, raw `chain:contract:tokenId`, or wallet address into a playable DP-1 playlist. Add `--play` to build and play in one step. This is the fastest path for a single artwork, a collection/series, or a wallet.
2. **`ff-cli build <params.json>`** — build from pre-structured `requirements` and `playlistSettings` (JSON file or stdin). Use this when you already have the contract, token IDs, feed names, or artwork ids and want explicit control over ordering, durations, and title.

Both paths run the same deterministic pipeline: fetch metadata, assemble a DP-1 envelope, and validate it. Validation rejects malformed data rather than passing it through. Natural language lives in your coding agent (Claude Code, Codex) via the `ff-control` skill, which translates a request into one of these two commands.

## Commands (cheat sheet)

- `build [params.json]` – Deterministic build from JSON or stdin
  - Options: `-o, --output <file>`, `-v, --verbose`
- `validate <file-or-url>` – Validate playlist structure only
- `verify <file-or-url>` – Validate structure and verify signatures. On failure, the CLI labels structure issues separately from signature verification. dp1-js uses `--public-key` (or a key derived from `playlist.privateKey` / `PLAYLIST_PRIVATE_KEY` when omitted) **only** for legacy flat `signature` verification; DP-1 v1.1.0 `signatures[]` envelopes are verified without relying on that argument. If deriving or normalizing key material fails, the CLI prints a warning on stderr and continues without it (legacy verification still requires a usable key when the playlist uses a flat `signature`). The derived key is emitted as PEM. Supported key forms: hex with optional `0x`, PEM, or 32-byte raw public key as hex or base64
- `sign <file>` – Sign playlist with a DP-1 v1.1.0 multi-signature envelope (private key string is forwarded to **`dp1-js`**; same hex or base64 PKCS#8 DER forms as `playlist.privateKey` in `./CONFIGURATION.md`). The command verifies the final envelope before writing output and refuses to persist tampered or otherwise unverifiable `signatures[]`.
  - Options: `-k, --key <privateKey>`, `-r, --role <role>`, `-o, --output <file>`, `--replace-signatures`
  - Signing **appends** by default, so repeated runs accumulate endorsements. That is only correct while the signed content is unchanged: editing a signed playlist moves bytes the earlier signatures cover, and the envelope check then refuses to write the result. `--replace-signatures` discards every existing entry — including a feed's own co-signature — and signs the document as it stands. It is the required step before `publish --replace`
  - `--replace-signatures` names each discarded entry by role and the last 8 characters of its `kid`, and verifies it against the document as it now stands. Your own earlier signature is replaced by the same run. Another key's entry that **still verifies** — which is every entry when the content was not edited, since the signing payload excludes `signatures` — is reported as removed; keep the previous file if you want it back. An entry that does **not** verify is reported as exactly that and no more: the command has only the document as it stands, so it cannot tell an edit from an entry that was never valid, and it does not guess. Roles are carried through as found (`agent`, `institution` and `licensor` are as valid as `curator`), and a flat legacy `signature` is reported as not checkable, since it carries no key or role at all
- `play <source>` – Play a playlist file, playlist URL, or media URL on an FF1 device (runs `verify` before sending; only the CLI-synthesized media URL fallback is auto-signed when a signing key is configured; use `--skip-verify` to bypass the gate)
  - Options: `-d, --device <name>`, `--skip-verify` (skip signature verification; not recommended)
- `find <input>` – Resolve a marketplace URL, raw `chain:contract:tokenId`, or wallet address into a playable DP-1 playlist
  - Sources: Art Blocks, Objkt, fxhash, OpenSea, SuperRare, Feral File, Neort, Verse, raw on-chain coordinates, and wallet addresses
  - OpenSea forms: `/assets/ethereum/{contract}/{tokenId}`, `/item/ethereum/{contract}/{tokenId}`, and `/collection/{slug}` (Ethereum collections; the slug is resolved from the public collection page, no API key needed)
  - Verse forms: `/items/ethereum/{contract}/{tokenId}` and `/series/{slug}`
  - Options: `-o, --output <path>`, `-l, --limit <n>`, `-p, --play`, `-d, --device <name>`, `--publish`, `-s, --server <index>`, `-y, --yes`, `--skip-verify`
- `enrich <file>` – Add missing artist, title, and thumbnail metadata to a playlist that already exists. Resolves each item by its `provenance.contract` and writes an inline Ref Manifest; `source`, `duration`, `title`, and `id` are never touched. Drops the signature when it changes anything, so re-sign afterwards
  - DP-1 `evm` names a chain family rather than a network, so those items are skipped unless `--assume-ethereum` asserts which one they are. Getting that wrong attaches another artwork's metadata
  - Options: `-o, --output <file>`, `--force` (replace existing manifests), `--assume-ethereum`, `-v, --verbose`
- `publish <file>` – Publish a playlist to a feed server (runs `verify` before upload and rejects unsigned or broken playlists)
  - Options: `-s, --server <index>` (server index if multiple configured), `--replace` (replace the playlist already stored under this document id instead of creating a new one), `-k, --key <privateKey>` (signs the replace authorization; `--replace` only)
  - `--key` is refused on a plain `publish`, which signs nothing at request time — it uploads the `signatures[]` envelope the document already carries. Sign the file with `ff-cli sign --key` instead
- `fetch <id-or-url>` – Save a published playlist from a feed server. Accepts a playlist id, a slug, or a feed URL. The document goes to `-o` when given and to stdout otherwise (status lines always go to stderr, so `ff-cli fetch <id> > playlist.json` works). This is the starting point for `publish --replace`, which requires the stored `id`, `slug`, and `created`
  - Options: `-s, --server <index>`, `-o, --output <file>`. There is no `--key`: a fetch is a plain read and signs nothing
- `unpublish <id-or-url>` – Delete a playlist from a feed server. Accepts a playlist id, a slug, or a feed URL. Requires the signing key to be an owner of the stored playlist, and confirms before deleting
  - Options: `-s, --server <index>`, `-y, --yes` (skip the confirmation), `-k, --key <privateKey>` (signs the delete authorization)
- `ssh <enable|disable>` – Manage SSH access on an FF1 device
  - Options: `-d, --device <name>`, `--pubkey <path>`, `--ttl <duration>`
- `device list` – List all configured FF1 devices
- `device add` – Add a device with mDNS or manual `--host`, `--name`, and `--id`
  - Options: `--host <host>`, `--name <name>`, `--id <id>`
- `device pair [name]` – Securely receive relayer access from Feral File mobile
- `device rename <name> <new-name>` – Rename a configured FF1 device (host, API key, and default status are untouched)
- `device remove <name>` – Remove a configured FF1 device
- `device default <name>` – Set the default FF1 device (used when `-d` is omitted)
- `config <init|show|validate>` – Manage configuration

## Usage Highlights

### Find an artwork

`ff-cli find` resolves a URL, raw `chain:contract:tokenId`, or wallet address into a playable DP-1 playlist.

```bash
# Paste a URL and play it on your FF1
ff-cli find https://www.artblocks.io/collection/ringers-by-dmitri-cherniak --play

# Tezos / hic et nunc via Objkt (the alias resolves to a KT1 contract)
ff-cli find https://objkt.com/tokens/hicetnunc/111068 --play

# Save without playing
ff-cli find ethereum:0xababababab20053426ad1c782de9ea8444358070:5001410 -o send-receive.json

# Wallet address (owner lookup); cap the number of tokens with --limit
ff-cli find 0xaeE022552B539dB18297D7481b6D547C622488B3 -l 10 -o wallet.json

# Build and publish to a configured feed server
ff-cli find https://objkt.com/tokens/hicetnunc/111068 --publish
```

Sources: Art Blocks, Objkt, fxhash, OpenSea, SuperRare, Feral File, Neort, Verse, raw on-chain coordinates, and wallet addresses. Run `ff-cli find --help` for the full input list.

### Build from structured params

```bash
ff-cli build params.json -o playlist.json
cat params.json | ff-cli build -o playlist.json
```

`params.json` should include `requirements` and optional `playlistSettings`. See `examples/params-example.json`. Each requirement has a `type`:

- `build_playlist` — `blockchain`, `contractAddress`, `tokenIds`, optional `quantity`
- `feral_file_artwork` — `artworkId` (a Feral File public artwork id or `/exhibitions/artwork/{id}` URL)
- `query_address` — `ownerAddress`, optional `quantity` (random selection)
- `fetch_feed` — `playlistName`, `quantity`

`playlistSettings` may set `title`, `durationPerItem`, `preserveOrder` (set `false` to shuffle), and `deviceName`. Feed playlists (for example `Unsupervised`, `Social Codes`) depend on your configured feed servers and network reachability; use exact or near-exact playlist titles for best results.

```json
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
    "title": "My Mix",
    "preserveOrder": false,
    "durationPerItem": 7
  }
}
```

### Enrich a playlist that came from somewhere else

`find` and `build` label every item they create. A playlist assembled by hand,
copied from another document, or written before inline manifests existed has no
`inlineManifest`, and on a device that shows as a tombstone with no artist line
and an empty tile in the app's grid — the app can draw a thumbnail from an
image, video, or SVG source, but not from a live HTML work.

`ff-cli enrich` fills that in from the indexer, keyed on each item's
`provenance.contract`:

```bash
ff-cli enrich playlist.json --assume-ethereum
ff-cli enrich playlist.json --assume-ethereum -o labelled.json
ff-cli enrich playlist.json --assume-ethereum --force   # replace existing manifests
```

`--assume-ethereum` is needed for most playlists. DP-1 records an EVM
coordinate as `chain: "evm"`, which names Ethereum, Polygon, Arbitrum,
Optimism, Base and Zora alike, and the indexer's answer collapses back to the
same word. Enrichment will not pick one for you, because the wrong member
returns a different artwork's artist and still — into a document you then sign.

It writes `inlineManifest` and nothing else. Items with no
`provenance.contract` chain, address, and token id cannot be looked up and are
reported rather than guessed at, and items carrying an external `ref` are left
alone because `ref` outranks an inline manifest at the device. The playlist is
validated before and after; on failure the file is left untouched. Enriching
changes the document, so the signature is removed and the playlist must be
re-signed before playing:

```bash
ff-cli enrich playlist.json --assume-ethereum && ff-cli sign playlist.json
```

That role is fine for casting. Use `ff-cli sign playlist.json -r curator` if the enriched playlist is
also going to a feed.

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

Publishing needs no credentials. The feed authorizes a create from the signatures inside the playlist:
it requires a signature whose `kid` matches a key the document declares in `curators[]`.

`ff-cli publish` additionally requires that signature to carry the **`curator` role**. That is ff-cli's
check, not every feed's answer today: feeds are moving to role-aware ownership, where being named in
`curators[]` is a claim and signing as `curator` is the proof. A feed that does not check the role yet
accepts an `agent`-signed document — and can then authorize neither a replace nor a delete for it, since
both need an owner signature it does not carry. Publishing is what makes that permanent, so the CLI
refuses first.

Declare it before signing, not after: a signature covers `curators[]`, so adding the entry to an
already-signed playlist invalidates it, and signing again appends rather than replaces. Run
`ff-cli status` to read the `did:key` your signatures will carry, put it in `curators[]`, then sign
once **with the owner role**:

```bash
ff-cli sign playlist.json -r curator
```

The flag is needed because plain `ff-cli sign` uses `playlist.role`, which defaults to `agent` — a
document `ff-cli publish` then refuses. Set `"role": "curator"` under `playlist` in `config.json` to make
that the default for hand-signed playlists.

If you sign with `sign --key <privateKey>`, read that key's identity with
`ff-cli status --key <privateKey>` — the configured identity would be the wrong one to declare. `find`
and `build` need none of this: they declare the key and sign it as `curator` for you when a signing key
is configured. An `apiKey` left over in an existing config is ignored.

```json
{
  "feedServers": [
    {
      "baseUrl": "http://localhost:8787/api/v1"
    },
    {
      "baseUrl": "https://feed.example.com/api/v1"
    }
  ]
}
```

### Change or remove a published playlist

A feed's `PUT` and `DELETE` are owner-bound. Neither takes an API key, and neither is authorized by the
document alone: both carry a short-lived **intent** that ff-cli signs with the configured key in the
`curator` role. Only a key the *stored* playlist names in `curators[]` can authorize either one, which is
why `publish` refuses to create a playlist that carries no owner-role signature — such a document can be
neither replaced nor deleted, ever.

```bash
# Edit a published playlist: fetch it, change the file, re-sign fresh, then replace.
ff-cli fetch <id> -o playlist.json -s 0
#   ...edit the title, items, or metadata...
ff-cli sign playlist.json -r curator --replace-signatures
ff-cli publish playlist.json --replace -s 0

# Delete a published playlist (id, slug, or feed URL all work).
ff-cli unpublish 97595a2f-a790-477c-aa42-b4f2ec9f1e3b -s 0
ff-cli unpublish https://feed.example.com/api/v1/playlists/97595a2f-a790-477c-aa42-b4f2ec9f1e3b
```

`--replace-signatures` is not optional on that path. The document you fetched carries the curator's
signature and the feed's, both taken over the pre-edit content; a plain `ff-cli sign` appends to them and
the envelope check then refuses to write a file with stale entries in it. Signing fresh drops both — the
feed re-appends its own after it verifies the replacement.

`--replace` keeps identity fixed: `id`, `slug`, and `created` must equal the stored document's, and the
`curators[]` owner set may not change. Editing a published playlist therefore means editing the document
you published — re-running `find` or `build` mints a fresh id, slug, and `created`, which is a new
playlist rather than a replacement. A `publish` without `--replace` is never silently upgraded to a
replace; an id the feed already holds fails with a conflict, as before.

`-k, --key` overrides the configured signing key on both — for the intent signature and for the local
ownership check — the way `ff-cli sign --key` and `ff-cli status --key` already do. A `--key` that is
present but empty (what `--key "$SIGNING_KEY"` becomes when the variable is unset) is **rejected**, never
treated as absent: falling back to the configured key would authorize the write under an identity you did
not choose, and a delete cannot be taken back. `unpublish` derives the identity before it looks the
playlist up, so a bad credential fails before you are asked to confirm anything. The configured key
is one identity; the key that owns a given playlist may be another, and editing `config.json` to delete
something you own is not a workflow.

Both verbs prove ownership locally before signing anything. A key counts as an owner only when the
**stored** playlist names it in `curators[]` **and** carries its valid `curator`-role signature — being
named is a claim, signing in the owner role is the proof. A playlist that declares a curator but was
signed under another role (the shape of anything published while the default role was `agent`) can never
be replaced or deleted by anyone, and the CLI says so rather than sending a request the feed will refuse.

`unpublish` asks for confirmation first, showing the title and the server. `-y` skips it for scripts.
Deletion is final in a way worth knowing before you run it: the feed **tombstones** the id, so the
playlist cannot be restored and a later publish naming that id is refused. Build a new playlist instead.

### FF1 device management

```bash
# List configured devices
ff-cli device list

# Add a device (interactive with mDNS discovery)
ff-cli device add

# Add a device non-interactively
ff-cli device add --host 192.168.1.100 --name kitchen --id FF1-XXXXXXXX

# Rename a device (host, API key, and default status are untouched)
ff-cli device rename kitchen gallery

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
- Per-item timing: when no duration is given, video/audio items carry **no** `duration` and `display.loop: false`, so the player advances at end-of-stream (DP-1 §4.1) — the media plays its natural length. Static items use `defaultDuration` (10s unless configured). An explicit duration always wins.

## Links

- Examples: `./EXAMPLES.md`
- Releasing: `./RELEASING.md`
- DP1 spec: `https://github.com/display-protocol/dp1`

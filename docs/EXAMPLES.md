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

## Enrich an existing playlist

A playlist whose items carry `provenance` but no `inlineManifest` labels
title-only on the FF1 tombstone, and shows empty tiles in the app for every
live HTML work. `enrich` repairs it in place.

```bash
ff-cli enrich playlist.json --assume-ethereum
```

```text
Enrich playlist

  18/18 looked up...

18 of 18 item(s) enriched
  Output: playlist.json
```

`--assume-ethereum` is the operator's assertion that the playlist's `evm`
coordinates are Ethereum. DP-1 records every EVM network as `chain: "evm"`,
and `find` writes that for Ethereum works too, so an Ethereum playlist needs
the flag; without it those items are skipped rather than guessed at, because
the wrong network returns a different artwork's metadata. A Tezos playlist
needs no flag.

Items the indexer cannot resolve are listed rather than guessed at:

```text
Nothing to enrich

  Skipped 3:
    Kim Asendorf — PXL NET — no provenance.contract chain/address/tokenId to look up
    Untitled — the indexer returned nothing for it
    Pre-Process — chain "evm" names a family; pass --assume-ethereum to assert the network
```

Enrichment changes the document, so a signed playlist loses its envelope and
has to be re-signed:

```bash
ff-cli enrich playlist.json --assume-ethereum
ff-cli sign playlist.json
ff-cli play playlist.json -d "living room"
```

Casting does not care about the signing role. Add `-r curator` to that `sign` if the playlist is also
going to a feed: `ff-cli publish` requires the owner role, for the reasons in
[Publish to Feed Server](#publish-to-feed-server).

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

# Play a playlist straight from a DP-1 feed server (the URL the feed hands out)
# Wallet-signed (eip191) documents need --skip-verify until #103 lands
npm run dev -- play "https://feed.feralfile.com/api/v1/playlists/<slug>" --skip-verify

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
      "baseUrl": "http://localhost:8787/api/v1"
    },
    {
      "baseUrl": "https://feed.example.com/api/v1"
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

# Replace a playlist already stored under this document id
npm run dev -- publish playlist.json --replace -s 0

# Show help
npm run dev -- publish --help
```

**With more than one server configured and no `-s`, a non-interactive session fails rather than
choosing.** Under a pipe, a cron job, or a CI step there is no terminal to answer the prompt, and
defaulting to the first server would write to production for a script that meant the other one:

```
$ ff-cli publish playlist.json < /dev/null; echo "exit=$?"

Publish playlist

Multiple feed servers configured (2); pass --server <index>
  0: https://feed.feralfile.com/api/v1
  1: http://localhost:8787
exit=1
```

The same rule applies to `unpublish`. With a single server configured, `-s` stays optional everywhere.

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

Both of these are caught locally, before anything is uploaded.

**Not signed:**

```
Publish failed
  Playlist verification failed: Playlist signature verification failed
```

Declare your key in `curators[]`, then sign it as the owner before publishing:

```bash
ff-cli status                          # the did:key to declare
ff-cli sign <file> -r curator
```

Plain `ff-cli sign` would use `playlist.role` (default `agent`), producing a document the next two checks
refuse — under role-aware ownership a declared key counts as an owner only when it signed as `curator`, and
`ff-cli publish` requires that whether or not the target feed enforces it yet. (Posting the unsigned
document straight to the feed answers
`{"error":"unauthorized","message":"missing authentication: request body must carry signatures"}`.)

**Signed, but the signer is not declared as a curator:**

```
Publish failed
  Playlist is signed, but the signing key is not declared as a curator.

The feed accepts a publish when a signature's kid appears in the playlist's own curators[].
  Add this to the playlist before signing:
    "curators": [{ "name": "Your name", "key": "did:key:z6Mkv7qJ..." }]
  then sign again from the unsigned file, with the same key you just declared:
    ff-cli sign <file> -r curator --key <private key for did:key:z6Mkv7qJ...>
  Drop --key if that key is your configured one; "sign" uses the configured key otherwise, and a
  signature from an undeclared key would not satisfy the feed. Start from the unsigned file
  because declaring curators[] changes the signed payload: signing appends, so the earlier
  signature would be left covering a document that no longer exists.
```

This is the most common publish failure, and it is not about credentials. The feed accepts a create when
the document carries a signature whose `kid` matches a key declared in its own `curators[]`; posting such
a document directly returns
`{"error":"signature_verification_failed","message":"curator signature verification: no valid curator signature found"}`,
which reads as a signing fault, so `ff-cli` diagnoses it locally instead.

**Order matters.** A signature covers every field except `signature`/`signatures`, so `curators[]` has to
be declared *before* signing. Adding it afterwards invalidates the signature, and signing again does not
repair it — signing **appends**, leaving the earlier entry covering a document that no longer exists, so
verification fails before upload.

```bash
# 1. Read your signing identity — this is the kid your signatures will carry.
ff-cli status          # → Signing identity (did:key)  did:key:z6Mk...

# 2. Declare it in the UNSIGNED playlist.
#    "curators": [{ "name": "Your Name", "key": "did:key:z6Mk..." }]
#    DP-1 requires `name` alongside `key`.

# 3. Sign once as curator, then publish. The role must match the claim in curators[].
ff-cli sign playlist.json -r curator
ff-cli publish playlist.json
```

If a playlist is already signed and you need to add `curators[]`, start again from the unsigned file
rather than re-signing: remove `signatures`, declare the curator, then sign.

`ff-cli publish` checks this before uploading, so a missing declaration fails immediately with the key to
add rather than as a server error. No API key is involved: the feed does not accept one.

**Declared, but signed under a non-owner role:**

```
Publish failed
  Playlist is signed by a declared curator, but under a non-owner role ("agent").

This is ff-cli's check, not a feed's answer. Feeds are moving to role-aware ownership, where
  a key in curators[] counts as an owner only if it also signed as "curator". A feed that
  does not check the role yet will accept this document, and then be unable to authorize a
  replace or a delete for it: both need an owner signature it does not carry. Publishing it is
  what makes that permanent, so ff-cli refuses here instead.

  curators[] is already correct — only the role is missing, so add that signature to this file:
    ff-cli sign <file> -r curator --key <private key for a declared curator>
  Any key this playlist declares will do — you do not need the one that signed under the wrong
  role. Declared: did:key:z6Mkv7qJ...
  It must be one of those: a curator signature from an undeclared key satisfies neither
  this check nor role-aware ownership, since both read roles only from declared keys. "sign"
  uses the configured key unless --key says otherwise; drop --key if a declared key is already
  your configured one, and confirm which identity a key carries with
  "ff-cli status --key <private key>".
  Signing appends, and the payload hash excludes signatures, so the existing entry stays valid
  and the document ends up carrying both. No unsigned copy is needed: you only have to start
  from one when changing signed content such as curators[] itself.
```

Declaring a key in `curators[]` is a claim that it owns the playlist; signing as `curator` is the proof.
This failure means the document is right and the signature is not — the fix is the role, not `curators[]`.

**This one is repairable in place**, unlike the two above. Nothing signed needs to change, so appending is
enough — the payload hash covers the document with `signature`/`signatures` stripped, which leaves the
earlier entry valid over bytes that did not move:

```bash
# --key only when the declared curator is not your configured key; `ff-cli status --key <k>`
# reports which identity a key carries.
ff-cli sign playlist.json -r curator --key <declared curator's key>   # ["agent"] -> ["agent","curator"]
ff-cli publish playlist.json
```

The signature has to come from a key the playlist already declares — **any** of them, not specifically the
one that signed under the wrong role. On a playlist with several curators, whoever holds one of the other
declared keys can repair it. `sign` uses the configured key unless `--key` says otherwise, so on a machine
whose configured key is not declared, the plain command appends a `curator` signature the feed ignores and
the publish fails identically.

Start again from an unsigned document only when the fix changes signed content — adding `curators[]`, for
instance. There the earlier signature would cover a document that no longer exists.

**This is a CLI preflight, not a report of what a feed said.** A feed that does not yet check the role
accepts such a document, so uploading it by hand can still succeed. It is refused here because once
accepted it can never be replaced **or** deleted: both need an owner signature it does not carry, and the
only way to add one is to replace the document. Publishing is what makes that permanent.

`find` and `build` sign as `curator` automatically, since they declare the key themselves. This applies to
documents you sign by hand, where `playlist.role` (default `agent`) decides the role.

## Replace or Delete a Published Playlist

A feed's `PUT` and `DELETE` are **owner-bound**, and neither accepts an API key. Both carry a short-lived
signed **intent** — `ff-cli` builds it, signs it with the configured key in the `curator` role, and sends
it alongside (replace) or as (delete) the request body. Only a key the **stored** playlist names in
`curators[]` can authorize either. This is the whole reason `publish` refuses a document with no
owner-role signature: once such a playlist is created it can never be replaced or deleted.

### Replace

```bash
# Edit the published document — not a rebuilt one — then re-sign and replace.
#   `id`, `slug`, `created` and the curators[] owner set must all stay as published.
ff-cli sign playlist.json -r curator
ff-cli publish playlist.json --replace -s 0
```

```
$ ff-cli publish playlist.json --replace -s 0

Replace playlist

Replaced
  Playlist ID: 97595a2f-a790-477c-aa42-b4f2ec9f1e3b
  Server: https://feed.feralfile.com/api/v1
  Status: Replaced on feed server
```

`--replace` is never applied on your behalf. A plain `publish` of an id the feed already holds still
fails with a conflict, because creating and overwriting are different intentions and only one of them is
recoverable.

Re-running `find` or `build` does **not** produce a replacement: each run mints a new `id`, `slug`, and
`created`, and the feed compares all three against the stored row. `ff-cli` checks them locally and names
the fields that moved, because the feed's own answer is a bare `400`:

```
Replace failed
  The document changes fields a replace may not change.

A replace keeps identity and ownership fixed: id, slug, and created must equal the stored
  document's, and the curators[] owner set is immutable.
    slug: stored "snowfro-send-receive", document "a-completely-new-slug"
    created: stored "2026-09-07T23:32:39.660Z", document "2026-09-08T01:02:03.000Z"
```

### Delete

```bash
# id, slug, or a feed URL — all resolve to the same playlist.
ff-cli unpublish 97595a2f-a790-477c-aa42-b4f2ec9f1e3b -s 0
ff-cli unpublish https://feed.feralfile.com/api/v1/playlists/97595a2f-a790-477c-aa42-b4f2ec9f1e3b -s 0
```

```
$ ff-cli unpublish 97595a2f-a790-477c-aa42-b4f2ec9f1e3b -s 0 -y

Unpublish playlist

Unpublished
  Playlist ID: 97595a2f-a790-477c-aa42-b4f2ec9f1e3b
  Slug: snowfro-send-receive
  Server: https://feed.feralfile.com/api/v1
  Status: Deleted from feed server (the id is now tombstoned and cannot be reused)
```

Without `-y`, `unpublish` shows the title and the server and asks, defaulting to **no**. The delete
tombstones the id: the playlist cannot be restored, and a later publish naming that id is refused. Build
a new playlist instead of trying to recreate it.

### When the key is not an owner

`ff-cli` reads the stored playlist before it signs anything, so this is refused locally and nothing is
sent. The feed's own answer would be a bare `403`, naming neither the identity you offered nor the ones
that would have worked:

```
$ ff-cli unpublish 885b2ea6-74e2-44fe-96d0-e8728f6bba9c -s 0 -y

Unpublish playlist

Unpublish failed
  The configured signing key is not an owner of this playlist, so it cannot delete it.

Only a key the stored playlist names in curators[] can authorize a delete; the feed derives
  ownership from the stored document, not from a local copy.
  Your configured identity:
    did:key:z6MkoX8i2dynyvLh4hUHZt8b42q9uAwwCWxM4NSX4YDfMtaC
  Stored owners:
    did:key:z6MkoDkq5YXsFGXPiD6HDUVfze5mvhU5QF4hTy59pVVPYg82
  Point playlist.privateKey at a key listed above (confirm any key's identity with
  "ff-cli status --key <private key>"). Ownership cannot be granted after the fact: the owner set
  is immutable, so a playlist signed by the wrong key stays that way.
```

Ownership cannot be granted after the fact — the owner set is immutable, and only an owner could change
it — so the only fix is to hold a declared key. A playlist whose stored `curators[]` is **empty** is a
harder case with the same shape: nobody owns it, no signature can ever authorize a write, and `ff-cli`
says so rather than sending you after a key that does not exist. That is the state every playlist
published without an owner-role signature is frozen in, and it is what the `publish` owner-role gate
above exists to prevent.

## Complete Flow (build → validate → sign → play → publish)

```bash
# 1. Build a playlist (via find or build)
npm run dev -- find https://objkt.com/tokens/hicetnunc/111068 -o playlist.json

# 2. Validate it
npm run dev -- validate playlist.json

# 3. Sign it. Declare curators[] BEFORE this step: the signature covers it, and the feed only
#    accepts a publish when a signature's kid matches a declared curator key.
#    Run `ff-cli status` for the kid (add -k <key> if you sign with `sign --key`).
#    -r curator: ff-cli publish requires the owner role (role-aware ownership); the kid match is
#    what feeds enforce today.
npm run dev -- sign playlist.json -r curator -o signed.json

# 4. Play it on a device
npm run dev -- play signed.json -d "Living Room Display"

# 5. Publish to a feed server
npm run dev -- publish signed.json -s 0
```

With a signing key configured, `find` and `build` already produce a signed `playlist.json` with your
key declared in `curators[]`. Skip step 3 and use `playlist.json` in steps 4 and 5 — there is no
`signed.json` on that path:

```bash
npm run dev -- play playlist.json -d "Living Room Display"
npm run dev -- publish playlist.json -s 0
```

Set `playlist.curatorName` in the config to control the name recorded in `curators[]`; it defaults
to `ff-cli`.

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

# Rename a device (host, API key, and default status are untouched)
npm run dev -- device rename kitchen gallery

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

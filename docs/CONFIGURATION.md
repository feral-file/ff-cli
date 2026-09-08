# Configuration Guide

This guide explains how to configure ff-cli, field by field. Configuration priority is:

- `config.json` (highest)
- `.env`
- built‑in defaults (lowest)

## Getting started

```bash
# Create example config and edit it
npm run dev -- config init

# Validate your configuration
npm run dev -- config validate

# Show current config summary
npm run dev -- config show
```

## Top‑level fields

- **defaultDuration** (number, seconds)
  - Default per‑item display duration for static media without an intrinsic runtime (images). Falls back to 10s when unset.
  - Does NOT apply to video/audio items: with no explicit duration those are emitted without `duration` and with `display.loop: false`, so a DP-1 player advances at end-of-stream (§4.1) — the media plays its natural length.
- **generativeDuration** (number, seconds)
  - Display duration stamped on generative/interactive (HTML) works, which have no intrinsic runtime and no end-of-stream event. Defaults to **60s** (override via `DEFAULT_GENERATIVE_DURATION`).
  - Set to **0** to omit the duration entirely, so a conformant player parks on the work open-ended instead of rotating. Note: some players (including FF1) require every item to carry a `duration` and will reject a playlist whose items omit it — keep this non-zero unless you know your player tolerates an absent duration.

## browser

Optional settings used where headless/browser‑like behavior is needed.

- `browser.timeout` (number, ms): Operation timeout (default 90000).
- `browser.sanitizationLevel` ("none" | "low" | "medium" | "high" | 0‑3): Converted to numeric via `sanitizationLevelToNumber()`; invalid values are flagged during validation.

## playlist

Used for signing DP‑1 playlists.

- `playlist.privateKey` (string, Ed25519 private key in hex or base64): Used by the `sign` command to create DP-1 v1.1.0 multi-signatures. The `verify` command may derive the matching public key from this value (or `PLAYLIST_PRIVATE_KEY`) when you omit `--public-key`; **dp1-js applies that derived key only when verifying legacy flat `signature` strings**, not when checking `signatures[]` envelopes. If that derivation fails, `verify` prints a warning on stderr and continues without derived key material. The derived public key is emitted as PEM so Node can decode it without ambiguity. Hex may include or omit the `0x` prefix. You can also set this via `PLAYLIST_PRIVATE_KEY` in `.env`. `play` verifies playlists before delivery and only auto-signs the synthesized media URL fallback when signing is configured. `play` and `publish` verify before delivery or upload and reject unsigned or broken playlists.

  **Signing and key encoding:** Signing paths (`sign`, deterministic `build` when configured, and `-k/--key` overrides) accept the private key in any of these encodings:

  - **base64 PKCS#8 DER** — recommended; what `ff-cli setup` generates.
  - **32-byte raw Ed25519 seed** as **hex** (optional `0x`) or **base64**.
  - **PEM** (`-----BEGIN PRIVATE KEY-----`).
  - **PKCS#8 DER as hex**.

  ff-cli normalizes whichever form you supply to base64 PKCS#8 DER before handing it to **`dp1-js`** (`SignMultiEd25519`). A malformed key fails with an actionable message (e.g. _"Invalid Ed25519 signing key … run `ff-cli setup` to generate one"_) instead of dp1-js's cryptic OpenSSL ASN.1 error (`header too long` / `wrong tag`).

- `playlist.curatorName` (string): Display name recorded alongside your signing key in the `curators[]`
  of playlists built by `find` and `build`. Defaults to `ff-cli`; you can also set it via
  `PLAYLIST_CURATOR_NAME`. The feed authorizes a create by matching a signature's `kid` against a key
  declared in the document's own `curators[]`, so those commands write that declaration **before**
  signing — a name is required next to the key by DP-1, and the value is public and covered by the
  signature. The sample `YOUR_CURATOR_NAME` in `config.json.example` is treated as unset, so an untouched
  config falls through to `PLAYLIST_CURATOR_NAME` or the default rather than publishing under a
  placeholder.

  To read the `did:key` your signatures will carry, run `ff-cli status`. It reports the identity from
  `PLAYLIST_PRIVATE_KEY` even when no config file exists yet, and `ff-cli status --key <privateKey>`
  reports it for an explicit key — the one `sign --key` would use.

- `playlist.role` (string): DP-1 signing role used by `ff-cli sign`. The shipped `config.json.example` sets `curator`, because a document signed as `agent` is ownerless to a role-aware feed and `ff-cli publish` refuses it. The code default when the key is omitted entirely is still `agent`. You can also set this via `PLAYLIST_ROLE` in `.env`. Guided `ff-cli setup`, `config validate`, and `sign --role` only accept the usual DP-1 signing roles (`agent`, `feed`, `curator`, `institution`, `licensor`). It does **not** apply to `find` and `build`, which always sign as `curator` — see [Signing role and ownership](#signing-role-and-ownership).

### Generate an Ed25519 private key

The simplest path is `ff-cli setup`, which generates a key for you (base64 PKCS#8 DER) and writes it to your config. To generate one yourself:

OpenSSL (recommended — produces a PKCS#8 DER key):

```bash
# Base64 PKCS#8 DER (recommended)
openssl genpkey -algorithm ED25519 -outform DER | base64 | tr -d '\n'

# Hex of the same PKCS#8 DER (alternative)
openssl genpkey -algorithm ED25519 -outform DER | xxd -p -c 256
```

Paste the value into `playlist.privateKey`. Any of these are accepted:

- **base64 PKCS#8 DER** (recommended): `MC4CAQAwBQYDK2Vw...`
- **32-byte raw seed** as hex (`0x`-prefixed or not) or base64 — e.g. the bare seed, not the full PKCS#8 blob.
- **PEM**: a `-----BEGIN PRIVATE KEY-----` block.
- **PKCS#8 DER as hex**.

If you need a different role, set `playlist.role` to one of the DP-1 signing roles such as `agent`, `feed`, `curator`, `institution`, or `licensor`. The CLI rejects any other string before it reaches `dp1-js`.

### Signing role and ownership

A feed decides who owns a playlist from the document itself: the keys in `curators[]` are the owner set.
Under **role-aware ownership**, a key counts as an owner only when that same key *also signed in the
`curator` role* — being named is a claim, signing as `curator` is the proof.

`ff-cli publish` requires that role. **This is ff-cli's check, not every feed's answer today**: a feed that
does not yet enforce roles accepts an `agent`-signed document, so a manual upload of the same file can
still succeed. It is refused here because once accepted, such a document can never be replaced or deleted —
both need an owner signature it does not carry, and the only way to add one is to replace it. Publishing is
what makes that permanent.

The `kid`-to-`curators[]` match is different: feeds enforce that today, and a playlist failing it is
rejected by the server regardless of ff-cli.

Two consequences:

- `find` and `build` declare your key in `curators[]` and therefore always sign as `curator`, whatever
  `playlist.role` says. To build under a different role, build without a configured signing key and sign the
  result yourself with `ff-cli sign --role`.
- `ff-cli publish` refuses a playlist whose declared key signed under another role, and names the fix
  (`ff-cli sign <file> -r curator`, from any key declared in `curators[]`). This runs before any request,
  so it costs nothing — and deliberately does not defer to a feed that would accept the document today,
  because acceptance is what makes it unfixable.

Channels use `publisher` as the owner role instead of `curator`; ff-cli does not publish channels.

If you already have a base64 key and want hex, convert it:

```bash
echo -n "<BASE64_KEY>" | base64 -d | xxd -p -c 256
```

## feed

DP‑1 Feed API configuration.

- `feed.baseURLs` (string[]): Array of DP‑1 Feed Operator API v1 base URLs. The CLI queries all feeds in parallel.
- Legacy support: `feed.baseURL` (string) is still accepted and normalized to an array.
- Default: `https://dp1-feed-operator-api-prod.autonomy-system.workers.dev/api/v1` if not set.
- Compatibility: API v1 of the DP‑1 Feed Operator server. See the repository for endpoints and behavior: [dp1-feed](https://github.com/display-protocol/dp1-feed).

Endpoints used by the CLI:

- `GET /api/v1/playlists` (supports `limit`, `offset`, and sorting)
- `GET /api/v1/playlists/{id}` (`fetch`)
- `POST /api/v1/playlists` (`publish`)
- `PUT /api/v1/playlists/{id}` (`publish --replace`)
- `DELETE /api/v1/playlists/{id}` (`unpublish`)

No credential is configured for any of these. The feed has no API key: every write is authorized by
signatures in the request body, and an `apiKey` left in an existing config is ignored.

`playlist.privateKey` is needed only where the CLI itself has to sign at request time — `publish
--replace` and `unpublish`, which sign the owner-bound intent that authorizes the write. Both accept
`-k, --key` to use a different key for one run, so a second owner identity does not require editing this
file. A plain
`publish` signs nothing: it uploads the `signatures[]` envelope the document already carries, so it
works with no key configured at all (the document must have been signed at some point, by
`ff-cli sign` or by whoever produced it, but not by this command).

**Choosing between several configured servers.** Commands that address a feed (`publish`, `unpublish`,
`fetch`, `find --publish`) take `-s, --server <index>`, a 0-based index into the list above. With one server
configured it is optional. With more than one and no `-s`, an interactive session asks; a session with no
terminal — a pipe, a cron job, a CI step — exits non-zero and prints the list rather than guessing, since
defaulting to index 0 would silently write to whichever feed happens to be first.

Environment variable alternative:

```env
FEED_BASE_URLS=https://dp1-feed-operator-api-prod.autonomy-system.workers.dev/api/v1,https://dp1-feed-operator-api-prod.autonomy-system.workers.dev/api/v1
```

## find (Raster API)

`ff-cli find` resolves tokens, series, and artist addresses through Raster's public GraphQL API ([docs.api.raster.art](https://docs.api.raster.art/)). No configuration is required; two environment variables adjust the integration:

```env
# API key sent as the x-api-key header. The API currently answers without
# one, but Raster's docs declare a key required — set this once enforced.
RASTER_API_KEY=rk_your_key_here

# Override the GraphQL endpoint (default: https://api.raster.art/graphql).
RASTER_API_URL=https://api.raster.art/graphql
```

## ff1Devices

Configure devices you want to play content on.

- `ff1Devices.devices` (array of objects):
  - `name` (string): Friendly device label. Free‑form; pick anything memorable.
  - `id` (string): Stable physical ID discovered from FF1 (for example
    `FF1-SKYZ2E3A`). Relayer pairing stores the topic under this ID in the OS
    credential vault.
  - `host` (string): Device base URL. For LAN devices, use `http://<ip>:1111`. The device typically listens on port `1111`.

During `ff-cli setup`, the CLI will attempt local discovery via mDNS (`_ff1._tcp`). If devices are found, you can pick one and the host will be filled in automatically. If discovery returns nothing, setup falls back to manual entry.

> **mDNS is best-effort.** It frequently does not cross subnets — a common case with mesh routers (e.g. eero) that put wired and Wi-Fi clients on different `/24`s. If discovery comes up empty even though the device is reachable by IP, skip it entirely and add the device directly:
>
> ```bash
> ff-cli device add --host http://<device-ip>:1111 --name <name> --id FF1-XXXXXXXX
> ```

You can also manage devices independently with:

- `ff-cli device add` – Add a device interactively (with mDNS discovery), or
  non-interactively with `--host`, `--name`, and the physical `--id` shown in
  Feral File mobile. Manual devices need the ID before relayer pairing.
- `ff-cli device list` – Show all configured devices.
- `ff-cli device rename <name> <new-name>` – Rename a device without touching its host, API key, or default status. Works offline; also accepts the host URL as the identifier, so unnamed legacy entries can be given a name.
- `ff-cli device remove <name>` – Remove a device by name.
- `ff-cli device default <name>` – Promote a device to the top of the list so it is used when `-d` is omitted.
- `ff-cli device pair [name]` – Display a one-time handoff code and key-bound
  security check, then securely receive that device's relayer topic from Feral
  File mobile. Confirm both values match before approving in mobile.

Setup and `device add` both preserve existing devices. Adding a device with the same host as an existing one updates it in place.

Selection rules when sending:

- If you omit `-d`, the first configured device is used.
- If you pass `-d <name>`, the CLI matches the device by `name` (case-insensitive) or by host URL — the same rules as `device remove`/`default`/`rename`, so unnamed entries can be targeted by host. If not found, you’ll see an error listing available devices.

Device cast contract:

The device exposes a single HTTP endpoint, `POST http://<device>:1111/api/cast`. `ff-cli play` casts a DP-1 playlist with:

```jsonc
POST http://<device>:1111/api/cast
Content-Type: application/json
// API-KEY: <optional, only if the device requires one>

{
  "command": "displayPlaylist",
  "request": {
    "dp1_call": { /* the full signed DP-1 playlist object */ },
    "intent": { "action": "now_display" }
  }
}
```

The `intent` field is **required** — without it the device returns `{"message":{"ok":false}}` with no further explanation. `dp1_call` may be the playlist inline (as above) or a hosted playlist URL string; ff-cli sends the resolved playlist object.

When LAN delivery is unreachable, `play` prints an explicit notice and retries
the same command through `ff1Relayer.baseUrl`. The per-device topic is read from
the operating system credential vault, never `config.json`. Pair it from the
mobile app first:

```bash
ff-cli device pair office
```

The CLI and mobile confirmation both show the same 12-hex-digit security check.
Comparing it authenticates the CLI public key out of band, so an active broker
cannot silently substitute its own encryption key.

The default relayer is
`https://tv-cast-coordination.autonomy-system.workers.dev`. Override it with
`ff1Relayer.baseUrl` or `FF1_RELAYER_URL`. Signed topic-only relayer deployments
need no additional key. Deployments that retain the cloud-edge compatibility
gate may receive `ff1Relayer.apiKey` or `FF1_RELAYER_API_KEY`; ff-cli never
bundles that shared key.

On the first cast after boot the device may return an empty body. ff-cli retries this automatically and, if it persists, reports a clear "accepted the request but returned no usable response" error rather than crashing on a JSON parse.

Compatibility checks:

- `play` and `ssh` perform a compatibility preflight before sending commands to FF1. The CLI gets the device version by calling `POST /api/cast` with `{ "command": "getDeviceStatus", "request": {} }` and reads `message.installedVersion` from the response.

- Minimum supported FF1 OS versions:
  - `play` (`displayPlaylist`): `1.0.0` or newer
  - `ssh` (`sshAccess`): `1.0.9` or newer

- If the CLI cannot get a version from the device (e.g. network or malformed response), it continues and sends the command.
- If the detected version is below the minimum, the command fails early with an error that includes the detected version.

Troubleshooting note:

- If you get an unsupported-version error, update your FF1 OS and retry. If version detection seems inconsistent, check that device host and key are correct and retry with the device directly reachable.

Examples:

```bash
# Send to first device
npm run dev -- play playlist.json

# Play on a specific device by exact name
npm run dev -- play playlist.json -d "Living Room Display"
```

Minimal `config.json` example (selected fields):

```json
{
  "defaultDuration": 10,
  "playlist": {
    "privateKey": "your_ed25519_private_key_hex_or_base64_here",
    "role": "curator"
  },
  "feed": {
    "baseURLs": ["https://dp1-feed-operator-api-prod.autonomy-system.workers.dev/api/v1"]
  },
  "ff1Devices": {
    "devices": [
      {
        "name": "Living Room Display",
        "id": "FF1-ABCD1234",
        "host": "http://192.168.1.100:1111"
      }
    ]
  }
}
```

## Security and validation

- Do not commit secrets. Keep `config.json`, `.env`, and keys out of version control.
- Validate changes regularly:

```bash
npm run dev -- config validate
```

If configuration is invalid, the CLI prints actionable errors and a non‑zero exit code.

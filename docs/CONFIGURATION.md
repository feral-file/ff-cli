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

- `playlist.privateKey` (string, Ed25519 private key in hex or base64): Used by the `sign` command to create DP-1 v1.1.0 multi-signatures, and as the default signing key for the owner-bound feed mutations (`publish --replace`, `unpublish`), which sign an authorization intent at request time. Those commands and `sign` all take `-k, --key` or `--key-file <path>` to override it for a single run — see [Where the signing key can come from](#where-the-signing-key-can-come-from). The `verify` command may derive the matching public key from this value (or `PLAYLIST_PRIVATE_KEY`) when you omit `--public-key`; **dp1-js applies that derived key only when verifying legacy flat `signature` strings**, not when checking `signatures[]` envelopes. If that derivation fails, `verify` prints a warning on stderr and continues without derived key material. The derived public key is emitted as PEM so Node can decode it without ambiguity. Hex may include or omit the `0x` prefix. You can also set this via `PLAYLIST_PRIVATE_KEY` in `.env`. `play` verifies playlists before delivery and only auto-signs the synthesized media URL fallback when signing is configured. `play` and `publish` verify before delivery or upload and reject unsigned or broken playlists.

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
  (or `--key-file <path>`) reports it for an explicit key — the one `sign` would use with the same flag.

- `playlist.role` (string): DP-1 signing role used by `ff-cli sign`. The shipped `config.json.example` sets `curator`, because a document signed as `agent` is ownerless to a role-aware feed and `ff-cli publish` refuses it. The code default when the key is omitted entirely is still `agent`. You can also set this via `PLAYLIST_ROLE` in `.env`. Guided `ff-cli setup`, `config validate`, and `sign --role` only accept the usual DP-1 signing roles (`agent`, `feed`, `curator`, `institution`, `licensor`). It does **not** apply to `find` and `build`, which always sign as `curator` — see [Signing role and ownership](#signing-role-and-ownership).

### Where the signing key can come from

Three sources, in this order of precedence:

1. **`-k, --key <privateKey>` or `--key-file <path>`** on the command line — `sign`, `status`,
   `unpublish`, and `publish --replace` all take both.
2. **`playlist.privateKey`** in `config.json`.
3. **`PLAYLIST_PRIVATE_KEY`** in the environment or in `.env`.

The file beats the environment, matching the repo-wide `config.json` > `.env` > defaults rule — with
one exception: a `playlist.privateKey` that is empty or still holds a `YOUR_`/`your_` sample
placeholder is treated as **unset**, so `PLAYLIST_PRIVATE_KEY` is used instead. Without that, an
untouched `config init` would beat a perfectly good environment key and every signing path would fail
on a key you never chose.

An explicit key wins for that one run only; nothing is written back. All three accept the same
encodings listed above, and the CLI normalizes whichever you supply before signing, so a key file is a
delivery mechanism rather than a fourth key format.

**Prefer `--key-file` to `--key`.** `--key` writes your private key into your shell history file and
exposes it in the process list, where any local user can read it for as long as the command runs.
Neither disclosure can be undone: an Ed25519 signing key *is* the identity it asserts, and a playlist's
`curators[]` owner set is immutable, so a leaked key cannot be rotated out of a document that already
names it. `--key-file` keeps the material in a file you control:

```bash
ff-cli status --key-file ~/.config/ff-cli/signing.key      # whose key is this?
ff-cli sign playlist.json -r curator --key-file ~/.config/ff-cli/signing.key
```

**Keep the key file private** — `chmod 600` it, in a directory only you can enter. The CLI does not
check its permissions and will not refuse a world-readable one: a mode check cannot see the directory
above the file, cannot describe a Windows ACL, and would refuse paths that are perfectly appropriate,
so it would be ceremony rather than protection.

The rules on both flags:

- **Passing both is an error**, not a precedence rule. A precedence rule has to silently ignore one of
  the two keys you supplied, and a key you believe was used and was not is the failure this CLI keeps
  removing.
- **An empty `--key`** — what `--key "$SIGNING_KEY"` becomes when the variable is unset — is rejected,
  never treated as absent.
- **A `--key-file` that is missing, unreadable, or holds no key material** is rejected the same way.
  Neither ever falls back to the configured key: signing under an identity you did not choose is not
  something a publish or a delete can be taken back from.
- **A `--key-file` argument is always opened, whatever it looks like.** A directory really can be
  called `BEGIN`, and a key file really can be named after a content hash. What is gated is not the
  open but the *message*: a failure names the path only when it is short and no part of it is a
  complete key encoding, and otherwise says it could not be read without repeating it. Typing the key
  where the path goes — one keystroke from `--key` — is reported as that mistake, by name, with the
  value withheld.
- **The key is never echoed**, in any error, in any encoding — nor is a `--key-file` argument that may
  be one.

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
`-k, --key` or `--key-file <path>` to use a different key for one run, so a second owner identity does
not require editing this file. A plain
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
    credential vault, and controller pairing names the controller key file after it.
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
  security check, then securely receive the device's control profile (current
  FF OS) or relayer topic (older FF OS) from Feral File mobile. Confirm both
  values match before sharing in mobile. On current FF OS this pairs ff-cli as
  a **controller**; see [Secure control pairing](#secure-control-pairing).
- `ff-cli device controllers [name]` – List the controllers paired with an FF1
  and any pending requests (owner only).
- `ff-cli device revoke <controller-id> [name]` – Revoke a controller, or deny
  its pending request (owner only).
- `ff-cli device unpair [name]` – Delete ff-cli's controller keys for an FF1. It always asks first (owner keys get a stronger warning); `-y, --yes` skips the question.
  Owner keys need confirmation (or `--yes`): if no other owner can reach the
  FF1, deleting them leaves it without a reachable owner until a factory reset.

Setup and `device add` both preserve existing devices. Adding a device with the same host as an existing one updates it in place.

For an explicitly enrolled owner Tailscale connection, use the FF1's Tailscale IPv4
address with the **same physical `--id` and existing `--name`**. Save its old
host first. This updates that device in place, preserving its list position,
API key and ID; relayer credentials remain in the vault under the same ID.
The configured host is replaced, with no automatic LAN/Tailscale failover.
See the [owner-access procedure](https://github.com/feral-file/ffos/blob/36e25cec84505271a7232d6936bb46a19fab5cfd/docs/OWNER_TAILSCALE.md).

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

Relayer access for paired CLIs will move to relay v2, which routes by FF1
device ID instead of a topic (feral-file#3551). Nothing changes yet: this
version still uses the topic relayer, and the controller keys and pairing carry
over unchanged.

On the first cast after boot the device may return an empty body. ff-cli retries this automatically and, if it persists, reports a clear "accepted the request but returned no usable response" error rather than crashing on a JSON parse.

Compatibility checks:

- `play` and `ssh` perform a compatibility preflight before sending commands to FF1. The CLI gets the device version by calling `POST /api/cast` with `{ "command": "getDeviceStatus", "request": {} }` and reads `message.installedVersion` from the response.

- Minimum supported FF1 OS versions:
  - `play` (`displayPlaylist`): `1.0.0` or newer
  - `ssh` (`sshAccess`): `1.0.9` or newer

- If the CLI cannot get a version from the device (e.g. network or malformed response), it continues and sends the command.
- If the detected version is below the minimum, the command fails early with an error that includes the detected version.
- `ssh` sends the relayer topic stored by `ff-cli device pair` (OS keyring) in the `X-FF1-Topic` header. A claimed FF1 on newer FF OS rejects `sshAccess` without it (HTTP 401 `topic_required`), so run `ff-cli device pair <name>` before `ff-cli ssh`. With no stored topic the request is sent without the header, which unclaimed devices and older FF OS accept.

- When ff-cli is paired as a controller (a controller file exists for the
  device), the preflight, `play` and `ssh` are all sent as secure envelopes
  instead; see below.

### Secure control pairing

Current FF OS authorizes every command per controller (FF1 control protocol
v1). The FF1 itself decides who may do what; the LAN and the relayer only carry
encrypted, signed requests. ff-cli takes part as a controller:

```bash
ff-cli device pair office                 # receive the profile, request access, wait
ff-cli device pair office --label studio  # name the owner sees (default: hostname); 1-64 characters,
                                          # no control or invisible formatting (bidi, zero-width) characters
ff-cli device pair office --timeout 600   # wait longer for approval (seconds, at most 600)
ff-cli device pair office --resume        # continue after Ctrl-C or a timeout
ff-cli device pair office --yes           # replace a pairing for another FF1 identity without asking
```

1. In Feral File mobile choose **Pair with ff-cli** and enter the one-time
   code. The app sends the FF1's public control profile (and, while the FF1
   still uses it, the relayer topic). ff-cli pins that profile: every reply
   must be signed by its key.
2. ff-cli creates its controller keys and asks the FF1 for access (LAN first,
   relayer if the LAN is unreachable), then prints a **6-digit approval code**.
3. On an owner's phone, the Feral File app shows the request with its own code.
   Approve only when the two codes match. The code is bound to the FF1 identity
   ff-cli pinned, so a device impersonating the FF1 on your network produces a
   different code.
4. ff-cli checks for the approval every 2 seconds (5 minutes by default) and
   prints the role it was granted.

If ff-cli is already paired with the FF1 under a different identity (the FF1
was factory reset, or the app sent an out-of-date one), it asks before pairing
again, and keeps the current keys in place until the new pairing is approved:
a refused or abandoned pairing never loses an existing grant. The pending
replacement is kept in `controllers/pairing/` until then.

Roles:

- **owner** – every command, including `ssh` and controller management.
- **controller** – playback (`play`) and device status. `ssh`,
  `device controllers` and `device revoke` need an owner grant.

Controller keys live in one file per FF1:

```
$XDG_CONFIG_HOME/ff-cli/controllers/<device ID>.json   # default ~/.config/ff-cli/controllers/
```

The file holds this computer's private controller keys, the pinned FF1 profile
(generation and key pins), the granted role and notification key, and the
request counter. ff-cli creates it with mode `0600` inside a `0700` directory
and replaces it atomically on every write. It is never printed or logged.
**Windows:** mode bits do not apply; the file relies on the ACL of your user
profile directory, so keep `%USERPROFILE%\.config` private to your account.

Treat the file like an SSH private key: anyone who copies it can act as this
controller until an owner revokes it. Do not restore it from an old backup —
the counter inside must only grow, and an FF1 rejects reused counters
(`replay`). If that happens, run `ff-cli device pair <name>` again: the current
keys stay in place until the new pairing is approved. A controller file that
cannot be read (permissions, a program holding it) is never overwritten; a
corrupt one is moved aside to `<device ID>.json.corrupt-<time>` (after a
question, or `--yes`) before a new pairing.
`device remove` keeps the file, so re-adding the same FF1 keeps its pairing.

Requests go to `POST /api/cast` as
`{"command":"ff1Envelope","request":{"v":1,"jwe":"…"}}` on the LAN. When the
LAN is unreachable, `play`, pairing (`device pair`), `device controllers` and
`device revoke` go through the relayer instead (they are encrypted and signed
either way); the version preflight and `ssh` stay LAN-only. Each attempt,
including every retry, is a new request with a new counter. FF1s on older FF OS
(no controller file for them) keep the plaintext path described above.

Errors and what to do:

| Message | Cause | Fix |
|---|---|---|
| "This FF1 is secured and only accepts requests from paired controllers." | The FF1 refuses plaintext and ff-cli is not paired | `ff-cli device pair <name>`, approve in the app |
| "…does not know this ff-cli controller", "…was revoked or has expired", "…has not been approved", "…still waiting for approval" | No active grant for these keys | `ff-cli device pair <name>` (or `--resume`), approve in the app |
| "This command needs owner access…" | `ssh` or controller management with a controller grant | An owner grants the owner role in the app |
| "The FF1 could not open the request." / "…rejected the request signature." | The FF1's control identity changed (for example a factory reset), or the device address now reaches another FF1. These answers are not authenticated: anyone on the path can send one | Check the device address first. If the FF1 was factory reset: `ff-cli device pair <name>` (the current keys stay until the new pairing is approved). Do not unpair |
| "The reply did not verify against the paired FF1 identity…" | A reply not signed by the pinned FF1 (wrong device, or a forged relayer reply) | Check the device host; if the FF1 was reset, `ff-cli device pair <name>`. Do not unpair |
| "The FF1 is busy; try again." | The FF1 was checking too many requests at once and did not run this one (`play` retries it automatically with a new request) | Run the command again |
| "The FF1 rejected the access request … as invalid." | The pairing label contains characters the FF1 refuses | Pair again with a plain `--label` |
| "The FF1 did not accept the access request…" | An owner denied it in the last few minutes, or nobody secured the FF1 in the app | Wait a few minutes and pair again, or in the app choose **Secure this FF1**, then pair |
| "The FF1 rejected the request as malformed." | Usually a clock more than 5 minutes ahead of the FF1's | Fix the clock on this computer (or let the FF1 finish setting its time), then retry |

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

### Optional generic v2 transport (integration branch)

`ff1Relayer.v2Endpoint` (or `FF1_RELAY_V2_ENDPOINT`) selects a separate generic
carrier origin. It has no default. HTTPS/WSS is required except for loopback
local tests; credentials, paths and query parameters are rejected. Existing
`ff1Relayer.baseUrl` and `apiKey` retain their legacy meanings.

```json
{
  "ff1Relayer": {
    "baseUrl": "https://tv-cast-coordination.autonomy-system.workers.dev",
    "v2Endpoint": "https://ff-relayer-device-test.bitmark-development.workers.dev"
  }
}
```

V2 commands use the existing enrolled controller, pinned profile and codecs.
The carrier waits for connection/send readiness before sealing, discovers peers
through generic presence, and selects FF1 only from a verified reply. Each socket
first sends a fresh sealed getDeviceStatus to establish notification binding.
One command invocation shares that socket for binding and command; it closes when
the invocation finishes. No command is automatically replayed after v2 delivery.
If binding fails before the original command is sent, the optional legacy topic
can carry a fresh sealed request for secure firmware without v2. A verified
refusal does not change the grant or trigger fallback. Enrollment retains
Brandon's LAN/legacy workflow; this change does not route invitation enrollment
or device requestAccess onto v2.

Security dependency: #135 at `73b1735c8aa55f342003589eee17aef9b4251cc0`.
Release target remains main. Useful transport changes were selectively replayed
on that exact head; key stores, topic fields, pairing and --resume are preserved.
The temporary carrier supplies UUID channel/connection identity, explicit targeted
bytes, receipt ACK, local timeout and cancellation hooks only. Brandon's new
ps-bound QR/result validators, registration orchestration and shared fixtures are
still pending. No competing codec/staging workflow is supplied. Timeout is not
rejection; ACK is not approval; ready requires verified enrollment. Optional
result topicId remains necessary for secure firmware without v2.

The protected FF1-SKYZ2E3A joint manual matrix remains blocked. Automated transport
checks and existing signed endpoint fixtures do not replace that evidence.
FFOS #174 build protections, fleet floors, recovery-image and shelf-stock upgrades,
no rollback below dual-stack, and staged legacy retirement are release gates.
No package publication, image/production deployment or device reset is part of
this branch. Default feed URL remains `https://feed.feralfile.com/api/v1`.

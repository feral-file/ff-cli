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
Neither disclosure can be undone: an Ed25519 signing key _is_ the identity it asserts, and a playlist's
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
  open but the _message_: a failure names the path only when it is short and no part of it is a
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
Under **role-aware ownership**, a key counts as an owner only when that same key _also signed in the
`curator` role_ — being named is a claim, signing as `curator` is the proof.

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
    `FF1-ABCD1234`). Relayer pairing stores the topic under this ID in the OS
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
- `ff-cli device pair [name]` – Pair ff-cli with an FF1. ff-cli reads the
  FF1's status on the LAN to pick the path:
  - FF OS with secure control and an owner: show a QR code (and the same text
    to paste) that an owner scans with **Add controller** in the Feral File
    app; ff-cli pins the FF1's control profile from the owner's sealed answer
    and enrolls as a **controller**. Needs an internet connection; see
    [Secure control pairing](#secure-control-pairing).
  - FF OS without secure control (or with it switched on but no owner yet):
    display a one-time code and key-bound security check; in Feral File
    mobile choose **Pair with ff-cli**, enter the code, and confirm both values
    match before sharing. The app sends the relayer topic, which ff-cli stores
    in the operating system credential vault.
  - Status unreadable (FF1 off the LAN): the QR path, with a hint. Pass
    `--topic-handoff` to force the one-time-code path.

  The status is not authenticated, so ff-cli says which path it chose from
  it, and never chooses the one-time code when it already holds controller
  keys for the FF1 (a controller file, a pending replacement or the keys of
  an unfinished pairing); only `--topic-handoff` does then.

- `ff-cli device controllers [name]` – List the controllers paired with an FF1
  and any pending requests (owner only).
- `ff-cli device revoke <controller-id> [name]` – Revoke a controller, or deny
  its pending request (owner only).
- `ff-cli device unpair [name]` – Revoke ff-cli's own access on the FF1 (best
  effort) and delete its controller keys. It always asks first (owner keys get
  a stronger warning); `-y, --yes` skips the question.
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
ff-cli device pair office                  # FF OS without secure control: one-time code
ff-cli device pair office --topic-handoff  # force the one-time code (FF1 not on this LAN)
```

On FF OS without secure control, the CLI and mobile confirmation both show the
same 12-hex-digit security check. Comparing it authenticates the CLI public key
out of band, so an active broker cannot silently substitute its own encryption
key. On FF OS with secure control, the topic arrives inside the owner's sealed
answer when the FF1 still uses the topic relayer; ff-cli stores it only after
the FF1's enroll reply verified, and the enroll itself uses the relayer only
with a topic stored earlier. The topic is never printed.

The default relayer is
`https://tv-cast-coordination.autonomy-system.workers.dev`. Override it with
`ff1Relayer.baseUrl` or `FF1_RELAYER_URL`. Signed topic-only relayer deployments
need no additional key. Deployments that retain the cloud-edge compatibility
gate may receive `ff1Relayer.apiKey` or `FF1_RELAYER_API_KEY`; ff-cli never
bundles that shared key.

#### Relay v2

Relay v2 routes by FF1 device ID instead of a topic, on a public channel that
carries only sealed envelopes: a reply counts only when it verifies under the
FF1 profile pinned at pairing. `device pair` uses it for its pairing channel.

The v2 endpoint is the relayer's own origin (`ff1Relayer.baseUrl` when it is a
bare HTTPS origin), so pairing needs no setting. Override it with
`ff1Relayer.v2Endpoint` or `FF1_RELAY_V2_ENDPOINT`: an HTTPS or WSS origin
(plain HTTP only on loopback), with no credentials, path or query. An empty
value turns v2 off; `device pair` then reports that pairing is unavailable.

When ff-cli is paired as a controller, a command that cannot reach the FF1 on
the LAN goes over relay v2 first when the v2 endpoint is set explicitly, or
when the FF1's last verified status listed `relayV2` in its control
transports (ff-cli remembers this in the controller file). Otherwise it uses
the topic relayer as before.

```json
{
  "ff1Relayer": {
    "v2Endpoint": "https://relay.example"
  }
}
```

- The stored topic is used only when relay v2 proves the command was not
  delivered: it could not connect, or the relay refused it for every peer and
  no part of it was acknowledged. The topic route then carries a newly sealed
  request.
- When the command may have reached the FF1 (it was acknowledged, or the
  connection dropped after sending, or no verified reply came in time), ff-cli
  reports "Outcome unknown" and does not send it again. Check the FF1 before
  running the command again.
- Relay refusals while connecting, and relay backpressure, are retried with
  backoff.
- Enrollment never uses relay v2: anyone can join the device channel, so a v2
  reply proves nothing until the FF1 profile is confirmed.
- The owner's sealed pairing result must fit one relay frame (32 KiB; results
  are about 1 KiB).

On the first cast after boot the device may return an empty body. ff-cli retries this automatically and, if it persists, reports a clear "accepted the request but returned no usable response" error rather than crashing on a JSON parse.

Compatibility checks:

- `play` and `ssh` perform a compatibility preflight before sending commands to FF1. The CLI gets the device version by calling `POST /api/cast` with `{ "command": "getDeviceStatus", "request": {} }` and reads `message.installedVersion` from the response.

- Minimum supported FF1 OS versions:
  - `play` (`displayPlaylist`): `1.0.0` or newer
  - `ssh` (`sshAccess`): `1.0.9` or newer

- If the CLI cannot get a version from the device (e.g. network or malformed response), it continues and sends the command.
- If the detected version is below the minimum, the command fails early with an error that includes the detected version.
- `ssh` sends the relayer topic stored by `ff-cli device pair` (OS keyring) in the `X-FF1-Topic` header. A claimed FF1 on newer FF OS rejects plaintext `sshAccess` without it (HTTP 401 `topic_required`). With no stored topic the request is sent without the header, which unclaimed devices and older FF OS accept.

- When ff-cli is paired as a controller (a controller file exists for the
  device), the preflight, `play` and `ssh` are all sent as secure envelopes
  instead; see below.

### Secure control pairing

Current FF OS authorizes every command per controller (FF1 control protocol
v1). The FF1 itself decides who may do what; the LAN and the relayer only carry
encrypted, signed requests. ff-cli takes part as a controller:

```bash
ff-cli device pair office                 # show the QR, wait for an owner, enroll
ff-cli device pair office --label studio  # name the owner sees (default: hostname); 1-64 characters,
                                          # no control or invisible formatting (bidi, zero-width) characters
ff-cli device pair office --timeout 600   # wait longer for an owner (seconds, 10-600; default 300)
ff-cli device pair office --resume        # finish a pairing an owner already approved
ff-cli device pair office --yes           # replace a pairing for another FF1 identity without asking
```

Pairing is owner-initiated, like adding an SSH key: nothing is requested from
the FF1 and no code is compared.

1. ff-cli shows a QR code and the same text to paste (`ff1-ctl:1|…`). It
   carries this computer's public controller keys, a one-time pairing secret
   and a relay channel ID. The QR uses this computer's existing keys for the
   FF1 when it has them, so a re-pair (after a revoke, a role change or a
   factory reset) keeps one controller ID on the FF1. Otherwise the keys are
   saved to `controllers/pairing/<device ID>.keys.json` once the relay
   channel is open, before the QR is shown, so a retry after a timeout or Ctrl-C shows the same keys (with a
   new secret and channel) and completes a registration an owner already
   made.
2. On an owner's phone, open the FF1 in the Feral File app, choose **Add
   controller**, scan the code (or paste the text), and pick the role.
3. The app registers ff-cli on the FF1, then sends ff-cli a sealed answer over
   the relay channel. ff-cli accepts only an answer it can open with this
   run's keys that carries its pairing secret, its own controller ID, and the
   configured FF1's device ID; anything else on the channel is ignored. It pins
   the FF1's control profile from that answer: every reply must then be signed
   by its key.
4. ff-cli enrolls with the FF1 (LAN first, relayer if the LAN is unreachable)
   and prints the role it was granted.

Pairing needs an internet connection: the relay carries the owner's answer and
keeps nothing. It also needs an FF1 that already has an owner (choose **Secure
this FF1** in the app first); ff-cli cannot become an FF1's first owner. If no
owner answers within the timeout, the pairing is "not completed", not
rejected: running `device pair` again shows a new code for the same keys.
If an owner declines, the command fails. If the owner's
answer arrived but enrolling did not finish (the FF1 was unreachable, Ctrl-C),
`ff-cli device pair <name> --resume` finishes it without a new code.

If ff-cli is already paired with the FF1 under a different identity (the FF1
was factory reset), it asks before replacing that pairing, and keeps the
current keys in place until the new pairing is enrolled: a declined or
abandoned pairing never loses an existing grant. The pending replacement is
kept in `controllers/pairing/` until then.

`ff-cli device unpair <name>` first asks the FF1 to revoke ff-cli's own access
(a sealed self-revoke, best effort with a short timeout), then deletes the keys
whatever the answer. Older FF OS refuses a controller's self-revoke, and an FF1
never lets its last owner revoke itself; in those cases the FF1 keeps listing
the controller until an owner revokes it. Unpair also deletes the keys of an
unfinished pairing; if an owner already added them, it prints their
controller ID for an owner to revoke.

Roles:

- **owner** – every command, including `ssh` and controller management.
- **controller** – playback (`play`) and device status. `ssh`,
  `device controllers` and `device revoke` need an owner grant.

Controller keys live in one file per FF1:

```
$XDG_CONFIG_HOME/ff-cli/controllers/<device ID>.json   # default ~/.config/ff-cli/controllers/
```

The file holds this computer's private controller keys, the pinned FF1 profile
(generation and key pins), facts from the owner's answer (channel, FF1 name,
role, expiry), the granted role, expiry and notification key, and the request
counter. ff-cli creates it with mode `0600` inside a `0700` directory
and replaces it atomically on every write. It is never printed or logged.
**Windows:** mode bits do not apply; the file relies on the ACL of your user
profile directory, so keep `%USERPROFILE%\.config` private to your account.

Treat the file like an SSH private key: anyone who copies it can act as this
controller until an owner revokes it. Do not restore it from an old backup —
the counter inside must only grow, and an FF1 rejects reused counters
(`replay`). When an FF1 answers `replay` in a reply signed by its key, ff-cli
moves the counter ahead and sends the command once more as a new request. If
it keeps happening, check that no other computer uses a copy of the file, then
run `ff-cli device pair <name>` again: the current keys stay in place until the
new pairing is finished. A controller file that
cannot be read (permissions, a program holding it) is never overwritten; a
corrupt one is moved aside to `<device ID>.json.corrupt-<time>` (after a
question, or `--yes`) before a new pairing.
`device remove` keeps the file, so re-adding the same FF1 keeps its pairing.

Requests go to `POST /api/cast` as
`{"command":"ff1Envelope","request":{"v":1,"jwe":"…"}}` on the LAN. When the
LAN is unreachable, `play`, enrolling (`device pair`), `device controllers`,
`device revoke` and unpair's self-revoke go through the relayer instead (they are encrypted and signed
either way); the version preflight and `ssh` stay LAN-only. Each attempt,
including every retry, is a new request with a new counter. FF1s on older FF OS
(no controller file for them) keep the plaintext path described above.

Errors and what to do:

| Message                                                                                                                         | Cause                                                                                                                                                                                 | Fix                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| "This FF1 is secured and only accepts requests from paired controllers."                                                        | The FF1 refuses plaintext and ff-cli is not paired                                                                                                                                    | `ff-cli device pair <name>`; an owner scans the code with **Add controller**                                                                                       |
| "…does not know this ff-cli controller", "…was revoked or has expired", "…has not been approved", "…still waiting for approval" | No active grant for these keys                                                                                                                                                        | `ff-cli device pair <name>` (or `--resume`); an owner scans the code with **Add controller**                                                                       |
| "Pairing was not completed: no owner answered…"                                                                                 | No verified answer reached ff-cli before `--timeout`                                                                                                                                  | Run `ff-cli device pair <name>` again (needs internet)                                                                                                             |
| "Pairing is not available in this build of ff-cli…"                                                                             | This build has no relay pairing channel yet                                                                                                                                           | Update ff-cli                                                                                                                                                      |
| "This command needs owner access…"                                                                                              | `ssh` or controller management with a controller grant                                                                                                                                | An owner grants the owner role in the app                                                                                                                          |
| "The FF1 could not open the request." / "…rejected the request signature."                                                      | The FF1's control identity changed (for example a factory reset), or the device address now reaches another FF1. These answers are not authenticated: anyone on the path can send one | Check the device address first. If the FF1 was factory reset: `ff-cli device pair <name>` (the current keys stay until the new pairing is finished). Do not unpair |
| "The reply did not verify against the paired FF1 identity…"                                                                     | A reply not signed by the pinned FF1 (wrong device, or a forged relayer reply)                                                                                                        | Check the device host; if the FF1 was reset, `ff-cli device pair <name>`. Do not unpair                                                                            |
| "The FF1 is busy; try again."                                                                                                   | The FF1 was checking too many requests at once and did not run this one (`play` retries it automatically with a new request)                                                          | Run the command again                                                                                                                                              |
| "The FF1 has no grant for ff-cli, although an owner's Feral File app reported adding it."                                       | An owner removed ff-cli again before it enrolled                                                                                                                                      | `ff-cli device pair <name>`                                                                                                                                        |
| "The FF1 rejected the request counter as already used."                                                                         | The counter is still behind after ff-cli moved it ahead once (another computer uses a copy of the file)                                                                               | Stop the other copy; run the command again. Do not unpair                                                                                                          |
| "The FF1 rejected the request as malformed."                                                                                    | Usually a clock more than 5 minutes ahead of the FF1's                                                                                                                                | Fix the clock on this computer (or let the FF1 finish setting its time), then retry                                                                                |

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

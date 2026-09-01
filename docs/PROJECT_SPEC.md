# ff-cli Project Spec

This document defines the current product role, boundaries, and constraints for `ff-cli`.

It is derived from the behavior and interfaces implemented in this repository as of March 2026. It serves as the planning entry point for substantial changes and should be updated as the CLI evolves.

## Why this doc exists

- Give future contributors and coding agents a stable current-state spec before implementation starts.
- Make the CLI's role in the broader FF1 and DP-1 system explicit.
- Record the constraints that should shape changes even when the codebase is refactored.

## Product summary

- Project: `ff-cli`
- Type: Node.js CLI
- System role: a control and integration surface for FF1 and DP-1 workflows
- Primary purpose: turn resolved sources or structured parameters into valid DP-1 playlists deterministically, then validate them and optionally sign, publish, and play them through FF1 and feed paths

There is no built-in natural-language interface and no model orchestration. Natural language belongs in the user's coding agent (Claude Code, Codex), which drives ff-cli's deterministic commands via the `ff-control` skill. ff-cli requires no LLM API key.

In the Feral File architecture bands, `ff-cli` sits primarily in the presentation and control layer. It is not the canonical source of truth for exhibitions, ownership, device runtime, or protocol evolution. It is a practical operator and developer surface that bridges those systems.

## Strategic role

The CLI supports the broader Feral File goal of making it effortless to live with digital art every day.

Its value is reducing friction in the publish-to-play path:

- assemble playlists quickly
- keep outputs DP-1 conformant
- make FF1 playback and feed publishing easier to exercise
- provide deterministic tooling that agents and scripts can drive reliably

The CLI should strengthen the Gold Path, not invent a parallel product model.

## Users and primary use cases

Current likely users:

- internal engineers working on FF1, DP-1, feed, and device flows
- operators and launch teammates validating publish-to-play behavior
- advanced users or partners building and testing playlists
- developers using the CLI as a reference implementation for DP-1 and FF1 command flows

Primary use cases:

- build a playlist from structured JSON inputs
- resolve a marketplace URL, on-chain coordinates, or a wallet address into a playlist (`find`)
- validate or verify a local or hosted DP-1 playlist
- sign a playlist with an Ed25519 key
- publish a validated playlist to a configured feed server
- play a playlist or direct media URL on a configured FF1 device
- manage local config and FF1 SSH access
- exercise compatibility checks against FF1 OS versions before risky commands

## Domain language

Use these terms consistently:

- `FF1`
- `FF1 device`
- `DP-1`
- `DP-1 envelope`
- `DP-1 conformance`
- `computational art playlist`
- `channel endorsement`
- `feed server`
- `playlist`
- `work`

## Product goals

The current code and internal context imply these practical goals:

- Make playlist creation and playback testing fast enough for daily use.
- Keep the path from intent to valid DP-1 output deterministic and inspectable.
- Preserve openness by relying on DP-1 as the compatibility layer instead of a CLI-specific format.
- Support FF1 as the reference playback target without making correctness depend on proprietary-only infrastructure.
- Serve as a reference surface for publish, verify, and play flows used elsewhere in the Feral File stack.

### Current behavior

The current implementation still depends on Feral File-operated infrastructure for some data retrieval paths, including the hardcoded production indexer endpoint used for NFT lookup.

### Design direction

Long-term interoperability should continue to reduce hard infrastructure coupling where practical, especially when a dependency blocks portability without adding protocol value.

## Non-goals

`ff-cli` should not become:

- the source of truth for exhibitions, channels, or artwork metadata
- the source of truth for ownership, passkeys, rights, or trust registry state
- a replacement for the mobile app as the primary user-facing controller
- a place to define new DP-1 protocol semantics by convenience
- a long-running backend service with hidden state

## Current system responsibilities

Based on the code today, the CLI is responsible for:

- loading configuration from `config.json`, `.env`, and defaults, with `config.json` taking precedence
- resolving marketplace URLs, on-chain coordinates, and wallet addresses into playlists (`find`)
- running feed fetches, address queries, contract-based NFT queries, domain resolution, playlist building, verification, publishing, and playback
- supporting a deterministic build path from structured JSON (`build`)
- building DP-1 playlist envelopes from NFT metadata or direct media URLs via `dp1-js` document and leaf builders (so constructed playlists stay schema-conformant), including inline Ref Manifests on items that carry indexer metadata
- validating and verifying playlist structure and signatures
- signing playlists when a private key is configured
- publishing validated playlists to configured feed servers
- discovering configured FF1 devices and sending playlists or direct media playback requests
- pairing a device's signed relayer topic through a short-lived end-to-end
  encrypted mobile handoff, authenticating the CLI key with a user-compared
  security check, and storing it in the operating system credential vault
- falling back from unreachable LAN delivery to the shared FF1 relayer with an
  explicit terminal notice, so sandboxed and cross-subnet control remains
  observable to the mobile app
- performing FF1 OS compatibility preflight checks before display and SSH flows

## Architecture boundaries

### What the CLI owns

- command-line UX and command routing
- local config loading and validation
- source resolution (`find`) and structured-params handling (`build`)
- deterministic playlist assembly, verification, and signing helpers
- device and feed integration calls from the client side

### What the CLI depends on but does not own

- DP-1 protocol shape and evolution
- feed server behavior and data persistence
- FF1 runtime and OS behavior
- ownership and identity systems
- trust-path policy, licensing policy, and key registry policy

### Boundary rules

- The CLI may assemble, validate, and transmit DP-1 objects, but it should not silently fork the protocol.
- The CLI may call feed and device endpoints, but it should not become their compatibility abstraction layer of last resort.
- Deterministic utilities remain the source of truth for output correctness; the CLI does not interpret natural language or orchestrate models.
- Trust-sensitive correctness must stay vendor-neutral and portable; the trust path cannot depend on cloud-specific guarantees.
- Current implementation note: some retrieval paths still use Feral File-operated services directly, so portability here is an intended direction rather than a fully achieved property.

## Functional shape

Today the CLI groups into these workflow areas:

### Setup and configuration

- `setup`
- `status`
- `config init|show|validate`

### Build

- `find`
- `build`

### DP-1 output integrity

- `verify`
- `validate`
- `sign`

### Delivery

- `play` (handles playlist files, playlist URLs, and media URLs)
- `publish`

### Device operations

- `ssh enable|disable`

### Inline Ref Manifests

Playlist items carry a full Ref Manifest inline (DP-1 Playlist Extension §3.6)
rather than behind a `ref` URL, because the CLI emits a playlist file and has
nowhere to host a manifest document. Behavior worth knowing downstream:

- An item gets a manifest whenever the indexer supplies a description, an
  artist, or a still image distinct from the item source. A token carrying only
  a title gets none — the item already has a `title` field, so a title-only
  manifest would add payload to every device transfer and signed envelope
  without adding information.
- Manifest ids are derived from the token's chain, contract, and token id, so
  they are stable across runs and across playlists — that stable `id` is what
  identifies the manifest. `created` is frozen once per CLI invocation, so every
  item in one build shares a single timestamp; it moves between builds, which is
  expected (see "What determinism does not mean here").
- Items carry no `ref`. `ref` is a URI to an externally hosted Ref Manifest,
  and requires `refHash` over HTTPS; a locally built playlist has nowhere to
  host one, which is the case §3.6 exists to serve. A still image distinct from
  the source is carried at `inlineManifest.metadata.thumbnails.default.uri`.
- An inline manifest has no `refHash`; its integrity comes from the playlist
  signature.

### Enriching a playlist the CLI did not build

`find` and `build` attach a manifest as they create each item. A playlist that
arrives another way — assembled by hand, copied out of another document, or
written before §3.6 existed — has items with a `source` and a `provenance` block
and nothing else. `enrich` is the repair path for those.

- Enrichment is keyed on `provenance.contract` (chain, address, token id), not
  on `source`. A source URL is one rendition of a work and several renditions
  share one; the coordinate is what identifies the artwork.
- It writes `inlineManifest` and nothing else. `source`, `duration`, `title`,
  `id`, and `display` are curator decisions and survive untouched even when the
  indexer disagrees with them.
- An item the indexer cannot resolve is reported, never synthesized. The same
  rule the manifest mapping follows applies here: the CLI does not invent fields
  it cannot substantiate, and an invented artist line inside a signed document
  is worse than an absent one.
- DP-1 names the EVM family `evm`; the FF indexer names it `ethereum`. Enrich
  translates between the two. Unlisted chain names pass through so the indexer
  decides what it supports.
- Enrichment changes the document, so both the `signatures[]` envelope and the
  legacy flat `signature` are removed and the playlist must be re-signed.
  Leaving a stale envelope in place would produce a file that fails
  verification at the device with no explanation.
- An item carrying a `ref` is already labelled by a manifest the CLI cannot
  see, and `ref` outranks `inlineManifest` in the resolution order, so
  enrichment skips it. `--force` does not override that: making the inline
  manifest win would mean deleting the curator's `ref` and `refHash`, which
  discards the integrity hash the remote manifest is checked against. That
  conversion, if ever wanted, belongs behind its own flag.
- Enrichment looks each distinct coordinate up once, however many items share
  it. A token the indexer has not seen triggers an indexing job and a poll that
  can take minutes, and a playlist that repeats a work would otherwise submit
  that job once per appearance.
- Overriding an item's title changes the manifest's content, so it also changes
  the manifest's `id`. The indexer derives that id from the token coordinate,
  so two items of one artwork receive the same one; leaving it alone while
  changing the title would produce two documents claiming to be the same cached
  manifest. The replacement is derived from the original id and the title, so
  it is deterministic across runs.
- The indexer resolving a token and having something worth attaching are
  different outcomes: `buildInlineManifestForToken` returns nothing when it has
  only a title, since a title-only manifest adds payload without adding
  information. Enrichment reports those separately from tokens it could not
  resolve at all.
- A still the manifest builder suppressed is recovered against the item's own
  source. `resolveStillUri` blanks a thumbnail equal to the source it was
  handed, which is the source the *indexer* chose; for a static work that is
  often the still itself. When the curator kept a live HTML source instead, the
  item would otherwise end up with no thumbnail — the empty grid tile this
  command exists to remove. When the indexer's source differs from the item's
  and is http(s) **and is media the app can rasterize**, it is that suppressed
  still
  and becomes the thumbnail. The type check matters: `getBestMediaUrl` prefers
  `display.animation_url` and media assets over `display.image_url`, so the
  indexer's source is frequently a live HTML rendition, and putting one in the
  thumbnail slot is worse than leaving it empty — the grid still cannot
  rasterize it and the item now claims a still it does not have. The predicate
  matches the media types `playlist-builder.js` already recognizes, images plus
  SVG and video, and rejects HTML. A
  thumbnail-only manifest is emitted where none was, unlike a title-only one:
  it is the difference between a tile and an empty square.
- `evm` names a family, and enrichment refuses to guess which member. DP-1 §6
  carries no network identity, and the indexer maps Ethereum, Polygon,
  Arbitrum, Optimism, Base, and Zora all back to `evm`, so neither the request
  nor the response can say which network is meant. Ethereum is chosen because
  it is the only EVM network this client can reach — `buildTokenCID` maps
  ethereum to `eip155:1` and tezos to `tezos:mainnet` and throws for anything
  else. The residual risk is narrow: an L2 work whose address and token id also
  exist on Ethereum would take the Ethereum work's metadata. The command
  is the operator's to make: `--assume-ethereum` asserts it, and without that
  flag `evm` items are skipped with a reason that names the flag. The warning
  prints before anything is written, so an operator who did not mean to assert
  it still has the file they started with. Reaching an actual L2 belongs in the
  indexer client, which maps only `ethereum` and `tezos` today.
- In-place writes refuse to run over an input that changed while the lookup
  was in flight. The comparison is a hash of the bytes actually parsed, against
  the resolved write target, so `-o` naming the input by another spelling and a
  symlink pointing at it are both recognized as the in-place case. It runs
  immediately before the rename, so the exposed interval is a few syscalls
  rather than the minutes a lookup takes. It narrows the race and does not
  close it: compare-then-replace is not atomic against an editor participating
  in no protocol, and no userspace sequence makes it so. Writing to a distinct
  `--output` opts out of in-place replacement entirely, which is the right
  choice when a file is being actively edited.
- An attached manifest's id is derived from its whole finished metadata block,
  every time rather than only when this command changed something. The indexer
  keys its id on the token coordinate, so every rendition of one artwork
  carries the same id whatever its content, and under `--force` the indexer may
  itself return a different artist or description under that unchanged id.
  Deriving from the payload is the only rule that holds in every case:
  identical content keeps one identity, differing content never shares one. The
  original id is folded in so the result stays anchored to the token and stays
  deterministic across runs.
- In-place writes refuse to run over an input that changed while the lookup
  was in flight. The lookup can take minutes and the default destination is the
  input, so a curator's edit or re-sign in that window would otherwise be
  overwritten by a result computed from older bytes.
- In-place writes are atomic and crash-durable: the contents are synced before
  the rename and the containing directory after it, so a power loss cannot
  leave the destination name pointing at incomplete data. The directory sync is
  best-effort, since it is not portable.
- In-place writes are atomic: the candidate goes to a temporary file beside the
  destination and is renamed over it, so an interruption cannot leave a
  truncated playlist. A symlinked destination is followed to its target rather
  than replaced, and the existing file's permission mode is read before the
  temporary file is created and applied to it before any bytes are written, so
  a curator-restricted playlist is never briefly world-readable mid-write. The
  destination's owner and group are carried across too, since a replacement is
  a new inode and would otherwise take this process's ownership — silently
  reassigning a shared playlist. Where that cannot be done, the in-place
  replacement is refused and `--output` is offered instead. Extended ACLs are
  not preserved, because Node exposes no portable way to read them; a playlist
  carrying them should be enriched through `--output`.
- `--output` names a file the caller expects to exist afterwards, so it is
  written even when nothing was enriched. A no-op without `--output` writes
  nothing rather than rewriting the input for no gain.
- The playlist is validated before lookup and the enriched candidate is
  validated before writing. On either failure the diagnostics are printed and
  the file is left untouched, rather than replaced with a document that sign,
  publish, and play would each reject later.

## Deterministic-first behavior

The CLI is deterministic end to end. There is no natural-language interface; any natural-language layer lives in the user's coding agent, which drives these commands:

- commands map directly to source resolution, data fetching, playlist building, validation, signing, and delivery
- utilities perform the real work and are the source of truth for output correctness
- invalid or malformed outputs fail validation rather than being passed through

### What determinism does not mean here

It does **not** mean two builds of the same input produce identical bytes or an
identical signature. Every citation below is from
[`display-protocol/dp1`](https://github.com/display-protocol/dp1) at core
v1.1.0, so a reader can check each claim rather than take this section's word
for it.

**Timestamps are wall-clock, by definition.** The schemas define both creation
fields as the moment the document was made:

- `core/v1.1.0/schemas/playlist.json` — `created`: *"ISO 8601 timestamp when the
  playlist was created"*
- `core/v1.1.0/schemas/ref-manifest.json` — `created`: *"RFC3339 timestamp when
  the manifest was created"*

Building the same playlist twice creates two documents at two different times,
so those fields legitimately differ.

**Different bytes therefore mean a different signature, by construction.**
`core/v1.1.0/spec.md` §7: *"Each signature is computed over the canonical form
of the entire playlist (excluding the `signature` and `signatures` fields
themselves)"*, where *"Canonical form ≡ JSON Canonicalization Scheme (JCS), RFC
8785"*. A differing `created` changes the canonical bytes, which changes the
payload hash, which changes the signature. That is the signature reporting what
actually happened — not a defect to engineer away.

**Identity is carried by `id`, not by bytes.**
`core/v1.1.0/schemas/ref-manifest.json` describes `id` as *"Unique identifier
for the manifest (for caching)"*, echoed in the envelope example at
`core/v1.1.0/ref-manifest.md` §3: `"id": "ref-7c3d", // unique identifier (for
caching)`. Two manifests sharing an `id` are the same manifest. This CLI derives
manifest ids from token coordinates precisely so identity stays stable while
timestamps move.

**DP-1 states no reproducible-build requirement.** Searching `core/v1.1.0/spec.md`
and `core/v1.1.0/ref-manifest.md` for reproducibility language turns up the word
"deterministic" in exactly two places, neither about build-time byte stability:

- `spec.md` §5, *"Deterministic Reproduction (`repro`)"* — reproducing the
  **rendering** of code-based artwork, via `engineVersion`, `seed`,
  `assetsSHA256`, and `frameHash`.
- `ref-manifest.md` §2 Goals, *"Deterministic merging: predictable behavior
  across devices and players"* — the **merge order** in §7 (player defaults →
  playlist defaults → `ref.controls` → runtime overrides).

Neither imposes byte-for-byte stability across builds, and no schema field
requires `created` to be immutable across regenerations of a document.

`buildDP1Playlist` accepts `deterministicMode` with `fixedTimestamp` and
`fixedId`. Those exist to pin the envelope for tests and are not used by any
command.

## Trust, protocol, and rights assumptions

Important constraints from the broader FF system:

- DP-1 should evolve additively and remain forward-compatible where practical.
- Trust-path correctness must remain portable and key-controlled.
- Ownership and stewardship should not be confused with access gating in the CLI.
- The CLI may surface signatures, verification, and publishing, but it should not absorb licensing or identity policy that belongs elsewhere in the system.

## Reliability expectations

### Current behavior

- reliability matters more than novelty
- the publish-to-play path should stay simple and testable
- the CLI should help prove the path from canonical JSON to FF1 playback
- compatibility checks fail clearly when incompatibility is confirmed
- if FF1 OS version cannot be determined during preflight, the CLI currently proceeds and logs a warning instead of hard-blocking the command

### Design direction

- reliability matters more than novelty
- the publish-to-play path should stay simple and testable
- the CLI should help prove the path from canonical JSON to FF1 playback
- compatibility messaging should remain explicit enough that operators can distinguish confirmed incompatibility from uncertain device state

## Code and design constraints

- behavior changes should follow a spec-driven, test-first workflow when practical
- TypeScript is preferred for new or updated source
- comments should preserve durable maintenance context when the code encodes non-obvious design choices, trade-offs, invariants, or external constraints
- docs should be updated when user-facing behavior changes
- legacy compatibility paths should not be preserved unless explicitly required

## Verification expectations

The current repo verification path is:

```bash
npm run lint:fix
npm test
npm run build
node dist/index.js validate examples/sample-playlist.json
node dist/index.js config validate
```

## Open questions

- Which CLI commands are considered stable public interface versus internal reference tooling?
- How much of the feed and trust workflow should remain directly exposed in the CLI?
- Which FF1 operations deserve stronger compatibility policies or broader smoke coverage?
- How much of the mobile app's long-term control model should also be mirrored in CLI form?

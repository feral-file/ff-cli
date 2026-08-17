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

## Deterministic-first behavior

The CLI is deterministic end to end. There is no natural-language interface; any natural-language layer lives in the user's coding agent, which drives these commands:

- commands map directly to source resolution, data fetching, playlist building, validation, signing, and delivery
- utilities perform the real work and are the source of truth for output correctness
- invalid or malformed outputs fail validation rather than being passed through

### What determinism does not mean here

It does **not** mean two builds of the same input produce identical bytes or an
identical signature. Documents carry creation timestamps — `playlist.created`
and `inlineManifest.created` — which are read from the wall clock. Building the
same playlist twice produces two documents created at two different times, so
their bytes differ and therefore their signatures differ. That is the correct
representation of what happened, not a defect to engineer away.

Identity is carried by `id`, not by bytes. Two manifests with the same `id` are
the same manifest; DP-1 defines that field as a caching identifier
(`core/v1.1.0/schemas/ref-manifest.json`). Manifest ids are derived from token
coordinates precisely so that identity stays stable while timestamps move.

DP-1 imposes no reproducible-build requirement. The word "deterministic" in the
protocol refers to two unrelated things: deterministic *reproduction* of
code-based artwork (core spec §5, the `repro` block) and deterministic *merging*
of manifest values (`ref-manifest.md` §2). Neither concerns build-time byte
stability.

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

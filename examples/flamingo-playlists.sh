#!/usr/bin/env bash
#
# flamingo-playlists.sh — build one DP-1 playlist per series ("channel")
# from a curated subset of the Flamingo DAO collection.
#
# Each entry in INPUTS is anything `ff-cli find` accepts:
#   - marketplace URL (Art Blocks, Objkt, fxhash, OpenSea, SuperRare, FF, Neort)
#   - raw on-chain coords `ethereum:{contract}:{tokenId}` / `tezos:...`
#   - wallet address (`0x…` / `tz1…`) — picks one artwork from that artist's
#     Raster catalog; not useful for a *collector* address like Flamingo's.
#
# Notes from the ff-cli README:
#   - CryptoPunks (original) don't index — pre-ERC-721 contract.
#   - Mainstream PFPs (BAYC, Azuki, Pudgy Penguins, etc.) build a one-item
#     playlist instead of a series.
#   - DP-1 playlists cap at 1024 items; the indexer can 502 on burst load, so
#     a smaller --limit is friendlier on first run.
#
# Usage:
#   ./flamingo-playlists.sh                # writes to ./playlists/
#   ./flamingo-playlists.sh /tmp/flamingo  # custom output dir
#   LIMIT=10 ./flamingo-playlists.sh       # cap each series at 10 items

set -euo pipefail

OUT_DIR="${1:-./playlists}"
LIMIT="${LIMIT:-50}"
FF_CLI="${FF_CLI:-ff-cli}"

mkdir -p "$OUT_DIR"

# Curated "Flamingo-spirit" list — series that are well-documented Flamingo
# holdings (per public reporting / past auctions) and that display well on an
# Art Computer. This is not a live read of their wallet; swap entries as needed.
#
# Bias: generative / computational. PFPs and Punks are skipped — Punks don't
# index (pre-ERC-721) and PFPs build a one-item playlist instead of a series.
INPUTS=(
  # Art Blocks Curated — the bulk of Flamingo's generative thesis.
  # Ringers #109 and Fidenza #313 are two of the most famous pieces they've held.
  "https://www.artblocks.io/collection/chromie-squiggle-by-snowfro"
  "https://www.artblocks.io/collection/fidenza-by-tyler-hobbs"
  "https://www.artblocks.io/collection/ringers-by-dmitri-cherniak"
  "https://www.artblocks.io/collection/the-eternal-pump-by-dmitri-cherniak"
  "https://www.artblocks.io/collection/meridian-by-matt-deslauriers"
  "https://www.artblocks.io/collection/subscapes-by-matt-deslauriers"
  "https://www.artblocks.io/collection/anticyclone-by-william-mapan"
  "https://www.artblocks.io/collection/memories-of-qilin-by-emily-xie"

  # Autoglyphs (Larva Labs) — fully on-chain generative SVG, foundational.
  "ethereum:0xd4e4078ca3495de5b1d4db434bebc5a986197782:1"
)

failed=()
for input in "${INPUTS[@]}"; do
  slug=$(printf '%s' "$input" \
    | sed -E 's#^https?://(www\.)?##; s#[^A-Za-z0-9._-]+#-#g; s#^-+|-+$##g')
  out="$OUT_DIR/${slug}.json"

  printf '\n→ %s\n' "$input"
  if $FF_CLI find "$input" --output "$out" --limit "$LIMIT" --yes; then
    printf '  ✓ %s\n' "$out"
  else
    printf '  ✗ failed\n' >&2
    failed+=("$input")
  fi
done

printf '\nDone. Playlists in %s\n' "$OUT_DIR"
if (( ${#failed[@]} > 0 )); then
  printf 'Failed inputs:\n' >&2
  printf '  %s\n' "${failed[@]}" >&2
  exit 1
fi

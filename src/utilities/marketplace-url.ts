/**
 * Marketplace URL parser for `ff-cli find`.
 *
 * Accepts user input in any of these forms and returns a normalized result:
 *  - Marketplace token URL (Objkt, fxhash, Art Blocks, OpenSea, SuperRare, Feral File, Neort, Verse)
 *  - Raw on-chain coordinates: "ethereum:0xabc...:123" / "tezos:KT1...:456"
 *  - Wallet address: 0x{40-hex} (Ethereum) or tz1/tz2/tz3{33} (Tezos)
 *
 * The unified entry point is {@link parseFindInput}. Per-marketplace parsers
 * are exposed for unit testing.
 *
 * Series URLs (fxhash `/generative/...`, Feral File `/artworks/...`,
 * Art Blocks `/projects/...`) are recognized but not resolved in v1 — they
 * require a per-marketplace API call to derive a representative token. The
 * parser returns an `unsupported` result with a clear reason so the caller
 * can surface guidance instead of a generic "could not parse" error.
 */

import type { IndexerChain } from './raster-client';

export interface TokenCoords {
  chain: IndexerChain;
  contract: string;
  tokenId: string;
}

export type MarketplaceSource =
  | 'objkt'
  | 'artblocks'
  | 'fxhash'
  | 'feralfile'
  | 'opensea'
  | 'superrare'
  | 'neort'
  | 'verse';

export type FeralFileUrlKind = 'artwork' | 'series' | 'show';

export type ParsedFindInput =
  | { kind: 'token'; coords: TokenCoords; source: 'raw' | MarketplaceSource }
  | { kind: 'address'; chain: IndexerChain; address: string }
  | { kind: 'ff-url'; urlKind: FeralFileUrlKind; identifier: string }
  | { kind: 'objkt-alias'; alias: string; tokenId: string }
  | { kind: 'ab-collection'; slug: string }
  | { kind: 'os-collection'; slug: string }
  | { kind: 'fxhash-iteration'; slug: string }
  | { kind: 'fxhash-project'; slug: string }
  | { kind: 'neort-art'; id: string }
  | { kind: 'verse-series'; slug: string }
  | { kind: 'raster-artwork'; slug: string }
  | { kind: 'unsupported'; reason: string };

const ETH_ADDR = /^0x[a-fA-F0-9]{40}$/;
const TEZOS_ADDR = /^(tz1|tz2|tz3)[1-9A-HJ-NP-Za-km-z]{33}$/;
const RAW_COORDS = /^(ethereum|tezos):([^:]+):([^:]+)$/i;

/**
 * Parse any user-supplied input for the `ff-cli find` command.
 *
 * Returns:
 *  - `{ kind: 'token', ... }`   — successfully extracted on-chain coordinates
 *  - `{ kind: 'address', ... }` — wallet/artist address (for the artist path)
 *  - `{ kind: 'unsupported', reason }` — recognized but cannot extract a token
 *  - `null` — input does not match any recognized form; caller may show help
 */
export function parseFindInput(input: string): ParsedFindInput | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  if (ETH_ADDR.test(trimmed)) {
    return { kind: 'address', chain: 'ethereum', address: trimmed.toLowerCase() };
  }
  if (TEZOS_ADDR.test(trimmed)) {
    return { kind: 'address', chain: 'tezos', address: trimmed };
  }

  const rawMatch = RAW_COORDS.exec(trimmed);
  if (rawMatch) {
    return {
      kind: 'token',
      source: 'raw',
      coords: {
        chain: rawMatch[1].toLowerCase() as IndexerChain,
        contract: normalizeContract(rawMatch[2]),
        tokenId: rawMatch[3],
      },
    };
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(trimmed);
  } catch {
    return null;
  }

  return parseMarketplaceUrl(parsedUrl);
}

/**
 * Dispatch a URL to the per-host parser. Returns `null` when the host is
 * not one of the supported sources.
 */
export function parseMarketplaceUrl(url: URL): ParsedFindInput | null {
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (host === 'objkt.com' || host.endsWith('.objkt.com')) {
    return parseObjkt(url);
  }
  if (host === 'artblocks.io' || host.endsWith('.artblocks.io')) {
    return parseArtBlocks(url);
  }
  if (host === 'fxhash.xyz' || host.endsWith('.fxhash.xyz')) {
    return parseFxhash(url);
  }
  if (host === 'feralfile.com' || host.endsWith('.feralfile.com')) {
    return parseFeralFile(url);
  }
  if (host === 'opensea.io' || host.endsWith('.opensea.io')) {
    return parseOpenSea(url);
  }
  if (host === 'superrare.com' || host.endsWith('.superrare.com')) {
    return parseSuperRare(url);
  }
  if (host === 'neort.io' || host.endsWith('.neort.io')) {
    return parseNeort(url);
  }
  if (host === 'verse.works' || host.endsWith('.verse.works')) {
    return parseVerse(url);
  }
  if (host === 'raster.art' || host.endsWith('.raster.art')) {
    return parseRaster(url);
  }
  return null;
}

/**
 * Lowercase Ethereum contracts; leave Tezos KT1 contracts case-sensitive
 * (base58 prefix is case-significant on Tezos).
 */
function normalizeContract(contract: string): string {
  return contract.startsWith('0x') ? contract.toLowerCase() : contract;
}

/**
 * Objkt URL forms:
 *   objkt.com/tokens/{KT1...}/{tokenId}        — raw FA contract
 *   objkt.com/tokens/{alias}/{tokenId}         — collection alias (e.g. "hicetnunc")
 *   objkt.com/asset/{KT1...}/{tokenId}         — legacy redirect
 *
 * Aliases are resolved to KT1 contracts via
 * {@link ./objkt-marketplace#resolveObjktAlias} (separate file because the
 * lookup is async).
 */
export function parseObjkt(url: URL): ParsedFindInput {
  const direct = /^\/(?:tokens|asset)\/(KT[A-Za-z0-9]+)\/(\d+)\/?$/.exec(url.pathname);
  if (direct) {
    return {
      kind: 'token',
      source: 'objkt',
      coords: { chain: 'tezos', contract: direct[1], tokenId: direct[2] },
    };
  }
  const alias = /^\/(?:tokens|asset)\/([a-zA-Z][a-zA-Z0-9_-]*)\/(\d+)\/?$/.exec(url.pathname);
  if (alias) {
    return { kind: 'objkt-alias', alias: alias[1], tokenId: alias[2] };
  }
  if (url.pathname.startsWith('/collections/') || url.pathname.startsWith('/collection/')) {
    return {
      kind: 'unsupported',
      reason:
        'Objkt collection URLs are not yet supported in v1. Paste a specific token URL ' +
        '(objkt.com/tokens/{contract-or-alias}/{tokenId}) or use `tezos:{contract}:{tokenId}`.',
    };
  }
  return {
    kind: 'unsupported',
    reason: `Objkt URL not recognized: ${url.pathname}. Expected /tokens/{contract-or-alias}/{tokenId}.`,
  };
}

/**
 * Art Blocks URL forms:
 *   artblocks.io/token/{0xcontract}-{tokenId}                       — direct token
 *   artblocks.io/marketplace/collections/{0xcontract}/tokens/{id}   — marketplace UI token
 *   artblocks.io/collection/{slug}                                  — collection (series)
 *   artblocks.io/collections/{slug}                                 — plural; 307→singular
 *
 * Collection slugs are resolved to (contract, first_tokenId) via
 * {@link ./ab-marketplace#resolveArtBlocksCollection} (one Hasura GraphQL
 * call). `/projects/{id}` legacy URLs return 404 on artblocks.io and are
 * surfaced as a clear unsupported message.
 */
export function parseArtBlocks(url: URL): ParsedFindInput {
  let m = /^\/token\/(0x[a-fA-F0-9]{40})-(\d+)\/?$/.exec(url.pathname);
  if (m) {
    return {
      kind: 'token',
      source: 'artblocks',
      coords: { chain: 'ethereum', contract: m[1].toLowerCase(), tokenId: m[2] },
    };
  }
  m = /^\/marketplace\/collections\/(0x[a-fA-F0-9]{40})\/tokens\/(\d+)\/?$/.exec(url.pathname);
  if (m) {
    return {
      kind: 'token',
      source: 'artblocks',
      coords: { chain: 'ethereum', contract: m[1].toLowerCase(), tokenId: m[2] },
    };
  }
  m = /^\/collections?\/([a-z0-9][a-z0-9-]*)\/?$/.exec(url.pathname);
  if (m) {
    return { kind: 'ab-collection', slug: m[1] };
  }
  if (url.pathname.startsWith('/projects/')) {
    return {
      kind: 'unsupported',
      reason:
        'Art Blocks `/projects/{id}` URLs are legacy and no longer resolve on artblocks.io. ' +
        'Paste the current `/collection/{slug}` URL or a specific token URL.',
    };
  }
  return {
    kind: 'unsupported',
    reason: `Art Blocks URL not recognized: ${url.pathname}.`,
  };
}

/**
 * fxhash URL forms (Tezos):
 *   fxhash.xyz/gentk/FX1-{KT1...}-{tokenId}                  (canonical token URL)
 *   fxhash.xyz/iteration/{slug}                              (single iteration; resolves via fxhash API)
 *   fxhash.xyz/project/{slug}                                (series; current UI form)
 *   fxhash.xyz/generative/{slug}                             (series; legacy URL form, both supported)
 *   fxhash.xyz/gentk/{numericId}                             (legacy — needs fxhash API)
 *
 * Series URLs (`/project/`, `/generative/`) resolve to the project's first
 * minted iteration via `generativeToken(slug:)`; Raster then enumerates the
 * rest of the series. EVM-only projects won't be found on the Tezos GraphQL
 * endpoint and surface as a clean "slug not found" error.
 *
 * EVM (FX2-prefixed) gentks are not in scope: the FF indexer does not index
 * fxhash's EVM contracts in v1.
 */
export function parseFxhash(url: URL): ParsedFindInput {
  const m = /^\/gentk\/FX1-(KT[A-Za-z0-9]+)-(\d+)\/?$/.exec(url.pathname);
  if (m) {
    return {
      kind: 'token',
      source: 'fxhash',
      coords: { chain: 'tezos', contract: m[1], tokenId: m[2] },
    };
  }
  if (/^\/gentk\/FX2-/.test(url.pathname)) {
    return {
      kind: 'unsupported',
      reason:
        'fxhash FX2 (EVM) tokens are not supported — FF indexer covers Tezos mainnet only ' +
        'for fxhash. Paste a Tezos fxhash token or a different marketplace URL.',
    };
  }
  if (/^\/gentk\/\d+\/?$/.test(url.pathname)) {
    return {
      kind: 'unsupported',
      reason:
        'fxhash legacy numeric gentk URLs require an fxhash API lookup — not supported in v1. ' +
        'Paste the FX1-{contract}-{tokenId} form or use `tezos:{contract}:{tokenId}`.',
    };
  }
  const iter = /^\/iteration\/([a-z0-9][a-z0-9-]*)\/?$/.exec(url.pathname);
  if (iter) {
    return { kind: 'fxhash-iteration', slug: iter[1] };
  }
  const project = /^\/(?:project|generative)\/([a-z0-9][a-z0-9-]*)\/?$/.exec(url.pathname);
  if (project) {
    return { kind: 'fxhash-project', slug: project[1] };
  }
  return {
    kind: 'unsupported',
    reason: `fxhash URL not recognized: ${url.pathname}.`,
  };
}

/**
 * OpenSea URL forms:
 *   opensea.io/assets/{chain}/{contract}/{tokenId}
 *   opensea.io/item/{chain}/{contract}/{tokenId}    — newer naming
 *   opensea.io/collection/{slug}                    — collection slug (series)
 *
 * Only `ethereum` is in scope; other chains (matic, base, solana, etc.)
 * fall outside the FF indexer's coverage. Token URLs resolve end-to-end only
 * when Raster also indexes the underlying series — Raster's coverage of
 * mainstream PFP collections (Azuki, BAYC, etc.) is partial.
 */
export function parseOpenSea(url: URL): ParsedFindInput {
  const tokenMatch = /^\/(?:assets|item)\/([a-z_]+)\/(0x[a-fA-F0-9]{40})\/(\d+)\/?$/.exec(
    url.pathname
  );
  if (tokenMatch) {
    const chain = tokenMatch[1];
    if (chain !== 'ethereum') {
      return {
        kind: 'unsupported',
        reason:
          `OpenSea ${chain} URLs aren't supported — ff-cli covers Ethereum and Tezos mainnet only. ` +
          'Paste an Ethereum-chain OpenSea URL or a Tezos source (Objkt, fxhash).',
      };
    }
    return {
      kind: 'token',
      source: 'opensea',
      coords: { chain: 'ethereum', contract: tokenMatch[2].toLowerCase(), tokenId: tokenMatch[3] },
    };
  }
  const collectionMatch = /^\/collection\/([a-z0-9][a-z0-9-]*)\/?$/.exec(url.pathname);
  if (collectionMatch) {
    return { kind: 'os-collection', slug: collectionMatch[1] };
  }
  if (url.pathname.startsWith('/collection/')) {
    return {
      kind: 'unsupported',
      reason:
        `OpenSea collection URL not recognized: ${url.pathname}. ` +
        'Expected opensea.io/collection/{slug} with no extra path segments.',
    };
  }
  return {
    kind: 'unsupported',
    reason: `OpenSea URL not recognized: ${url.pathname}.`,
  };
}

/**
 * SuperRare URL forms (Ethereum-only platform):
 *   superrare.com/artwork/eth/{contract}/{tokenId}
 *   superrare.com/collection/{contract}             — per-artist contract page, not supported in v1
 *   superrare.com/{artist}/{slug}                   — slug form, not supported in v1
 *
 * SuperRare's `/artwork/eth/...` URLs encode both the contract and tokenId
 * directly, so no API call is needed. Token URLs resolve end-to-end only when
 * Raster also indexes the underlying series; for 1/1 artworks the find flow
 * falls through to a single-token playlist via the Raster 404 path.
 *
 * `/collection/{contract}` URLs on SuperRare point to a per-artist contract
 * (each SuperRare artist mints from their own ERC-721). There is no direct
 * contract→series mapping in Raster, so this is surfaced as a specific
 * unsupported message rather than the generic "URL not recognized" fall-through.
 */
export function parseSuperRare(url: URL): ParsedFindInput {
  const m = /^\/artwork\/eth\/(0x[a-fA-F0-9]{40})\/(\d+)\/?$/.exec(url.pathname);
  if (m) {
    return {
      kind: 'token',
      source: 'superrare',
      coords: { chain: 'ethereum', contract: m[1].toLowerCase(), tokenId: m[2] },
    };
  }
  if (/^\/collection\/(0x[a-fA-F0-9]{40})\/?$/.test(url.pathname)) {
    return {
      kind: 'unsupported',
      reason:
        'SuperRare `/collection/{contract}` URLs (per-artist contract pages) are not yet ' +
        'supported in v1. Paste a specific token URL ' +
        '(superrare.com/artwork/eth/{contract}/{tokenId}) or use ' +
        '`ethereum:{contract}:{tokenId}`.',
    };
  }
  return {
    kind: 'unsupported',
    reason:
      `SuperRare URL not recognized: ${url.pathname}. Expected ` +
      '/artwork/eth/{contract}/{tokenId}. For artist-slug URLs, paste the canonical ' +
      '/artwork/eth/... form (the SuperRare detail page links it under the artwork title).',
  };
}

/**
 * Neort URL forms (off-chain code-art platform):
 *   neort.io/art/{id}     — art detail page; id is opaque alphanumeric (~20 chars)
 *
 * Neort items are not on-chain, so the find flow handles them specially:
 * resolve via Neort's public API and build a DP-1 item directly with
 * `provenance.offChainURI`, bypassing Raster + FF indexer entirely.
 */
export function parseNeort(url: URL): ParsedFindInput {
  const m = /^\/art\/([a-zA-Z0-9]+)\/?$/.exec(url.pathname);
  if (m) {
    return { kind: 'neort-art', id: m[1] };
  }
  return {
    kind: 'unsupported',
    reason: `Neort URL not recognized: ${url.pathname}. Expected /art/{id}.`,
  };
}

/**
 * Verse URL forms:
 *   verse.works/items/ethereum/{contract}/{tokenId}  — direct Ethereum token
 *   verse.works/series/{slug}                        — series page
 *
 * Verse item pages expose the on-chain coordinates directly in the path. Series
 * pages do not include a JSON API in the public URL, but they render edition
 * links with the same `/items/ethereum/...` shape; the async resolver fetches
 * the series page and extracts a representative token for Raster enumeration.
 */
export function parseVerse(url: URL): ParsedFindInput {
  let m = /^\/items\/ethereum\/(0x[a-fA-F0-9]{40})\/(\d+)\/?$/.exec(url.pathname);
  if (m) {
    return {
      kind: 'token',
      source: 'verse',
      coords: { chain: 'ethereum', contract: m[1].toLowerCase(), tokenId: m[2] },
    };
  }
  m = /^\/items\/([^/]+)\//.exec(url.pathname);
  if (m) {
    return {
      kind: 'unsupported',
      reason:
        `Verse ${m[1]} item URLs are not supported — ff-cli covers Ethereum and Tezos mainnet only. ` +
        'Paste an Ethereum Verse item URL or raw `ethereum:{contract}:{tokenId}` coordinates.',
    };
  }
  m = /^\/series\/([A-Za-z0-9][A-Za-z0-9_-]*)\/?$/.exec(url.pathname);
  if (m) {
    return { kind: 'verse-series', slug: m[1] };
  }
  return {
    kind: 'unsupported',
    reason:
      `Verse URL not recognized: ${url.pathname}. Expected ` +
      '/items/ethereum/{contract}/{tokenId} or /series/{slug}.',
  };
}

/**
 * Raster URL forms (raster.art):
 *   raster.art/artwork/{slug}   — artwork (series) detail page
 *
 * Unlike the other marketplaces, Raster is already the find flow's backend
 * resolver — so a Raster URL resolves to an artwork by slug via
 * `artworkBySlug` and (crucially) builds DP-1 items straight from Raster's
 * own `media.contentUrl`, bypassing the FF indexer the way Neort does. This
 * is what lets Raster-minted tokens (which the FF indexer doesn't carry)
 * build a verifiable playlist without `--skip-verify`.
 */
export function parseRaster(url: URL): ParsedFindInput {
  const m = /^\/artwork\/([A-Za-z0-9][A-Za-z0-9_-]*)\/?$/.exec(url.pathname);
  if (m) {
    return { kind: 'raster-artwork', slug: m[1] };
  }
  return {
    kind: 'unsupported',
    reason: `Raster URL not recognized: ${url.pathname}. Expected /artwork/{slug}.`,
  };
}

/**
 * Feral File URL forms (source of truth: feralfile-client app-routing
 * + collection-routing modules):
 *   /exhibitions/artwork/{tokenId}       — single artwork by on-chain tokenId
 *   /exhibitions/series/{slug}           — series detail (multi-token)
 *   /exhibitions/shows/{slug}            — full exhibition (multiple series)
 *
 * These URLs do not include `chain` or `contract`; FF API walks are required
 * to derive them. The parser stays sync — it returns an `ff-url` marker that
 * the caller resolves asynchronously via `ff-marketplace#resolveFeralFileToken`.
 * Tracked for collapse to a single GET in feral-file/ff-exhibition#3039.
 */
export function parseFeralFile(url: URL): ParsedFindInput {
  // Public artwork ids may be numeric (legacy: URL id == on-chain tokenID) or
  // hex hashes (swapped-id editions). Accept any URL-safe alphanumeric form;
  // the FF API rejects unknown ids cleanly downstream.
  let m = /^\/exhibitions\/artwork\/([A-Za-z0-9]+)\/?$/.exec(url.pathname);
  if (m) {
    return { kind: 'ff-url', urlKind: 'artwork', identifier: m[1] };
  }
  m = /^\/exhibitions\/series\/([^/]+)\/?$/.exec(url.pathname);
  if (m) {
    return { kind: 'ff-url', urlKind: 'series', identifier: m[1] };
  }
  m = /^\/exhibitions\/shows\/([^/]+)\/?$/.exec(url.pathname);
  if (m) {
    return { kind: 'ff-url', urlKind: 'show', identifier: m[1] };
  }
  return {
    kind: 'unsupported',
    reason:
      `Feral File URL not recognized: ${url.pathname}. Supported: ` +
      '/exhibitions/artwork/{tokenId}, /exhibitions/series/{slug}, /exhibitions/shows/{slug}.',
  };
}

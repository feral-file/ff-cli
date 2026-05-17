/**
 * Marketplace URL parser for `ff-cli find`.
 *
 * Accepts user input in any of these forms and returns a normalized result:
 *  - Marketplace token URL (Objkt, fxhash, Art Blocks, Feral File)
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

export type MarketplaceSource = 'objkt' | 'artblocks' | 'fxhash' | 'feralfile';

export type FeralFileUrlKind = 'artwork' | 'series' | 'show';

export type ParsedFindInput =
  | { kind: 'token'; coords: TokenCoords; source: 'raw' | MarketplaceSource }
  | { kind: 'address'; chain: IndexerChain; address: string }
  | { kind: 'ff-url'; urlKind: FeralFileUrlKind; identifier: string }
  | { kind: 'objkt-alias'; alias: string; tokenId: string }
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
 * Dispatch a URL to the per-marketplace parser. Returns `null` when the
 * host is not one of the four supported marketplaces.
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
 *   artblocks.io/token/{0xcontract}-{tokenId}                        (current)
 *   artblocks.io/marketplace/collections/{0xcontract}/tokens/{id}    (marketplace UI)
 *
 * Project / series URLs (`/projects/{id}`, `/collections/{slug}`) are not
 * resolved in v1.
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
  if (url.pathname.startsWith('/projects/') || url.pathname.startsWith('/collections/')) {
    return {
      kind: 'unsupported',
      reason:
        'Art Blocks project/collection URLs are not yet supported in v1. Paste a specific ' +
        'token URL (artblocks.io/token/{contract}-{tokenId}) or use `ethereum:{contract}:{tokenId}`.',
    };
  }
  return {
    kind: 'unsupported',
    reason: `Art Blocks URL not recognized: ${url.pathname}.`,
  };
}

/**
 * fxhash URL forms (Tezos):
 *   fxhash.xyz/gentk/FX1-{KT1...}-{tokenId}                  (current naming)
 *   fxhash.xyz/gentk/{numericId}                             (legacy — needs fxhash API)
 *   fxhash.xyz/generative/{slug}                             (series — not supported in v1)
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
  if (url.pathname.startsWith('/generative/')) {
    return {
      kind: 'unsupported',
      reason:
        'fxhash series URLs (`/generative/...`) are not yet supported in v1. Paste a specific ' +
        'token URL.',
    };
  }
  return {
    kind: 'unsupported',
    reason: `fxhash URL not recognized: ${url.pathname}.`,
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
  let m = /^\/exhibitions\/artwork\/(\d+)\/?$/.exec(url.pathname);
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

import { Command, Option } from 'commander';
import chalk from 'chalk';
import { promises as fs } from 'fs';
import { parseFindInput } from '@feralfile/source-resolver';
import type { ParsedFindInput, TokenCoords } from '@feralfile/source-resolver';
import type { Playlist } from '../types';
import { createPrompt, promptYesNo } from './helpers/prompt';
import { selectFeedServer } from './helpers/feed-server';
import {
  FIND_NON_INTERACTIVE_HINT,
  fetchSeriesTokens,
  resolveFindTarget,
  type DirectTarget,
  type ResolvedTarget,
} from './helpers/find-target';
import { resolveNeortArt } from '../utilities/neort-marketplace';
import type { NeortArt } from '../utilities/neort-marketplace';
import { castPlaylist } from '../utilities/playlist-cast';
import {
  failureMessages,
  getTokenSource,
  itemsOf,
  type ResolvedToken,
  type TokenSource,
} from '../utilities/token-source';

// playlist-builder is still CommonJS; require keeps interop simple.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { buildDP1Playlist, buildUrlItem } = require('../utilities/playlist-builder');

interface FindOptions {
  output?: string;
  limit?: string;
  yes?: boolean;
  /** `--display` (true) or `--no-display` (false); undefined when neither was passed. */
  display?: boolean;
  /** Hidden `-p, --play` / `--no-play`, the retired spelling of `display`; see displayIntent. */
  play?: boolean;
  device?: string;
  publish?: boolean;
  server?: string;
  skipVerify?: boolean;
}

/**
 * Maximum item count for a single DP-1 playlist (v1.1 spec). Build paths
 * that exceed this would silently produce a playlist that `validateDP1Playlist`
 * rejects — so cap implicitly here and surface an actionable warning, and
 * reject explicit `--limit > MAX` outright.
 */
const DP1_MAX_ITEMS = 1024;

type PostBuildAction = 'play' | 'publish' | 'skip';

/**
 * playAPageHint points a caller who handed `find` a page it cannot resolve to
 * the command that shows a page as it is.
 *
 * @param {string} input - The URL the caller gave `find`
 * @returns {string} One line naming `ff-cli display --web`
 */
function playAPageHint(input: string): string {
  return `To show this page itself on your FF1, run: ff-cli display --web "${input}"`;
}

/**
 * displayIntent folds the hidden `--play` / `--no-play` spellings into
 * `--display` / `--no-display`.
 *
 * The verb for art is display, not play (B&F weekly 2026-11-03; Canon
 * reference/naming-brand.md §3.4), so `find` takes `--display` and
 * `--no-display`. `-p, --play` and `--no-play` stay accepted, hidden from
 * help, so existing scripts and agents keep working. Commander stores the two
 * spellings under separate keys (`display`, `play`); this is the one place
 * that reads both. The current spelling wins when a caller passes both.
 *
 * @param {FindOptions} options - Parsed `find` options
 * @returns {boolean | undefined} true to display, false to never cast,
 *   undefined when neither spelling was passed
 */
function displayIntent(options: FindOptions): boolean | undefined {
  return options.display ?? options.play;
}

export const findCommand = new Command('find')
  .description('Find an artwork on the web and build a DP-1 playlist')
  .argument(
    '<input>',
    'URL (Objkt / fxhash / Art Blocks / OpenSea / SuperRare / Feral File / Neort / Verse / Raster), `ethereum:{contract}:{tokenId}`, `tezos:{contract}:{tokenId}`, or a wallet address (looks up the artist, then wallet holdings if no artist claims it)'
  )
  .option('-o, --output <path>', 'Save the playlist to this file (default: ./<slug>.json)')
  .option('-l, --limit <n>', 'Max tokens to include from a series or wallet (up to 1024)')
  .option('--display', 'Display the playlist on an FF1 device after building')
  .option(
    '--no-display',
    'Never cast to a device; combine with -y to build and save without displaying'
  )
  // The retired spellings of the two flags above, accepted but never listed; see displayIntent.
  .addOption(new Option('-p, --play').hideHelp())
  .addOption(new Option('--no-play').hideHelp())
  .option(
    '-d, --device <name>',
    'Device to display on (used with --display; default: first configured)'
  )
  .option('--publish', 'Publish the playlist to a configured feed server')
  .option('-s, --server <index>', 'Feed server index (used with --publish)')
  .option(
    '-y, --yes',
    'Skip interactive prompts. Without --output or --publish, -y displays the playlist on a device; add --no-display to skip casting'
  )
  .option(
    '--skip-verify',
    'Skip signature verification before --display (mirrors `ff-cli display --skip-verify`)'
  )
  .action(async (input: string, options: FindOptions) => {
    try {
      console.log(chalk.blue('\nFind on Feral File CLI\n'));

      const parsed = parseFindInput(input);
      if (!parsed) {
        console.error(chalk.red('Could not understand input.'));
        console.error(
          chalk.dim(
            'Supported URLs: Objkt, fxhash, Art Blocks, OpenSea, SuperRare, Feral File, Neort, Verse, Raster. ' +
              'Or: `ethereum:{contract}:{tokenId}`, `tezos:{contract}:{tokenId}`, ' +
              'or a wallet address (`0x...` / `tz1.../tz2.../tz3...`).'
          )
        );
        // A plain web page or media URL is not an artwork lookup at all; `display`
        // casts those directly, so name it rather than leave the caller stuck.
        if (/^https?:\/\//i.test(input.trim())) {
          console.error(
            chalk.dim(`To display a web page or media URL as it is, run: ff-cli display "${input}"`)
          );
        }
        process.exit(1);
      }

      // Neort is off-chain and the source resolver does not cover it; its
      // items skip the token source and build a DP-1 entry from Neort's API.
      if (parsed.kind === 'neort-art') {
        await runNeortFind(parsed.id, options);
        return;
      }

      const target = await resolveFindTarget(input, parsed, !!options.yes);
      if (target === null) {
        exitUnresolved(input, parsed);
      }
      await runResolvedTarget(target, options);
    } catch (error) {
      console.error(chalk.red('\nError:'), (error as Error).message);
      process.exit(1);
    }
  });

/**
 * exitUnresolved explains an input the source resolver found no token behind
 * and exits 1. The parser's own reason leads when it had one (it names the
 * URL shapes that do work), and `display --web` is offered either way, since
 * `display` sends unrecognized pages on these hosts here and the way out of
 * that loop has to be printed on this side too.
 *
 * @param input - The caller's input
 * @param parsed - parseFindInput's reading of it
 */
function exitUnresolved(input: string, parsed: ParsedFindInput): never {
  const reason =
    parsed.kind === 'unsupported'
      ? parsed.reason
      : 'The source resolver found no token on Ethereum or Tezos behind this link.';
  console.error(chalk.red(reason));
  console.error(chalk.dim(playAPageHint(input)));
  process.exit(1);
}

/**
 * describeTarget prints the line that says what was found.
 *
 * A one-item fallback claims there is no series only when the service said
 * so cleanly. When it was unavailable (already explained) or some source did
 * not answer (its notes are shown), the series is unknown, not absent.
 *
 * @param target - A target other than a wallet
 */
function describeTarget(target: Exclude<ResolvedTarget, { kind: 'wallet' }>): void {
  if (target.kind === 'series') {
    console.log(chalk.cyan(`${target.artist || 'Unknown artist'} — ${target.title}`));
  } else if (target.kind === 'token-list') {
    console.log(chalk.cyan(target.title));
  } else {
    const { chain, contract, tokenId } = target.coords;
    console.log(chalk.cyan(`Single token — ${chain} ${contract}:${tokenId}`));
    for (const note of target.notes) {
      console.log(chalk.dim(`  Source resolver note: ${note}`));
    }
    if (!target.degraded && target.notes.length === 0) {
      console.log(
        chalk.dim(
          '  (No series of distinct works holds this token — building a one-item playlist.)'
        )
      );
    }
  }
  console.log();
}

/**
 * tokensToBuild lists the tokens a target builds, capped at `limit`, or
 * returns null when a series could not be listed and its fallback builds
 * instead.
 *
 * @param target - A target other than a wallet
 * @param limit - Effective token cap for the playlist
 * @returns The tokens and whether the source continues past them, or null
 */
async function tokensToBuild(
  target: Exclude<ResolvedTarget, { kind: 'wallet' }>,
  limit: number
): Promise<{ tokens: TokenCoords[]; hasMore: boolean } | null> {
  if (target.kind === 'series') {
    return fetchSeriesTokens(target, limit);
  }
  if (target.kind === 'token-list') {
    return { tokens: target.coords.slice(0, limit), hasMore: target.coords.length > limit };
  }
  return { tokens: [target.coords], hasMore: false };
}

/** runResolvedTarget builds the resolved artwork or wallet holdings into a playlist. */
async function runResolvedTarget(target: ResolvedTarget, options: FindOptions): Promise<void> {
  if (target.kind === 'wallet') {
    await runWalletFind(target.address, options);
    return;
  }
  describeTarget(target);

  const userLimit = parseLimitOption(options.limit);
  // Implicit cap: no --limit + series > 1024 → cap to DP-1 max with a
  // clear warning. Explicit `--limit > 1024` was already rejected by
  // parseLimitOption, so reaching here means either capped-by-default or
  // the user picked a value within spec.
  const limit = Math.min(userLimit, DP1_MAX_ITEMS);

  // Tokens are enumerated first (up to the effective limit) so the prompt
  // can name the real count. `hasMore` means the source continues past it.
  const listed = await tokensToBuild(target, limit);
  if (listed === null) {
    // Only a series that carries a fallback answers null (fetchSeriesTokens).
    await runResolvedTarget((target as { fallback: DirectTarget }).fallback, options);
    return;
  }
  const { tokens, hasMore } = listed;

  if (tokens.length === 0) {
    console.error(
      chalk.red('Series has no tokens on supported chains (Ethereum + Tezos mainnet).')
    );
    process.exit(1);
  }

  if (userLimit === Number.POSITIVE_INFINITY && hasMore) {
    console.log(
      chalk.yellow(
        `Series has more than ${DP1_MAX_ITEMS} tokens; DP-1 caps playlists at ${DP1_MAX_ITEMS}. ` +
          `Building with the first ${DP1_MAX_ITEMS} — pass \`--limit N\` (≤ ${DP1_MAX_ITEMS}) for fewer.`
      )
    );
    console.log();
  }

  const shouldBuild =
    !!options.yes || !!options.output || (await confirmMakePlaylist(tokens.length, hasMore));
  if (!shouldBuild) {
    console.log(chalk.dim('Cancelled.'));
    return;
  }
  const source = getTokenSource();
  const label = source.name === 'raster' ? 'Raster' : 'FF indexer';
  console.log(
    chalk.dim(`Resolving ${tokens.length} token${tokens.length === 1 ? '' : 's'} via ${label}...`)
  );
  // The indexer warms previously-unseen tokens by polling, which
  // takes minutes on a large series; Raster answers from its own index.
  if (source.name === 'indexer' && tokens.length > 10) {
    console.log(
      chalk.dim(
        '  First-time tokens can take the indexer a while to warm; use `--limit 5` for a faster first pass.'
      )
    );
  }
  const results = await resolveBuildTokens(source, tokens);
  const items = itemsOf(results);

  if (items.length === 0) {
    console.error(chalk.red(`No tokens could be resolved via ${label}; cannot build playlist.`));
    for (const message of failureMessages(results)) {
      console.error(chalk.dim(`  ${message}`));
    }
    process.exit(1);
  }

  const title = playlistTitleFor(target, items);
  const dropped = tokens.length - items.length;
  if (dropped > 0) {
    console.log(chalk.dim(`  ${dropped} token${dropped === 1 ? '' : 's'} could not be resolved:`));
    for (const message of failureMessages(results)) {
      console.log(chalk.dim(`    ${message}`));
    }
  }
  await saveFindPlaylist(items, title, options);
}

/** runWalletFind lists holdings through the configured token source without re-indexing them. */
async function runWalletFind(address: string, options: FindOptions): Promise<void> {
  const limit = effectiveLimitFromOption(options.limit);
  const source = getTokenSource();
  console.log(chalk.cyan(`Looking up holdings for wallet ${address}...`));
  const listing = await source.listTokensByOwner(address, { limit });
  const items = itemsOf(listing.results).slice(0, limit);
  for (const message of failureMessages(listing.results)) {
    console.log(chalk.dim(`  ${message}`));
  }
  if (listing.skippedUnsupported > 0) {
    console.log(chalk.dim(`  Skipped ${listing.skippedUnsupported} tokens on unsupported chains.`));
  }
  if (items.length === 0) {
    throw new Error(`No playable tokens found in wallet ${address} via ${source.name}.`);
  }
  if (!options.yes && !options.output && !(await confirmMakePlaylist(items.length, false))) {
    console.log(chalk.dim('Cancelled.'));
    return;
  }
  await saveFindPlaylist(items, `Wallet ${address}`, options);
}

/** saveFindPlaylist writes the DP-1 playlist and runs the requested delivery actions. */
async function saveFindPlaylist(
  items: Record<string, unknown>[],
  title: string,
  options: FindOptions
): Promise<void> {
  const playlist = await buildDP1Playlist({ items, title });

  const outputPath = options.output ?? `${playlist.slug || 'playlist'}.json`;
  await fs.writeFile(outputPath, JSON.stringify(playlist, null, 2));

  console.log(chalk.green(`✓ Playlist saved to ${outputPath}`));
  console.log(chalk.dim(`  ${items.length} item${items.length === 1 ? '' : 's'}`));
  console.log();

  const actions = await decideActions(options);
  for (const action of actions) {
    if (action === 'play') {
      await doPlay(playlist, options.device, !!options.skipVerify);
    } else if (action === 'publish') {
      await doPublish(outputPath, options.server, !!options.yes);
    }
  }
}

/**
 * effectiveLimitFromOption returns the effective token cap for a wallet
 * listing: the caller's --limit, never above the DP-1 maximum.
 */
function effectiveLimitFromOption(limitStr: string | undefined): number {
  return Math.min(parseLimitOption(limitStr), DP1_MAX_ITEMS);
}

/**
 * Build the playlist title. For series, "Artist — Series Title". For a
 * one-item fallback, use the token source's name (already in the item)
 * with a fall-through to coords if name is missing.
 */
function playlistTitleFor(
  target: Exclude<ResolvedTarget, { kind: 'wallet' }>,
  items: Array<{ title?: string }>
): string {
  if (target.kind === 'series') {
    return `${target.artist || 'Unknown artist'} — ${target.title}`;
  }
  if (target.kind === 'token-list') {
    return target.title;
  }
  return items[0]?.title ?? `Token ${target.coords.tokenId}`;
}

/**
 * resolveBuildTokens turns the tokens to build into results, one per token,
 * through the configured token source (one vendor per run).
 */
async function resolveBuildTokens(
  source: TokenSource,
  tokens: TokenCoords[]
): Promise<ResolvedToken[]> {
  // Unconditional progress: the final N/N line IS the "resolution finished"
  // signal, including for a single-batch run.
  return source.resolveTokens(tokens.map(coordinateOf), {
    onProgress: (done: number, total: number) => {
      console.log(chalk.dim(`  ${done}/${total} tokens resolved...`));
    },
  });
}

/** coordinateOf converts a find token to the token source's coordinate shape. */
function coordinateOf(token: TokenCoords): {
  chain: string;
  contractAddress: string;
  tokenId: string;
} {
  return { chain: token.chain, contractAddress: token.contract, tokenId: token.tokenId };
}

export function parseLimitOption(limitStr: string | undefined): number {
  if (limitStr === undefined) {
    return Number.POSITIVE_INFINITY;
  }
  // Strict integer parse: `Number('5abc')` is NaN, while `parseInt('5abc', 10)`
  // returns 5 and silently truncates user input. Reject anything that isn't a
  // clean positive integer.
  const n = Number(limitStr);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    throw new Error(`Invalid --limit value: ${limitStr} (expected a positive integer)`);
  }
  if (n > DP1_MAX_ITEMS) {
    throw new Error(
      `Invalid --limit value: ${n} exceeds DP-1 playlist max of ${DP1_MAX_ITEMS} items.`
    );
  }
  return n;
}

async function confirmMakePlaylist(count: number, hasMore: boolean): Promise<boolean> {
  const noun = count === 1 ? 'token' : 'tokens';
  const label = hasMore ? `the first ${count} ${noun}` : `${count} ${noun}`;
  const prompt = createPrompt(FIND_NON_INTERACTIVE_HINT);
  const yes = await promptYesNo(prompt.ask, `Build playlist with ${label}?`, true);
  prompt.close();
  console.log();
  return yes;
}

/**
 * Decide which post-build actions to run.
 *
 * Precedence: explicit flags (--display / --publish) win and may combine. If
 * no flag is set, fall back to the --yes default (display) or an interactive
 * 3-way prompt. Save is unconditional and already done before this is called.
 *
 * `--no-display` (commander sets `display === false`) is an opt-out that
 * removes casting from every path, including the `--yes` default and the
 * interactive prompt. It is additive: `--yes` alone keeps its deliberate
 * "max-satisfaction default for scripted use" of displaying, and this must not
 * change that. Because `--no-display` already states the user's intent, it
 * never opens the prompt. The hidden `--play` / `--no-play` spellings mean the
 * same (displayIntent). The internal action keeps its name, 'play'.
 */
export async function decideActions(options: FindOptions): Promise<PostBuildAction[]> {
  const flagActions: PostBuildAction[] = [];
  const display = displayIntent(options);
  const noDisplay = display === false;
  if (display) {
    flagActions.push('play');
  }
  if (options.publish) {
    flagActions.push('publish');
  }
  if (flagActions.length > 0) {
    return flagActions;
  }
  // --output alone (with or without --yes) means "save mode" — the save was the action.
  // --no-display likewise means the save was the action; never prompt or default to display.
  if (options.output || noDisplay) {
    return [];
  }
  // --yes without --output defaults to display (max-satisfaction default for scripted use).
  if (options.yes) {
    return ['play'];
  }
  return [await promptNextAction()];
}

export type { FindOptions, ResolvedTarget };

/**
 * promptNextAction asks what to do with a saved playlist when no flag said so.
 *
 * `p` and `play` stay accepted after the rename to display: a script that
 * pipes its answer in must keep getting the same action.
 *
 * @returns {Promise<PostBuildAction>} The chosen action
 * @throws {Error} On an answer that names no action
 */
async function promptNextAction(): Promise<PostBuildAction> {
  const prompt = createPrompt(
    'The playlist is saved. Pass --display to cast it, or --publish to publish it.'
  );
  const answer = (
    await prompt.ask(
      'Next? [D]isplay on FF1 / just [S]ave / pub[L]ish to feed (default: Display): '
    )
  )
    .trim()
    .toLowerCase();
  prompt.close();
  console.log();
  const displayAnswers = ['', 'd', 'display', 'p', 'play', 'y', 'yes'];
  if (displayAnswers.includes(answer)) {
    return 'play';
  }
  if (answer === 's' || answer === 'save' || answer === 'n' || answer === 'no') {
    return 'skip';
  }
  if (answer === 'l' || answer === 'pub' || answer === 'publish') {
    return 'publish';
  }
  throw new Error(`Unrecognized choice: "${answer}". Use D, S, or L.`);
}

async function doPlay(
  playlist: Playlist,
  deviceName: string | undefined,
  skipVerify: boolean
): Promise<void> {
  // Same verify → send gate `ff-cli display` uses, via the shared castPlaylist
  // helper. `find`'s playlists are already signed by buildDP1Playlist (when a
  // key is configured), so no signing is requested here — an unsigned one
  // fails the verify gate with an actionable message instead of reaching the
  // wall unverifiable.
  if (!skipVerify) {
    console.log(chalk.cyan('Verify playlist'));
  }

  const result = await castPlaylist(playlist, { deviceName, skipVerify });

  if (!result.success) {
    if (result.stage === 'verify') {
      console.error(chalk.red('Playlist verification failed:'), result.error);
      if (result.details && result.details.length > 0) {
        for (const d of result.details) {
          console.error(chalk.dim(`  ${d.path}: ${d.message}`));
        }
      }
      console.error(
        chalk.dim(
          '  Tip: configure a playlist signing key (config or PLAYLIST_PRIVATE_KEY), ' +
            'or pass --skip-verify to bypass.'
        )
      );
    } else {
      console.error(chalk.red('Display failed:'), result.error);
      if (result.deviceDetails) {
        console.error(chalk.dim(`  Details: ${result.deviceDetails}`));
      }
    }
    process.exitCode = 1;
    return;
  }

  if (result.verified) {
    console.log(chalk.green('✓ Verified\n'));
  }
  console.log(chalk.blue('Display on FF1'));
  console.log(chalk.green('✓ Displaying'));
  if (result.deviceName) {
    console.log(chalk.dim(`  Device: ${result.deviceName}`));
  }
  if (result.device) {
    console.log(chalk.dim(`  Host: ${result.device}`));
  }
  console.log();
}

async function doPublish(
  savedPath: string,
  serverArg: string | undefined,
  nonInteractive: boolean
): Promise<void> {
  console.log(chalk.blue('Publish to feed'));
  const { getFeedConfig } = await import('../config.js');
  const { publishPlaylist } = await import('../utilities/playlist-publisher.js');

  const feedConfig = getFeedConfig();
  // One implementation of the server rule for every write path (see helpers/feed-server.ts): --server is
  // validated whatever the server count, and an ambiguous choice fails loudly rather than defaulting.
  const selection = await selectFeedServer(feedConfig.baseURLs, {
    serverArg,
    nonInteractive,
  });
  if (!selection.ok) {
    console.error(chalk.red(selection.error));
    if (selection.detail) {
      console.error(selection.detail);
    }
    process.exitCode = 1;
    return;
  }

  const serverUrl = selection.url;

  const result = await publishPlaylist(savedPath, serverUrl);
  if (result.success) {
    console.log(chalk.green('✓ Published'));
    if (result.playlistId) {
      console.log(chalk.dim(`  Playlist ID: ${result.playlistId}`));
    }
    if (result.feedServer) {
      console.log(chalk.dim(`  Server: ${result.feedServer}`));
    }
    console.log();
    return;
  }
  console.error(chalk.red('Publish failed:'), result.error);
  if (result.message) {
    console.error(chalk.dim(`  ${result.message}`));
  }
  process.exitCode = 1;
}

/**
 * Neort flow. Off-chain platform with no on-chain coords, so we bypass
 * the token source and construct a single-item DP-1 playlist directly
 * from Neort's API response using the off-chain `provenance.offChainURI`
 * shape produced by `buildUrlItem`.
 */
async function runNeortFind(id: string, options: FindOptions): Promise<void> {
  const art: NeortArt = await resolveNeortArt(id);
  const artistLabel = art.artistName || 'Unknown artist';
  console.log(chalk.cyan(`Neort — ${artistLabel} — ${art.title}`));
  console.log(
    chalk.dim('  (Off-chain platform; building a one-item playlist directly from Neort.)')
  );
  console.log();

  const shouldBuild = !!options.yes || !!options.output || (await confirmMakePlaylist(1, false));
  if (!shouldBuild) {
    console.log(chalk.dim('Cancelled.'));
    return;
  }

  // No explicit duration: auto timing (video/audio play natural length).
  const item = buildUrlItem(art.assetUrl, undefined, { title: art.title });
  const playlistTitle = `${artistLabel} — ${art.title}`;
  const playlist = await buildDP1Playlist({ items: [item], title: playlistTitle });

  const outputPath = options.output ?? `${playlist.slug || 'playlist'}.json`;
  await fs.writeFile(outputPath, JSON.stringify(playlist, null, 2));

  console.log(chalk.green(`✓ Playlist saved to ${outputPath}`));
  console.log(chalk.dim('  1 item'));
  console.log();

  const actions = await decideActions(options);
  for (const action of actions) {
    if (action === 'play') {
      await doPlay(playlist, options.device, !!options.skipVerify);
    } else if (action === 'publish') {
      await doPublish(outputPath, options.server, !!options.yes);
    }
  }
}

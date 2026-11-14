/**
 * page-playlist-link finds the DP-1 playlist a web page declares for itself.
 *
 * A page that presents a set of works (an exhibition page, a curator's
 * selection) can name the playlist that carries those works in its head:
 *
 *   <link rel="alternate" type="application/json"
 *         href="https://example.com/show/playlist.json" title="DP-1 playlist">
 *
 * `display <page address>` follows that link, so the address someone has open
 * in a browser is enough to put the works, not the page, on an FF1. This is
 * the form feralfile.com exhibition pages carry (checked 2026-11-14 on
 * /exhibitions/e-volved-formulae-8an, which also declares a "DP-1 channel"
 * the same way).
 *
 * The match is `rel` containing `alternate` plus the exact title "DP-1
 * playlist" (case-insensitive). The `type` is plain `application/json`, which
 * says nothing about DP-1, so the title is the only marker there is today.
 * When the DP-1 docs define a form a client can match without reading title
 * text, add that form here and keep this one, since deployed pages use it.
 *
 * Only the playlist link is matched. A page that declares both a playlist and
 * a channel displays the playlist (decided with the feature): the page shows
 * one set of works, and the playlist is that set.
 */

/** The title a page gives the link to its DP-1 playlist. */
const PLAYLIST_LINK_TITLE = 'dp-1 playlist';

const LINK_TAG = /<link\b[^>]*>/gi;
const ATTRIBUTE = /([^\s"'<>/=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+))/g;

/**
 * parseAttributes reads the attributes of one HTML tag into a map keyed by
 * lower-cased name. The first occurrence of a name wins, as in a browser.
 *
 * @param {string} tag - One tag's source text, e.g. `<link rel="x" href="y">`
 * @returns {Map<string, string>} Attribute values with character references
 *   for `&amp;`, `&quot;` and `&#39;` decoded (the ones a URL or title can
 *   plausibly carry)
 */
function parseAttributes(tag: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of tag.matchAll(ATTRIBUTE)) {
    const name = match[1].toLowerCase();
    if (!attributes.has(name)) {
      const raw = match[2] ?? match[3] ?? match[4] ?? '';
      attributes.set(
        name,
        raw
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/&amp;/g, '&')
      );
    }
  }
  return attributes;
}

/**
 * findDeclaredPlaylistUrl returns the absolute URL of the DP-1 playlist an
 * HTML page declares, or null when it declares none.
 *
 * The first matching link wins. A relative `href` resolves against the page's
 * own URL (a `<base>` element is not honored; no page seen so far needs it).
 * A link whose `href` is missing, unparseable, or not http(s) is skipped, so a
 * page can never point `display` at a local file or another scheme.
 *
 * @param {string} html - The page's source text
 * @param {string} pageUrl - The URL the page was fetched from
 * @returns {string | null} The declared playlist URL
 */
export function findDeclaredPlaylistUrl(html: string, pageUrl: string): string | null {
  for (const tag of html.match(LINK_TAG) ?? []) {
    const attributes = parseAttributes(tag);
    const rel = (attributes.get('rel') ?? '').toLowerCase().split(/\s+/);
    const title = (attributes.get('title') ?? '').trim().toLowerCase();
    const href = attributes.get('href')?.trim();
    if (!rel.includes('alternate') || title !== PLAYLIST_LINK_TITLE || !href) {
      continue;
    }
    try {
      const resolved = new URL(href, pageUrl);
      if (resolved.protocol === 'http:' || resolved.protocol === 'https:') {
        return resolved.toString();
      }
    } catch {
      // An href that does not parse declares nothing; keep looking.
    }
  }
  return null;
}

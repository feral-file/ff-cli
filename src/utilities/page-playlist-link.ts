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

/**
 * Text a browser never reads as elements: comments, and the raw-text bodies
 * of script, style, textarea and title. A `<link>` written inside any of them
 * (a commented-out declaration, markup in a JavaScript string) declares
 * nothing, so it is removed before links are matched.
 */
const NON_ELEMENT_TEXT =
  /<!--[\s\S]*?(?:-->|$)|<(script|style|textarea|title)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi;

const NAMED_REFERENCES: Record<string, string> = {
  amp: '&',
  quot: '"',
  apos: "'",
  lt: '<',
  gt: '>',
};

/**
 * decodeCharacterReferences decodes the HTML character references an
 * attribute value can carry: numeric ones (`&#38;`, `&#x26;`) and the five
 * named ones every serializer emits. An undecoded `&#38;` in an href would
 * turn into a URL fragment and drop the rest of the query string.
 *
 * @param {string} value - Raw attribute value
 * @returns {string} The decoded value; unknown references are left as written
 */
function decodeCharacterReferences(value: string): string {
  return value.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (whole, dec, hex, name) => {
    if (name) {
      return NAMED_REFERENCES[name.toLowerCase()] ?? whole;
    }
    const codePoint = dec ? Number.parseInt(dec, 10) : Number.parseInt(hex, 16);
    return codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : whole;
  });
}
const ATTRIBUTE = /([^\s"'<>/=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+))/g;

/**
 * parseAttributes reads the attributes of one HTML tag into a map keyed by
 * lower-cased name. The first occurrence of a name wins, as in a browser.
 *
 * @param {string} tag - One tag's source text, e.g. `<link rel="x" href="y">`
 * @returns {Map<string, string>} Attribute values, character references decoded
 */
function parseAttributes(tag: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of tag.matchAll(ATTRIBUTE)) {
    const name = match[1].toLowerCase();
    if (!attributes.has(name)) {
      const raw = match[2] ?? match[3] ?? match[4] ?? '';
      attributes.set(name, decodeCharacterReferences(raw));
    }
  }
  return attributes;
}

/**
 * DeclaredPlaylist is what a page's playlist link says: a URL to load, or an
 * `href` that cannot be loaded (`invalid`). The two are kept apart because a
 * page that declares a playlist ff-cli cannot use must stop `display`, while a
 * page that declares nothing is displayed as a page.
 */
export type DeclaredPlaylist = { url: string } | { invalid: string };

/**
 * findDeclaredPlaylist returns the DP-1 playlist an HTML page declares, or
 * null when it declares none.
 *
 * The first matching link decides. A relative `href` resolves against
 * `pageUrl`, which must be the URL the page was finally served from (after
 * redirects), as in a browser; a `<base>` element is not honored, since no
 * page seen so far needs it. An `href` that does not parse, or that is not
 * http(s), comes back as `invalid`: a page can never point `display` at a
 * local file or another scheme, and the caller refuses instead of falling
 * back to the page. A matching link with no `href` at all declares nothing.
 *
 * @param {string} html - The page's source text
 * @param {string} pageUrl - The URL the page was served from
 * @returns {DeclaredPlaylist | null} The declaration, if any
 */
export function findDeclaredPlaylist(html: string, pageUrl: string): DeclaredPlaylist | null {
  for (const tag of html.replace(NON_ELEMENT_TEXT, ' ').match(LINK_TAG) ?? []) {
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
        return { url: resolved.toString() };
      }
    } catch {
      // Falls through: an href that does not parse is an invalid declaration.
    }
    return { invalid: href };
  }
  return null;
}

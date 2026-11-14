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

/**
 * Elements whose body is text, not markup: a `<link>` written inside one (markup
 * in a JavaScript string, a `<title>`) declares nothing, so the tokenizer skips
 * from the start tag to the matching end tag.
 */
const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'textarea', 'title']);

/**
 * One attribute: a name, then optionally `=` and a double-quoted, single-quoted
 * or unquoted value. Sticky, so a tag is read attribute by attribute from a
 * known position and a `>` inside a quoted value never ends the tag.
 */
const ATTRIBUTE = /\s*([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>]*)))?/y;

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
  // Numeric references decode without the closing semicolon, as in a browser
  // (`&#38b=2` is `&b=2`); named ones are decoded only when written with it.
  return value.replace(/&(?:#(\d+);?|#x([0-9a-f]+);?|([a-z]+);)/gi, (whole, dec, hex, name) => {
    if (name) {
      return NAMED_REFERENCES[name.toLowerCase()] ?? whole;
    }
    const codePoint = dec ? Number.parseInt(dec, 10) : Number.parseInt(hex, 16);
    return codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : whole;
  });
}

/** A start tag read from a page: its lower-cased name and attributes. */
interface StartTag {
  name: string;
  attributes: Map<string, string>;
}

/**
 * readStartTags walks an HTML document and yields each start tag a browser
 * would see as an element, in document order.
 *
 * This is a small tokenizer, not a regex over the whole text, because the
 * cases a regex gets wrong are the ones that matter here: a `>` inside a
 * quoted attribute value ends a regex match early and hides a real link, and
 * `<link …>` written inside another element's attribute value, a comment, or
 * a script is not an element at all and must not be followed. It handles
 * comments, quoted attributes, and raw-text elements; it does not build a
 * tree, which finding a `<link>` does not need. ff-cli has no HTML parser
 * dependency, and this job does not justify adding one.
 *
 * @param {string} html - The page's source text
 * @returns {Generator<StartTag>} Start tags; attribute names lower-cased, the
 *   first occurrence of a name winning, values character-reference decoded
 */
function* readStartTags(html: string): Generator<StartTag> {
  let position = 0;
  while ((position = html.indexOf('<', position)) !== -1) {
    if (html.startsWith('<!--', position)) {
      const end = html.indexOf('-->', position + 4);
      position = end === -1 ? html.length : end + 3;
      continue;
    }
    const nameMatch = /^<([a-z][^\s/>]*)/i.exec(html.slice(position, position + 64));
    if (!nameMatch) {
      position += 1;
      continue;
    }
    const name = nameMatch[1].toLowerCase();
    const attributes = new Map<string, string>();
    position += nameMatch[0].length;
    for (;;) {
      ATTRIBUTE.lastIndex = position;
      const attribute = ATTRIBUTE.exec(html);
      if (!attribute) {
        break;
      }
      position = ATTRIBUTE.lastIndex;
      const attributeName = attribute[1].toLowerCase();
      if (!attributes.has(attributeName)) {
        const raw = attribute[2] ?? attribute[3] ?? attribute[4] ?? '';
        attributes.set(attributeName, decodeCharacterReferences(raw));
      }
    }
    // Whatever is left before `>` is a stray `/`, quote or `=`; skip it.
    const close = html.indexOf('>', position);
    position = close === -1 ? html.length : close + 1;
    yield { name, attributes };
    if (RAW_TEXT_ELEMENTS.has(name)) {
      // Search the original text: lower-casing the page first can change its
      // length (Turkish İ becomes two code units) and shift every offset.
      const endTag = new RegExp(`</${name}`, 'gi');
      endTag.lastIndex = position;
      const end = endTag.exec(html);
      position = end ? end.index : html.length;
    }
  }
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
 * back to the page. So does an `href` that is present but empty. A matching
 * link with no `href` attribute at all declares nothing.
 *
 * @param {string} html - The page's source text
 * @param {string} pageUrl - The URL the page was served from
 * @returns {DeclaredPlaylist | null} The declaration, if any
 */
export function findDeclaredPlaylist(html: string, pageUrl: string): DeclaredPlaylist | null {
  for (const { name, attributes } of readStartTags(html)) {
    if (name !== 'link') {
      continue;
    }
    const rel = (attributes.get('rel') ?? '').toLowerCase().split(/\s+/);
    const title = (attributes.get('title') ?? '').trim().toLowerCase();
    const href = attributes.get('href')?.trim();
    if (!rel.includes('alternate') || title !== PLAYLIST_LINK_TITLE || href === undefined) {
      continue;
    }
    if (!href) {
      return { invalid: '(empty href)' };
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

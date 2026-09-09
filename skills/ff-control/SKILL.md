---
name: ff-control
description: Drive ff-cli end-to-end to build, validate, send, and publish DP-1 playlists on a Feral File Art Computer (FF1). Use when the user asks to make a playlist, play an artwork or URL on an Art Computer, publish to a feed, or otherwise operate ff-cli. Assumes ff-cli is installed and configured.
---

You run ff-cli end to end with full autonomy.
Do not ask for final confirmation before send or publish.

Context:
- The Art Computer is Feral File's instrument for daily playback in The Digital Art System.
- This skill uses ff-cli to build DP-1 playlists and send/publish them.
- Prioritize reliable execution and clear failure reporting over explanation.

Keep it simple. Prefer deletion over added process.
Do not invent new requirements.

Bootstrap (only if not yet installed/configured — skip when `ff-cli status` already works):
- Install (most reliable): `npm i -g @feralfile/cli` (needs Node.js 22+).
- Configure non-interactively (never rely on prompts — they cannot be driven by an agent):
  `ff-cli setup --non-interactive --generate-key --device-host http://<device-ip>:1111 --device-name "<name>"`
  - The signing key is base64 PKCS#8 DER; `--generate-key` creates one. To reuse a key, pass `--key "<value>"` (base64 PKCS#8 DER, 32-byte seed as hex/base64, or PEM).
  - Skip mDNS discovery entirely — it is unreliable across subnets. Always pass `--device-host`. Add more devices with `ff-cli device add --host http://<ip>:1111 --name "<name>"`.
- A signed playlist hosted at any public HTTPS URL plays directly (`ff-cli play "<url>"`); a feed server is only needed for discovery/curation, not for playback.

Flow:
1) ff-cli status
2) ff-cli config validate
3) Build playlist (ff-cli has no chat — you are the natural-language layer; translate the request into one of these yourself):
   - for a single artwork or a collection from a URL or on-chain coords: `ff-cli find "<input>" -o playlist.json -y` (add `--play` to build and play in one step). `-y` skips the prompts, which is safe when the input names one work or one series.
   - for a wallet address, do not pass `-y`: when the wallet holds several works `-y` makes `find` take the first one without asking. Ask the user which work they mean and run `find` on that work's URL or coordinate instead; use the wallet form only when they want everything the wallet holds (with `-l <n>`).
   - on-chain coordinates are `ethereum:<contract>:<tokenId>` or `tezos:<contract>:<tokenId>`. A coordinate resolves to its whole series, and a large series indexes for minutes. Always pass `-l <n>` unless the user asked for the whole series.
   - otherwise turn the request into structured params and run `ff-cli build <params.json> -o playlist.json -v`
   - `find` and `build` sign the playlist as `curator` with the configured key and declare it in `curators[]`; that is what lets the feed accept it and what lets you take it back later.
4) `ff-cli validate playlist.json`
5) If requested, run:
   - send: `ff-cli play playlist.json` (or with `-d "Device Name"`)
   - if it fails with reachability errors (`fetch failed`, `No route to host`, resolver timeout), report the exact failing command and error and that the Art Computer is unreachable from this network — do not suggest tunnels, IP changes, or network debugging
   - publish: `ff-cli publish playlist.json -s <index>`. Run `ff-cli config show` first; it lists the effective feed servers as `<index>: <url>`, whichever source configured them. With more than one configured, the command prompts for one and a prompt cannot be driven by an agent, so pass `-s <index>` for the feed the user named. If the user did not name a feed and more than one is configured, stop and ask which; never pick index 0 on your own, it is usually production. Use that same index for every later fetch, replace, or unpublish of that playlist. Publishing sends no API key; the feed accepts the playlist on its own signatures.
   - if both are requested: send first, then publish

Changing or removing something already published (owner-bound: only the key that signed it as `curator` can do this):
- `ff-cli fetch <id-or-url> -s <index> -o playlist.json` saves the stored document (same index the playlist was published to).
- edit it, then `ff-cli sign playlist.json -r curator --replace-signatures` (plain `sign` appends and refuses on an edited document), then `ff-cli publish --replace playlist.json -s <index>`.
- `ff-cli unpublish <id-or-url> -s <index> -y` deletes it. Deletion is permanent; the id is tombstoned and cannot be reused. Confirm the feed index with the user before deleting anything.
- A refusal that says the playlist declares no owners, or that no key has proved ownership, is terminal: nothing can mutate that playlist. Publish a corrected one under a new id instead.

If any step fails, do not hide it.
Return the exact failing command and error code/status (exit code or HTTP status), plus one next command to retry.

Keep output short and concrete:
- what ran
- what succeeded
- what failed (with code)
- what to run next

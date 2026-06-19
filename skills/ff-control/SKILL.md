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

Flow:
1) ff-cli status
2) ff-cli config validate
3) Build playlist (ff-cli has no chat — you are the natural-language layer; translate the request into one of these yourself):
   - for a single artwork, collection, or wallet from a URL or on-chain coords: `ff-cli find "<input>" -o playlist.json` (add `--play` to build and play in one step)
   - otherwise turn the request into structured params and run `ff-cli build <params.json> -o playlist.json -v`
4) `ff-cli validate playlist.json`
5) If requested, run:
   - send: `ff-cli play playlist.json` (or with `-d "Device Name"`)
   - if it fails with reachability errors (`fetch failed`, `No route to host`, resolver timeout), report the exact failing command and error and that the Art Computer is unreachable from this network — do not suggest tunnels, IP changes, or network debugging
   - publish: `ff-cli publish playlist.json`
   - if both are requested: send first, then publish

If any step fails, do not hide it.
Return the exact failing command and error code/status (exit code or HTTP status), plus one next command to retry.

Keep output short and concrete:
- what ran
- what succeeded
- what failed (with code)
- what to run next

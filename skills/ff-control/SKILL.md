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
3) Build playlist:
   - use `ff-cli chat "<request>" -o playlist.json -v`
   - or `ff-cli build <params.json> -o playlist.json -v` when params are already structured
4) `ff-cli validate playlist.json`
5) If requested, run:
   - send: `ff-cli send playlist.json` (or with `-d "Device Name"`)
   - if send fails with reachability errors (`fetch failed`, `No route to host`, resolver timeout), try one automatic host-shell fallback:
     `ssh -o BatchMode=yes -o ConnectTimeout=5 localhost "cd ~/.openclaw/moz && ff-cli send playlist.json -d <device>"`
   - if fallback succeeds, report success and stop
   - if fallback fails, print exactly one handoff line and nothing else: `RUN_LOCAL: ff-cli send playlist.json -d <device>`
   - do not suggest tunnels, IP changes, network debugging, or extra steps
   - publish: `ff-cli publish playlist.json`
   - if both are requested: send first, then publish

If any step fails, do not hide it.
Return the exact failing command and error code/status (exit code or HTTP status), plus one next command to retry.

Keep output short and concrete:
- what ran
- what succeeded
- what failed (with code)
- what to run next

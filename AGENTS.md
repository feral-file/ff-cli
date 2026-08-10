# AGENTS.md — ff-cli Repository Contract

This file is the repository-level contract for humans and coding agents working in `ff-cli`.

It defines how work is done in this repo. Tool-specific details live in `.cursor/`, `opencode.json`, and shared review prompts.

## Repository overview

- Project: `ff-cli`
- Purpose: a Node.js CLI for FF1 computational art workflows, DP-1 envelopes, playlist validation, playlist publishing, and FF1 device operations
- Primary runtime: Node.js + TypeScript
- Domain terms to keep consistent: `FF1`, `DP-1 envelope`, `DP-1 conformance`, `computational art playlist`, `channel endorsement`, `FF1 device`

## Portable operating model

Default sequence:

`spec -> design -> tasks -> tests -> implementation -> verification -> review -> merge`

TDD is the default discipline for behavior changes. For small, low-risk fixes, the sequence can be compressed, but work must still remain scoped, verified, reviewed, and traceable.

## Non-negotiables

- Prefer replacing or deleting flawed code paths over narrow local patches when that yields a clearer design.
- Do not preserve legacy behavior, compatibility shims, migrations, or transitional paths unless explicitly requested.
- Keep functions small, single-purpose, and testable. Break up functions that exceed roughly 30 lines, carry multiple concerns, or hide business rules in branching.
- Use TypeScript for new or updated source when practical. Legacy `.js` files may remain until intentionally migrated.
- Prefer comments that carry durable engineering context for future amendment by later agent sessions.
- When code is non-obvious, store design intent, trade-offs, invariants, edge cases, and coding constraints in comments near the code they govern.
- Update JSDoc whenever a function changes. New or updated functions should have complete JSDoc.

## Coding style and comments

- Follow a Go-style documentation standard for comments even though the repo is TypeScript-first.
- Write comments as clear sentences. Start doc comments with the symbol name when documenting a function, type, constant, or module.
- Prefer comments that explain `why`, `why now`, `why this shape`, and `what must not change` over comments that restate syntax.
- Add comments generously when the code encodes business rules, validation invariants, protocol expectations, fallback behavior, security assumptions, or trade-offs that would be easy for a later agent to break.
- Keep short obvious code paths uncommented. Extra comments are encouraged only when they add future maintenance value.
- When a compromise is intentional, record the constraint and rejected alternative in the comment.
- When behavior depends on external systems or repo conventions, record that dependency in the comment so a later agent can amend safely.
- Preserve high-signal comments during refactors. Update them when the reasoning changes.

## Repo-specific implementation rules

- Docs may only be updated in `/docs/README.md`, `/docs/EXAMPLES.md`, `/docs/CONFIGURATION.md`, `/docs/RELEASING.md`, or `/docs/PROJECT_SPEC.md`.
- Do not add new root or `/docs` process documents beyond the approved set above.
- Only update docs when behavior, usage, operations, or user-facing output changes.
- Config priority remains `config.json` > `.env` > defaults. Validate config before use.
- Never commit secrets or local runtime files such as `config.json`, `.env`, or `node_modules`.
- Temporary debug scripts belong in `/.tmp`, should not be committed, and should be removed after use.

## Architecture and API design

These sections are intentionally reserved for the repo owner to define.

- Architecture boundaries: `TBD by repo owner`
- API design rules: `TBD by repo owner`

Until those rules are defined, prefer conservative changes that improve clarity without locking in new architectural patterns.

## Required workflow for substantial changes

Before implementing a major feature, flow change, refactor, or architectural update:

1. Read `docs/PROJECT_SPEC.md`.
2. Read the relevant docs and source files for the affected area.
3. Summarize current behavior, constraints, and invariants.
4. Write or update a short spec or design note in the handoff if no formal artifact exists.
5. Break the work into concrete tasks.
6. Identify expected behaviors and verification steps.
7. Add or update tests before implementation where behavior changes.
8. Then implement, carrying forward the relevant design constraints in code comments when the resulting code would otherwise lose that context.

If no relevant spec or current-state summary exists for a substantial change, do not jump straight to implementation.

## TDD and verification expectations

For behavior changes:

1. Write or update focused tests first when practical.
2. Implement until tests pass.
3. Refactor while keeping tests green.
4. Run the repo verification commands before handing work off or finishing.

Required verification commands:

```bash
npm run verify
```

This is the same non-mutating entrypoint used by `.github/workflows/ci.yml` after `npm ci` on Node.js 22. Use `npm run lint:fix` only as an optional mutating cleanup step, then review and verify the resulting edits before committing.

If strict test-first sequencing is not practical, call out the reason in the handoff or final summary.

## Definition of done

A task is complete only when:

1. The requested change is implemented.
2. Relevant tests were added or updated, or an explicit reason is given when none were appropriate.
3. Verification passes cleanly.
4. Docs are updated if user-facing behavior changed.
5. For a non-trivial change, a fresh-context review has reported findings and the named human change owner has decided whether to fix, reject, or accept each material finding.
6. The branch is merge-ready without hidden follow-up work.

## Completion review

After implementation, run one fresh-context review at completion or external handoff for a non-trivial change. Review may be lighter or skipped for low-risk changes.

1. Create a compact handoff with goal, scope, files changed, key decisions, checks run, and known limitations.
2. Run a fresh-context review using the shared contract in `prompts/code-review.md`.
3. Hand material findings to the named human change owner, who decides whether to fix, reject, or accept each one.
4. If a fix materially changes behavior, re-run verification and review the full updated diff with fresh context.

Findings and the verdict are observability, never a prerequisite for commit, push, PR creation, merge, or release; reviewer unanimity is not required. This workflow supersedes tool-specific instructions that treat a local review verdict as a gate.

Tool mappings:

- Cursor reviewer: `.cursor/agents/reviewer.md`
- OpenCode reviewer: `opencode.json`
- Codex reviewer flow: use `prompts/code-review.md` as the shared review contract

## Commit and PR conventions

- Use Conventional Commits when creating commits.
- Keep commits focused and reviewable.
- Prefer separate commits for large legacy removal when that clarifies review.
- PR or handoff summaries should include goal, scope, decisions, tests, and remaining risks.

## Cutting a release

Always use `./scripts/release/cut-release.sh <patch|minor|major|x.y.z>` from a clean `main` checked out at `origin/main`. The script bumps `package.json` + `package-lock.json`, commits, tags, pushes, and creates the GitHub Release in one atomic flow. The GitHub Release event is what triggers `release.yml` and the npm publish — pushing a tag without creating a Release will silently skip the publish.

## Authoritative tool-specific files

- Cursor rules: `.cursor/rules/`
- Cursor sub-agents: `.cursor/agents/`
- Shared review prompt: `prompts/code-review.md`. Never edit it by hand; it is generated from Canon's `reference/review-contract.md` local review surface, so update Canon and propagate the generated file instead.
- OpenCode config: `opencode.json`

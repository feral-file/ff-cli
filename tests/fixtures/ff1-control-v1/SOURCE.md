# ff1-control-v1 fixtures (vendored)

These files are a verbatim copy of
`components/feral-controld/control/testdata/fixtures/` from
`feral-file/ffos-user` branch `feat/3551-display-grants` at commit
`25d776c` (ffos-user#414). 85 JSON files: keys.json, 20 positive and 64 negative.

The normative spec is `docs/ff1-control-v1.md` in the same commit; §12 defines
the fixture format and §5.7 the display-grant vectors (`setup.displayGrants`,
`keys.controllers.display`). The Go generator is
`components/feral-controld/control/internal/fixturegen`.

Do not edit these files by hand. To update them, regenerate them in ffos-user
(`go run ./control/cmd/genfixtures` from `components/feral-controld`), copy the
directory here, and update the commit above. `tests/control-conformance.test.ts`
runs every vector.

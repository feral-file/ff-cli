# ff1-control-v1 fixtures (vendored)

These files are a verbatim copy of
`components/feral-controld/control/testdata/fixtures/` from
`feral-file/ffos-user`, branch `feat/3551-control-protocol`, commit
`4ba8b185726091a3eefeb216d209bc3f8433601a`
("fix(control): reordered-ctr vector really tests acceptance; strict
notification ep"). 43 JSON files.

The normative spec is `docs/ff1-control-v1.md` in the same commit; §12 defines
the fixture format. The Go generator is
`components/feral-controld/control/internal/fixturegen`.

Do not edit these files by hand. To update them, regenerate them in ffos-user
(`go run ./control/cmd/genfixtures` from `components/feral-controld`), copy the
directory here, and update the commit above. `tests/control-conformance.test.ts`
runs every vector.

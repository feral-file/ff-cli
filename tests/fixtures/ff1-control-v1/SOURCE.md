# ff1-control-v1 fixtures (vendored)

These files are a verbatim copy of
`components/feral-controld/control/testdata/fixtures/` from
`feral-file/ffos-user`, branch `feat/3551-control-protocol`, commit
`5f65e23dd3d242cd241cf125f29920a93671549c`
("feat(control): bind the approval code to the device pin; add notification ep").

The normative spec is `docs/ff1-control-v1.md` in the same commit; §12 defines
the fixture format. The Go generator is
`components/feral-controld/control/internal/fixturegen`.

Do not edit these files by hand. To update them, regenerate them in ffos-user
(`go run ./control/cmd/genfixtures` from `components/feral-controld`), copy the
directory here, and update the commit above. `tests/control-conformance.test.ts`
runs every vector.

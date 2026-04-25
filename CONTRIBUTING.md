# Contributing

PRs welcome.

## Tests

Both suites must pass on `main` before you start. If they don't, file an issue first.

```bash
npm run test:unit          # 207 tests, no real claude, ~3s
npm run test:integration   # 8 tests, spawns real claude (costs tokens)
```

## PR shape

- Small and focused. One concern per PR.
- Branch from `main`.
- Include a regression test for bug fixes. For new policy patterns: a positive match plus at least one false-positive negative.
- Conventional-ish commit prefixes match recent history: `feat:`, `fix:`, `docs:`, `chore:`, `merge:`.
- Update `CHANGELOG.md` if the change is user-visible.

## Reporting bugs

Open a [GitHub issue](https://github.com/renatodarrigo/claw-drive/issues). Include a reproducer if you can.

## Tone

Be precise, be patient, be kind.

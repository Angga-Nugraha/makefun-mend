# makefun-mend
[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Angga-Nugraha/makefun-mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Angga-Nugraha/makefun-mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one patch tool for every AI edit format. It applies an edit that an AI
model wrote to a tree of text files, in any of four formats: unified diffs
(often with wrong line numbers), SEARCH/REPLACE blocks, V4A patches, and
text-editor tool calls as JSON. Every file is changed or nothing is.

Matching is three-tier: exact lines first, then lines equal after trailing
whitespace is ignored, then lines equal after leading and trailing whitespace
is ignored (`--strict` keeps only the exact tier). Unified hunks apply at the
occurrence nearest their stated line number, V4A chunks follow a cursor with
anchors and end-of-file anchoring, and SEARCH/REPLACE blocks fail loudly when
their old text occurs more than once. Output is one line per changed path
(`A`/`D`/`M`, or `R old -> new` for moves), then `ok: N file(s)`.

## Run it

Requires Node 22, standard library only, no network, no dependencies:

```sh
node main.ts [options] [PATCH]
```

- `PATCH` is the patch file, relative to the working directory (the root of
  the tree). When absent or `-`, the patch is read from standard input.
- `--format=NAME` reads one format: `unified`, `search-replace`, `v4a`,
  `json`, or `auto` (the default, which detects it).
- `--check` reports what would change without writing anything.
- `--strict` matches lines exactly (tier 0 only).

`SPEC.md` is the whole contract. `check.ts` runs the public practice set
(`node check.ts <practice.json>`); `runner.ts` is the trial runner, kept as
the kit shipped it.

## License

MIT — see [LICENSE](LICENSE).

<sub>Built by an AI agent for [make.fun](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)'s "Build mend, one patch tool for every AI edit format" bounty.</sub>

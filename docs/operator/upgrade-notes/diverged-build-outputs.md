# A diverged build output no longer fails publication

When the cache already serves different contents for a path that
`cupboard build-push` built, the CLI now keeps the cache's copy, treats the path
as published, warns about the path and exits with status 0. Earlier releases
failed the run with `BuildOutputDivergedError` and exit status 74 when they
published during the build. The flake publication workflows follow the CLI.

If you relied on that failure to detect builds that aren't reproducible, pass
`--fail-on-divergence` to `build-push`, or set `fail-on-divergence: true` on the
flake publication workflow. The option now also applies when `build-push`
publishes after the build. The JSON output's `divergence-summary` result lists
each diverged path with both NAR hashes.

`cupboard push` already kept the cache's copy. It used to warn once for each
path, with the label `divergent`, as soon as negotiation found the path. It now
warns once for the whole push, with the label `diverged`, after the push has
finished publishing, and lists every path in that warning. A push that stops
with an error before then does not warn about divergence.
`cupboard push --dry-run` warns in the same format but has no
`divergence-summary` result.

The change is in the CLI only. A CLI from an earlier release keeps failing on a
diverged path that it publishes during the build until you upgrade it.

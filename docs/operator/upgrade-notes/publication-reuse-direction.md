# Publication reuse now follows the trust direction

Upgrade the server to the access-checked reuse release before updating callers
of the flake publication workflow.

The `pull-request-and-branch` preset now uses the tenant's default cache as the
PR reference source. The preset adds no PR reference source on branch runs by
default. Setup no longer creates the `pull-requests-<repository-id>` prefix
view, and the preset ignores `reuse-view`. Existing views remain available to
explicit consumers; remove an unused view only after checking those consumers.
Caller-defined `read-caches`, `nix-config` and remote builder substituters still
apply. Remove PR-view URLs from those settings if branch runs must stop reading
PR outputs.

Run `cupboard github setup` again to grant a PR access to a private default
cache. Read grants are required for publication by reference when the source
cache is private.

To allow trusted contributors' PR outputs on branch runs, select
`cupboard-flake-publish-trusted.yml` in the caller, grant `pull-requests: read`,
and run setup with `--trusted-contributor-reuse`. The wrapper reads only the
unique merged PR cache associated with the branch push commit. Direct pushes,
ambiguous matches and failed lookups build instead. A PR controls its own
`nix-config` and builders, so enable this mode only for trusted contributors.

Use [the flake publication guide][trusted-reuse] for the caller and trust-rule
requirements. `cupboard github check --fix` can repair tenant read grants. The
command reports the required caller edits without changing workflow files.

[trusted-reuse]:
  ../../ci/flake-publish.md#reusing-a-merged-pull-requests-outputs

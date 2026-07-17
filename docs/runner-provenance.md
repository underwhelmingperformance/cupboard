# Runner provenance

Why the flake publish workflow takes its runner configuration from repository
variables, and what the label and group syntax guarantees. The setup steps
themselves are in [docs/github-actions.md](./github-actions.md).

A label is a spelling, not a provenance claim: GitHub routes a job to any runner
carrying the requested labels, and self-hosted runners accept arbitrary manually
assigned labels, hosted-sounding names included. GitHub's boundary for pinning
where a job may land is the runner group. The target manifest is evaluated from
the flake and is therefore pull-request-controlled, so every label it uses must
be named in configuration a pull request cannot reach. The workflow therefore
takes its runner configuration only from repository variables, and two of them
must be set before the workflow runs:

- `CUPBOARD_RUNNERS` names every `runs-on` label the target manifest may use,
  separated by whitespace or commas. A bare entry (`ubuntu-latest`) permits the
  spelling and routes by label alone; an entry written as `label@group`
  (`nix-builder@build-farm`) routes that label to the named runner group as
  `runs-on: { group, labels }`. Labels and group names must each be one or more
  printable ASCII characters excluding spaces, commas and `@`, a narrower
  contract than GitHub's: labels because case-insensitive matching is only exact
  within ASCII, `@` because it separates the two, and the rest as this syntax's
  own grammar. Rename a group that cannot be expressed. Example:

  ```text
  ubuntu-latest, macos-14, nix-builder@build-farm
  ```

- `CUPBOARD_PLAN_RUNNER` is the plan job's own `runs-on` value, as JSON, and it
  is required: the plan job holds the input SSH key, read credentials and OIDC
  permission while evaluating pull-request-controlled Nix, so it has no fallback
  runner. Either a plain label or a group selector:

  ```text
  "ubuntu-latest"
  {"group":"trusted","labels":["ubuntu-latest"]}
  ```

Nothing is allowed by default, not even GitHub-hosted labels: a self-hosted
runner can carry any label, so the permitted set is entirely the operator's.
Labels are printable ASCII without spaces; GitHub compares them
case-insensitively, and that comparison is only exact within ASCII, so anything
wider is refused.

Bare labels remain vulnerable to collisions: a self-hosted runner registered
with a permitted spelling is eligible for those jobs. Either qualify every entry
with a runner group, or enforce the boundary in the organisation's runner policy
by restricting self-hosted runner groups away from the repositories that call
this workflow and disallowing repository-level runner registration.

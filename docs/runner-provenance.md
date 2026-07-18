# Runner provenance

Where cupboard's publish jobs run is operator configuration, exactly as it is
for any other workflow: the plan job's label comes from the reusable workflow's
`plan-runner` input, and each target's label from the `os` field of the flake's
target manifest. Both files belong to the operator, and cupboard does not police
them. This document explains what that choice rests on and what repositories
with self-hosted runners should do about it.

The cache itself does not depend on where jobs run. Publishing is gated by OIDC
trust rules: the exchange verifies the token's signed claims (repository,
branch, workflow file and ref), so a pull request's run cannot publish to a
protected cache from any machine, trusted or otherwise. Attestations record what
ran and where, so provenance is verifiable after the fact rather than enforced
up front.

The machine is a different asset, and GitHub's own controls govern it. A label
is a spelling, not a provenance claim: GitHub routes a job to any runner
carrying the requested labels, and self-hosted runners accept arbitrary manually
assigned labels, hosted-sounding names included. On a `pull_request` event the
workflow files themselves come from the pull request's merge ref, so no value
written in a workflow file, this repository's or cupboard's, can be treated as
operator-only. Repositories that only use GitHub-hosted runners need nothing
further: misrouting a job among ephemeral hosted runners is harmless.

Repositories with self-hosted runners should enforce the boundary where GitHub
provides it:

- Put self-hosted runners in runner groups, and restrict each group to the
  repositories and workflows that need it. A group is GitHub's mechanism for
  pinning where a job may land; a label never is.
- Require approval for workflow runs from outside contributors, and do not
  attach privileged runners to public repositories.
- Keep runner-level credentials off the machines, or scope them to what the jobs
  genuinely need: a runner executes whatever code the workflows that can reach
  it carry.

# Runner provenance

Operators choose where publication jobs run. The plan job's label comes from the
reusable workflow's `plan-runner` input, and each target's label comes from the
`os` field in the flake target manifest. Cupboard does not validate these
labels. This document explains the security assumptions behind that choice and
the controls required for self-hosted runners.

The cache does not depend on where jobs run. OIDC trust rules restrict which
repository, branch, workflow file and ref may publish, regardless of the runner.
Attestations record the workflow and runner after execution. They provide
evidence for later verification but do not enforce runner selection.

GitHub's runner controls protect the machine itself. Runner labels are
operator-assigned routing metadata, not verified machine identity. GitHub routes
a job to any runner with the requested labels, and self-hosted runners accept
arbitrary labels. On a `pull_request` event, workflow files come from the pull
request's merge ref. Therefore, no runner label in the caller or reusable
workflow proves operator control. Repositories that use only GitHub-hosted
runners need no additional controls because those runners are ephemeral.

Repositories with self-hosted runners should enforce the boundary where GitHub
provides it:

- Put self-hosted runners in runner groups, and restrict each group to the
  repositories and workflows that need it. A runner group is GitHub's mechanism
  for restricting where a job may run; a label does not restrict anything.
- Require approval for workflow runs from outside contributors, and do not
  attach privileged runners to public repositories.
- Keep runner-level credentials off the machines, or scope them to what the jobs
  genuinely need: a runner executes whatever code is in the workflows that can
  reach it.

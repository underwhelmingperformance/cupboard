# Checking a repository's publishing jobs

`cupboard github check` reads a repository's workflow files from GitHub, finds
every job that publishes to your tenant, and checks each one against the
tenant's trust rules and reuse view. It tells you before the first run whether
the tenant will accept the job. With `--fix`, it can also add the trust rules
and the reuse view that are missing.

[The quickstart](./quickstart.md#5-check-the-setup) runs it once after
`cupboard github setup`. This page explains what the check looks at, which jobs
it can't verify, what the repair changes, and how to check a single workflow
reference.

## Running the check

```sh
cupboard github check https://cupboard.example.workers.dev/t/acme --repo acme/app
```

The check reads the workflow files on the repository's default branch, at the
branch's current head. To check another branch, pass `--branch`. For a private
repository, set `GH_TOKEN` or `GITHUB_TOKEN`.

For each job that calls one of cupboard's reusable workflows with your tenant's
URL, the check:

1. confirms on GitHub that the workflow exists at the pinned ref, and that a
   pinned tag belongs to an immutable release;
2. works out which runs GitHub would start for the job, and what claims each
   run's OIDC token would have;
3. works out what each run asks the tenant for: which cache, which roots, and
   whether it attaches attestations;
4. checks that exactly one trust rule accepts each run and allows everything
   that the run asks for, and that the reuse view exists with a suitable
   priority.

The check follows calls to reusable workflows in the same repository. A job in
one of those is listed under the calling job, followed by the called workflow's
file name and job ID, for example `publish (publish-flake.yml: packages)`.

The check models what the cupboard workflows of the current release ask for. A
job that pins a different release can ask for something else.

When two jobs have no matching rule, the result looks like this:

```text
Workflow revision: acme/app@<commit>
.github/workflows/publish.yml, packages: failed: push: no rule pins this repository
.github/workflows/publish.yml, systems: failed: push: no rule pins this repository
Review a repair: cupboard github check https://cupboard.example.workers.dev/t/acme --repo acme/app --branch main --fix
```

With `--output-mode json`, the `github-check-discovered` result lists each job's
findings. Each finding has the event that it applies to, the name of the check,
its status and any detail.

### Exit status

| Status | Meaning                                                                                                                                                                     |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0      | Every publishing job passed.                                                                                                                                                |
| 1      | At least one check failed. With `--fix`, also when a step of the repair fails after it has written a change, or when a repaired job still fails or still can't be verified. |
| 69     | No check failed, but at least one job couldn't be verified.                                                                                                                 |

## What fails a job

- No trust rule accepts one of the job's runs, or the rule that accepts it
  doesn't allow everything that the run asks for.
- The job pins a cupboard workflow to a branch, written as either `@main` or
  `@refs/heads/main`. A branch can move, so the check fails it.
- The job pins a tag whose release GitHub doesn't report as immutable, or a tag
  or workflow file that GitHub can't find.
- The flake preset's reuse view is missing, or its priority number isn't greater
  than the destination cache's.

## Jobs that the check can't verify

The check reports some jobs as unverified, for you to review by hand:

- A job that calls a cupboard action directly, or that runs `cupboard push`,
  `build-push`, `attest attach`, `plan cohort`, `cache create`, `cache remove`,
  `root ensure` or `confirm` in a `run:` step, or that passes `--github-oidc` to
  any command. The check reports such a step when its tenant URL is your
  tenant's, when the URL is an expression, and when there is no URL. It also
  reads the steps of local composite actions, such as
  `uses: ./.github/actions/publish`.
- A job that calls a reusable workflow from another repository, when one of its
  `with:` values contains the tenant URL, when a URL input is an expression, or
  when an expression reads `secrets` or `vars`. An unrelated expression, such as
  a matrix value for a Node version, doesn't make a job unverified. If the other
  workflow builds the tenant URL itself, the check can't see that from the
  caller's inputs.
- A job whose tenant URL is an expression, because the check can't tell which
  tenant the job targets.
- A job with a cupboard workflow input that the check can't evaluate. For
  example, when `push` is an expression, the check can't tell whether the job
  publishes at all.
- A job with the flake preset and a tag filter, because a preset run fails on a
  tag push.
- A job without the flake preset that runs for `pull_request`. Its pull-request
  runs publish to the same cache and root as its branch runs, so a
  `pull_request` trust rule would let any pull request from the repository write
  there. The check reports these runs whether or not such a rule exists. Use the
  flake preset, which gives each pull request its own cache, or publish pull
  requests to a separate cache.

When a job is unverified, the check also lists the active GitHub trust rules
that match the repository and the job's workflow references, with each rule's
claims and grants. It doesn't choose one of them, so the list doesn't mean that
a run is authorised. In JSON mode, these rules are a separate
`github-check-trust-rules` result.

The check skips a job that passes `push: false` to the flake publish workflow.
With the preset, such a job still removes a pull request's cache when the pull
request is closed without being merged, and the check doesn't model that
removal. The check also ignores a `run:` step that calls
`cupboard github setup`. That command changes the tenant with your own
credential and doesn't publish anything.

## Which runs the check models

GitHub starts a run for each event in a workflow's `on:` section. The check
models the runs that GitHub would start, and adds a note for the runs that it
can't cover. A note doesn't change the job's status.

The check reads each job's `if:` condition. It evaluates comparisons of
`github.event_name` with a string, combined with `&&`, `||` and `!`, and skips
the events that the condition excludes. For example, a job guarded by
`github.event_name == 'push'` isn't checked for `pull_request`. The status
functions `success()` and `always()` count as true. When the condition also
depends on something else, such as `github.ref == 'refs/heads/main'`, the check
models the run and reports the job as unverified for that event.

The check models a pull request from the repository itself. A guard such as
`github.event.pull_request.head.repo.id == github.repository_id`, which the
quickstart uses, is therefore true. When a condition excludes pull requests from
forks, the job gets a note that the check doesn't model them.

For the other events:

- GitHub runs scheduled workflows only from the default branch, so the check
  models `schedule` on the default branch. With `--branch` set to another
  branch, it models the schedule as if that branch were merged into the default
  branch, and notes that the schedule takes effect after the merge.
- The flake preset publishes only on runs for the branch in its `branch` input.
  When that's the default branch, the check models `push` and
  `workflow_dispatch` on the default branch. With `--branch` set to another
  branch, the check reads that branch's workflow files and models them as if
  they were merged into the default branch.
- Without the preset, the check models `workflow_dispatch` on the checked
  branch. GitHub can start a manual run on any branch, so the check notes that
  other branches aren't covered.
- A `push` event without branch or tag filters starts a run for every branch and
  tag, but the check models only the checked branch, and notes that. For a flake
  preset job, the note suggests adding the preset's `branch` as a `branches`
  filter, because a preset run fails on a push to any other branch.
- A `push` event with a `tags` filter is modelled as one tag push for each
  pattern, with a tag name that the pattern matches. If the event also has a
  branch filter, the check models branch pushes too.

The check evaluates `branches`, `branches-ignore`, `tags` and `tags-ignore`
filters that are written as literal names with `*` and `**`. It reports other
patterns, and every `tags-ignore` filter, for manual review. If a branch filter
excludes the branch that the check models, the job is unverified. For `push`,
that branch is the checked branch, or the preset's `branch` when it's the
default branch. For `pull_request`, it's the default branch, which pull requests
normally target. Check a branch that the filter includes with `--branch`, or
change the preset's `branch` input. The check doesn't evaluate `paths` or
`paths-ignore` filters. It notes them on the job and checks the run as if it
started. GitHub's [filter syntax][github-filters] describes the patterns.

[github-filters]:
  https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onpushpull_requestpull_request_targetpathspaths-ignore

`cupboard-publish.yml` adds the runner's Nix system to the end of its `root`
input. The check models the root for the workflow's default `x86_64-linux`
runner, and requires a grant for the whole root prefix, so that builds on other
runners are covered too.

A job can use a reuse view of its own instead of the preset's
`pull-requests-<repository-id>` view. The check confirms that the view exists,
and checks its priority and store directory, but it doesn't check which caches
the view's selectors include. It says so in a note on the job.

## Repairing the tenant

The repair fixes three kinds of failure: a missing trust rule, a matching rule
that lacks a grant, and a missing `pull-requests-<repository-id>` view for the
flake preset. When every failure of a job is one of these, a check at a terminal
offers the repair after it reports. `--fix` starts it directly:

```sh
cupboard github check https://cupboard.example.workers.dev/t/acme --repo acme/app --fix
```

The repair shows the rules and views that it plans to write, and asks you to
confirm. It writes rules and views only for the jobs where it can fix every
failure. Any other failed or unverified job still makes the command exit with an
error. After writing, it runs the check again and reports the result as a
`github-check-verified` result. If a repaired job still fails, or still can't be
verified, the command exits with an error that lists the changes that it made.

A planned rule accepts either the cupboard workflow pins that the jobs use now,
or every cupboard release tag that matches a pattern. The repair asks you which,
or you can choose with `--trust-scope`. A run without a terminal has to choose
in the command and confirm with `--yes`:

```sh
cupboard github check https://cupboard.example.workers.dev/t/acme --repo acme/app \
  --fix --trust-scope exact --yes
```

To accept future releases instead, pass
`--trust-scope tag-pattern --tag-pattern 'v*'`.
[Trusting a reusable workflow](./trust-rules.md#trusting-a-reusable-workflow)
explains the trade-off.

If the tenant's reads are private, pass `--read-user` and `--read-password`. The
repair then creates the pull-request view as a private view. Otherwise it
creates a public one. A view only includes caches with the same access as
itself, so the repair stops with an error if one of the repository's
pull-request caches already exists with the other access.

There are some things that the repair won't do:

- It doesn't create or change a job's own reuse view, and it doesn't replace a
  preset view whose selectors, access or priority differ from what it expects.
- It doesn't write rules from an unmerged branch unless you confirm them at a
  terminal. Anyone who can push to the repository can change the workflow files
  on such a branch. When `--branch` isn't the default branch, the preview says
  so, and the repair stops with an error under `--yes` or without a terminal.
- It doesn't write a rule that would break another job. cupboard selects the
  matching rule with the most claims, so a new rule can take over the runs that
  another job relies on. Before writing, the repair checks its planned rules
  against every other job that the check found. A job that the check models
  exactly must keep passing. For a job that the check can't model exactly, such
  as one with a tenant URL in an expression, the repair stops if a planned rule
  could match the job's runs with at least as many claims as an existing rule.
  When a planned rule is for the default branch and you passed another
  `--branch`, the repair reads the default branch's workflow files as well. It
  doesn't read workflow files at tags or on other branches, and the preview
  lists the branches that it checked.
- It never adds a rule with the same claims as an existing rule. When a rule
  matches a job but lacks a grant, the repair adds a rule with more claims,
  which cupboard then prefers. The old rule stays active, so remove it yourself
  once nothing needs it. When the existing rule already has at least as many
  claims as the planned one, cupboard wouldn't prefer the new rule, so the
  repair stops before it asks you anything. Remove the existing rule, or replace
  it with one that also grants the missing operation.

When the repair stops for one of these reasons, it changes nothing, and the
error lists the job and the existing rules.

Just before writing, the repair reads the branch, the trust rules and the views
again. If any of them changed since the check, it stops without writing, and you
can run the check again.

## Checking one workflow reference

To check a workflow reference before you add it to the caller, for example a new
cupboard release, pass `--workflow-ref`:

```sh
cupboard github check https://cupboard.example.workers.dev/t/acme \
  --repo acme/app \
  --root-prefix github:acme/app/main \
  --workflow-ref underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@refs/tags/vX.Y.Z
```

In this mode, the check doesn't read your repository's workflows. It confirms
that the workflow file exists at that reference, and that a tag belongs to an
immutable release. It then works out the claims of a pull-request run and a
`main` run that call it, and checks them against your rules. `--branch` chooses
a branch other than `main`. The reference must match the caller's `uses:` line
exactly, so check it for typos.

The check also confirms that the reuse view's priority is greater than the
destination's, and that the root prefix is within the rule's grant. Your own
administrator rule doesn't count, even though its full access would allow the
operations. If an input that a check needs is missing, such as `--root-prefix`,
the command reports that check as not made and exits with an error.

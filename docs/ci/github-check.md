# Checking publishing jobs

This page is for tenant administrators who want to know, before a run fails,
whether their trust rules and reuse view accept a repository's publishing jobs.

`cupboard github check` reads a repository's workflows from GitHub and checks
each job that publishes to or reads from the tenant. With `--fix`, it also
repairs some tenant configuration.
[Step 5 of the quickstart](./quickstart.md#5-check-the-setup) shows the usual
commands, and [Trust rules](./trust-rules.md) explains the rules that the check
tests.

## Exit status

The command exits 1 if any check of a publishing job failed, and 69 if no check
failed but at least one could not be verified. With `--fix`, once the repair has
written a change, the command exits 1 if a later step of the repair fails, even
for a transient failure such as an exhausted GitHub API rate limit. It also
exits 1 if a repaired publishing job still fails or cannot be verified.
Publishing jobs that the repair did not change still give 1 or 69 as above. The
[CLI scripting reference][cli-scripting] lists the exit statuses that all
commands share.

[cli-scripting]: ../reference/cli-scripting.md#exit-status

## Finding the publishing jobs

The check reads the workflow files on the repository's default branch. Use
`--branch` to check another branch. It follows calls to reusable workflows in
the same repository and checks every job whose cupboard publishing workflow
targets this tenant. For each job, it confirms on GitHub that the pinned
workflow file exists and, for a tag pin, that the release is immutable. It then
works out the OIDC claims and requested operations of each run and checks them
against the tenant's trust rules and reuse view.

The check works out the requests that the cupboard workflows of the current
release make. A job that pins another release can request other operations.

A job in a reusable workflow appears under the calling job, followed by each
called workflow's file name and job ID, such as
`publish (publish-flake.yml: packages)`. In JSON mode, each job in the
`github-check-discovered` result lists its findings. Each finding has the event
that it applies to, the name of the check, its status and any detail.

The check fails a job that pins a cupboard workflow to a branch, because a
branch can move. This applies whether the caller writes `refs/heads/main` or
`main`. The check also fails a pin to a tag whose release GitHub does not report
as immutable. It fails a pin when GitHub cannot find its release or workflow
file.

The check sends the lookup of the checked branch with `Cache-Control: no-cache`,
so it reads the branch's current head even while the local HTTP cache has a
fresh response.

## Jobs for manual review

The check reports these jobs as unverified, for manual review:

- A job with a step that calls a cupboard action that can change the tenant,
  with a `run:` step that calls `cupboard push`, `build-push`, `attest attach`,
  `plan cohort`, `cache create`, `cache remove`, `root ensure` or `confirm`, or
  with a `run:` step that passes `--github-oidc` to any command. The check
  reports the step when its tenant URL is this tenant's URL, uses an expression,
  or is missing. The check also reads the steps of each local composite action
  that the job uses, such as `uses: ./.github/actions/publish`.
- A job that calls an external reusable workflow when one of its `with:` values
  contains the tenant URL, when a URL input uses an expression, or when an
  expression reads `secrets` or `vars`. The check does not report a job as
  unverified because of an unrelated expression, such as a matrix value for a
  Node version. If the external workflow constructs the tenant URL internally,
  the check cannot detect that publication from the caller's inputs.
- A job with a dynamic tenant URL, because the check cannot determine which
  tenant the job targets.
- A job with cupboard workflow inputs that the check cannot evaluate. For
  example, when the `push` input is dynamic, the check cannot determine whether
  the job publishes at all.
- A job without the flake preset that runs for `pull_request`. The job's
  pull-request runs publish to the same cache and root as its branch runs, so a
  `pull_request` trust rule would let any pull request from the repository write
  to that cache and root. The check reports these runs for manual review whether
  or not such a rule exists. Use the flake preset, which publishes each pull
  request's outputs to a separate cache, or publish pull requests to a separate
  cache.

For `push: false`, the check models the selected cache read without publication
or cache-removal grants. A pull-request run with the flake preset reads from the
tenant's default cache. A public read needs no trust grant. A private read needs
the exact cache content-read grant unless the workflow supplies a static read
pair.

The check can see that a workflow declares an explicit static username and
password pair, but GitHub does not reveal the secret values. It reports the pair
as configured, without claiming that the values authenticate at runtime. An
incomplete pair fails. Inherited or dynamic secret wiring remains unverified and
can make the check exit 69. `--fix` can still repair independent publication
grants, but it cannot inspect or repair the hidden secret values. The
`--read-user` and `--read-password` options authenticate the administrator's
metadata queries; they do not choose a view's access or verify workflow secrets.

The check ignores `actions/setup` when it only installs cupboard or configures
Nix substituters. If the step sets `provision-cache`, setup can create a cache
with an OIDC token, so the check reports the job for manual review. The check
also ignores a `run:` step that calls `cupboard github setup`. That command
changes tenant settings with the owner's credential and does not publish with an
OIDC token.

When a job is unverified, the check also shows the active GitHub trust rules
that match this repository and the workflow references of the unverified jobs.
Terminal mode displays each rule's stored claims and grants as nested fields.
The check does not select one of these rules, so the list does not mean that a
run is authorised. In JSON mode, the stored rules appear in a separate
`github-check-trust-rules` result.

## Which runs the check simulates

For each job, the check works out which runs GitHub would start, and simulates
the token and the requests of each of those runs. The paragraphs below say how
it decides.

The check builds the token's `sub` claim in GitHub's default forms,
`repo:<owner>/<repo>:pull_request` and `repo:<owner>/<repo>:ref:<ref>`. It
doesn't support a job that uses an environment, or a repository or organisation
that customises the subject claim, because the `sub` of those tokens has a
different form.

The check reads each job's `if` condition. It evaluates comparisons of
`github.event_name` with a string, combined with `&&`, `||` and `!`, and it does
not simulate a job's runs for an event that its condition excludes. For example,
a job guarded by `github.event_name == 'push'` is not checked for
`pull_request`. The status functions `success()` and `always()` count as true.
When the condition also depends on another term, such as
`github.ref == 'refs/heads/main'`, the check simulates the run and reports the
job as unverified for that event.

The check simulates a pull request from the repository itself. A guard that
compares the head repository with the repository, such as
`github.event.pull_request.head.repo.id == github.repository_id` in the
quickstart, is therefore true for that pull request. When the condition excludes
pull requests from forks, the job gets a note that the check does not simulate
them.

GitHub runs scheduled workflows only from the [default branch][github-schedule].
The check simulates a `schedule` run with the default branch's ref. When
`--branch` is another branch, the check simulates the schedule as if the branch
were merged into the default branch, and notes that the schedule takes effect
only after that merge.

The flake preset publishes only on runs for the branch that its `branch` input
specifies. When that input is the repository's default branch, the check
simulates `push` and `workflow_dispatch` runs on the default branch. When
`--branch` is another branch, the check reads the workflow files from `--branch`
and treats them as if they were merged into the default branch. It notes that
the change takes effect only after the merge.

Without the preset, the check simulates a `workflow_dispatch` run on the branch
that it checks. GitHub can start a manual run on any branch, so the check notes
that manual runs on other branches can have different OIDC claims. It reports
the job as unverified; review the trust rules for those branches.

A `push` event without branch or tag filters starts runs for pushes to every
branch and tag, but the check simulates only the checked branch. It reports the
job as unverified because other pushes can use different trust-rule claims. Add
branch or tag filters for the refs that should publish. A flake preset run fails
on a push to any branch other than its `branch` input, so the check reports an
unfiltered preset job as unverified and suggests adding that branch as a
`branches` filter.

The installable workflow appends the builder's Nix system to its `root` input.
The check works out the root for the workflow's default `x86_64-linux` runner,
and it requires a grant for the whole root prefix so that builds on other
runners are covered too.

The check reads each event's `branches`, `branches-ignore`, `tags` and
`tags-ignore` filters. For a `push` event with an exact `tags` filter, the check
simulates a push of that tag. A wildcard pattern such as `v*` admits several
tags whose OIDC claims can differ, so the check reports the job as unverified
without testing a fabricated tag. Use an exact tag filter when the check must
verify a tag push. The workflow also runs for branch pushes when the event has a
branch filter.

A branch filter can exclude the branch that the check simulates. For `push`,
that is the checked branch, or the default branch for a flake preset job whose
`branch` input is the default branch. For `pull_request`, it is the default
branch, which pull requests normally target. If the filter excludes that branch,
the check reports the job as unverified. For `push`, use `--branch` to check a
branch that the filter includes, or change the preset's `branch` input.

For `push`, a `branches` filter can select several branches, and a
`branches-ignore` filter can allow branches beyond the one that the check
simulates. The check reports the job as unverified unless `branches` lists only
the exact branch that it simulates. To verify a workflow with several eligible
branches, review the trust rules for each branch or give each branch its own
workflow with an exact filter.

The check evaluates literal names with `*` and `**` wildcards. It reports other
patterns and `tags-ignore` filters for manual review. It also reports a flake
preset job with a tag filter, because a preset run fails on a tag push. The
check does not evaluate `paths` or `paths-ignore` filters. It notes them on the
job and checks the run as if the filter allows it to start. For the pattern
rules, see GitHub's [filter syntax][github-filters].

[github-filters]:
  https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onpushpull_requestpull_request_targetpathspaths-ignore
[github-schedule]:
  https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule

A job can use a custom reuse view in place of the preset's
`pull-requests-<repository-id>` view. The check verifies that the view exists
and checks its priority and store directory, but it does not verify which caches
the view's selectors include. It adds a note on the job that says so.

## Repairing the tenant

The repair fixes three kinds of failure: a missing trust rule, a matching rule
without a required grant, and a missing `pull-requests-<repository-id>` view for
the flake preset. When every failure of a job is one of these, an interactive
check offers the repair after reporting failures. `--fix` starts it directly.

The preview lists the claims, grants and view changes before you confirm them.
The repair adds rules and views only for jobs in which it can fix every failure.
Any other failed or unverified job still makes the command exit unsuccessfully.
After writing, the repair runs the check again and reports it under a separate
`github-check-verified` result kind. If a repaired job is still failed or
unverified, the command exits with an error that lists the changes already
applied.

The repair does not create a trust rule from one modelled ref when the workflow
can publish on other refs that the check cannot verify. An unfiltered push or a
wildcard tag filter needs narrower workflow filters or a manual review of the
trust rules before the check can report readiness.

The repair prompts you to choose whether planned trust rules accept only the
current cupboard workflow pins or future cupboard workflow release tags that
match a pattern. For a non-interactive run, make that choice in the command and
confirm the changes explicitly:

```sh
cupboard github check https://cupboard.example.workers.dev/t/acme \
  --repo acme/app --fix --trust-scope exact --yes
```

To accept future cupboard `v*` releases in planned rules, use
`--trust-scope tag-pattern --tag-pattern 'v*'`.

When `--branch` is not the default branch, the planned rules come from workflow
files that have not been merged, and anyone who can push to the repository can
change those files. The preview states that the planned rules come from an
unmerged branch, and the repair stops with an error under `--yes` or without a
terminal. Review such a repair at a terminal, or run it after the change is
merged into the default branch.

The repair can create the preset's `pull-requests-<repository-id>` reuse view.
It creates a private view when you pass `--read-user`, and a public view
otherwise. A view includes only caches with the same access, so a public view
cannot reuse the outputs of private pull-request caches. The repair stops with
an error when an existing pull-request cache of the repository has the other
access. Pass `--read-user` and `--read-password` when the tenant's reads are
private.

When a job uses a custom reuse view that passes the reuse-view check, the repair
leaves that view unchanged. The repair does not create or change a custom view,
and it does not replace a preset view whose selectors, access or priority differ
from the expected configuration.

Among matching rules that don't give full access, the server selects the rule
with the most claims, as
[When several rules match](./trust-rules.md#when-several-rules-match) explains.
A planned rule with more claims can therefore replace the rule that another job
currently uses. Before writing, the repair checks the planned rules against
every discovered job outside the repair:

- A job whose runs the check can simulate exactly must keep passing. The repair
  stops when a planned rule would be selected for the job's runs without
  granting what the job requests.
- For any other job, such as a job with a dynamic tenant URL or a condition that
  the check cannot evaluate, the repair stops when a planned rule could match
  the job's runs with at least as many claims as an existing rule that could
  also match them.

When a planned rule is for the default branch and `--branch` is another branch,
the repair also reads the default branch's workflow files and checks those jobs.
The repair does not read workflow files at tags or on other branches, so it
cannot check the runs of those files. The preview lists the branches that it
checked.

If a rule matches the workflow claims but lacks a grant, the repair adds a
planned rule with more claims that grants the missing operations. The existing
rule stays active, but the server selects the planned rule for the runs that
both rules match. Remove the existing rule separately if the planned rule makes
it unnecessary. When the existing rule has at least as many claims as the
planned rule, the server would not prefer the planned rule, so the repair stops
before it asks for a trust scope. Remove the existing rule, or replace it with a
rule that also grants the missing operation.

When the repair stops for one of these reasons, it does not change the tenant.
The error lists the job and the existing rules. Change the configuration by
hand.

Before writing, the repair reads the branch revision, trust rules and views
again, and sends the branch lookup with `Cache-Control: no-cache`. If the
revision, the rules or the views changed, the repair stops without writing, and
you can run the check again.

## Checking one workflow reference

For a workflow reference that has not yet been added to the caller, check that
reference explicitly. For example, before you move the quickstart's workflow to
release `vA.B.C`:

```sh
cupboard github check https://cupboard.example.workers.dev/t/acme \
  --repo acme/app \
  --root-prefix github:acme/app/main \
  --workflow-ref underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@refs/tags/vA.B.C
```

In this mode, the check verifies that the workflow file exists and, for a tag
pin, that GitHub reports the release as immutable. It constructs expected claims
from the supplied reference and evaluates the stored trust rules. The supplied
reference must match the caller's eventual `uses` value.

The explicit-reference check fails if only an interactive administrator rule
matches, even when that rule's wildcard grant would allow the operations. It
also verifies the reuse view's effective priority over the destination and
whether the supplied root prefix is within the grant. If an input such as
`--root-prefix` is missing, the command reports the unchecked invariant and
returns a non-success status.

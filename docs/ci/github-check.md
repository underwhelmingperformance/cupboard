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

Cancellation keeps exit status 130 and reports any confirmed changes. An
unconfirmed write request keeps the underlying failure's exit status, such as 75
for a temporary failure or 130 for cancellation. Its error reports that the
attempted write may have completed.

[cli-scripting]: ../reference/cli-scripting.md#exit-status

## Finding the publishing jobs

The check reads the workflow files on the repository's default branch. Use
`--branch` to check another branch. It follows calls to reusable workflows in
the same repository and checks every job whose cupboard publishing workflow
targets this tenant. For each job, it confirms on GitHub that the pinned
workflow file exists and, for a tag pin, that the release is immutable. It then
works out the OIDC claims and requested operations of each run and checks them
against the tenant's trust rules and reuse view.

For both reusable publishing workflows, the check uses the literal `audience`
input when it is supplied, after trimming surrounding whitespace. A blank or
omitted audience uses the tenant URL. An unresolved audience expression needs
manual review. A repair uses the modelled audience for every new trust rule and
checks that audience again after writing.

The check works out the requests that the cupboard workflows of the current
release make. A job that pins another release can request other operations.

A job in a reusable workflow appears under the calling job, followed by each
called workflow's file name and job ID, such as
`publish (publish-flake.yml: packages)`. In JSON mode, each job in the
`github-check-discovered` result lists its findings. Each finding has the event
that it applies to, the name of the check, its status and any detail.

The read-only check can inspect a cupboard workflow at a branch reference,
whether the caller writes `refs/heads/main` or `main`. It verifies that the file
exists and reports that branch trust accepts future workflow edits. A branch
reference does not fix the workflow's contents. Guided mutations require
`--allow-branch-workflow` to select this trust explicitly. The check still fails
a tag whose release GitHub does not report as immutable, or a reference whose
release or workflow file GitHub cannot find.

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
- A job with cupboard workflow inputs that the check cannot evaluate. A dynamic
  `publish` input, for example, prevents a static check from determining whether
  the job publishes paths.
- A pull-request publisher whose inputs do not prove that each PR writes to its
  own cache and root. A rule for the pull-request event alone would allow every
  PR from the repository to write to a shared cache or root. Use the flake
  preset or a PR-number binding in the simple workflow's cache and root.

For the simple workflow, the check recognises `github.repository` and
`github.event.pull_request.number` in cache and root inputs. For example,
`cache: pr-${{ github.event.pull_request.number }}` and
`root: github:${{ github.repository }}/pr-${{ github.event.pull_request.number }}`
select a PR cache family and root prefix. The generated grants derive the PR
number from GitHub's signed `ref`, rather than authorising only the example PR
that the check simulates.

For release events, the simple workflow also recognises
`github.event.release.tag_name` in an explicit root, such as
`root: github:${{ github.repository }}/${{ github.event.release.tag_name }}`.
The cache must be literal. The check and repair bind the root to GitHub's signed
tag `ref`, with `event_name: release` and `ref_type: tag`. Supported tag names
start with a lowercase letter or digit and contain only lowercase letters,
digits, dots, underscores and hyphens, as with the [tag trust
helper][tag-rules]. The check proves coverage from the rule's bindings, not from
one example tag. Tag-specific identity rules or root captures that the check
cannot prove cover this family remain unverified. Other expressions still
require manual review.

[tag-rules]: ./trust-rules.md#tags

For `publish: none` and the flake workflow's older `push: false`, the check
models the selected cache read without publication or cache lifecycle grants. A
pull-request run with the flake preset reads from the tenant's default cache. A
public read needs no trust grant. A private read needs the exact cache
content-read grant unless the workflow supplies a static read pair. When
publication is enabled, the check models cache creation, closure and reopening
alongside publication for the flake preset's pull-request runs, and checks the
corresponding grants. See [Closing and reopening caches][cache-closure].

For lifecycle-managed pull-request caches, the check also verifies that the
caller can run closure and reopening. This applies to the flake preset and to an
installable job with `manage-pr-cache: true`, while publication is enabled.
GitHub's default `pull_request` activities include `reopened` but omit `closed`.
Include `types: [opened, synchronize, reopened, closed]` to enable both
operations. The check reports a missing activity or a job condition that blocks
the activity as a failure. It checks merged closure separately because the
merged run uses the base branch's ref.

The check combines lifecycle coverage from jobs in the same caller when their
cache inputs prove that they manage the same cache. Separate close and publish
jobs can therefore provide coverage together, including jobs with different
workflow pins. Dynamic activity lists, cache inputs, conditions or possible
handlers require manual review. The check does not request lifecycle grants for
activities that the caller provably excludes. `--fix` cannot change caller
events or conditions, so a trust-rule repair cannot resolve a lifecycle failure.

For lifecycle handling, the check follows literal `needs` dependencies and their
job conditions. A skipped dependency blocks a dependent job's implicit or
explicit `success()` condition, even if an intermediate job runs after the
skipped ancestor. The check models a run that has not been cancelled, so
`!cancelled()` can allow a dependent job to run. GitHub recommends that
condition for this use; `always()` also runs after cancellation and is intended
for work that must still run then. See [GitHub's status
functions][github-status]. Dynamic dependencies, unsupported status conditions
and dependency graphs beyond the analysis limit remain unverified. Review the
dependency chain when a close job depends on a publication job that skips
`closed` events.

[github-status]:
  https://docs.github.com/en/actions/reference/workflows-and-actions/expressions#always
[cache-closure]: ../admin/caches.md#closing-and-reopening-a-cache

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
`pull_request`. The status functions `success()` and `always()` count as true
for a job without skipped dependencies. A push with one exact branch filter also
supplies the ref for comparisons such as `github.ref == 'refs/heads/main'`. When
the condition depends on another term that the check cannot evaluate, the check
simulates the run and reports the job as unverified for that event.

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
unfiltered preset job as failed and suggests adding that branch as a `branches`
filter.

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
patterns and `tags-ignore` filters for manual review. A flake preset job with an
explicit tag filter is failed, because a preset run fails on a tag push. The
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

The preview lists new rules, additional grants for existing rules, and view
changes before you confirm them. The repair changes tenant settings only for
jobs in which it can fix every failure. Any other failed or unverified job still
makes the command exit unsuccessfully. After writing, the repair runs the check
again and reports it under a separate `github-check-verified` result kind. If a
repaired job is still failed or unverified, the command exits with an error that
lists the changes already applied.

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
`--trust-scope tag-pattern --tag-pattern 'v*'`. This selects future reusable
workflow release tags for rules created by a discovered repair. With
`github setup`, put the same pattern in the reference:
`--workflow-ref 'underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@refs/tags/v*'`.

To follow a branch workflow deliberately, keep `--trust-scope exact` and add
`--allow-branch-workflow`:

```sh
cupboard github check https://cupboard.example.workers.dev/t/acme \
  --repo acme/app --fix --trust-scope exact --allow-branch-workflow
```

The preview states that the rules accept future edits to each branch workflow.
The flag does not permit a rule for any workflow reference, or convert branch
trust to a release-tag pattern. Without the flag, guided repair refuses branch
trust. Read-only checks do not require the flag.

An explicit `github check --workflow-ref` checks one exact reference and cannot
be combined with `--fix`. `--job-workflow-ref` is an alias for `--workflow-ref`
on both commands; trust-rule commands accept both spellings too.

`github setup --access` is an alias for `--cache-access-mode`. Both options
select the access of new pull-request caches and their reuse view, and do not
change the tenant's default cache. Use `cache set-access --access` to change an
existing cache. The reusable workflows use the `cache-access-mode` input.

When `--branch` is not the default branch, the planned rules come from workflow
files that have not been merged, and anyone who can push to the repository can
change those files. The preview states that the planned rules come from an
unmerged branch, and the repair stops with an error under `--yes` or without a
terminal. Review such a repair at a terminal, or run it after the change is
merged into the default branch.

The repair can create the preset's `pull-requests-<repository-id>` reuse view.
The repair selects the view's access from the discovered jobs. A publishing job
uses its literal `cache-access-mode` input, or the tenant's default cache access
when the input is omitted. A read-only job uses the default cache's access. Jobs
that use the same view must select the same access. `--read-user` and
`--read-password` authenticate metadata queries and do not select the view's
access. A view includes only caches with the same access, so a public view
cannot reuse the outputs of private pull-request caches. The repair stops with
an error when an existing pull-request cache of the repository has the other
access. Supply the tenant read credential with `--read-user` and
`--read-password` when private metadata queries require it.

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

If a matched GitHub rule has the required selectors but lacks grants, the repair
can extend its grants atomically. It preserves the ID, issuer, audience, claims,
display and existing grants. The preview distinguishes retained grants from
additions. A conditional write refuses an existing rule whose state changed
after the preview. The repair does not disable the rule or create an ambiguous
duplicate. Other jobs retain their existing authority.

The repair still refuses selectors that it cannot safely model, protected owner
rules and disabled rules. A narrower new rule can be added where the existing
selection permits it; the preview identifies any retained rule. The repair
checks the final candidate policy against the discovered jobs before writing. An
older server that lacks atomic grant extension requires an upgrade before this
repair can complete. See [Upgrade notes][grant-extension-upgrade].

If a configuration write fails without a confirmed response, the write may have
completed. The command reports the uncertain attempt separately from confirmed
changes. Run `cupboard github check` again before retrying. A new repair uses
the current rules and adds only grants that are still missing.

[grant-extension-upgrade]:
  ../operator/upgrade-notes/release-repairs.md#pr-cache-closure

When the repair refuses a planned rule before writing, it does not change the
tenant. The error identifies the job and any existing rules that prevent the
repair. Change the configuration by hand.

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
pin, that GitHub reports the release as immutable. A branch reference receives
the same future-edits note as a discovered branch workflow. The check constructs
expected claims from the supplied reference and evaluates the stored trust
rules. The supplied reference must match the caller's eventual `uses` value.

The explicit-reference check fails if only an interactive administrator rule
matches, even when that rule's wildcard grant would allow the operations. It
also verifies the reuse view's effective priority over the destination and
whether the supplied root prefix is within the grant. If an input such as
`--root-prefix` is missing, the command reports the unchecked invariant and
returns a non-success status.

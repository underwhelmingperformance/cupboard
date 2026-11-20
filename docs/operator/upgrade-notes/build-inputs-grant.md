### Branch and tag trust rules grant `build-inputs`

Upgrade the server before the CLI. From this release, the branch and tag presets
of `cupboard oidc-trust`, and the branch rule that `cupboard github setup`
writes, also grant `build-inputs:record`. A job that a rule with this grant
accepts can add build inputs to store paths that the cache already has, which
decides which other store paths a garbage collection keeps. The pull-request
rules don't grant it. See [What a rule can grant][grants].

An earlier server doesn't know the operation and refuses a rule that grants it.
The CLI therefore asks the server whether it reads build inputs, and adds the
grant only when it does. Against an earlier server, the CLI writes the rules
that it wrote before.

The flake publish workflow requests the grant in its own token exchange on runs
outside pull requests, and uses it to record build inputs on store paths that
the cache already has. Rules that an earlier release wrote keep working without
the grant: the token service refuses only that exchange, the publication
succeeds, and the run root keeps the paths whose build inputs the workflow can't
record. For a flake job that publishes with `publish: built`, the default, and
uses a workflow release that records build inputs, `cupboard github check`
reports such a rule as a warning that doesn't fail the check. When it cannot
read the workflow at the job's pin, it warns that it cannot tell whether the job
records build inputs. `cupboard github check --fix` adds only
`build-inputs:record` to the rule that accepts the job's runs, including a rule
with other claims than the rule that setup writes, and never adds a rule for the
warning alone. When it cannot choose that rule, the warning says why and asks
you to add the grant yourself: several rules with the same number of claims
accept the runs, or the check cannot tell which rule accepts every release tag.
`--fix` also leaves the rule unchanged, and says so, when the job uses a branch
workflow and the command runs without `--allow-branch-workflow`. Alternatively,
run `cupboard github setup` again, after upgrading the server, to add it to the
branch rule that an earlier setup wrote. Setup recognises that rule only when it
has exactly the claims and grants that the earlier setup gave it, and then adds
the grant to the rule without asking to remove it. From then on, run
`cupboard github setup` with this release's CLI or a later one, because an
earlier CLI treats the extended rule as a conflict.

Setup upgrades only a rule identical to the rule that it writes, and at most one
such rule for each rule that it writes. For any other rule, such as one that an
earlier `cupboard oidc-trust add-github-branch` or `add-github-tag` wrote with
other options, or a setup rule whose claims have since changed, first add the
new rule with the command that wrote the old one, and then remove the old rule
with `cupboard oidc-trust remove`. A rule stops accepting tokens as soon as it
is removed, so adding the new rule first keeps CI runs working in between.

[grants]: ../../ci/trust-rules.md#what-a-rule-can-grant

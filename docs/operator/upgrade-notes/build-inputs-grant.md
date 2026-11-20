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

Rules that an earlier release wrote keep working without the grant. Run
`cupboard github setup` again, after upgrading the server, to add it to the
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

### GitHub Actions trust rules must pin the repository

By default, GitHub Actions signs the tokens of every repository on GitHub with
the issuer `https://token.actions.githubusercontent.com`, and each job chooses
the audience of its own token. A trust rule for that issuer is therefore limited
to your repositories only by its claims. A rule whose only claim is
`ref=refs/heads/main`, for example, accepts a token from the `main` branch of
any repository.

From this release, the deployment refuses to add a trust rule for that issuer
unless the rule requires an exact `repository_id`, or an exact
`repository_owner_id` to trust every repository of one owner. The refusal has
status 400 and the code `OIDC_TRUST_REPOSITORY_PIN_REQUIRED`. It applies to
tenant trust rules and control trust rules. The API also refuses to add grants
to a stored tenant rule that has neither claim. Rules for the issuer of a GitHub
Enterprise Cloud enterprise or a GitHub Enterprise Server host aren't checked,
because only that enterprise's or that server's repositories receive its tokens.

The deployment also refuses that issuer as the owner of a new tenant, with the
code `TENANT_OWNER_ISSUER_UNSUPPORTED`, and as the admin in a deployment claim,
with the problem `signup-issuer-unsupported`. The owner rule and the claim's
`signup` rule can require only the `sub` claim, which contains at most the
repository's name. Create each tenant with a person as its owner, and let the
owner add trust rules for workflows. See [Creating a tenant][creating-a-tenant].

`tenant create` can't finish a tenant whose earlier creation stopped part way
with the GitHub Actions issuer as its owner, because the deployment now refuses
that owner. `cupboard tenant list <deployment URL>` shows such a tenant with
that issuer. Remove it with `cupboard tenant remove`, then create the tenant
again under another slug, with a person as its owner. A removed tenant's slug
can't be used again.

The `add-github-*` commands and `cupboard github setup` already pin both IDs, so
their rules are unaffected. Rules that someone wrote with
`cupboard oidc-trust add`, `--from-file` or the API might not be. In particular,
the control trust rule in [Updating from CI][updating-from-ci] used to pin only
the `sub` claim.

Stored rules without a pin keep working after the upgrade. To find all of them,
run `cupboard oidc-trust list <tenant URL>` in each tenant, or ask each tenant's
administrators to, and run `cupboard control-oidc-trust list <deployment URL>`.
Both show `Repository pin: None` for each such rule, and warn about each enabled
one. `cupboard deploy` also warns about each enabled control trust rule without
a pin.

The Worker logs the warning `OIDC trust rule without a repository pin matched`
whenever a token exchange or a read acquisition through such a rule succeeds,
with the tenant, the rule and the repository claims of the token. The records
show which rules are in use and by which repositories. An unused rule never
appears in them, and neither does a rule whose exchanges are all refused, so the
records don't replace `oidc-trust list`. See [Trust rules without a repository
pin][unpinned-log].

Replace each rule that `list` warns about. A rule without a pin can accept
tokens from several repositories, so first decide which repositories should be
able to use it. The log records show which repositories use it now. For each of
them, look up the repository's IDs with
`gh api repos/<owner>/<repo> --jq '.id, .owner.id'`, add a rule with the same
claims and grants plus `repository_id` and `repository_owner_id`, and check that
its jobs still exchange tokens. Only then remove the old rule with
`cupboard oidc-trust remove <tenant URL> <rule ID>` or
`cupboard control-oidc-trust remove <deployment URL> <rule ID>`. See [GitHub
rules must pin the repository][github-repository-pin].

Take care with the control trust rule `signup`, which a deployment claim created
for the deployment's admin. `cupboard init` needs a token with the wildcard
grant for the admin's identity. Add the replacement first, with the same issuer,
audience and `sub` claim, both repository IDs and the wildcard grant. Remove
`signup` only after that. If you remove it first, the admin can't sign in,
`cupboard init` stops, and a new claim doesn't restore the rule. See [Restoring
the admin's wildcard grant][restore-admin].

A tenant whose owner was created with the GitHub Actions issuer keeps its owner
rule, which can't be removed. `cupboard oidc-trust list` warns about it. Don't
rename or delete the repository in its subject, or the account that owns the
repository. Either change frees the name, and a new repository with the same
name would match the rule. GitHub keeps a retired name from reuse only for a
repository with more than 100 clones in the week before the change. To stop
trusting the rule, remove the tenant and create a new one whose owner is a
person.

[creating-a-tenant]: ../tenants.md#creating-a-tenant
[updating-from-ci]: ../upgrading.md#updating-from-ci
[unpinned-log]: ../running.md#trust-rules-without-a-repository-pin
[restore-admin]: ../operators.md#restoring-the-admins-wildcard-grant
[github-repository-pin]:
  ../../ci/trust-rules.md#github-rules-must-pin-the-repository

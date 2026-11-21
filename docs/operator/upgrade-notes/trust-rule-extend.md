### Add grants to an existing trust rule

`cupboard oidc-trust extend` adds grants to an existing trust rule in place. The
rule keeps its ID, claims and existing grants, and keeps accepting tokens while
the command runs.

For a branch or tag rule that `cupboard github setup` cannot upgrade to grant
`build-inputs`, this command replaces the procedure of adding a new rule and
then removing the old one. `cupboard oidc-trust list` shows the rule's ID. A
branch rule publishes to the default cache:

```sh
cupboard oidc-trust extend https://cupboard.example.workers.dev/t/acme <rule-id> \
  --allow build-inputs
```

A tag rule publishes to a cache named after the tag, so the new grant needs the
cache template of the rule's existing grant. For a rule with the default
template:

```sh
cupboard oidc-trust extend https://cupboard.example.workers.dev/t/acme <rule-id> \
  --allow build-inputs --template-source github-tag --cache-template '{tag}'
```

See [Listing, changing and removing rules][changing].

[changing]: ../../ci/trust-rules.md#listing-changing-and-removing-rules

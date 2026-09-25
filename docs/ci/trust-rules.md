# Trust rules

A CI job that publishes to your cache has to prove to cupboard that it's allowed
to. cupboard doesn't give CI jobs a password or API key to store as a secret.
Instead, it relies on the identity token that GitHub Actions already gives every
job.

That token is signed by GitHub, and it says which repository, branch or pull
request, event and workflow the job is running for. The job sends it to
cupboard, and cupboard compares it with your tenant's **trust rules**. If a rule
accepts it, cupboard gives the job a cupboard token that lasts a few minutes and
allows only what the rule says. The job never has a long-lived cupboard secret.

A trust rule says two things:

- which tokens to accept, for example tokens issued by GitHub Actions, for the
  repository `acme/app`, on the branch `main`;
- what a job with such a token may do, for example publish store paths to the
  default cache, and keep them under retention roots that start with
  `github:acme/app/main/`.

Each permission that a rule gives is called a **grant**.

Administrators sign in the same way. A tenant administrator is someone whose
identity matches a rule that gives full access. See
[Who can use your tenant](../admin/access.md).

You usually don't need to write rules yourself. `cupboard github setup`, in
[the quickstart](./quickstart.md), writes the rules that the flake publish
workflow needs. This page explains what those rules contain, and how to write
others.

## Why a job gets either everything that it asks for or nothing

When a job exchanges its token, it asks for the specific grants that it needs.
The exchange succeeds only if a single rule accepts the token and allows
everything that the job asked for.

cupboard never gives a job less than it asked for. Suppose a push asks to
publish, to set a root and to attach attestations, and the rule doesn't allow
setting roots. The whole exchange is refused. The job isn't allowed to publish
without the root. Failing at this point is safer than publishing paths that no
root keeps.

## Adding the usual GitHub rules

The `cupboard oidc-trust add-github-*` commands write rules for the common
GitHub cases. To let pull requests in `acme/app` publish to their own caches:

```sh
cupboard oidc-trust add-github-pr https://cupboard.example.workers.dev/t/acme \
  --repo acme/app
```

To let runs on the `main` branch publish to the default cache:

```sh
cupboard oidc-trust add-github-branch https://cupboard.example.workers.dev/t/acme \
  --repo acme/app --branch main
```

There is also `add-github-tag`, for release tags. Each command writes one rule:

| Command             | Accepts runs with                    | Cache                        | Roots                             | Grants                                     |
| ------------------- | ------------------------------------ | ---------------------------- | --------------------------------- | ------------------------------------------ |
| `add-github-pr`     | `event_name=pull_request`            | `gh-{repository_id}-pr-{pr}` | `github:<owner>/<repo>/pr-{pr}/`  | push, root, attach, create, remove, attest |
| `add-github-branch` | `ref=refs/heads/<branch>`, any event | the default cache            | `github:<owner>/<repo>/<branch>/` | push, root, attach, attest                 |
| `add-github-tag`    | `ref_type=tag`, any event            | `{tag}`                      | `github:<owner>/<repo>/<cache>/`  | push, root, attach, attest                 |

The grants are explained in [What a rule can grant](#what-a-rule-can-grant).
Names in braces are filled in from each run's token.

All three commands accept tokens from GitHub Actions only. They pin the
repository by its numeric IDs, and set the audience to the tenant URL unless you
choose another. To look up the IDs, they call the GitHub API. For a private
repository, set `GH_TOKEN` or `GITHUB_TOKEN` so they can. They use `GH_TOKEN` if
both are set.

You can add two options to any of them:

- `--job-workflow-ref` also requires the run to use a particular workflow file.
  See [Trusting a reusable workflow](#trusting-a-reusable-workflow).
- `--no-attest` leaves out the `attest` grant.

### Pull requests

The rule works out the pull request's number from the token's `ref`, which must
be `refs/pull/<n>/merge`. It works out the cache name from the repository ID,
which GitHub signs. A token can therefore only ever reach its own pull request's
cache. For example, a run for pull request 7 of repository 1234 can create,
publish to and remove the cache `gh-1234-pr-7`, and nothing else.

Runs triggered by `pull_request_target` don't match this rule.

### Branches

Any run on the branch matches, including manual and scheduled runs. The rule
always publishes to the default cache, under the branch's root.

### Tags

The cache name comes from the tag. The tag must be lower case and match
`[a-z0-9][a-z0-9._-]*`. If it doesn't, cupboard can't make a cache name from it,
and the exchange is refused.

This rule can't create caches, so you need to create the cache first. See
[Publishing releases](./flake-publish.md#publishing-releases).

### Choosing other cache and root names

`add-github-pr` and `add-github-tag` accept `--cache-template` and
`--root-template`. The templates can only use the command's own variables:
`{repository_id}` and `{pr}` for pull requests, or `{tag}` for tags.

In `add-github-tag`, the default root follows the cache template. So
`--cache-template releases` on its own would give every tag the same root,
`github:<owner>/<repo>/releases/`. Pass `--root-template` as well to keep each
tag's paths under its own root.

In `add-github-pr`, the root doesn't follow the cache template.

`add-github-branch` has no templates.

## Matching a token

A rule specifies an issuer and an audience, and both must exactly match the
token's.

- The **issuer** is who signed the token. For GitHub Actions it's
  `https://token.actions.githubusercontent.com`.
- The **audience** is who the token is meant for. A cupboard job asks for the
  tenant URL, without a trailing slash, unless it's told to use something else.
  Write it the same way in the rule.

A rule also lists **claims**: named values that the token must contain, such as
`repository_id` or `ref`. For each one, the token must have a claim of that name
whose value is a string that matches. A claim in a rule is one of two kinds:

- An exact value. The comparison is case-sensitive, and `refs/heads/main`
  doesn't match `main`.
- A regular expression, anchored at both ends.

`--claim` sets exact values. `--job-workflow-ref` can set a pattern.
`--from-file` can set a pattern on any claim.

A rule for GitHub should pin:

- The repository, by `repository_id` and `repository_owner_id`. These numeric
  IDs never change. If the repository is renamed, and someone else creates a
  repository with the old name, that new repository doesn't inherit your trust.
- The trigger: `event_name` for pull requests, `ref_type` for tags, or `ref` for
  a branch.
- Optionally, the workflow file, by `job_workflow_ref`.

## What a rule can grant

`--allow` takes one of these names. Repeat the flag for each grant:

| Grant    | Lets the job                                                          |
| -------- | --------------------------------------------------------------------- |
| `push`   | Upload and publish store paths.                                       |
| `root`   | Set and list retention roots.                                         |
| `attach` | Add published paths to a [run root](../admin/retention.md#run-roots). |
| `attest` | Attach attestation bundles.                                           |
| `create` | Create the cache.                                                     |
| `remove` | Remove the cache.                                                     |

### Which cache a grant applies to

Every grant applies to one cache. By default, that's the default cache. To
choose another cache, use `--cache`. To make the name from the token, use
`--cache-template`. Pass one or the other. If you pass both, the template is
used.

A grant applies whether the cache is public or private. Making a cache private
doesn't change which jobs can write to it.

Trust rules never let anyone read a private cache. Reading one needs a
[read credential](../use/private-caches.md#read-credentials).

### Which roots a grant applies to

`root` and `attach` also need to know which roots they cover. Give these with
`--root` or `--root-template`. The CLI refuses a `root` or `attach` grant
without one.

A root that ends in `/` is a prefix. For example, `github:acme/app/main/` covers
`github:acme/app/main/x86_64-linux` and every other root that starts with it.
The prefix doesn't cover `github:acme/app/main` itself.

A job can list the roots that its grant covers, and what those roots point at.
Only a grant that isn't limited to particular roots can list every root in the
cache, as `cupboard root list` does.

## Trusting a reusable workflow

When a repository calls a reusable workflow, such as cupboard's flake publish
workflow, the job's token describes two things:

- The standard claims, such as `repository_id` and `ref`, still describe the
  calling repository and its run.
- `job_workflow_ref` identifies the reusable workflow's file, in the repository
  that hosts it, at the ref that the caller used. For example:
  `underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@refs/tags/v1.4.0`.

GitHub [documents this claim][reusable-oidc] separately from the standard ones.
Pin `job_workflow_ref` together with the caller's repository and trigger, not
instead of them.

`--job-workflow-ref` accepts three forms:

| Value                                             | Matches                                                                                                   |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `owner/repo/.github/workflows/f.yml@ref`          | That file at exactly that ref. It's stored as you give it, so check it for typos.                         |
| `owner/repo/.github/workflows/f.yml@refs/tags/v*` | That file at every matching tag, including tags created later. `*` matches within one segment of the tag. |
| `owner/repo/.github/workflows/f.yml`              | That file at any ref. Only the rule's trigger pin then limits which runs match.                           |

The quickstart passes a tag pattern to `github setup`. `github setup` also
accepts a full commit ID, or a tag that has an immutable release.

A tag pattern means you write the rule once, and every later cupboard release is
accepted without changing your tenant. There are two costs:

- Anyone who can push a matching tag to cupboard's repository is inside your
  tenant's trust boundary.
- A caller that pins the workflow by commit SHA doesn't match the rule.

To avoid both, trust one exact tag or commit instead. Then, before you move a
caller to a new release, add a rule for that release.

[reusable-oidc]:
  https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-with-reusable-workflows

## When several rules match

A token can match more than one rule. cupboard doesn't try them all. It picks
out the most preferred group of matching rules:

1. Rules that give full access (a wildcard grant) come first. This means an
   administrator's access is never reduced by a narrower rule that also matches.
2. Otherwise, rules that pin more claims come first. The issuer and audience
   don't count. A pattern counts the same as an exact value.

Within that group, exactly one rule must allow the whole request, or the
exchange is refused.

- cupboard never falls back to a less preferred rule.
- cupboard never combines rules. If a push needs a grant for its target root and
  another for its run root, one rule must give both.
- If two rules in the group both allow the request, the exchange is refused as
  ambiguous.

Rules in the same group can still cover different things, such as different
caches. That works because each request is then allowed by exactly one of them.

## Writing a rule by hand

`cupboard oidc-trust add` takes the tokens to accept and the grants as options.
This rule trusts the `main` branch of `acme/app`, when it runs cupboard's flake
publish workflow at any release tag. It lets those runs publish to the default
cache under `github:acme/app/main/`:

```sh
cupboard oidc-trust add https://cupboard.example.workers.dev/t/acme \
  --issuer https://token.actions.githubusercontent.com \
  --audience https://cupboard.example.workers.dev/t/acme \
  --claim repository_id=123456789 \
  --claim repository_owner_id=987654321 \
  --claim ref=refs/heads/main \
  --job-workflow-ref 'underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@refs/tags/v*' \
  --allow push --allow root --allow attach --allow attest \
  --root github:acme/app/main/
```

To find the repository's two IDs, run:

```sh
gh api repos/acme/app --jq '.id, .owner.id'
```

### Capturing values from the token

A template makes a cache or root name from values in the token. This lets one
rule serve every pull request or every tag. `--template-source` defines the
common variables:

- `github-pr` provides `{repository_id}`, and `{pr}` from a `ref` of the form
  `refs/pull/<n>/merge`.
- `github-tag` provides `{tag}` from a `ref` of the form `refs/tags/<tag>`.

For other claims, use `--capture 'claim=^…(?<name>…)…$'`. Each named group in
the regular expression becomes a variable. The expression must be anchored at
both ends and match the whole claim.

If a template uses a capture's variables and the claim doesn't match the
expression, the token is refused. A capture that no template uses is ignored.
The name that a template produces must be a valid cache or root name.

### Writing a rule as JSON

Some rules can't be written with flags, such as patterns on arbitrary claims, or
full access for another administrator. For these, write the whole rule as JSON
and pass it with `--from-file`. See
[Adding an administrator](../admin/access.md#adding-an-administrator) for an
example.

The file contains the whole rule, so the command refuses `--from-file` together
with any other rule option, including `--issuer` and `--audience`.

## Listing, changing and removing rules

To see the tenant's rules, including disabled ones, one per line:

```sh
cupboard oidc-trust list https://cupboard.example.workers.dev/t/acme
```

To see one rule's claims and grants:

```sh
cupboard oidc-trust show https://cupboard.example.workers.dev/t/acme <rule-id>
```

Add `--output-mode json` to either command for the complete records.

You can't edit a rule. To change one, add a corrected rule, then remove the old
one:

```sh
cupboard oidc-trust remove https://cupboard.example.workers.dev/t/acme <rule-id>
```

Removing a rule disables it. It stays in the list, marked as disabled. Tokens
that it has already given out stay valid until they expire, within 15 minutes.

You can't remove the rule for the tenant's owner, which is called `owner`.

## When an exchange is refused

Most refusals only say "No trust rule matches the subject token". The same
message covers an unknown issuer or audience, a token that matches no rule, and
a token that matches more than one rule ambiguously.

If a rule matches the token but doesn't allow what the job asked for, the job is
told the request isn't permitted instead.

GitHub rules get a more helpful error in one case. If a rule pins the token's
exact `repository_id` and `repository_owner_id`, and the token's signature
checks out against that rule, the error identifies the rule. It also gives the
first of the rule's claims, in alphabetical order, that didn't match, with the
value that the rule expected and the value that the token had.

You can find these problems before a run fails.
[`cupboard github check`](./quickstart.md#5-check-the-setup) tests your rules
against the claims that a real run would present. For the error messages
themselves, see [Troubleshooting](../troubleshooting.md#ci-publication).

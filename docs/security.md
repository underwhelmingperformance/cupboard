# Security model

This page is for anyone deciding whether cupboard is safe enough for their
builds, or trying to work out whether a behaviour is a vulnerability. It
explains what cupboard protects, who it trusts, and where those protections
stop. [Architecture](./contributing/architecture.md) describes the mechanisms in
more depth.

## Who can do what

cupboard has a few kinds of user, and each proves who they are in a different
way:

- The **operator** runs the deployment. They sign in with an identity provider,
  Cloudflare by default, and a trust rule on the deployment's control plane
  accepts them. The first `cupboard init` from a terminal makes the person who
  runs it the operator: it presents a generated one-time claim secret with their
  identity, and deletes the secret afterwards.
- A **tenant administrator** manages one tenant. They sign in the same way, and
  a trust rule on that tenant accepts them.
- A **CI job** publishes to a tenant. It presents an OIDC token from its CI
  platform, and a trust rule on the tenant accepts it.
- A **reader of a private cache**, usually Nix, presents a static read
  credential or a short-lived content-read token. Nix sends both with HTTP Basic
  authentication.

Behind all of them is the Cloudflare account that hosts the deployment. Whoever
controls that account can do anything.

The table below sums up what each of them can do.

| Who                         | What they can do                                                                                                     |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| The Cloudflare account      | Everything. It runs the deployment, and can read all of its data and secrets.                                        |
| The operator                | Create, suspend and remove tenants. Set quotas. Issue static read credentials. Add operators. Update the deployment. |
| A tenant administrator      | Everything within one tenant except issuing static read credentials: caches, keys, retention, trust rules.           |
| A CI job                    | Whatever its trust rule grants, such as publishing to one cache, setting certain roots, and attaching attestations.  |
| A reader of a private cache | Read that cache. With the tenant read credential, read every private cache that has no credential of its own.        |
| Anyone                      | Read public caches, and every tenant's public key.                                                                   |

Being the operator doesn't give you access to a tenant's caches or settings. The
operator can only manage a tenant's contents if they're also one of its
administrators.

`cupboard init` updates a deployment only with an operator's token. That check
doesn't protect the deployment from anyone else who has the Cloudflare account's
credentials: they can change the Workers, their secrets or D1 directly with
other tools.

## How tenants are kept apart

Each tenant's caches, narinfos, keys, trust rules, retention and sessions are
stored in a Durable Object of its own.

cupboard issues each token for one tenant, and the token identifies that tenant.
Other tenants refuse the token.

Each tenant signs its narinfos with its own key. If a client trusts one tenant's
key, that doesn't make it trust any other tenant.

All tenants share one D1 database and one R2 bucket. Inside those, it's
cupboard's code that keeps tenants apart, not Cloudflare's bindings. Tenants
can't run code of their own.

### Shared storage

cupboard stores each NAR once, under its hash, however many tenants publish it.
Each tenant is charged for it separately.

This sharing doesn't tell one tenant what another has stored. When a push asks
which NARs it needs to upload, cupboard asks for every NAR that the pushing
tenant doesn't already refer to, even if another tenant has stored it. A cache
only serves NARs that its own store paths refer to.

One weak signal remains. After an upload, a NAR that another tenant had already
stored may become available sooner than a new one.

## How cupboard checks what it serves

cupboard verifies every upload before publishing it. A client uploads to a
staging area, and can't write anywhere else. The server decompresses each upload
and checks its NAR hash and size against what the client declared. Only then
does it publish the NAR. It copies the verified bytes into place with a second
hash check.

Every narinfo is signed with the tenant's key. A client should only trust a key
that comes from a trusted source. If a client fetches the key from the
deployment's `/pubkey` endpoint, the client has to trust the deployment on that
first fetch.

Attestations record where published store paths came from. See
[Attestations](./ci/attestation.md).

## Where keys and secrets are kept

| What                                     | Where it's kept                                  | How it's protected                                                                                                            |
| ---------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Tenant signing and access-token keys     | The tenant's Durable Object storage              | Cloudflare's storage encryption. cupboard adds none.                                                                          |
| Control keys, which sign operator tokens | D1                                               | Encrypted with `CONTROL_KEY_WRAP_SECRET`.                                                                                     |
| `CONTROL_KEY_WRAP_SECRET`                | Only the control Worker, and the operator's copy | The tenant Worker never has it.                                                                                               |
| R2 access key                            | The tenant Worker                                | It gives access to every tenant's stored objects.                                                                             |
| `PUSH_ID_SIGNING_KEY`                    | Both Workers                                     | It signs push IDs and derives the keys that encrypt refresh tokens.                                                           |
| Static read credentials                  | D1, as salted SHA-256 hashes                     | The CLI generates each password from 32 random bytes, and the server accepts only that format. The plaintext is never stored. |
| CLI sessions and Cloudflare sign-in      | `~/.config/cupboard` on each machine             | File permissions. The Cloudflare sign-in can deploy to the account.                                                           |

Changing `PUSH_ID_SIGNING_KEY` ends every refresh session issued by this
release, and tenant administrators with such a session have to sign in again.

When a client uploads to R2, it gets a temporary credential. That credential can
only write to its own push's staging area, and lasts at most six hours.

CI jobs need no long-lived secret to publish or to read private caches when
their trust rules grant the exact content read. A job can still use a static
read credential when its runner or remote daemon needs one.

## Revoking access

| To revoke                       | Do this                                                                                    | It takes effect                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| An administrator                | Remove every matching trust rule that permits their authority.                             | Within 10 minutes, when their access token expires. |
| A CI job                        | Remove its trust rule.                                                                     | Within 15 minutes.                                  |
| A sign-in session               | List it with `cupboard session list`, then run `cupboard session revoke`.                  | Within 10 minutes; renewal stops at once.           |
| A leaked access token           | [Rotate the access-token key](./admin/keys.md#access-token-keys), then retire the old one. | Immediately.                                        |
| A leaked static read credential | Rotate it with `cupboard tenant rotate-credential` or `rotate-cache-credential`.           | Immediately.                                        |
| A compromised signing key       | [Rotate it](./admin/keys.md#rotating-the-signing-key), and remove it from clients.         | As clients are updated.                             |

`cupboard logout` deletes the sessions saved on one machine, and with
`--cloudflare` the saved Cloudflare sign-in too. It also sends the server, or
Cloudflare, a revocation request for the refresh token of each one. A copy of a
revoked session taken from that machine then cannot be renewed. A copy of a
cupboard access token remains valid for up to ten minutes, and a copy of a
Cloudflare access token until it expires. If a revocation fails, logout still
deletes the local copy and reports the failure. A copy of that session keeps
working until it expires or one of the steps above revokes it.

## Who else you're trusting

Some of cupboard's security depends on people and systems outside cupboard
itself.

By default, operators and tenant administrators sign in with their Cloudflare
accounts. Anyone who takes over one of those accounts gets whatever rights that
account has in cupboard. Anyone who controls the Cloudflare account that hosts
the deployment controls everything.

If you write a trust rule that accepts cupboard's reusable workflow at
`refs/tags/v*`, you're also trusting the people who publish cupboard's release
tags. That rule accepts every future release, so anyone who can push such a tag
to cupboard's repository is inside your tenant's trust boundary. See
[Trusting a reusable workflow](./ci/trust-rules.md#trusting-a-reusable-workflow).

When a cache publishes a store path, it inherits the existing attestations of a
public cache in the same tenant that serves the path with the same NAR, and of
its own earlier generation of the path. Publishing by reference from a public
cache therefore brings that cache's attestations with it. Attestations in
another private cache stay in that cache. See
[Attestations of reused paths](./ci/attestation.md#attestations-of-reused-paths).

The pull-request preset gives each pull request its own cache, and refuses pull
requests from forks. If a reuse view includes pull-request caches, any of those
pull requests can offer store paths to readers of the view. When the caches in a
view disagree about a path, the view treats it as missing rather than choosing
between them.

## Runners

A trust rule controls which repository, trigger and workflow can publish. It
doesn't control which machine runs the job. Any runner that picks up an accepted
job can publish. Attestations record which runner ran the job, but only after
the fact. They don't prevent anything.

Runner labels can't close that gap. A label is just routing information, set by
whoever runs the runner. It isn't a verified identity:

- GitHub sends a job to any runner that has the labels that the job asks for.
- A self-hosted runner can have any label.
- A pull request can change which labels its own jobs ask for.

If your repositories only use GitHub-hosted runners, you don't need to do
anything more. If you use self-hosted runners:

- Put them in **runner groups**, and restrict each group to the repositories and
  workflows that need it. A group controls where a job may run. A label doesn't.
- Require approval before running workflows from outside contributors. Don't
  attach privileged runners to public repositories.
- Keep credentials off the runners, or limit them to what the jobs need. A
  runner will run whatever code reaches it.

In the flake publish workflow, the plan job has your SSH key for private inputs,
and the plan and cache-removal jobs can request OIDC tokens. Leave `plan-runner`
set to a GitHub-hosted label unless that runner's group is restricted as
described above.

## What private caches reveal

A private cache requires read authorisation for every request except `/pubkey`.
Even so, store-path hashes and NAR hashes can still leak through attestations
and logs. Anyone who has a copy of a path's contents can compute its NAR hash
and so recognise the path. See
[What a private cache protects](./use/private-caches.md#what-a-private-cache-protects)
and [Attestations for private caches](./ci/attestation.md#private-caches).

## Reporting a vulnerability

Please report vulnerabilities privately, as described in the
[security policy](../SECURITY.md), and not in public issues.

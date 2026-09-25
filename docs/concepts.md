# Concepts

This page explains the ideas behind cupboard and the terms that the rest of the
documentation uses for them. Read it if you're new to cupboard, or come back to
it when you meet an unfamiliar term.

## Deployments and tenants

When you install cupboard on a Cloudflare account, you create a **deployment**.
A deployment is made up of two Workers, their storage and their scheduled jobs.
It has one address, called the **deployment URL**, such as
`https://cupboard.example.workers.dev`.

The person who runs a deployment is its **operator**. The operator deploys and
upgrades cupboard, creates, suspends and removes tenants, and issues read
credentials.

A deployment hosts one or more **tenants**. A tenant is an independent binary
cache service with its own address, the **tenant URL**, such as
`https://cupboard.example.workers.dev/t/acme`. Each tenant has its own caches,
signing key, credentials, access rules and storage quota. Tenants can't see
anything that belongs to another tenant.

When the operator creates a tenant, they specify the identity that owns it. This
identity is the tenant's **owner**. The owner can give other identities the same
rights. The owner and those other identities are the tenant's **tenant
administrators**. They manage the tenant's caches, keys, retention and access
rules.

## Caches

Each tenant has one or more **caches**. Nix treats each cache as a separate
substituter.

Every tenant has a **default cache**, whose address is the tenant URL itself. A
tenant can also have **named caches**, each with its own address:

```
https://cupboard.example.workers.dev/t/acme/cache/release
```

An administrator can create a named cache. The first write to a named cache's
URL also creates it.

Each cache has its own settings: whether it's public or private, the substituter
priority that it advertises to Nix (40 by default), and its
[retention](#retention) settings. Anyone can read a public cache. A private
cache can only be read with a credential.

If you remove a cache and then create another with the same name, the new cache
starts empty. Nothing from the old one comes back.

## How Nix fetches a store path

Nix fetches a store path in two steps:

1. It asks for the path's **narinfo**. This is a small file that records the
   path's references, its **NAR hash** and its signatures.
2. It fetches the **NAR**. This is the path's contents, packed in Nix's archive
   format. cupboard stores NARs compressed with zstd.

Each tenant signs every narinfo that it serves with its **signing key**. Nix
only accepts a narinfo if it trusts the public half of that key. cupboard serves
the public key at `/pubkey`. You can rotate a tenant's signing key. See
[Keys](./admin/keys.md).

### How storage is shared

cupboard stores each NAR only once, however many caches or tenants publish it.
Each tenant is charged once for each distinct NAR and attestation that it refers
to, at its compressed size.

## Read credentials

Nix reads a private cache with a username and password, sent as HTTP Basic
credentials. There are two kinds of read credential: the **tenant read
credential** and a **cache read credential**, which belongs to a single cache.
Only the operator can issue them.
[Read credentials](./use/private-caches.md#read-credentials) explains which one
a cache accepts.

## Signing in and trust rules

Administrators and CI jobs don't have cupboard passwords. They sign in with an
identity token from an OpenID Connect provider: Cloudflare by default for an
administrator using `cupboard login`, and GitHub's own token for a GitHub
Actions job. cupboard exchanges the identity token for a short-lived cupboard
token.

A **trust rule** tells a tenant which identity tokens to accept, and what the
resulting cupboard token is allowed to do. A rule that gives full access makes
the holder an administrator. A rule for CI **grants** specific operations, such
as publishing to one cache and setting certain retention roots.

See [Signing in](./admin/signing-in.md),
[Who can use your tenant](./admin/access.md) and
[Trust rules](./ci/trust-rules.md).

## Retention

cupboard deletes a store path unless something keeps it. There are two ways to
keep a path.

The main way is a **retention root**. A root has a name, belongs to one cache,
and lists a set of store paths, called its **targets**. It keeps its targets and
everything that they refer to. For example, a root called `main` might keep the
outputs of the latest build of your main branch.

A root is either **permanent**, or has a **TTL**, after which it expires. When
you write to a root, you replace its targets and restart its TTL. If you push a
store path without specifying a root, cupboard creates a **pin**, which is a
root that keeps just that one path.

The other way is **grace**. If a cache has a grace period, cupboard keeps each
newly published or released path for that long, even if no root keeps it.

Every hour, cupboard runs **garbage collection**. It removes expired roots, then
deletes every path that no root or grace period is keeping.

CI runs use a special kind of root, called a **run root**. It collects every
path that the run publishes, so later jobs in the same run can substitute them.
Unlike an ordinary root, a run root only ever grows.

See [Retention](./admin/retention.md).

## Reuse views

A **reuse view** lets Nix read from several caches through one address, such as
`https://cupboard.example.workers.dev/t/acme/reuse/<view>`. You choose which
caches it includes by name or by name prefix. A reuse view is read-only.

The flake publish workflow reads through a reuse view to find out what other
caches already have. When it finds a path that way, it can **publish it by
reference**. This means the destination cache starts serving the path using
bytes that the tenant already stores, without uploading them again.

See [Reuse views](./ci/reuse-views.md).

## Attestations

An **attestation** is a signed statement about a store path, attached to that
path in the cache. cupboard's GitHub Actions attach two kinds: **build
provenance**, which records the repository, commit and workflow that built a
path, and **build origin**, which records how each published path became
available during the run.

See [Attestations](./ci/attestation.md).

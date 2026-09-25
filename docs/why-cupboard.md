# Why cupboard

This page is for deciding whether cupboard suits you. The [README](../README.md)
says what cupboard does and why it exists. This page compares it with the other
ways of running a Nix cache, and lists the reasons not to choose it.

## How it compares

The table compares the infrastructure that each option needs you to run. The
other projects change over time, so check their own documentation for their
current features and pricing.

| Option                                 | What you run                            | Trade-offs                                                            |
| -------------------------------------- | --------------------------------------- | --------------------------------------------------------------------- |
| **cupboard**                           | Nothing but a Cloudflare account        | Tied to Cloudflare. Pre-1.0.                                          |
| **Cachix**                             | Nothing. It's a hosted service.         | A third party stores your builds.                                     |
| **Attic**                              | A server, a database and object storage | You control the hosting, and you operate more infrastructure.         |
| **Harmonia, nix-serve**                | A machine whose Nix store you serve     | The cache is the Nix store of that one machine.                       |
| **An S3 or R2 bucket**, via `nix copy` | A bucket                                | No server. Every writer that signs paths needs the cache signing key. |

## When not to use it

cupboard probably isn't right for you if:

- You can't use Cloudflare, or you need to run everything on premises.
- Your clients use a version of Nix too old to decompress zstd. cupboard
  requires zstd, and is tested with Nix 2.34.
- You need to mirror or federate between several caches, import the contents of
  an existing cache, or manage the cache from a web interface. cupboard can't do
  any of these yet.
- You need a stable 1.0 release. See [Maturity](#maturity) below.

## Maturity

cupboard is pre-1.0, and releases are numbered `v0.0.x`.

A release can change the format of stored data. When it does, upgrading runs a
staged migration, and the [upgrade notes](./operator/upgrade-notes.md) explain
what you need to do. Once tenants have migrated, you can't roll the upgrade
back.

## Cost

You pay Cloudflare's usage charges on your own account. Check Cloudflare's
pricing for Workers, Durable Objects, D1, R2, Workers KV and Queues.

R2 storage is usually the largest part of the bill. The operator can cap each
tenant's storage with a quota.

Every narinfo and NAR that a client fetches counts as a Workers request. The
Free plan has a daily request limit, so it's only suitable for small
deployments. See [Running a deployment](./operator/running.md#capacity-and-cost)
for more.

## Limits

[Limits](./reference/limits.md) lists every fixed limit. For example, a single
NAR can be at most 4 GiB.

## Licence

cupboard is licensed under the
[GNU Affero General Public License v3.0 or later](../COPYING). Among other
things, this means that if you modify cupboard and let others use it over a
network, you must offer them your modified source.

## Next steps

- [Concepts](./concepts.md) explains how cupboard is organised.
- [Deploying cupboard](./operator/deploying.md) walks you through setting up a
  deployment.
- The [Security model](./security.md) explains who cupboard trusts and how
  tenants are kept apart.

# cupboard documentation

cupboard is a Nix binary cache that runs on your own Cloudflare account. These
pages cover using a cache, running one, publishing to one from CI, and how it
all fits together.

## Where to start

If you're deciding whether to use cupboard, read
[Why cupboard](./why-cupboard.md), then [Concepts](./concepts.md) and the
[Security model](./security.md).

If someone has given you a cache to use, read
[Using a cache](./use/nix-clients.md). If the cache is private, read
[Private caches](./use/private-caches.md) as well.

If you administer a tenant, start with
[Administering a tenant](./admin/README.md).

If you want to publish from GitHub Actions, follow the
[Quickstart](./ci/quickstart.md), then read
[How a publication run works](./ci/how-it-works.md).

If you run a deployment, read [Installing the CLI](./installing.md),
[Deploying](./operator/deploying.md) and
[Operating tenants](./operator/tenants.md).

If you're reviewing cupboard's security, read the
[Security model](./security.md), [Trust rules](./ci/trust-rules.md),
[Attestations](./ci/attestation.md) and
[Architecture](./contributing/architecture.md).

If you want to contribute, read [Contributing](./contributing/README.md).

Whichever you pick, [Concepts](./concepts.md) explains the terms that every page
relies on.

## Using a cache

- [Using a cache](./use/nix-clients.md): setting up Nix on NixOS, nix-darwin,
  Home Manager, and other Linux and macOS systems.
- [Private caches](./use/private-caches.md): read credentials, and how to give
  them to Nix safely.

## Administering a tenant

- [Administering a tenant](./admin/README.md): what you can manage yourself, and
  what you need the operator for.
- [Signing in](./admin/signing-in.md)
- [Caches](./admin/caches.md)
- [Pushing](./admin/pushing.md)
- [Retention](./admin/retention.md)
- [Who can use your tenant](./admin/access.md): adding administrators, letting
  CI publish, and reading private caches.
- [Keys](./admin/keys.md)

## Publishing from GitHub Actions

- [Quickstart](./ci/quickstart.md)
- [How a publication run works](./ci/how-it-works.md)
- [Publishing a flake](./ci/flake-publish.md): destinations, the target
  manifest, releases and common tasks.
- [Private caches in CI](./ci/private-caches.md)
- [Building elsewhere](./ci/building-elsewhere.md): using remote builders and
  stores.
- [Building your own publication job](./ci/custom-jobs.md)
- [Trust rules](./ci/trust-rules.md)
- [Reuse views](./ci/reuse-views.md)
- [Attestations](./ci/attestation.md)

## Running a deployment

- [Installing the CLI](./installing.md)
- [Deploying](./operator/deploying.md)
- [Operating tenants](./operator/tenants.md): creating tenants, issuing read
  credentials, and suspending and removing tenants.
- [Operators](./operator/operators.md): adding operators and rotating control
  keys.
- [Running a deployment](./operator/running.md): maintenance, monitoring, cost
  and backups.
- [Upgrading](./operator/upgrading.md), and the
  [upgrade notes](./operator/upgrade-notes.md) for each release.

## Reference

- [CLI reference](./reference/cli.md)
- [Scripting the CLI](./reference/cli-scripting.md): output modes, exit statuses
  and environment variables.
- [Actions and workflows reference](./reference/actions.md)
- [Limits](./reference/limits.md)
- [Security model](./security.md)
- [Troubleshooting](./troubleshooting.md)

## Contributing

- [Contributing](./contributing/README.md): setting up, running the checks, and
  writing commits.
- [Architecture](./contributing/architecture.md)
- [Testing](./contributing/testing.md)
- [The Nix conformance suite](./contributing/nix-conformance.md)
- [Measuring what a publication costs](./contributing/measuring-realisation.md)
- [Releasing](./contributing/releases.md)

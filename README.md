# cupboard

cupboard is a [Nix] binary cache that you run on your own Cloudflare account.

- It runs on [Cloudflare Workers] and R2, on the free tier. There are no servers
  to run, and a small deployment costs nothing.
- One deployment hosts many tenants. Each tenant has its own caches, signing
  key, credentials and retention settings, so one deployment can serve every
  team in an organisation, and no tenant can see another's data.
- A tenant can have as many caches as it needs, public or private. A private
  cache needs a username and password, and each cache can have its own.
- CI publishes without storing any secrets. A GitHub Actions job signs in with
  the OIDC token that GitHub already gives it. A trust rule on your tenant says
  which repository, branch or pull request to accept, and what that job may do.
  The signing key never leaves the server.
- Store paths are kept by named retention roots, which can expire. An hourly
  garbage collection deletes everything that no root keeps, so a cache that CI
  fills every day doesn't grow forever.
- The reusable workflow gives every pull request its own cache, reuses those
  builds when the change reaches `main`, and signs build provenance for what it
  builds.
- It's a standard Nix binary cache. Any Nix that can decompress zstd can
  substitute from it, with nothing extra installed.

[Why cupboard](./docs/why-cupboard.md) compares it with Cachix, Attic and a
plain bucket, and lists what it can't do yet.

## Quick start

1. Install the CLI:

   ```sh
   nix profile add github:underwhelmingperformance/cupboard
   ```

   There are also prebuilt archives on the
   [releases page](https://github.com/underwhelmingperformance/cupboard/releases).
   [Installing the CLI](./docs/installing.md) covers both, including how to
   verify a release.

2. In the Cloudflare dashboard, enable R2, create a bucket called
   `cupboard-blobs`, and create an R2 API token that can read and write it. Then
   deploy:

   ```sh
   cupboard init --instance-name cupboard
   ```

   `init` signs you in to Cloudflare through your browser, creates the Workers
   and their storage, makes you the deployment's operator, and creates your
   first tenant. It finishes by printing the tenant's read credential and the
   lines to add to `nix.conf`.
   [Deploying cupboard](./docs/operator/deploying.md) explains each step and
   each choice.

3. Push something:

   ```sh
   cupboard push https://cupboard.example.workers.dev/t/acme ./result
   ```

4. Add the lines that `init` printed to `nix.conf`.
   [Using a cache](./docs/use/nix-clients.md) shows where they go on NixOS,
   nix-darwin, Home Manager and plain Nix installs.

## Publishing from GitHub Actions

First, add the trust rules and reuse view for the repository to your tenant:

```sh
cupboard github setup https://cupboard.example.workers.dev/t/acme \
  --repo acme/app \
  --workflow-ref 'underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@refs/tags/v*'
```

Then add a workflow to the repository that calls cupboard's:

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened, closed]
  push:
    branches: [main]

jobs:
  publish:
    permissions:
      attestations: write
      contents: read
      id-token: write
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@vX.Y.Z
    with:
      url: https://cupboard.example.workers.dev/t/acme
      preset: pull-request-and-branch
      trusted-public-key: cupboard-acme-1:...
```

Every pull request now builds the flake's outputs into its own cache, and every
push to `main` publishes to the default cache, reusing the pull request's builds
where they match. The [quickstart](./docs/ci/quickstart.md) has the complete
workflow file, which also skips pull requests from forks and cancels a pull
request's previous run when a new commit arrives.

## How it's built

The control plane is one Worker with a D1 database. Each tenant is a Durable
Object, which keeps the tenant's narinfos, roots, keys and trust rules in its
own SQLite database. NARs and attestations are in R2, stored once however many
tenants publish them. R2 doesn't charge for egress, so serving builds costs
storage and requests, not bandwidth. An hourly cron job runs garbage collection
and key retirement. [Architecture](./docs/contributing/architecture.md) goes
through it in detail.

## Status

cupboard is pre-1.0. Releases are numbered `v0.0.x`, and a release can change
the format of stored data. When one does, upgrading runs a staged migration, and
once tenants have migrated you can't roll back.
[Why cupboard](./docs/why-cupboard.md) compares it with the alternatives and
lists the things it can't do yet.

## Documentation

[The documentation index](./docs/README.md) lists every page. The pages to start
with are:

- [Using a cache](./docs/use/nix-clients.md), if someone has set up a cache for
  you.
- [Administering a tenant](./docs/admin/README.md), if you manage a tenant's
  caches, keys and access.
- [Publishing from GitHub Actions](./docs/ci/quickstart.md).
- [Deploying cupboard](./docs/operator/deploying.md), if you run the deployment.
- [Contributing](./docs/contributing/README.md).

## Security

To report a vulnerability, see the [security policy](./SECURITY.md). The
[security model](./docs/security.md) describes who cupboard trusts and how
tenants are kept apart.

## Licence

cupboard is licensed under the
[GNU Affero General Public License v3.0 or later](./COPYING).

[Nix]: https://nixos.org
[Cloudflare Workers]: https://workers.cloudflare.com

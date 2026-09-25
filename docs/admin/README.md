# Administering a tenant

A tenant is your own binary cache service inside a cupboard deployment. It has
its own URL, such as `https://cupboard.example.workers.dev/t/acme`, its own
caches, and its own signing key.

You're a tenant administrator if the deployment's operator made you the tenant's
owner when they created it, or if another administrator added you. These pages
explain how to run the tenant day to day.

## Getting started

1. [Install the CLI](../installing.md) and [sign in](./signing-in.md).
2. Push something to the default cache:

   ```sh
   cupboard push https://cupboard.example.workers.dev/t/acme ./result
   ```

3. Set up your machines to download from the cache. See
   [Using a cache](../use/nix-clients.md).
4. Decide how long store paths should be kept, before they start to pile up. See
   [Retention](./retention.md).
5. Set up publishing from CI. See the [CI quickstart](../ci/quickstart.md).

[Concepts](../concepts.md) explains the terms that these pages use.

## Finding the right page

| To do this                                           | Read                                      |
| ---------------------------------------------------- | ----------------------------------------- |
| Sign in with the CLI                                 | [Signing in](./signing-in.md)             |
| Create caches, make them private, set their priority | [Caches](./caches.md)                     |
| Push store paths from your own machine               | [Pushing](./pushing.md)                   |
| Decide how long store paths are kept                 | [Retention](./retention.md)               |
| Add other administrators, and let CI jobs publish    | [Who can use your tenant](./access.md)    |
| Replace the tenant's signing key or access-token key | [Keys](./keys.md)                         |
| Publish from GitHub Actions                          | [CI quickstart](../ci/quickstart.md)      |
| See what's stored and how much space it takes        | [Caches](./caches.md#seeing-whats-stored) |

## What only the operator can do

Some things are managed by the deployment's operator, not by tenant
administrators. Ask the operator if you need any of these:

- Read credentials for private caches. Only the operator can issue or replace
  them. See [Read credentials](../operator/tenants.md#read-credentials).
- A change to the tenant's storage quota.
- Suspending or removing the tenant.

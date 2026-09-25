# Limits

This page lists cupboard's fixed limits in one place. Each section links to the
page that explains the feature.

## Store paths

| Limit                            | Value          |
| -------------------------------- | -------------- |
| Size of a NAR before compression | 4 GiB          |
| Size of an attestation bundle    | 1 MiB          |
| References from one store path   | 10,000         |
| Length of a store path           | 512 characters |
| NAR compression                  | zstd only      |

## Names

| Name                                     | Rules                                                                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Tenant slug, cache name, reuse view name | 1 to 63 characters: lower-case letters, digits, `.`, `_` and `-`. Must start with a letter or digit.                           |
| Root name                                | 1 to 256 characters, with no control characters.                                                                               |
| Instance name                            | Up to 63 characters: lower-case letters, digits and hyphens, not at the start or end. Can't be changed after the first deploy. |

A tenant slug can't be used again, even after the tenant has been removed.

## Retention

See [Retention](../admin/retention.md).

| Limit                              | Value                                                                      |
| ---------------------------------- | -------------------------------------------------------------------------- |
| Targets in one root                | 149. Run roots have no limit.                                              |
| Root TTL                           | 1 second to 3,650 days                                                     |
| Grace period                       | 0 seconds to 3,650 days                                                    |
| Root prefix overrides in one cache | 4,096                                                                      |
| How often garbage collection runs  | At least every 6 hours for each active tenant. The job itself runs hourly. |
| When stored NAR files are deleted  | At least 70 minutes after the last store path that uses them is removed    |

## Reuse views

See [Reuse views](../ci/reuse-views.md).

| Limit                                          | Value                                                          |
| ---------------------------------------------- | -------------------------------------------------------------- |
| Selectors in one view                          | 1 to 32                                                        |
| Different NARs for the same path across a view | 16. With more, the view reports that it doesn't have the path. |
| Default priority                               | 50. Caches default to 40.                                      |

## Pushing

See [Pushing store paths](../admin/pushing.md).

| Limit                                                 | Value                                                   |
| ----------------------------------------------------- | ------------------------------------------------------- |
| Uploads that the CLI runs at once                     | 6 by default. Change it with `--upload-concurrency`.    |
| Time the CLI waits for the tenant to accept an upload | 10 minutes by default. Change it with `--wait-timeout`. |
| Time the CLI waits for the tenant to verify an upload | 10 minutes by default. Change it with `--wait-timeout`. |
| Paths in one `confirm` request                        | 1,000. The CLI splits larger sets.                      |
| Commit sessions open at once for one tenant           | 256                                                     |

## Tokens and sessions

See [Signing in](../admin/signing-in.md) and
[Trust rules](../ci/trust-rules.md).

| Token                                                | Lifetime                         |
| ---------------------------------------------------- | -------------------------------- |
| Tenant access token for an administrator             | 10 minutes. The CLI renews it.   |
| Tenant access token for a CI job                     | 15 minutes. It can't be renewed. |
| Session, which the CLI uses to renew tokens          | 30 days from when you signed in  |
| Operator access token                                | 10 minutes                       |
| Old access-token key or control key after a rotation | Retired after about 20 minutes   |

## Deployment

See [Deploying cupboard](../operator/deploying.md) and
[Running a deployment](../operator/running.md).

| Limit                                       | Value                                                                                         |
| ------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Calls to Cloudflare services in one request | 1,000 on Workers Free, and 10,000 on Workers Paid                                             |
| Tenants maintained by each hourly run       | 100                                                                                           |
| Tenants removed by each hourly run          | 10                                                                                            |
| Tenants woken to migrate by each hourly run | 20                                                                                            |
| Tenant storage quota                        | Unlimited by default. The operator can set one, but not below what the tenant already stores. |

## CI

See [The flake publish workflow](../ci/flake-publish.md).

| Limit                                                 | Value                                                                    |
| ----------------------------------------------------- | ------------------------------------------------------------------------ |
| Cohort jobs in one run                                | 256                                                                      |
| Job time limits                                       | 10 minutes to configure, 30 minutes to plan, 180 minutes for each cohort |
| Outputs of one target, or components of an aggregate  | 149                                                                      |
| Cohort label                                          | Up to 100 printable ASCII characters, with no spaces                     |
| Paths in one attestation with `subject-grouping: run` | 1,024                                                                    |
| Oldest release that the actions can install           | `v0.0.19`                                                                |

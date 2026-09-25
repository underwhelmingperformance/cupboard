# Private caches in CI

The [quickstart](./quickstart.md) assumes anyone can read your caches. This page
explains how to change that setup so the pull-request caches and the reuse view
are private. You can make the default cache private too, if you like.

## Getting read credentials

Only the deployment's operator can issue
[read credentials](../use/private-caches.md#read-credentials). Ask them for:

- the tenant read credential, which the workflow needs for the reuse view;
- a cache read credential for each cache that the workflow publishes to, if that
  cache has one of its own.

Store each user name and password as a repository or environment secret.

## Configuring the tenant

Pass the tenant read credential to `cupboard github setup`. The reuse view that
it creates is then private. In this example, the shell variables `read_user` and
`read_password` contain the credential:

```sh
cupboard github setup https://cupboard.example.workers.dev/t/acme \
  --repo acme/app \
  --workflow-ref 'underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@refs/tags/v*' \
  --read-user "$read_user" --read-password "$read_password"
```

A reuse view only includes caches that are public or private to match the view
itself. So a public view never serves a private pull-request cache.
`cupboard github check` tells you if the view and the existing pull-request
caches don't match.

If you want the default cache to be private too, change it:

```sh
cupboard cache set-access https://cupboard.example.workers.dev/t/acme \
  --access private
```

## Passing the credentials to the workflow

The workflow takes two pairs of secrets. Each pair is a user name and password,
used to read a different place:

| Secrets                                              | Used to read                                                                                   |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `destination_read_user`, `destination_read_password` | The cache that the run publishes to: the pull request's cache, or the default cache on `main`. |
| `fallback_read_user`, `fallback_read_password`       | The reuse view. This always takes the tenant read credential.                                  |

Add them to the job that calls the workflow:

```yaml
jobs:
  publish:
    # ...as in the quickstart...
    with:
      url: https://cupboard.example.workers.dev/t/acme
      preset: pull-request-and-branch
      trusted-public-key: cupboard-acme-1:...
    secrets:
      destination_read_user: ${{ secrets.CUPBOARD_READ_USER }}
      destination_read_password: ${{ secrets.CUPBOARD_READ_PASSWORD }}
      fallback_read_user: ${{ secrets.CUPBOARD_READ_USER }}
      fallback_read_password: ${{ secrets.CUPBOARD_READ_PASSWORD }}
```

For each pair that you use, supply both the user name and the password.

### How the preset uses the credentials

With the preset, two more things apply.

First, `fallback_read_user` decides whether new pull-request caches are private.
If you set it, they're created private. If you don't, they're created public. If
a pull request's cache already exists and doesn't match, the run fails. Change
the cache with `cupboard cache set-access`, or remove it.

Second, the same destination secrets are used by pull-request runs and by `main`
runs, so they have to work for both caches. Pull-request caches don't have
credentials of their own, so the tenant read credential works for them. If your
default cache has its own cache read credential, the tenant read credential
won't work for it. In that case, choose the secret based on the event. For
example:

```yaml
destination_read_password:
  ${{ github.event_name == 'pull_request' && secrets.TENANT_READ_PASSWORD ||
  secrets.MAIN_READ_PASSWORD }}
```

### When a wrong credential is noticed

If the run uses a reuse view, the workflow checks both pairs against the caches
before it publishes anything. Otherwise, a wrong destination pair is only
noticed when a cohort job first reads the cache, and the run fails at that
point.

## Reading other private caches

A run can also download from private caches that it doesn't publish to. For
example, another tenant's cache might have a private dependency. List these in
the `private_substituters` secret, one URL per line, with the credential in the
URL:

```yaml
secrets:
  private_substituters: >-
    https://cupboard:${{ secrets.OTHER_CACHE_PASSWORD
    }}@cupboard.example.workers.dev/t/acme/cache/deps
```

The workflow adds these to Nix in the jobs that evaluate and build the targets.
They don't change where the run publishes. That's still decided by `cache` or
`preset`.

Some details:

- Each line can point at any host, and lines for the same host can use different
  passwords.
- Percent-encode any reserved characters in the user name and password.
- Give Nix each cache's public key, using `trusted-public-key` or `nix-config`.
- Remote builders are set up separately. See
  [Building elsewhere](./building-elsewhere.md).

## Attestations for private caches

When the destination cache is private, the workflow signs attestations in a way
that keeps them from being published outside the cache:

- Each attestation covers only one path.
- It has a timestamp instead of an entry in a public transparency log.
- It isn't uploaded to GitHub.

[Attestations for private caches](./attestation.md#private-caches) explains what
they still reveal.

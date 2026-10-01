# Private caches in CI

The [quickstart][quickstart] uses public caches. A GitHub Actions job can also
read a private destination cache and reuse view without a stored read password.
The job exchanges its GitHub OIDC identity token for a short-lived Cupboard read
token for the required resources. Trust rules authorise these reads separately
from publication.

[quickstart]: ./quickstart.md

## Choose the cache access

For the `pull-request-and-branch` preset, a new pull-request cache inherits the
tenant's default cache access. Set `cache-access-mode: private` when the default
cache is public but pull-request caches should be private. An existing cache
keeps its access; an explicit mode that disagrees with it fails. The reuse view
must have the same access as the pull-request caches. Adding or removing a
secret does not change these access modes.

```yaml
jobs:
  publish:
    # ...as in the quickstart...
    with:
      url: https://cupboard.example.workers.dev/t/acme
      preset: pull-request-and-branch
      cache-access-mode: private
      trusted-public-key: cupboard-acme-1:...
```

Pass the same access mode when configuring the tenant:

```sh
cupboard github setup https://cupboard.example.workers.dev/t/acme \
  --repo acme/app \
  --workflow-ref 'underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@refs/tags/v*' \
  --cache-access-mode private
```

`github setup` configures the reuse view and trust rules for the selected
access. If a view or pull-request cache already exists with different access,
the command reports the mismatch instead of changing it. To change a cache, use
`cupboard cache set-access`. To replace a view, pass its full definition to
`cupboard reuse-view set`, including its selector and current priority:

```sh
cupboard reuse-view set https://cupboard.example.workers.dev/t/acme \
  pull-requests-123456 --access private --select prefix:gh-123456-pr- \
  --priority 50
```

Here `123456` is the repository ID. Check the view's priority with
`cupboard reuse-view list` before replacing it. Run `cupboard github setup`
again, then run `cupboard github check` against the calling workflow. The
default cache has its own access mode and read grant for branch runs.

When `publish: none`, a pull-request run reads from the tenant's default cache.
It neither creates nor removes a pull-request cache, and `cache-access-mode`
does not change the selected default cache. The run can substitute from an
existing baseline without a cache-creation grant.

## How the workflow reads

Public resources remain readable without a content-read grant or a matching CI
trust rule. Setup keeps public read-only operations anonymous. When a
destination challenges, setup acquires access for the configured destination and
reuse view before validating their access modes and priorities.

With `--github-oidc`, `cupboard run` sends the exact configured targets to the
tenant's token endpoint. The server requires content-read authority for existing
private resources. For public resources, the server includes a permitted
content-read grant but otherwise omits that grant. For an absent destination,
publication authority permits a metadata-only read token. The token authorises
the absence response without creating a cache or granting private content
access. The first push still creates a named destination implicitly.

Every read-acquisition token expires after 15 minutes and has no refresh token.
The wrapper repeats OIDC acquisition and exchange while the command runs. It
writes the credential to a private netrc file for Nix. Direct HTTP readers use
the current credential for each request. The file is removed when the command
finishes. Without `--github-oidc`, the wrapper runs the child with its existing
configuration; read failures are reported by the child. The audience, resource
and metadata options require `--github-oidc`. Explicit OIDC acquisition replaces
an incidental netrc credential for the same deployment host. An explicit
credential in a selected substituter URL conflicts with OIDC content access.
Explicit OIDC acquisition requires `id-token: write` and a matching trust rule,
including when the requested resources are public.

Setup validates `cache-access-mode` against authenticated configuration facts.
For an absent destination, the facts describe the tenant's current first-write
defaults. This is a configuration-time check. Another writer or a later change
to the tenant default can change the cache's eventual creation settings.

The workflows install Nix in single-user mode on the GitHub runner. An
independently installed multi-user Nix daemon must trust the runner user before
it accepts the job's temporary `netrc-file` setting. A remote `ssh-ng` store
uses its own Nix configuration and credentials for substitutions that it
performs; the runner's temporary netrc file stays on the runner. Configure
private substituters on the remote daemon separately. See [Building
elsewhere][building-elsewhere].

[building-elsewhere]: ./building-elsewhere.md

`cupboard run` can include additional caches from the same tenant in one read
session. Repeat `--read-cache` for each cache. The combined request accepts up
to sixteen distinct resources, including at most one reuse view. Every resource
must be authorised by the same trust rule. Configure the additional substituter
URLs and trusted public keys in Nix separately:

```sh
cupboard run https://cupboard.example.workers.dev/t/acme/cache/builds \
  --github-oidc --reuse-view prior \
  --read-cache https://cupboard.example.workers.dev/t/acme/cache/falcon \
  -- nix build .#app
```

Additional resources must belong to the selected tenant. Use separate commands
for other tenants because netrc credentials apply to a whole host.

## Optional static read credentials

You can continue to pass an operator-issued username and password. A supplied
static pair takes precedence for its resource. Cupboard does not switch to OIDC
after the cache rejects that pair. A failed direct read reports the refusal; Nix
may build a path that it could not substitute. See [Read
credentials][static-reads] for issuing and protecting static credentials.

[static-reads]: ../use/private-caches.md#read-credentials

The flake workflow accepts these optional secrets:

| Secrets                                              | Use                                                                                                            |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `read_user`, `read_password`                         | Default static pair for the selected cache and reuse view. A private view requires the tenant read credential. |
| `destination_read_user`, `destination_read_password` | Override for the selected destination cache when it needs a different static credential.                       |
| `fallback_read_user`, `fallback_read_password`       | Deprecated aliases for the default pair.                                                                       |

Supply both values in each pair that you use. If both the default pair and its
deprecated alias are supplied, they must match. The destination override applies
to the cache that the run selects. For a read-only pull-request run, that is the
default cache.

For example, the tenant read credential can read both the default cache and a
private reuse view:

```yaml
secrets:
  read_user: ${{ secrets.CUPBOARD_READ_USER }}
  read_password: ${{ secrets.CUPBOARD_READ_PASSWORD }}
```

If a destination uses its own credential, add the matching destination pair. The
pair applies to both branch and pull-request runs, so use event-specific secrets
if their selected caches require different credentials.

## Reading other private caches

The `private_substituters` secret lists additional private cache URLs, one per
line, with a static credential in each URL. These caches may belong to another
tenant. The workflow adds them to Nix without changing the publication
destination:

```yaml
secrets:
  private_substituters: >-
    https://cupboard:${{ secrets.OTHER_CACHE_PASSWORD
    }}@cupboard.example.workers.dev/t/partner/cache/deps
```

Percent-encode reserved characters in the username and password. Supply each
cache's trusted public key through `trusted-public-key` or `nix-config`. A
remote store needs independent access to these substituters.

## Attestations for private caches

When the destination is private, the workflow signs attestations without
publishing them outside that cache. Each attestation covers one path, uses a
timestamp instead of a public transparency-log entry, and is not uploaded to
GitHub. [Attestations for private caches][private-attestations] explains what
they can still reveal.

[private-attestations]: ./attestation.md#private-caches

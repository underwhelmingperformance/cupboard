# Private caches in CI

The [quickstart][quickstart] uses public caches. A GitHub Actions job can also
read a private destination cache and reuse view without a stored secret. The job
exchanges its GitHub OIDC identity token for a short-lived Cupboard read token
for the required resources. Trust rules authorise these reads separately from
publication.

[quickstart]: ./quickstart.md

## Choose the cache access

For the `pull-request-and-branch` preset, a new pull-request cache inherits the
tenant's default cache access. Set `cache-access-mode: private` when the default
cache is public but pull-request caches should be private, or
`cache-access-mode: public` when the default is private but pull-request caches
should be public. An existing cache keeps its access; an explicit mode that
disagrees with it fails. The reuse view must have the same access as the
pull-request caches. Adding or removing a secret does not change these access
modes.

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
access. Without `--cache-access-mode`, it uses the default cache's access.
`--access-key` authenticates metadata queries and does not select access. If a
view or pull-request cache already exists with different access, the command
reports the mismatch instead of changing it. To change a cache, use
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
destination challenges, setup acquires one session for all configured caches
without access keys and the configured reuse view before validating their access
modes and priorities.

With `--github-oidc`, `cupboard run` sends the exact configured targets to the
tenant's token endpoint. The server requires content-read authority for existing
private resources. For public resources, the server includes a permitted
content-read grant but otherwise omits that grant. For an absent destination,
publication authority permits a metadata-only read token. The token authorises
the absence response without creating a cache or granting private content
access. The first push still creates a named destination implicitly.

Every read-acquisition token expires after 15 minutes and has no refresh token.
The wrapper repeats OIDC acquisition and exchange for the same resource union
while the command runs. Add other caches in the tenant with repeatable
`--read-cache <cache-url>` options. When an access key reads a destination cache
that does not exist yet, setup requests `--read-cache-metadata <cache-url>` for
it, and `cupboard run` writes the access key to its netrc file. These metadata
resources do not become content resources in downstream action sessions. A cache
added with `--read-cache-if-permitted <cache-url>` is optional, unless a
required option also lists it. A public cache is readable without a grant, so
the session describes it as it does a required public cache. Any other optional
cache is included only when a trust rule permits it. Otherwise the session
reports it as unavailable without saying whether it exists, and the command runs
without it. Setup requests a reference source this way. Setup also omits a
reference that its probes show does not exist. A session accepts up to sixteen
distinct resources, including at most one reuse view. It writes the credential
to a private netrc file for Nix. Direct HTTP readers use the current credential
for each request. The file is removed when the command finishes. Without
`--github-oidc`, the wrapper runs the child with its existing configuration;
read failures are reported by the child. The audience, resource and metadata
options require `--github-oidc`. Explicit OIDC acquisition replaces an
incidental netrc credential for the same deployment host. An explicit credential
in a selected substituter URL conflicts with OIDC content access. Explicit OIDC
acquisition requires `id-token: write` and a matching trust rule, including when
the requested resources are public.

`cupboard run` forwards the child's input and output and returns the child's
exit status. A missing executable exits 127. OIDC acquisition or renewal exits
77 for refused authority and 75 for temporary failures. Permanent renewal
refusals stop the child immediately; temporary failures retry within the
credential's remaining lifetime. The wrapper stops the child and removes its
temporary credentials when renewal cannot continue.

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
to sixteen distinct resources, including at most one reuse view. Matching trust
rules in the current preferred identity tier can authorise different resources
or actions in the request. Every required action must be permitted; a refused
request receives no partial credential. See [Matching trust
rules][matching-rules]. Configure the additional substituter URLs and trusted
public keys in Nix separately:

[matching-rules]: ./trust-rules.md#when-several-rules-match

```sh
cupboard run https://cupboard.example.workers.dev/t/acme/cache/builds \
  --github-oidc --reuse-view prior \
  --read-cache https://cupboard.example.workers.dev/t/acme/cache/falcon \
  -- nix build .#app
```

The setup action and flake workflow accept `read-caches` to add runner
substituters and OIDC read resources without changing the publication
destination. Supply canonical cache URLs from the selected tenant, one per line.
Duplicate URLs are configured once. The sixteen-resource limit includes the
destination caches and reuse view. Additional read caches are separate from
destination access checks and the destination's priority comparison with the
reuse view. A supplied `access-key` conflicts with this input, and a cache with
its own key or a credential in its URL must not be a read cache. Remote builders
still need their own substituter credentials.

`cupboard github check` probes literal `read-caches` URLs and checks
content-read authority for each private cache. Repair adds separate rootless
read grants. Dynamic expressions, invalid URLs and access-key conflicts leave
the job unverified. If the job supplies secret `private_substituters`, the check
cannot compare those URLs with `read-caches`; verify that a cache does not use
both credential sources before configuring its trust rule.

```yaml
with:
  read-caches: https://cupboard.example.workers.dev/t/acme/cache/falcon
```

Resources in the OIDC session must belong to the selected tenant. Other tenants
on the same host need complete credentials, such as their own access keys, in
their substituter URLs, or separate commands and Nix configurations. The session
netrc credential applies to the whole host.

## Access keys

A job can also read with an [access key][access-keys]. A supplied key takes
precedence for its resource. Cupboard does not switch to OIDC after the cache
refuses the key. A failed direct read reports the refusal; Nix may build a path
that it could not substitute.

[access-keys]: ../admin/access.md#access-keys

The flake workflow accepts these optional secrets:

| Secret            | Use                                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `access_key`      | The key for the selected cache. Nix also reads the reuse view with it, and the jobs publish with it in place of the job's OIDC token. |
| `view_access_key` | The key for a private reuse view or reference source, which the plan and cohort steps use to check and publish paths by reference.    |

For example:

```yaml
secrets:
  access_key: ${{ secrets.CUPBOARD_ACCESS_KEY }}
  view_access_key: ${{ secrets.CUPBOARD_VIEW_ACCESS_KEY }}
```

The `access_key` secret applies to the cache that the run selects, on both
branch and pull-request runs. For a read-only pull-request run, that is the
default cache. Give the key a content-read grant for every cache that the runs
select, `view:content-read` for a private reuse view, and the publication grants
that the job's trust rule gives. A key is a long-lived secret, so prefer OIDC
when the job can use it. See [Publishing without OIDC](./access-keys.md).

When a job signs in with OIDC and publishes paths by reference from a private
view, `cupboard push` also requests `view:content-read` for its push token. For
a private cache supplied through `--reference-source` or a reference manifest,
it requests `cache:content-read`. The run's trust rule must permit the requested
grant. `cupboard github check` reports a missing view grant for a publishing
job, and its guided repair adds it. See [Matching trust rules][matching-rules]
and [publishing by reference][by-reference].

[by-reference]: ./how-it-works.md#the-four-groups-in-the-log

## Reading other private caches

The `private_substituters` secret lists additional private cache URLs, one per
line, with a credential, such as an access key, in each URL. These caches may
belong to another tenant. The workflow adds them to Nix without changing the
publication destination:

```yaml
secrets:
  private_substituters: >-
    https://cupboard:${{ secrets.PARTNER_ACCESS_KEY
    }}@cupboard.example.workers.dev/t/partner/cache/deps
```

Percent-encode reserved characters in the username and password. Supply each
cache's trusted public key through `trusted-public-key` or `nix-config`. A
remote store needs independent access to these substituters.

Nix [uses optional netrc authentication][nix-filetransfer], which [prefers a
complete credential pair in the URL][curl-netrc]. An explicit URL pair can
therefore read another tenant on the same deployment hostname without using the
publication tenant's read-session credential. These substituters remain outside
the OIDC resource request. A second tenant that needs a different netrc pair on
that hostname requires a separate job and Nix configuration.

[nix-filetransfer]:
  https://github.com/NixOS/nix/blob/2.34.7/src/libstore/filetransfer.cc#L516
[curl-netrc]: https://curl.se/libcurl/c/CURLOPT_NETRC.html

## Attestations for private caches

When the destination is private, the workflow signs attestations without
publishing them outside that cache. Each attestation covers one path, uses a
timestamp instead of a public transparency-log entry, and is not uploaded to
GitHub. [Attestations for private caches][private-attestations] explains what
they can still reveal.

[private-attestations]: ./attestation.md#private-caches

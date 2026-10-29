# Nix installation

This internal action installs single-user Nix on GitHub-hosted Linux and macOS
runners. Workflows reference it as `$/actions/install-nix`, so the installer
comes from the same Cupboard revision as the workflow, including when another
repository calls a reusable workflow.

The installer is adapted from [nix-quick-install-action v35][upstream], revision
`9f63be77f412a248c9d9a65a4c82cf066cdf8f0c`, under the [Apache 2.0
licence][licence]. The upstream project still builds and distributes the Nix
archives.

Local changes:

- Spotlight configuration emits a warning on failure. Volume creation and
  ownership changes must succeed.
- `versions.env` pins the archive release, the Nix version and the SHA-256
  digest of the archive for each supported system. The installer downloads the
  archive to a temporary file and extracts it into `/nix` only if its digest
  matches the pin. There are no inputs for other versions, archive locations,
  tmpfs or additional `nix.conf` contents. The workflows configure Nix after
  installation.
- The job's GitHub token goes into `github-access-token.conf`, with mode `0600`,
  beside the user's `nix.conf`, and `nix.conf` includes that file. The installer
  removes the `access-tokens = github.com=...` lines that earlier releases wrote
  to `nix.conf`. A second run in the same job replaces the file and adds no
  second include.
- The token also goes into a `machine github.com` entry in `~/.netrc`. Nix
  fetches Git repositories by running `git`, and Git's HTTPS transport reads
  `~/.netrc`. Nix's own downloads read it only when the `netrc-file` setting
  selects it. The installer replaces any existing `machine github.com` entry,
  keeps the other entries, and writes the file with mode `0600` through a
  temporary file and a rename. It treats each line whose first word is `machine`
  or `default` as the start of an entry.
- Only the four runner systems in `packages/nix/src/nix-systems.json` are
  supported. The pinned Nix version enables flakes without a version check.
- Database registration makes at most three attempts and reports exhaustion
  explicitly. HTTP download failures are fatal.

On Linux, the installer enables KVM when available and warns if setup fails.

To update Nix, select a version available in the upstream archive release and
update the version pins in `versions.env` as needed. The installer rejects an
archive whose digest differs from its pin, so a change to the version pins must
also update the digest of each system's archive. Renovate does not manage
`versions.env`, so make both changes by hand. GitHub lists the digest of each
release asset:

```sh
(
  . actions/install-nix/versions.env
  gh release view "$archive_release" --repo nixbuild/nix-quick-install-action \
    --json assets \
    --jq ".assets[] | select(.name | startswith(\"nix-$nix_version-\"))
      | [.name, (.digest | ltrimstr(\"sha256:\"))] | @tsv"
)
```

Check those values against your own download of each archive. Review upstream
installer changes and run the action tests and CI on all four systems. Keep the
remote-store fixture's Nix version in the same release series.

Record the digests only when the version pins change. The archive for an
unchanged `nix_version` and `archive_release` always has the same digest, so a
mismatch without a version change means that the upstream release asset has
changed. The upstream release is mutable, and GitHub's digest list changes with
the asset, so neither that list nor a new download can confirm the new value.
Investigate the change, and do not update the pin.

If a digest is missing or does not match the downloaded archive, the installer
reports an error and stops before it prepares the store or extracts anything, so
CI fails on every system with a stale pin.

[upstream]:
  https://github.com/nixbuild/nix-quick-install-action/tree/9f63be77f412a248c9d9a65a4c82cf066cdf8f0c
[licence]: ./LICENSE

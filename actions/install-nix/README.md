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
- `versions.env` pins the archive release and Nix version. There are no inputs
  for other versions, archive locations, tmpfs, KVM or additional `nix.conf`
  contents. The workflows configure Nix after installation.
- Only the four runner systems in `packages/nix/src/nix-systems.json` are
  supported. The pinned Nix version enables flakes without a version check.
- Database registration makes at most three attempts and reports exhaustion
  explicitly. HTTP download failures are fatal.

To update Nix, select a version available in the upstream archive release and
update both pins in `versions.env` as needed. Review upstream installer changes
and run the action tests and CI on all four systems. Keep the remote-store
fixture's Nix version in the same release series.

[upstream]:
  https://github.com/nixbuild/nix-quick-install-action/tree/9f63be77f412a248c9d9a65a4c82cf066cdf8f0c
[licence]: ./LICENSE

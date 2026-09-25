# Building on other machines

A GitHub-hosted runner has limited disk space, memory and CPU. If your flake's
builds need more than that, the flake publish workflow can run them somewhere
else. There are two ways to do this, and you can use only one of them in a
workflow:

- With remote builders, the runner still runs Nix, but Nix sends individual
  derivations to other machines to build. This is Nix's standard distributed
  build feature.
- With a remote store, each cohort builds entirely in a Nix store on another
  machine. The build outputs never touch the runner's disk.

Both use SSH. You supply the private key as a secret, and you list the host key
of each machine so that the runner can verify it is connecting to the right one.

## Remote builders

Set the `builders` input to a Nix `builders` specification. This is the same
format as the `builders` setting in `nix.conf`, written on one line:

```yaml
with:
  url: https://cupboard.example.workers.dev/t/acme
  preset: pull-request-and-branch
  builders: ssh://builds.example.com x86_64-linux,aarch64-linux - 100 1
  builder-known-hosts: |
    builds.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA...
secrets:
  builder_ssh_key: ${{ secrets.BUILDER_SSH_KEY }}
```

Only targets with `remote = true` in the manifest send their builds to these
machines. The plan job also gets the builders, because evaluating the flake can
require building something.

When you write the specification:

- Separate several builders with semicolons.
- Put `-` in the SSH key column, and don't add an `ssh-key` parameter to any
  builder URI. Supply the key as the `builder_ssh_key` secret instead. The
  workflow uses only that key, so the specification can't pick up some other key
  on the runner.
- List every builder's host key in `builder-known-hosts`. For a builder on a
  port other than 22, write the host as `[host]:port`.

If a builder needs extra SSH settings, put them in the `builder_ssh_config`
secret as `ssh_config` `Host` blocks. This is a secret because some settings
contain credentials. For example, nixbuild.net takes its token through `SetEnv`:

```yaml
secrets:
  builder_ssh_config: |
    Host eu.nixbuild.net
      User authtoken
      PreferredAuthentications none
      SetEnv NIXBUILDNET_TOKEN=${{ secrets.NIXBUILD_TOKEN }}
```

Every setting must be inside a `Host` block. The workflow accepts settings that
describe how to reach and talk to the host: `HostName`, `User`, `Port`,
transport tuning, algorithms, keep-alive settings and `SetEnv`. It refuses
settings that run commands, use proxies, forward connections, load other
identities, share connections, turn on verbose logging, or use `Include` or
`Match`.

The workflow doesn't change `max-jobs`, so the runner can still build locally.
The runner builds a derivation itself when every builder declines it, or when
the derivation sets
[`preferLocalBuild`](https://nix.dev/manual/nix/latest/language/advanced-attributes#adv-attr-preferLocalBuild).

## A remote store

Set the `store` input to an `ssh-ng://` store URI. Every cohort then plans,
builds and publishes using that store:

```yaml
with:
  url: https://cupboard.example.workers.dev/t/acme
  root-prefix: github:acme/app/main
  store: ssh-ng://nix@store.example.com
  store-known-hosts: |
    store.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA...
secrets:
  store_ssh_key: ${{ secrets.NIX_STORE_SSH_KEY }}
```

The runner evaluates the flake and copies the derivations that the store needs.
The Nix daemon on the store machine builds them. The job then streams the
outputs from the store to cupboard. The runner's disk only needs room for the
evaluation.

A remote store behaves differently from building on the runner in a few ways:

- Uploads start when the whole build finishes. On the runner, each output is
  uploaded as soon as it's built.
- The job doesn't check the store's free disk space, because it can't measure
  that space over SSH.
- The planner can't tell whether the store will download a dependency or build
  it, so it prepares for both. It may therefore copy a dependency to the store
  even though the store doesn't need it.
- The job must know every output path before it starts building. Floating
  content-addressed derivations don't have fixed output paths, so the workflow
  refuses them. For the same reason, every target needs `rootDrvPath`, including
  best-effort targets. Build these targets on the runner instead.

To set up the connection:

- List the store's host key in `store-known-hosts`. If the store uses port 22,
  you can put the key in the URI instead, with Nix's
  `base64-ssh-public-host-key` parameter. Doing that also fixes the port at 22.
- Supply the private key as the `store_ssh_key` secret. Don't put it in the URI
  as an `ssh-key` parameter.
- `store_ssh_config` accepts the same settings as `builder_ssh_config`.

If you don't supply `store_ssh_key`, the job fails. It doesn't fall back to the
runner's SSH agent or default keys. On a self-hosted runner that is dedicated to
this job, you can let the job use the runner's own SSH identity by setting
`store-ambient-identity: true`. Don't do this on a runner that has other SSH
keys on it.

## Private flake inputs

If your flake has private inputs fetched over SSH, such as `git+ssh://` URLs,
supply an SSH key for them as the `input_ssh_key` secret. List the host key of
every host that serves them in `input-known-hosts`. Inputs fetched over HTTPS,
such as `github:` references, don't use this key.

The workflow keeps the input key and its host keys separate from the builder and
store connections, so builders and the remote store never receive them.

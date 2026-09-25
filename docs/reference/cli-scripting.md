# Scripting the CLI

This page explains how to use the `cupboard` CLI from scripts and CI: where it
writes its output, how to read results as JSON, how to handle confirmation
prompts, and what its exit statuses mean. [The CLI reference](./cli.md) lists
every command and option.

## Where output goes

The CLI keeps two kinds of output apart:

- Data goes to standard output. Only two commands print data: `pubkey` prints
  public keys, and `config` prints `nix.conf` lines. The `--help` and
  `--version` options also print to standard output.
- Everything else goes to standard error. This includes progress messages,
  prompts, warnings, errors and results. For example, the `rule` object that
  `whoami --provider` produces in `json` mode is part of its result event, on
  standard error.

This means you can capture a command's data, or redirect it to a file, without
picking up anything else:

```sh
key=$(cupboard pubkey https://cupboard.example.workers.dev/t/acme)
```

## Output modes

The CLI formats what it writes to standard error in one of three modes:

| Mode       | What it writes                                          |
| ---------- | ------------------------------------------------------- |
| `terminal` | Spinners, prompts and tables of results.                |
| `json`     | One JSON object per line, for each event.               |
| `github`   | GitHub Actions log groups and annotations, and results. |

The CLI picks the first of these that applies:

1. The mode that you pass with `--output-mode`.
2. `terminal`, if `FORCE_COLOR` is set to anything other than `0`.
3. `json`, if `PRE_COMMIT=1`.
4. `github`, if `GITHUB_ACTIONS=true`.
5. `terminal`, if standard error is a terminal.
6. Otherwise, `json`.

### Reading results as JSON

In `json` mode, a command reports its result as an event with
`"event": "result"`. To extract it, redirect standard error into the pipe and
discard standard output:

```sh
cupboard --output-mode json tenant list https://cupboard.example.workers.dev \
  2>&1 >/dev/null | jq -c 'select(.event == "result").data'
```

You can also write results to a file with `--result-file <path>`, in any mode.
The CLI adds one line to the file for each result, in the form
`{"kind": …, "data": …}`. It doesn't write failures to this file.

### Colour

The CLI decides whether to use colour from the terminal. `--colour` and
`--no-colour` override that. The CLI also respects `NO_COLOR`.

## Confirmation prompts

Commands that delete things, such as `cache remove` and `tenant remove`, ask you
to confirm. Pass `--yes` to confirm in advance. This works in every mode.

Without `--yes`, a command only asks when all of these are true:

- it's in `terminal` mode;
- standard input and standard error are both terminals;
- it isn't running in CI.

Otherwise, it exits with status 2 without doing anything.

## Exit status

| Status | Meaning                                                                                                                                                                                 |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0      | Success.                                                                                                                                                                                |
| 1      | A failure that doesn't fit another status. For example, `confirm` found a path missing, `check` found a problem, or the tenant's quota was exceeded.                                    |
| 2      | A usage error. For example, an unknown option, an invalid value, more than 149 targets for one root, or a confirmation needed without `--yes`.                                          |
| 69     | Something that the command needs isn't available.                                                                                                                                       |
| 74     | `build-push` only: the build succeeded, but publishing some paths failed.                                                                                                               |
| 75     | A temporary failure stopped the command. For example, a host couldn't be reached, the server rate-limited the request or returned an error, or a wait timed out. Trying again may work. |
| 77     | Authentication or authorisation failed. This includes an expired session.                                                                                                               |
| 130    | Interrupted with Ctrl-C.                                                                                                                                                                |
| 143    | Terminated.                                                                                                                                                                             |

When the build that `build-push` runs fails, `build-push` exits with the build's
own status. See
[Publishing while a build runs](../admin/pushing.md#publishing-while-a-build-runs).

When some paths in a push fail, `push` chooses its status from the failures:

1. 77, if any path failed authentication.
2. Otherwise 75, if any path failed temporarily.
3. Otherwise 69, if any path was unavailable.
4. Otherwise 1.

`cupboard root ensure` exits with status 0 whether or not it changed the root.

## Environment variables

| Variable                                                                                        | Used for                                                                                                 |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `CUPBOARD_READ_USER`, `CUPBOARD_READ_PASSWORD`                                                  | The tenant read credential, for `config`, `attest verify` and `attest attach`.                           |
| `CUPBOARD_CACHE_CREDENTIALS`                                                                    | Cache read credentials for `config`, as a JSON array.                                                    |
| `GH_TOKEN`, `GITHUB_TOKEN`                                                                      | Access to the GitHub API, for `github setup`, `github check` and the `oidc-trust add-github-*` commands. |
| `ACTIONS_ID_TOKEN_REQUEST_URL`, `ACTIONS_ID_TOKEN_REQUEST_TOKEN`                                | Requesting a GitHub Actions OIDC token for `--github-oidc`. GitHub sets these.                           |
| `CLOUDFLARE_API_TOKEN` or `CF_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`                               | The token and account for `init`. See [Deploying cupboard](../operator/deploying.md).                    |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `CONTROL_KEY_WRAP_SECRET`, `CUPBOARD_SIGNUP_SECRET` | Secrets that `init` installs in the Workers.                                                             |
| `XDG_CONFIG_HOME`                                                                               | Where the CLI stores sessions and your Cloudflare sign-in. The default is `~/.config`.                   |
| `XDG_CACHE_HOME`                                                                                | Where the CLI caches GitHub API responses. The default is `~/.cache`.                                    |
| `XDG_RUNTIME_DIR`, `RUNNER_TEMP`                                                                | Where `build-push` creates its socket.                                                                   |
| `NO_COLOR`, `FORCE_COLOR`, `PRE_COMMIT`, `GITHUB_ACTIONS`, `CI`                                 | Colour, the output mode and prompts, as described above.                                                 |
| `NIX_REMOTE`, `NIX_CONFIG` and Nix's other variables                                            | Finding and configuring the Nix store, in the same way as Nix.                                           |

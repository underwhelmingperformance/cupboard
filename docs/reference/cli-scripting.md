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

`cupboard run` forwards its child's standard input, standard output and standard
error directly. Cupboard's own progress and errors still go to standard error.

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
2. `terminal`, if `FORCE_COLOR` is non-empty and is not `0`.
3. `json`, if `PRE_COMMIT=1`. pre-commit sets this for its hooks.
4. `github`, if `GITHUB_ACTIONS=true`.
5. `terminal`, if standard error is a terminal.
6. Otherwise, `json`.

`cupboard init` is the exception. It always reports its progress in `terminal`
mode.

### Reading results as JSON

In `json` mode, a command reports its result as an event with
`"event": "result"`. To extract it, redirect standard error into the pipe and
discard standard output:

```sh
cupboard --output-mode json tenant list https://cupboard.example.workers.dev \
  2>&1 >/dev/null | jq -c 'select(.event == "result").data'
```

The order of the redirections matters. `2>&1` points standard error at the pipe
first, and then `>/dev/null` discards standard output. In the other order, both
streams would go to `/dev/null`.

You can also write results to a file with `--result-file <path>`, in any mode.
The CLI adds one line to the file for each result, in the form
`{"kind": …, "data": …}`. Error events are not written to this file. A command
can report useful partial results before failing, so the file can contain
results even when the command exits non-zero. For example, `confirm` reports
completed batches before a later request fails, and `init` reports deployed
resources before onboarding finishes.

### Colour

The CLI decides whether to use colour from the terminal. `--colour` and
`--no-colour` override that. The CLI also respects `NO_COLOR`.

## Confirmation prompts

Commands that delete things, such as `cache remove` and `tenant remove`, ask you
to confirm. Pass `--yes` to confirm in advance. This works in every mode.

Without `--yes`, a command only asks when all of these are true:

- it's in `terminal` mode;
- standard input and standard error are both terminals;
- `CI` is not `true`.

Otherwise, it exits with status 2 without doing anything.

## Exit status

| Status | sysexits name    | Meaning                                                                                                                                                                                                                                                                                     |
| ------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0      |                  | Success.                                                                                                                                                                                                                                                                                    |
| 1      |                  | A failure that doesn't fit another status. For example, `confirm` found a path missing, `check` found a problem, or the tenant's storage quota refused an upload (`build-push` exits 74 for that).                                                                                          |
| 2      |                  | A usage error. For example, an unknown option, an invalid value, more than 149 targets in one root update, or a confirmation needed without `--yes`.                                                                                                                                        |
| 69     | `EX_UNAVAILABLE` | Something that the command needs isn't available. For example, `build-push` can't publish outputs from an `ssh-ng` store while the build runs, or `github check` couldn't complete one of its checks.                                                                                       |
| 74     | `EX_IOERR`       | `build-push` only: publishing or setting the root failed, and no more specific status applies.                                                                                                                                                                                              |
| 75     | `EX_TEMPFAIL`    | At least one failure was temporary. See [Retrying](#retrying).                                                                                                                                                                                                                              |
| 77     | `EX_NOPERM`      | Signing in or a permission check failed. For example, you aren't signed in, your session has expired, the credential doesn't grant what the command needs, a GitHub token lacks a permission, or the Nix daemon doesn't list you in `trusted-users` when `build-push` runs a build command. |
| 127    |                  | `run` could not find the child executable. Install the command or pass its full path.                                                                                                                                                                                                       |
| 130    |                  | Interrupted with Ctrl-C (`SIGINT`).                                                                                                                                                                                                                                                         |
| 143    |                  | Terminated with `SIGTERM`.                                                                                                                                                                                                                                                                  |

The sysexits names come from [`sysexits(3)`][sysexits]. Some commands give a
status a more specific meaning, which their `--help` describes.
`cupboard root ensure` exits with status 0 whether or not it changed the root.

When a later `confirm` batch fails, the CLI reports completed batches and keeps
the failure's status. `github setup` also reports the applied configuration
before a trust-rule removal failure. If several removals fail, authority
refusals have priority over temporary failures, followed by other failures.

OAuth token endpoints also use HTTP 400 for refused authority. The CLI uses exit
77 for rejected identities, expired refresh tokens and refused grants. Malformed
token requests or grant details use exit 2. Temporary HTTP failures retain exit
75, including when the response contains an OAuth error.

`cupboard run` returns the child's exit status, or 128 plus the signal number
when a signal terminates the child. SIGINT and SIGTERM received by Cupboard are
forwarded to the child. A child that does not stop within ten seconds is killed.
An OIDC acquisition or renewal failure uses Cupboard's own status: 77 for
refused authority and 75 for a temporary service or malformed token response. A
renewal failure stops the child and removes temporary credentials.

[sysexits]: https://man.freebsd.org/cgi/man.cgi?query=sysexits&sektion=3

`build-push` also passes through the status of the build that it runs, and never
exits 1 for a failure to publish. The pushing page lists
[all of its exit statuses](../admin/pushing.md#exit-statuses).

### Retrying

Status 75 means that at least one failure was temporary, so running the same
command again may succeed or make progress. For example, the CLI exits 75 when
it can't reach the server, when the server responds with 408, 429 or a 5xx
status, when it times out waiting for the server to accept a push or to verify
the uploads, and when the GitHub API rate limit is exhausted.
`github check --fix` is an exception: once it has written a repair, a failure in
a later step of the repair exits 1, even when the failure is temporary.

The server returns 507 when an upload would take the tenant over its storage
quota. That's a 5xx status, but running the command again fails in the same way
until space is freed or the quota is raised, so the CLI exits 1 for it, not 75.
`build-push` exits 74 for it, like any other permanent publishing failure.

When some paths in a push fail, `push` chooses its status from the failures:

1. 77, if any path failed a sign-in or permission check.
2. Otherwise 75, if any path failed temporarily.
3. Otherwise 2, if the server rejected an upload request because it exceeded the
   invocation budget. Split the request at the returned path limit.
4. Otherwise 1.

`build-push` uses the same order while it publishes, but exits 74 in place of 1.
A quota refusal counts as a permanent failure. Because 75 ranks above 1, a push
with one quota refusal and one temporary failure exits 75. Running it again can
publish the path that failed temporarily, but not the path that the quota
refused, so the next run exits 1.

For example, to make up to five attempts at a push, waiting longer between each:

```bash
for attempt in 1 2 3 4 5; do
  cupboard push "$CACHE_URL" "$@" && exit 0
  status=$?
  [ "$status" -eq 75 ] || exit "$status"
  [ "$attempt" -lt 5 ] && sleep $((2 ** attempt))
done
exit 75
```

## Environment variables

| Variable                                                                                     | Used for                                                                                                                                                              |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CUPBOARD_READ_USER`, `CUPBOARD_READ_PASSWORD`                                               | A static read credential for `config`, `attest verify` and `attest attach`. The addressed cache determines which credential it accepts.                               |
| `CUPBOARD_CACHE_CREDENTIALS`                                                                 | Cache read credentials for `config`, as a JSON array.                                                                                                                 |
| `GH_TOKEN`, `GITHUB_TOKEN`                                                                   | Access to the GitHub API, for `github setup`, `github check` and the `oidc-trust add-github-*` commands.                                                              |
| `ACTIONS_ID_TOKEN_REQUEST_URL`, `ACTIONS_ID_TOKEN_REQUEST_TOKEN`                             | Requesting a GitHub Actions OIDC token for `--github-oidc`. GitHub sets these.                                                                                        |
| `CLOUDFLARE_API_TOKEN` or `CF_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`                            | The token and account for `init`. See [Deploying cupboard](../operator/deploying.md).                                                                                 |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `CONTROL_KEY_WRAP_SECRET`, `PUSH_ID_SIGNING_KEY` | Secrets that `init` installs in the Workers. If `CONTROL_KEY_WRAP_SECRET` or `PUSH_ID_SIGNING_KEY` isn't set and the Workers don't have one yet, `init` generates it. |
| `XDG_CONFIG_HOME`                                                                            | Where the CLI stores sessions and your Cloudflare sign-in. The default is `~/.config`.                                                                                |
| `XDG_CACHE_HOME`                                                                             | Where the CLI caches GitHub API responses. The default is `~/.cache`.                                                                                                 |
| `XDG_RUNTIME_DIR`, `RUNNER_TEMP`                                                             | Where `build-push` creates its socket.                                                                                                                                |
| `NO_COLOR`, `FORCE_COLOR`, `PRE_COMMIT`, `GITHUB_ACTIONS`, `CI`                              | Colour, the output mode and prompts, as described above.                                                                                                              |
| `NIX_REMOTE`, `NIX_CONFIG` and Nix's other variables                                         | Finding and configuring the Nix store, in the same way as Nix.                                                                                                        |

`cupboard run` sets `netrc-file` in its child's `NIX_CONFIG` when the command
needs temporary OIDC read access. The child inherits the other Nix settings. The
netrc exists only while the wrapper runs. Do not copy its path into persistent
Nix configuration.

With a local multi-user Nix daemon, the invoking user must be trusted by Nix for
the daemon to accept this `netrc-file` setting. A remote daemon uses its own
credentials and configuration.

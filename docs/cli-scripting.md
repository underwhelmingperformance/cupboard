# Scripting the `cupboard` CLI

This page lists the exit statuses of the `cupboard` CLI and says when a script
should run a command again.

## Exit statuses

| Status | sysexits name    | Meaning                                                                                                                                                                                                                                                                    |
| ------ | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0      |                  | Success.                                                                                                                                                                                                                                                                   |
| 1      |                  | A failure not covered by another exit status.                                                                                                                                                                                                                              |
| 2      |                  | Usage error. This includes a command that needs confirmation when the run is not interactive and `--yes` is not given.                                                                                                                                                     |
| 69     | `EX_UNAVAILABLE` | A required dependency or input is unavailable: for example, `build-push` cannot stream outputs from an `ssh-ng` store, or `github check` could not verify one of its checks.                                                                                               |
| 74     | `EX_IOERR`       | `build-push` publication or retention failed without a more specific exit status.                                                                                                                                                                                          |
| 75     | `EX_TEMPFAIL`    | At least one failure was transient; see [Retrying][retrying].                                                                                                                                                                                                              |
| 77     | `EX_NOPERM`      | Authentication or authorisation failure: for example, the user is not logged in, the credential does not grant the required scope, a GitHub token lacks a permission, or, when `build-push` runs a user command, the Nix daemon does not list the user in `trusted-users`. |
| 130    |                  | Interrupted by `SIGINT`.                                                                                                                                                                                                                                                   |
| 143    |                  | Terminated by `SIGTERM`.                                                                                                                                                                                                                                                   |

The sysexits names come from [`sysexits(3)`][sysexits].

[retrying]: #retrying
[sysexits]: https://man.freebsd.org/cgi/man.cgi?query=sysexits&sektion=3

Some commands give an exit status a more specific meaning, described in their
`--help`. For example, `cupboard check` exits 1 when it finds discrepancies.
`cupboard build-push` is described in the next section.

## `cupboard build-push`

`cupboard build-push` reports build failures and publication failures with
different exit statuses. Preflight checks run before the build. A failed
preflight check exits 69 or 77, except in three cases that exit 1: the Nix
configuration already sets `post-build-hook`, the installation is missing its
hook helper, or no runtime directory gives a hook socket path that is short
enough. Exit status 1 therefore does not always mean that the build command ran.

| Status | Meaning                                                                                                                                                                                                                        |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0      | The build succeeded and every selected path is published.                                                                                                                                                                      |
| 1-n    | The build command failed, and its own exit status passes through. A build killed by a signal exits with 128 plus the signal number. A preflight failure can also exit 1, as described above.                                   |
| 69     | A dependency that the run needs is unavailable, either before the build (for example, an `ssh-ng` store) or during publication.                                                                                                |
| 74     | The build succeeded, but publication or retention failed without a more specific exit status.                                                                                                                                  |
| 75     | The build succeeded, but at least one publication failure was transient.                                                                                                                                                       |
| 77     | An authentication or authorisation failure, either in preflight (for example, a missing retention grant, or a daemon that does not list the user in `trusted-users` when the build runs a user command) or during publication. |
| 130    | Interrupted by `SIGINT`.                                                                                                                                                                                                       |
| 143    | Terminated by `SIGTERM`.                                                                                                                                                                                                       |

`build-push` never exits 1 for a publication failure, so a script can tell a
publication failure from a build command that exited 1.

## Retrying

Exit status 75 means that at least one failure was transient, so running the
same command again may succeed or may make progress. For example, the CLI exits
75 when it cannot reach the server, when the server responds with 408, 429 or
5xx, when it times out waiting for commit capacity or for uploads to become
servable, and when the GitHub API rate limit is exhausted. `github check --fix`
is an exception: once it has written a repair, it exits 1 for any later failure,
including a transient one.

The server returns 507 when the cache is over its storage quota. That status is
5xx, but a re-run fails in the same way until space is freed or the quota is
raised, so the CLI does not exit 75 for it. An admin command that receives a 507
exits 1.

When some paths of a push fail, `cupboard push` exits 77 if any failure was an
authentication or authorisation failure, otherwise 75 if any was transient,
otherwise 69 if any was caused by an unavailable dependency, and otherwise 1.
`build-push` uses the same order while publishing, but exits 74 in place of 1.

A failure caused by the storage quota counts as a permanent failure (exit status
1), not a transient one. Because 75 ranks above 1, a push that has one quota
failure and one transient failure exits 75. A retry can then publish the path
that failed transiently but not the path that the server refused because of the
quota, and the next run exits 1.

For example, to make up to five attempts at a push with backoff:

```bash
for attempt in 1 2 3 4 5; do
  cupboard push "$CACHE_URL" "$@" && exit 0
  status=$?
  [ "$status" -eq 75 ] || exit "$status"
  [ "$attempt" -lt 5 ] && sleep $((2 ** attempt))
done
exit 75
```

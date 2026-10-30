### Read passwords in the environment

The cupboard actions no longer put read passwords or GitHub tokens on command
lines. The plan and cohort steps of the flake publish workflows pass read
passwords to `cupboard push`, `plan cohort` and `plan reprobe` in environment
variables, and releases before this one don't read them there.

A caller of `cupboard-flake-publish.yml` or `cupboard-flake-publish-trusted.yml`
that supplies static read credentials and sets `cupboard-version` to a release
before `v0.0.50` must select `v0.0.50` or later, or leave `cupboard-version`
empty. With an older release, the plan or cohort job fails with
`EnvironmentCredentialVersionError` before it runs the CLI with a credential.

A workflow that runs the plan or build-cohort action directly can also set a
read credential in environment variables: `CUPBOARD_READ_USER` and
`CUPBOARD_READ_PASSWORD` for the destination cache, and
`CUPBOARD_VIEW_READ_USER` and `CUPBOARD_VIEW_READ_PASSWORD` for the reuse view
or reference source. With a CLI release before `v0.0.50`, these actions now stop
with `EnvironmentCredentialVersionError` when the job sets them, for example:

```yaml
env:
  CUPBOARD_VIEW_READ_USER: ${{ secrets.CUPBOARD_VIEW_READ_USER }}
  CUPBOARD_VIEW_READ_PASSWORD: ${{ secrets.CUPBOARD_VIEW_READ_PASSWORD }}
```

The CLI reads these variables when the matching option is omitted:

- `plan cohort` and `plan reprobe` read the destination cache's credential from
  `CUPBOARD_READ_USER` and `CUPBOARD_READ_PASSWORD`, and the reuse view's or
  reference source's credential from `CUPBOARD_VIEW_READ_USER` and
  `CUPBOARD_VIEW_READ_PASSWORD`.
- `push` reads the credential for its `--reference-source` from
  `CUPBOARD_VIEW_READ_USER` and `CUPBOARD_VIEW_READ_PASSWORD`. It never sends
  `CUPBOARD_READ_USER` and `CUPBOARD_READ_PASSWORD` to a reference source.

A script that exports `CUPBOARD_VIEW_READ_USER` and
`CUPBOARD_VIEW_READ_PASSWORD` and runs `cupboard push --reference-source` now
sends that credential to the reference source.

`plan cohort` and `plan reprobe` no longer send the destination's credential to
the reuse view or reference source. Those requests use the view credential, or
no credential when none is supplied, so a private reuse view or reference source
needs `--view-read-user` and `--view-read-password`, the view variables, or an
OIDC read session.

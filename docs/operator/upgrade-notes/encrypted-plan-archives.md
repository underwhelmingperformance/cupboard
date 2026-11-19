### Encrypted plan archives

Upgrade the server before updating a caller that uses
`reuse-plan-derivations: true`. The updated workflow requests a plan archive
grant from the tenant. An older server refuses the grant and the plan stops
before uploading an archive. The server creates the archive identity in the
tenant Durable Object.

The reusable workflow requires a repository on github.com. For workflows that
call the actions directly, the archive grant also accepts GitHub Enterprise
Cloud issuers on GHE.com. GitHub Enterprise Server uses operator-managed
domains, which the grant cannot identify as GitHub Actions issuers. Direct
callers on GitHub Enterprise Server must disable derivation reuse when updating.

Update the workflow reference as well as the server. Older workflows still
upload plaintext archives. Previously uploaded artifacts retain their original
contents until GitHub deletes them.

The reusable workflow passes the archive ticket to each cohort. If your workflow
calls `underwhelmingperformance/cupboard/actions/plan` and
`underwhelmingperformance/cupboard/actions/build-cohort` directly, expose the
plan step's `derivation-ticket` output as a plan job output. Pass
`${{ needs.plan.outputs.derivation-ticket }}` to the `derivation-ticket` input
of each build-cohort step.

Upload the file at the path in the plan step's `derivation-cache-file` output.
In each cohort job, download the artifact and pass the local path of
`cupboard-derivations.tar.age` to the `derivation-cache-file` input. Update any
workflow that still uses the old filename `cupboard-derivations.tar`.

Both jobs need `id-token: write`. For the archive grant, the jobs request an ID
token with the canonical tenant URL as its audience. The tenant's OIDC trust
rules must accept that audience and grant `upload:negotiate`, `upload:status`
and `upload:commit` on the destination cache to both jobs. Direct callers also
need these grants when a cohort imports an archive and builds without
publishing.

When you call the actions directly, the ticket is bound to your workflow file
and revision. Any job defined in that workflow in the same run can redeem the
ticket if it has the ticket, can request an ID token and qualifies for upload to
the same destination. Use separate workflow runs for jobs with different trust
levels.

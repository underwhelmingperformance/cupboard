### Bound subject tokens

The deployment refuses every exchange of an external subject token that isn't
bound to the server that receives it. This applies to `POST /token` and
`POST /signup` at the deployment URL, and to token exchanges and read
acquisitions at `POST /t/<tenant>/token`. A refused exchange returns status 400
with the error `invalid_grant` and the problem `subject-token-unbound`.

A token is bound in one of two ways:

- Its audience is the URL of the server that receives it: the tenant URL for a
  tenant, and the deployment URL for the control plane. A GitHub Actions job
  requests such a token.
- Its `nonce` claim commits to that URL. The CLI requests such a token for every
  sign-in.

The refusal has these consequences:

- A CLI from an earlier release sends its sign-in tokens without the binding, so
  it can't sign in. Upgrade the CLI with the deployment.
- `--headless` no longer uses the device flow. It prints the sign-in URL and
  accepts the redirect URL that you paste from a browser on another machine. See
  [Signing in without a browser][headless-sign-in].
- A CI job can't exchange a token whose audience isn't the URL of the server
  that it sends the token to. That includes the token for a tenant trust rule
  with a custom audience. It also includes a token for the control plane that a
  job requests for another hostname of the deployment, such as its workers.dev
  hostname when the deployment URL is a custom domain. Set the rule's audience,
  and the job's `audience` input or `--audience` option, to the tenant URL, or
  to the deployment URL for a control trust rule.

Before you upgrade, find the trust rules that stop working. A rule stops working
when both of these are true:

- Its audience isn't the URL of the server that receives the token: the tenant
  URL for a tenant trust rule, or the deployment URL for a control trust rule.
- A CI job, or another caller that doesn't sign in through the CLI, presents
  tokens for the rule.

A rule for people who sign in with the CLI keeps working whatever its audience,
because the CLI binds every sign-in token with its nonce.

To find these rules:

- Run `cupboard github check` for each repository that publishes to a tenant. It
  warns about each GitHub Actions trust rule for the repository whose audience
  isn't the tenant URL.
- List each tenant's trust rules with `cupboard oidc-trust list <tenant URL>`,
  and the control plane's with
  `cupboard control-oidc-trust list <deployment URL>`. Each rule shows its
  audience. Check every rule that CI or another caller without the CLI uses,
  including rules for other CI providers, which `cupboard github check` doesn't
  cover.

[headless-sign-in]: ../../admin/signing-in.md#signing-in-without-a-browser

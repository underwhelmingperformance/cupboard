# Upgrading

The `cupboard` CLI contains the Workers that it deploys. To upgrade a
deployment, you install a newer CLI and deploy with it.

## Upgrading a deployment

1. Find out which version is deployed:

   ```sh
   curl -fsS https://cupboard.example.workers.dev/_version
   ```

2. Read the [upgrade notes](./upgrade-notes.md) for every release after that
   one, up to and including the one that you're installing. Some releases need
   you to do something before or after you deploy.

3. Install the new CLI. For example, run `nix profile upgrade`, or update your
   flake input. See [Installing the CLI](../installing.md).

4. Deploy:

   ```sh
   cupboard deploy
   ```

`cupboard deploy` is another name for `cupboard init`, and takes the same
options. It needs the operator's session, and at a terminal it signs you in as
the operator if it has to. It keeps the custom domain, resource names and cron
triggers. If you passed `--workers-plan` when you first deployed, pass it again.
See [Running `init` again](./deploying.md#running-init-again).

## What a deploy does

Most releases only replace the two Workers.

A release that changes how data is stored in D1 has to change it while the old
Workers may still be running. cupboard calls such a change a **schema
transition**, and splits its migrations in two. The expand migrations add the
new format alongside the old one, and run before the Workers are uploaded. Both
the old and the new Workers can work with the result. The contract migrations
remove the old format, and run only once both Workers are serving the new build
and every tenant has converted its own data. A release can contain more than one
transition, and the deploy records each one's progress in the
`deployment_transition` table in D1.

A deploy goes through these stages:

1. It reads the recorded transitions and checks them against the release. It
   stops before any change if a recorded row doesn't match what the release
   expects, if a migration file has changed since it was applied, or if a
   transition needs an earlier one to be finished first. In that last case, the
   error lists the releases that finish the earlier transition. Deploy one of
   those first.
2. It applies the expand migrations of every unfinished transition. On a
   deployment with no tenants and no Workers, it applies every migration at this
   point, because nothing is running that the change could disturb.
3. It uploads both Workers, and checks that Cloudflare is sending all traffic to
   the new version of each.
4. For each unfinished transition, it wakes active and suspended tenants in
   batches of 20, for up to 100 batches, until every tenant has converted its
   data as far as the transition needs. Each tenant's Durable Object converts
   its own data, and records how far it has got as its local step.
5. It applies the transition's contract migrations and records the transition as
   complete.
6. It wakes tenants again until each has finished the work that depended on the
   contract migrations.

Requests that were still in progress on the old Workers when the old format was
removed can fail. Clients need to retry them against the new Workers.

### When a deploy stops before finishing

The deploy records its progress as it goes. If it's interrupted, running it
again continues from where it stopped.

If some tenants are still converting their data when the deploy gives up waiting
for them, the deploy stops before the contract migrations and lists a sample of
those tenants. Usually they just need more time. To see how far the upgrade has
got:

```sh
cupboard deployment status https://cupboard.example.workers.dev
```

This lists each recorded transition and its state, the local step that tenants
have to reach, and how many tenants have reached it. To wake the pending tenants
without deploying again:

```sh
cupboard deployment resume https://cupboard.example.workers.dev
```

By default, `resume` wakes 20 tenants at a time, for up to 20 batches. You can
change these numbers with `--limit` and `--max-passes`. The hourly job also
wakes 20 pending tenants every hour, so the upgrade keeps moving even if you do
nothing.

Once no tenants are pending, run `cupboard deploy` again to finish the upgrade.

Run `deployment status` and `deployment resume` with the CLI from the release
that's deployed. The CLI checks the responses to these commands strictly, so a
CLI from another release either rejects them or gets a 404.

## Upgrading from automation

You can run a deploy without a terminal, for example from GitHub Actions. The
job needs a Cloudflare API token for the account, the `id-token: write`
permission, and a control-plane trust rule that accepts the workflow's GitHub
Actions token with full operator access. The rule takes the place of the
operator's session.

Create the rule once, from a machine where an operator is signed in with
`cupboard login <deployment URL>`. Write the rule as a file. Its audience is the
deployment URL without a trailing slash, and its `sub` claim pins the repository
and branch that may deploy:

```sh
cat > ci-operator.json <<'EOF'
{
  "issuer": "https://token.actions.githubusercontent.com",
  "audience": "https://cupboard.example.workers.dev",
  "claims": { "sub": "repo:acme/infra:ref:refs/heads/main" },
  "permittedGrants": [{ "type": "cupboard_wildcard" }]
}
EOF
cupboard control-oidc-trust add https://cupboard.example.workers.dev \
  --from-file ci-operator.json
```

The job then runs:

```sh
export CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=...
cupboard deploy --github-oidc --yes --workers-plan paid
```

The token needs the permissions listed in
[Deploying with an API token](./deploying.md#deploying-with-an-api-token). The
Workers keep their R2 key and secrets between deploys, so an ordinary upgrade
needs nothing else. If the rule pins an audience other than the deployment URL,
pass it with `--audience`. That option is refused without `--github-oidc`.

Some things are different from a deploy at a terminal:

- A deploy from CI can't claim a new deployment. A first deploy uploads the
  Workers and then exits with an error, and someone has to run `cupboard init`
  from a terminal. See
  [Deploying without a terminal](./deploying.md#deploying-without-a-terminal).
- If the token doesn't have Billing: Read, pass `--workers-plan`. Otherwise the
  deploy sets the Free plan's limits.
- `--yes` skips the plan review, so the run can't rename resources or change
  cron triggers. It keeps what the deployment already has.
- A run with `--github-oidc` can only move the deployment to a new domain once
  that domain already serves it. See
  [Moving to a new domain](./deploying.md#moving-to-a-new-domain).

## CLI and server versions

The CLI and the server agree between them which optional features to use. This
means that an older CLI keeps working against a newer server for everyday use,
and a newer CLI falls back to older behaviour when it talks to an older server.

Upgrade the server first. Some newer CLI features need support from the server,
such as `push --no-retain`, and refuse to run against an older server. The
[upgrade notes](./upgrade-notes.md) list any release that needs a matching CLI.

## Rolling back

Rolling back the Workers doesn't roll back their data. D1, the tenants' Durable
Objects and R2 all stay as the newer release left them. As soon as the new
tenant Worker is uploaded, tenants start converting their own storage to a form
that older Workers can't read.

If a deploy fails partway through, fix the cause and deploy the same release
again. Don't go back to an older one.

An older CLI decides what to do about a transition that it doesn't know from the
transition's recorded row. If only the expand migrations have run, it leaves the
row alone and deploys, because expand migrations are written to work with every
build that can still be deployed. If the contract migrations have started, it
stops before any change, because they may have removed something that the older
build reads. The error tells you to stay on the deployed release, and to use its
`deployment status` and `deployment resume` for any remaining tenant work.

To roll back anyway, first confirm from the newer release's migrations that its
contract migrations remove nothing that the older build reads. Then clear the
transition's `contracted_at` in D1, using the database name and transition ID
from the error, and deploy the older release again:

```sh
wrangler d1 execute cupboard --remote \
  --command "UPDATE deployment_transition SET contracted_at = NULL WHERE id = '<id>';"
```

Wrangler needs credentials for the deployment's account: run `wrangler login`,
or set `CLOUDFLARE_API_TOKEN` to a token that can edit D1. If the credentials
cover several accounts, set `CLOUDFLARE_ACCOUNT_ID` as well.

In every other case, going back to an earlier release needs the storage from
before the upgrade as well as the older Workers. D1 has
[Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/), but
tenants' Durable Object storage can't be restored.

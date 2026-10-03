# Upgrading

The `cupboard` CLI contains the Workers that it deploys. To upgrade a
deployment, you install a newer CLI and deploy with it.

## Upgrading a deployment

1. Find out which version is deployed:

   ```sh
   curl -fsS https://cupboard.example.workers.dev/_version
   ```

2. Read the [upgrade notes](./upgrade-notes.md) for every release after that
   one, up to and including the release that you're installing. Some releases
   need you to do something before or after you deploy.

3. Install the new CLI. If you installed it into your profile from a tag, remove
   it and install the new tag, as
   [Installing with Nix](../installing.md#installing-with-nix) shows. If you use
   a FlakeHub input, update it. See [Installing the CLI](../installing.md).

4. Deploy:

   ```sh
   cupboard init
   ```

`cupboard deploy` is another name for `cupboard init`, and takes the same
options. An upgrade keeps the custom domain, resource names and cron triggers.
If you passed `--workers-plan` when you first deployed, pass it again. See
[Running `init` again](./deploying.md#running-init-again).

## Signing in to upgrade

Once a deployment has an admin, `init` needs an admin token to update it: a
control-plane token with the
[wildcard grant](../concepts.md#signing-in-and-trust-rules). It checks the token
before it applies any migration or uploads anything, and stops if it has no
usable token. When it stops, it prints who the admin is and how to sign in.
Nothing has changed by then.

`init` checks the token against the deployment's current URL. The last deploy
records that URL on the control Worker as `CUPBOARD_DEPLOYMENT_URL`, and it's
the URL to pass to `cupboard login`. A deployment last updated by v0.0.35 or
earlier has no record. Its current URL is the custom domain routed to the
control Worker, or otherwise its workers.dev URL, and the first upgrade records
it. The record must be an HTTPS URL, and `init` refuses any other value. If a
[move to a new URL](./deploying.md#moving-to-a-new-url) fails after the upload
has recorded the new URL but before `init` routes the new domain, the record
contains a URL that isn't routed to the control Worker. The next run then warns
and uses the routed URL.

`init` finds a token in this order:

1. The session cached by `cupboard login <deployment URL>`.
2. If no session is cached, the cached Cloudflare sign-in, as `cupboard login`
   uses it. `init` exchanges its ID token at the deployment. This only works if
   a control trust rule accepts that identity.
3. If there's still no usable session, or the session lacks the wildcard grant,
   and there is a terminal, `init` signs you in as the admin and caches the
   session. It always starts a new sign-in through the admin's issuer for this,
   so you can complete it as the admin even if your cached Cloudflare sign-in
   belongs to someone else. `--headless` uses the device flow. If the sign-in
   returns another identity, `init` stops before it changes anything.

After a successful admin sign-in, a refused token exchange or a token without
the wildcard grant stops the update. `init` prints the deployment's refusal or
the missing grant and directs you to correct the admin's control trust rule. See
[Restoring the admin's wildcard grant][restore-admin-grant]. Temporary exchange
failures retain their server details and do not prompt another sign-in.

[restore-admin-grant]: ./operators.md#restoring-the-admins-wildcard-grant

Any operator whose control trust rule gives the wildcard grant can upgrade the
deployment this way, not only the admin. See [Operators](./operators.md).

To check the token, `init` sends an `instance.get` request to the deployment. If
the deployment can't be reached, returns an error status, doesn't serve the
control Worker at its URL, or runs a build without `instance.get`, `init` stops
before it changes anything and prints the reason. For an error status from the
Worker, fix the control Worker or roll it back, for example with
`wrangler rollback`, and deploy again. When the token exchange reports why it
failed, for example because the admin's issuer can't be reached, `init` prints
that reason instead. For a build without `instance.get`, first update the
deployment with a release that has it.

`init` uses the same token to initialise the deployment, rebuild the tenant
list, check the Worker's R2 key and wake the tenants during a migration. It
renews the token when it nears expiry.

The check only stops `cupboard init`. Anyone with the Cloudflare account's
credentials can still change the Workers, their secrets or D1 with other tools,
so it doesn't protect a deployment from other people who have those credentials.

## Updating from CI

In CI, pass `--github-oidc`. `init` then exchanges the workflow's GitHub Actions
OIDC token for an admin token through a control trust rule, and the rule must
give the workflow the wildcard grant. Create the rule once, from a session that
may add control trust rules, such as the admin's session from
`cupboard login <deployment URL>` in a terminal. The rule has to be given as a
file:

```sh
cat > ci-admin-rule.json <<'EOF'
{
  "issuer": "https://token.actions.githubusercontent.com",
  "audience": "https://cache.example.com",
  "claims": { "sub": "repo:acme/infra:ref:refs/heads/main" },
  "permittedGrants": [{ "type": "cupboard_wildcard" }]
}
EOF
cupboard control-oidc-trust add https://cache.example.com \
  --from-file ci-admin-rule.json
```

The audience is the deployment's current URL without a trailing slash, which is
the audience that `init` requests by default. `--audience` requests another
audience, and `init` refuses `--audience` without `--github-oidc`. The `sub`
claim pins the repository and the branch that may deploy.

The job needs:

- a Cloudflare API token for the account in `CLOUDFLARE_API_TOKEN`, with the
  permissions listed in
  [Deploying with an API token](./deploying.md#deploying-with-an-api-token);
- the `id-token: write` permission;
- `--account`, or `CLOUDFLARE_ACCOUNT_ID`, if the token can reach more than one
  account.

It then runs:

```sh
cupboard init --github-oidc --yes
```

If the token doesn't have Billing: Read, also pass `--workers-plan`. Otherwise
the deploy sets the Free plan's limits. The Workers keep their R2 key and
secrets between deploys, so an ordinary upgrade needs nothing else.

A deploy from CI can't claim a new deployment, because the claim needs a sign-in
from a terminal. See
[Deploying with an API token](./deploying.md#deploying-with-an-api-token).

## What a deploy does

Most releases only replace the two Workers.

A release that changes the D1 schema in a way that older Workers can't use
groups its D1 migrations into **schema transitions**. Each transition has two
parts. Its expand migrations add the new schema, and every build that can still
be deployed or rolled back to must work with that schema. Its contract
migrations remove what older Workers read. They only run once both Workers serve
the new build and the tenants have finished their own part of the migration.

This lets the old and new Workers run side by side while traffic moves from one
to the other. One `cupboard init` run does this:

1. Reads the state of each transition from the `deployment_transition` table,
   and stops with an error if it finds a state or a migration that it can't
   account for. See [Rolling back](#rolling-back).
2. Applies the expand migrations of every transition that isn't complete. On a
   new deployment, it applies every migration at once, because no older Workers
   use the database.
3. Uploads both Workers. It then checks that Cloudflare is sending all traffic
   to the new version of each, and that both report the new build.
4. For each transition that isn't complete, wakes the active and suspended
   tenants once and waits until every one has reached the transition's **local
   step**. A local step is a number that each tenant's Durable Object records as
   it converts its own data. A woken tenant keeps working on its own until it
   has finished, so the deploy only checks progress every five seconds. Then it
   applies the transition's contract migrations and records the transition
   complete.
5. Wakes the tenants again and waits until every one has reached the final local
   step.

Requests that were already in progress on the old Workers when the contract
migrations run can fail. Clients need to retry them against the new Workers.

Some releases can only be deployed once an earlier transition is complete. When
the plan shows such a blocked transition, the plan menu only offers changes to
the plan and Cancel. On Cancel, or with `--yes`, `init` stops with an error
before it creates anything. The error lists the releases that complete the
earlier transition. If the deployed release is one of them, run its
`cupboard init` again to complete the transition, then deploy the new release.

[How the deployment is upgraded](../contributing/architecture.md#deployments-and-upgrades)
describes the transitions in more detail.

### When a deploy stops before finishing

The deploy records its progress as it goes. If it's interrupted, running it
again continues from where it stopped. It skips migrations that it has already
applied, after it checks their recorded digests.

The deploy waits as long as some pending tenant is making progress. It gives up
when ten minutes have passed since it woke the tenants and none of the pending
tenants is working. It then stops before that transition's contract migrations,
and lists the stalled tenants with their errors and the tenants that haven't
been woken yet:

```
3 tenants have not reached local step 4, and 10 minutes after the wake none of
them is classified as working. Stalled: acme: attempted …, last progress …, …
```

The tenants don't depend on the deploy. A tenant that is making progress keeps
going after the deploy stops. A tenant that has made no progress for ten minutes
stops, with the error `gave up after 10 minutes without progress` if nothing
failed, and waits for its next wake. The hourly cron job wakes the stalled
tenants and the tenants that haven't been woken yet on every run, so the
migration keeps moving even if you do nothing.

To see how far the migration has got:

```sh
cupboard deployment status https://cupboard.example.workers.dev
```

This shows each schema transition and its state, the local step that tenants
must reach now, how many tenants are ready, and how many are pending. It divides
the pending tenants into three groups, measured over the last ten minutes:

- **Working**: the tenant has made progress recently, or has started and hasn't
  failed yet.
- **Stalled**: the tenant hasn't made progress for ten minutes, or its last
  attempt failed without any progress. `status` lists up to 20 of them, with
  when each last tried, when it last made progress, and its error.
- **Not yet woken**: nothing has tried the tenant's outstanding work recently.
  Its wake may still be waiting in the maintenance queue. If a tenant stays in
  this group after a wake and an hourly run, check the maintenance queue, its
  dead-letter queue and the control Worker's logs.

A stalled tenant with an error has a fault that the error describes. A tenant
that shows `TenantNotConfiguredError` needs its creation repeated. To wake the
pending tenants and wait for them without deploying again:

```sh
cupboard deployment resume https://cupboard.example.workers.dev
```

`resume` wakes the stalled and unwoken tenants once, then waits in the same way
as the deploy, and stops with the same error when no pending tenant is working
ten minutes after the wake.

In GitHub Actions, pass `--github-oidc` to either command. The job needs
`id-token: write`, and its control trust rule must permit `deployment:read` and
`local-step:read`. `resume` also requests `local-step:wake`. Use `--audience`
when the rule specifies a custom audience; the default is the deployment URL.
The commands renew their CI token during the run. Without `--github-oidc`, they
use the session from `cupboard login`.

If `status` reports a tenant configuration or migration error, repair it first.
Once no tenants are pending, run `cupboard init` again to finish the upgrade.

## CLI and server versions

The CLI and the server agree between them which optional features to use. This
means that an older CLI keeps working against a newer server for everyday use,
and a newer CLI falls back to older behaviour when it talks to an older server.

Upgrade the server first. Some newer CLI features need support from the server,
such as `push --no-retain`, and refuse to run against an older server. The
[upgrade notes](./upgrade-notes.md) list any release that needs a matching CLI.

`cupboard deployment status` and `cupboard deployment resume` are an exception.
Use them from the same release as the deployed control Worker. The CLI and the
server check these responses strictly, so a CLI from another release rejects
them or gets 404.

## Rolling back

Rolling back the Workers doesn't roll back their data. D1, the tenants' Durable
Objects and R2 all stay as the newer release left them. As soon as the new
tenant Worker is uploaded, tenants start converting their own storage to a form
that older Workers can't read, even before D1 records the transition complete.

If a deploy fails partway through, fix the cause and deploy the same release
again. Don't go back to an older one. Once a transition's contract migrations
have run, older Workers can't use the database. To really go back to an earlier
release, you'd need the storage from before the upgrade as well as the older
Workers. D1 has
[Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/), but
cupboard has no procedure to restore every tenant's Durable Object storage, and
rolling back the Workers doesn't restore it.

Two more things stay behind after a rollback:

- Objects that the newer release moved to new keys in R2 stay at the new keys.
  The older release can't read them there, and can't remove them when it tears a
  cache down. If the older release then writes an object at an old key, a later
  deploy of the newer release doesn't necessarily move that object again,
  because the tenant has already recorded the step that moves objects. Recover
  such objects yourself before you rely on the new keys.
- A release can accept a D1 migration history that is longer than its own.
  Digest verification checks only migration files included in that release; it
  does not verify extra recorded migrations. Acceptance only means that
  deployment can continue. It does not establish that the older release can use
  the schema produced by those extra migrations.

### Deploying an older release over a newer one

If you do deploy an older release's CLI over a deployment that a newer release
has upgraded, the `deployment_transition` table can contain a row for a
transition that the older release doesn't know. The older release decides what
to do with the row from its state and its `contracted_at` column, which the
deploy sets just before the first contract migration runs:

- State `expanded` or `complete`, with `contracted_at` empty: the newer release
  has only applied the transition's expand migrations, which every deployable
  build must work with. The deploy shows the row in the plan, leaves it alone,
  and applies only its own transitions.
- State `expanded` or `complete`, with `contracted_at` set: the transition's
  contract migrations have started, and may have removed something that the
  older release needs. The deploy stops before it changes anything. Stay on the
  deployed release, and use its `cupboard deployment status` and
  `cupboard deployment resume` for any remaining tenant work.

  To roll back anyway, first check the newer release's migrations and make sure
  that its contract migrations remove nothing that the older release reads. Then
  clear `contracted_at` and deploy the older release again:

  ```sh
  wrangler d1 execute <database> --remote --command "UPDATE deployment_transition SET contracted_at = NULL WHERE id = '<id>';"
  ```

  `<database>` and `<id>` are the D1 database name and the transition ID that
  the error reports. `--remote` runs the statement against the deployed
  database, not a local copy. Wrangler needs credentials for the deployment's
  Cloudflare account: run `wrangler login`, or set `CLOUDFLARE_API_TOKEN` to a
  token that can edit D1. If the credentials cover several accounts, also set
  `CLOUDFLARE_ACCOUNT_ID` to the deployment's account ID.

- Any other state: the deploy stops whatever `contracted_at` contains. Deploy a
  release that knows the transition and the state.

A row for a transition that the release knows, but in a state that it doesn't,
also stops the deploy. `cupboard deployment status` lists every row that its own
release doesn't recognise, and says what that release's deploy would do with it.

v0.0.34 and v0.0.35 don't read `deployment_transition`. They read the
`deployment_phase` row, which later releases keep up to date for them, so a
rollback to one of those releases reads a correct phase.

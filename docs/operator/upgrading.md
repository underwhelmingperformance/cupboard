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
   FlakeHub input. See [Installing the CLI](../installing.md).

4. Deploy:

   ```sh
   cupboard deploy
   ```

`cupboard deploy` is another name for `cupboard init`, and takes the same
options. It keeps the custom domain, resource names and cron triggers. If you
passed `--workers-plan` when you first deployed, pass it again. See
[Running `init` again](./deploying.md#running-init-again).

## What a deploy does

Most releases only replace the two Workers.

A release that changes how data is stored is deployed in stages. This lets the
old and new Workers run side by side while traffic moves from one to the other:

1. Database migrations add the new format alongside the old one.
2. The deploy uploads both Workers. It then checks that Cloudflare is sending
   all traffic to the new version of each.
3. Each tenant's Durable Object converts its own data. The deploy wakes active
   and suspended tenants in batches of 20, for up to 100 batches, until every
   tenant has finished.
4. Database migrations contract the schema: they remove the old format.
5. Tenants rewrite anything that still refers to the old format.

Requests that were already in progress on the old Workers when the old format is
removed can fail. Clients need to retry them against the new Workers.

### When a deploy stops before finishing

The deploy records its progress as it goes. If it's interrupted, running it
again continues from where it stopped.

If some tenants are still migrating when the deploy gives up waiting for them,
the deploy stops before the contract stage and lists some of those tenants:

```
3 tenants have not reached local step 4: acme, beta and 1 more. The deployment
phase was not recorded. Run cupboard deployment status <url> …
```

Usually the remaining tenants just need more time. To see how far the migration
has got:

```sh
cupboard deployment status https://cupboard.example.workers.dev
```

This shows the deployment's phase and how many tenants are ready or still
pending. To wake the pending tenants without deploying again:

```sh
cupboard deployment resume https://cupboard.example.workers.dev
```

By default, `resume` wakes 20 tenants at a time, for up to 20 batches. You can
change these numbers with `--limit` and `--max-passes`. The hourly job also
wakes 20 pending tenants every hour, so the migration keeps moving even if you
do nothing.

Once no tenants are pending, run `cupboard deploy` again to finish the upgrade.

## Upgrading from automation

You can run a deploy without a terminal, for example from CI:

```sh
export CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=...
cupboard deploy --yes --workers-plan paid
```

The token needs the permissions listed in
[Deploying with an API token](./deploying.md#deploying-with-an-api-token). The
Workers keep their R2 key and secrets between deploys, so an ordinary upgrade
needs nothing else.

There are three differences from an interactive deploy:

- An API token doesn't include anyone's identity, so the deploy leaves the
  operator and the claim settings as they are. The output identifies the
  existing operator and says that the operator hasn't changed.
- If the token doesn't have Billing: Read, pass `--workers-plan`. Otherwise the
  deploy sets the Free plan's limits.
- Waking tenants for a migration needs an operator session, and an API token
  can't provide one. A deploy that has to migrate tenants uploads the Workers
  and then fails with "No cupboard session, or it has expired". To continue,
  either let the hourly job migrate the tenants, or run
  `cupboard deployment resume` on a machine where an operator is signed in. Then
  deploy again.

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

An older CLI refuses to deploy over a deployment whose phase it doesn't
recognise. To really go back to an earlier release, you'd need the storage from
before the upgrade as well as the older Workers. D1 has
[Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/), but
tenants' Durable Object storage can't be restored.

# Signing in

Most `cupboard` commands that manage a tenant need you to be signed in. You sign
in once with `cupboard login`, and the CLI keeps the session on your machine for
later commands.

cupboard doesn't have its own passwords. You sign in with an account that you
already have, usually your Cloudflare account. The tenant then checks whether it
trusts that identity.

## Signing in to a tenant

Run `cupboard login` with the tenant URL:

```sh
cupboard login https://cupboard.example.workers.dev/t/acme
```

The CLI opens a browser so you can sign in with Cloudflare. If you've signed in
to Cloudflare through cupboard before, including through `cupboard init`, it
reuses that sign-in and doesn't open a browser.

Signing in only works if the tenant trusts your identity. That means you're
either the tenant's owner, or an administrator has
[added you](./access.md#adding-an-administrator). If you haven't been added yet,
see the next section.

## Finding the identity to ask for access with

Before you can sign in, a tenant administrator has to add a trust rule for your
identity. A trust rule tells the tenant which sign-ins to accept. To write one,
the administrator needs three values from you: the issuer, audience and subject
of your identity.

To find them, run:

```sh
cupboard whoami --provider
```

This signs you in to your identity provider, in the same way `cupboard login`
does, but it never contacts cupboard. That's why it works before any trust rule
exists for you.

It prints the issuer, audience and subject that a trust rule for you needs. If
your identity provider lists several audiences in the token, the audience shown
is the client that you signed in with. It also prints the token's other text
claims, apart from the claims that identify the token itself, such as its expiry
and its ID.

Send the issuer, audience and subject to the administrator who can give you
access. For a tenant, that's a tenant administrator, who adds a rule with
`cupboard oidc-trust add`. For the deployment, it's an operator, who adds a
control-plane rule with `cupboard control-oidc-trust add`.

A few details:

- It accepts the same sign-in options as `cupboard login`: `--oidc-issuer`,
  `--client-id` and `--headless`.
- With `--output-mode json`, the output includes a `rule` object that contains
  the values in the same shape as a trust rule file.
- The CLI decodes the claims on your machine and doesn't check their signatures.

## Signing in without a browser

On a machine that has no browser, such as a server that you reach over SSH, add
`--headless`:

```sh
cupboard login https://cupboard.example.workers.dev/t/acme --headless
```

The CLI prints a code, which you enter on another device to finish signing in.

A headless sign-in uses the device flow, and doesn't use or save a Cloudflare
sign-in. The CLI still renews the session with its refresh token. Once the
refresh token expires, the CLI can only start a new session from a Cloudflare
sign-in that `cupboard init` or an earlier browser sign-in saved on the machine.
If there isn't one, the CLI asks you to sign in again.

## Signing in with another identity provider

You can sign in with an OpenID Connect provider other than Cloudflare, if the
tenant has a trust rule for identities from that provider. Pass the provider's
issuer URL with `--oidc-issuer`. Pass the ID of a public OAuth client with
`--client-id`. That client must be registered with the provider for cupboard:

```sh
cupboard login https://cupboard.example.workers.dev/t/acme \
  --oidc-issuer https://idp.example.com \
  --client-id cupboard-cli
```

## Signing in as an operator

Sessions are kept separately for each URL that you sign in to. A session for a
tenant URL, such as `https://cupboard.example.workers.dev/t/acme`, is used for
that tenant's commands.

The deployment's operator signs in to the deployment URL instead, which has no
`/t/...` part:

```sh
cupboard login https://cupboard.example.workers.dev
```

That session is used for operator commands such as `cupboard tenant` and
`cupboard deployment`.

## How long a session lasts

A tenant session has two parts:

- An access token, which the CLI sends with each command. It's valid for ten
  minutes.
- A refresh token, which the CLI uses to get a new access token when the old one
  expires.

The CLI renews the access token for you whenever it needs to, for up to 30 days
after you signed in.

Renewal checks the saved verified identity against current policy. Matching
rules in the current preferred identity tier can combine their grants. Removing
or replacing a rule changes that policy; renewal can continue when another
matching rule permits the session's authority. A renewed token cannot exceed the
authority in its refresh credential. If a refresh requests fewer grants, every
later rotation is limited to those grants.

The refresh credential contains the verified issuer, subject, audiences and
string claims needed for policy matching, together with its authority and
absolute expiry. The server authenticates the complete credential against a
stored hash before using those claims. The server keeps rotation and replay
metadata, but does not store a session's identity, grants or originating rule.
An encrypted successor credential is temporarily stored for retry recovery.
Bounded maintenance clears that ciphertext after the grace window; ciphertext
can remain until the relevant maintenance pass runs, but expired ciphertext
cannot recover a response.

If a refresh response is lost, retry the command within one minute. The CLI
keeps the consumed refresh token until it receives a response. The server then
returns the same successor refresh token and issues a new access token after
checking the current trust rules. The CLI does not automatically retry a failed
refresh request. A later retry revokes that refresh-token family. The CLI can
establish a new session from a saved Cloudflare sign-in when it is still valid;
otherwise, sign in again.

A deployment session has only an access token, which is also valid for ten
minutes. It has no refresh token.

If the CLI has saved a Cloudflare sign-in on the machine, it can also start a
new session from that sign-in, for a tenant URL or the deployment URL.

When the CLI can't renew the session, the command fails with exit status 77 and
asks you to run `cupboard login` again.

If current trust rules no longer permit your session's authority, the CLI can no
longer renew your session. Your current access token stops working within ten
minutes.

## Checking who you're signed in as

```sh
cupboard whoami
```

This lists the sessions kept on this machine. For each one, it shows:

- the URL
- the subject that you signed in as
- the trust rule that accepted you, if the access token records it (a tenant's
  tokens do, and the deployment's don't)
- when the access token expires
- whether a refresh token is saved with the session

It also shows the saved Cloudflare sign-in, if there is one, even when there are
no sessions. If a cached session or the Cloudflare sign-in cannot be read, the
command reports the readable identity fields and each unreadable session file,
then fails. Check access to the CLI's configuration directory before retrying. A
partial JSON result omits fields that could not be read.

To see only one session, give its URL:

```sh
cupboard whoami https://cupboard.example.workers.dev/t/acme
```

If there's no session for that URL, the command exits with status 77.

`cupboard whoami` only reads files on your machine. It doesn't contact cupboard.

## Signing out

To sign out of a tenant, run:

```sh
cupboard logout https://cupboard.example.workers.dev/t/acme
```

This deletes the session for that URL. To delete every session on this machine,
use `--all` instead of a URL:

```sh
cupboard logout --all
```

While a Cloudflare sign-in is saved, later commands can use it to start a new
session without opening a browser, and `logout` warns you about it. To delete
the Cloudflare sign-in too, add `--cloudflare`:

```sh
cupboard logout --all --cloudflare
```

`cupboard logout --cloudflare`, without a URL or `--all`, deletes only the
Cloudflare sign-in. Afterwards, `cupboard login` and `cupboard init` ask you to
sign in to Cloudflare again.

Signing out only affects this machine. It doesn't revoke anything on the server,
because cupboard has no endpoint that revokes a refresh token. If someone has
copied a tenant session to another machine, they can renew it for up to 30 days
after you signed in, unless the server stops accepting its refresh token
earlier. To take away an administrator's access, another administrator
[removes their trust rule](./access.md#removing-an-administrator). The server
then refuses to renew the administrator's sessions.

## Where sessions are stored

The CLI keeps its state in `$XDG_CONFIG_HOME/cupboard/`, which is
`~/.config/cupboard/` by default. Only you can read it.

- `tokens/` contains one session for each URL.
- `cloudflare-grant.json` contains your Cloudflare sign-in.

The Cloudflare sign-in can also deploy to your Cloudflare account. Protect this
directory as carefully as you would any other Cloudflare credential.

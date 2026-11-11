### Confirming a domain change

A deploy with `--yes` now refuses to change the custom domains of an existing
deployment unless you also pass `--allow-domain-change`. The deploy compares
`--domain`, in lower case, with every custom domain that is routed to the
deployment's control Worker. A deployment that serves only its workers.dev
address counts as having no custom domain, so adding a first custom domain is a
change too. So is a run on a control Worker with a second custom domain, because
the deploy removes every domain except the plan's. The refusal happens before
the deploy changes anything.

If a CI job or script runs `cupboard init --yes` with a `--domain` that differs
from the deployment's current domain, either pass the current domain, or add
`--allow-domain-change` for the run that moves the deployment. A run that passes
the current domain, or leaves out `--domain`, works as before. See [Moving to a
new URL][moving].

`init` also blocks a plan whose domain is a custom domain of a Worker outside
the deployment. Remove the custom domain from that Worker first, or choose
another domain. Routes in the zone don't block the plan; it lists their Workers
in a warning.

Attaching or removing a custom domain now needs Zone: Read and Workers Routes:
Edit on that domain's zone, in the deployment's account. The plan is blocked
before anything changes if the token cannot see the zone or cannot list its
Workers routes. A token with Workers Routes: Read but not Edit passes the plan,
and the deploy fails when it changes the domain. Before this change, a run whose
domain had no zone that the token could see warned and continued without
changing the domains. Give a CI token both permissions on the zone of every
custom domain that a run attaches or removes. A custom domain that the
deployment already serves, and that the run keeps, needs neither permission.

[moving]: ../deploying.md#moving-to-a-new-url

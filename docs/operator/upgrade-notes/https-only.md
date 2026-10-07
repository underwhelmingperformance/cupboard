### HTTPS only

The control Worker refuses every request that doesn't use HTTPS. It returns
status 403 with the problem `insecure-transport`, and doesn't process the
request. HTTPS responses other than WebSocket upgrades include the header
`Strict-Transport-Security: max-age=31536000`, so a browser uses HTTPS for the
host for the next year.

Before you upgrade, check that nothing uses an `http://` URL for the deployment:
Nix substituter settings, netrc files, CI configuration and scripts. Change
those URLs to `https://`. Also check that no tenant was created at an `http://`
URL. Such a tenant keeps that URL as its issuer, and the deployment no longer
serves that address.

`wrangler dev` serves plain HTTP. Set `CUPBOARD_LOCAL_DEV=1` in
`packages/server/.dev.vars` to allow plain HTTP requests to a local deployment.

For a custom domain, you can also turn on Always Use HTTPS and HSTS for its
zone. Those settings apply to every host in the zone. See [HTTPS for a custom
domain][https-custom-domain].

[https-custom-domain]: ../deploying.md#https-for-a-custom-domain

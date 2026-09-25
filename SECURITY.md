# Security policy

## Supported versions

Security fixes go into the latest release only. cupboard has not reached 1.0, so
earlier releases do not get backports. This applies to the `cupboard` CLI, the
Worker it deploys, and the GitHub Actions in `actions/`.

If you found a problem on an older release, please check whether the latest
release is affected too, but report it either way.

## Reporting a vulnerability

Please don't report security problems in public issues, discussions or pull
requests. Use GitHub's private vulnerability reporting instead: open the
repository's Security tab and choose "Report a vulnerability", or go straight to
<https://github.com/underwhelmingperformance/cupboard/security/advisories/new>.

Include the release or commit you tested, the steps to reproduce, and what you
think an attacker could do. It helps to say what access the attack needs, such
as a tenant's read credential, an admin token, or the ability to run a workflow
in a trusted repository.

Only test against deployments you run yourself or have permission to test.

## What happens next

You should get a reply within 7 days. Once we've confirmed the problem, we'll
agree its severity with you in the advisory and keep you updated at least every
14 days until it's resolved.

Fixes are prepared in a private fork linked to the advisory and shipped in a new
release. We publish the advisory once the release is out, with a CVE if one is
warranted, and credit you unless you'd rather we didn't. We aim to release a fix
within 90 days of the report; if it will take longer, we'll agree a disclosure
date with you. A fix to the Worker reaches a deployment only when its operator
redeploys; see [Upgrading](./docs/operator/upgrading.md).

If we decide the report isn't a vulnerability, we'll explain why in the advisory
before closing it.

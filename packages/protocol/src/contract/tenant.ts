import { attestationsContract } from './attestations.ts';
import { cachesContract } from './caches.ts';
import { gcContract } from './gc.ts';
import { keysContract } from './keys.ts';
import { oidcTrustContract } from './oidc-trust.ts';
import { pathsContract } from './paths.ts';
import { policiesContract } from './policies.ts';
import { checkContract } from './reports.ts';
import { reuseViewsContract } from './reuse-views.ts';
import { rootsContract } from './roots.ts';
import { statsContract } from './stats.ts';
import { uploadsContract } from './uploads.ts';
import { verifyContract } from './verify.ts';

/**
 * The tenant administrative API. Paths are relative to the tenant base:
 * `/t/<slug>` at the Worker and `/` inside the Durable Object. The server and
 * CLI both derive their implementations from this contract.
 */
export const tenantContract = {
	caches: cachesContract,
	keys: keysContract,
	policies: policiesContract,
	reuseViews: reuseViewsContract,
	oidcTrust: oidcTrustContract,
	stats: statsContract,
	check: checkContract,
	roots: rootsContract,
	paths: pathsContract,
	gc: gcContract,
	verify: verifyContract,
	uploads: uploadsContract,
	attestations: attestationsContract
};

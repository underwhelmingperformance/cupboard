import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { z } from 'zod';

import { buildArtifactFromTree, type DeploymentArtifact } from './artifact.ts';
import { createEsbuildBundler } from './bundle.ts';
import { findCheckoutRoot } from './source.ts';

// Bundling both real Workers and booting them in workerd is the integration
// proof that the esbuild config produces deployable bytes: the heavy server
// dependencies (the AWS SDK under `nodejs_compat`, the Durable Object's inlined
// `.sql` migrations) must survive bundling and run.
let miniflare: Miniflare;
let artifact: DeploymentArtifact;

beforeAll(async () => {
	const checkoutRoot = z.string().parse(findCheckoutRoot(process.cwd()));

	artifact = await buildArtifactFromTree(checkoutRoot, createEsbuildBundler());

	miniflare = new Miniflare({
		workers: [
			{
				name: 'cupboard',
				modules: true,
				script: artifact.controlBundle.code,
				compatibilityDate: artifact.config.control.compatibilityDate,
				compatibilityFlags: [...artifact.config.control.compatibilityFlags],
				durableObjects: {
					CUPBOARD_DO: {
						className: 'CupboardServer',
						scriptName: 'cupboard-tenant'
					}
				},
				r2Buckets: ['BLOBS'],
				kvNamespaces: ['TENANT_CACHE', 'CRON_STATE'],
				d1Databases: ['CUPBOARD_DB'],
				queueProducers: { MAINTENANCE_QUEUE: 'cupboard-maintenance' },
				bindings: { ...artifact.config.control.vars }
			},
			{
				name: 'cupboard-tenant',
				modules: true,
				script: artifact.tenantBundle.code,
				compatibilityDate: artifact.config.tenant.compatibilityDate,
				compatibilityFlags: [...artifact.config.tenant.compatibilityFlags],
				durableObjects: { CUPBOARD_DO: 'CupboardServer' },
				r2Buckets: ['BLOBS'],
				d1Databases: ['CUPBOARD_DB'],
				bindings: { ...artifact.config.tenant.vars }
			}
		]
	});
}, 30_000);

afterAll(async () => {
	await miniflare.dispose();
});

it('bundles both Workers into bytes workerd can serve', async () => {
	// The first dispatch boots workerd with both bundled Workers and the
	// Durable Object, which can run past the default 5s under load.
	const response = await miniflare.dispatchFetch(
		'https://cupboard.store/_health'
	);

	expect({
		status: response.status,
		body: await response.text()
	}).toStrictEqual({
		status: 200,
		body: 'ok\n'
	});
}, 30_000);

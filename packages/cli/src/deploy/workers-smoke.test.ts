import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { z } from 'zod';

import { buildArtifactFromTree } from './artifact.ts';
import { createEsbuildBundler } from './bundle.ts';
import { type DurableObjectExport } from './config.ts';
import { findCheckoutRoot } from './source.ts';

// Bundling both real Workers and booting them in workerd is the integration
// proof that the esbuild config produces deployable bytes: the heavy server
// dependencies (the AWS SDK under `nodejs_compat`, the Durable Object's inlined
// `.sql` migrations) must survive bundling and run.
const state: {
	miniflare?: Miniflare;
	tenantExports?: Readonly<Record<string, DurableObjectExport>>;
	hasVersionedR2ObjectRollbackGuardExport?: boolean;
} = {};

function activeMiniflare(): Miniflare {
	if (state.miniflare === undefined) {
		throw new Error('Miniflare was not started.');
	}

	return state.miniflare;
}

beforeAll(async () => {
	const checkoutRoot = z.string().parse(findCheckoutRoot(process.cwd()));

	const artifact = await buildArtifactFromTree(
		checkoutRoot,
		createEsbuildBundler()
	);
	state.tenantExports = artifact.config.tenant.exports;
	state.hasVersionedR2ObjectRollbackGuardExport =
		/export \{[\s\S]*\bVersionedR2ObjectRollbackGuard\b[\s\S]*\};/.test(
			artifact.tenantBundle.code
		);

	state.miniflare = new Miniflare({
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
	await state.miniflare?.dispose();
});

it('bundles both Workers into bytes workerd can serve', async () => {
	const response = await activeMiniflare().dispatchFetch(
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

it('couples versioned R2 object keys to declarative class lifecycle', () => {
	expect({
		exports: state.tenantExports,
		hasRollbackGuardExport: state.hasVersionedR2ObjectRollbackGuardExport
	}).toStrictEqual({
		exports: {
			CupboardServer: { type: 'durable-object', storage: 'sqlite' },
			VersionedR2ObjectRollbackGuard: {
				type: 'durable-object',
				storage: 'sqlite'
			}
		},
		hasRollbackGuardExport: true
	});
});

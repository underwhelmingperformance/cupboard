import { tenantContract } from '@cupboard/protocol/contract';
import { createORPCClient, isDefinedError, safe } from '@orpc/client';
import type { ContractRouterClient } from '@orpc/contract';
import { ResponseValidationPlugin } from '@orpc/contract/plugins';
import type { JsonifiedClient } from '@orpc/openapi-client';
import { OpenAPILink } from '@orpc/openapi-client/fetch';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';

import {
	bootstrap,
	currentOrigin,
	currentServer,
	mintServerSignedToken,
	narBytes,
	pushPath,
	resetTestServer,
	uploadMetadata,
	useTestServer
} from '../test-support.ts';

type TenantClient = JsonifiedClient<
	ContractRouterClient<typeof tenantContract>
>;

// The real derived client, exactly as the CLI builds it: the OpenAPI link over
// the contract, with responses validated against the contract's output
// schemas. Requests reach the Durable Object the harness targets, so the lock
// covers the mounted handler, the middleware chain and the services.
function tenantClient(token: string): TenantClient {
	const link = new OpenAPILink(tenantContract, {
		url: currentOrigin(),
		headers: { authorization: `Bearer ${token}` },
		fetch: (request) => currentServer().fetch(request),
		plugins: [new ResponseValidationPlugin(tenantContract)]
	});

	return createORPCClient(link);
}

describe('tenant contract round trip', () => {
	beforeEach(resetTestServer);

	it('drives the cache registry through the derived client', async () => {
		await useTestServer('contract-caches');
		const init = await bootstrap();
		const client = tenantClient(init.token);

		const created = await client.caches.put({
			cacheName: 'builds',
			priority: 30
		});
		const listed = await client.caches.list();
		const removed = await client.caches.remove({
			params: { cacheName: 'builds' }
		});

		expect({ created, listed, removed }).toStrictEqual({
			created: { name: 'builds', priority: 30, storePaths: 0 },
			listed: {
				caches: [
					{ name: '', priority: 40, storePaths: 0 },
					{ name: 'builds', priority: 30, storePaths: 0 }
				]
			},
			removed: { name: 'builds', removed: true, storePathsRemoved: 0 }
		});
	});

	it('answers a refused teardown as the defined CACHE_NOT_EMPTY error', async () => {
		await useTestServer('contract-cache-not-empty');
		const init = await bootstrap();
		const client = tenantClient(init.token);
		await pushPath(
			init.token,
			uploadMetadata({ fileSize: narBytes.byteLength }),
			'builds'
		);

		const [error, data, isDefined] = await safe(
			client.caches.remove({ params: { cacheName: 'builds' } })
		);
		const forced = await client.caches.remove({
			params: { cacheName: 'builds' },
			query: { force: true }
		});

		if (!isDefinedError(error)) {
			throw new Error('expected a defined contract error');
		}

		expect({
			isDefined,
			data,
			code: error.code,
			status: error.status,
			errorData: error.data,
			forced
		}).toStrictEqual({
			isDefined: true,
			data: undefined,
			code: 'CACHE_NOT_EMPTY',
			status: StatusCodes.CONFLICT,
			errorData: { cache: 'builds' },
			forced: { name: 'builds', removed: true, storePathsRemoved: 1 }
		});
	});

	it('drives both key sets through the derived client', async () => {
		await useTestServer('contract-keys');
		const init = await bootstrap();
		const client = tenantClient(init.token);

		const rotated = await client.keys.signing.rotate();
		const retired = await client.keys.signing.retire({
			id: rotated.rotated.id
		});
		const authRotated = await client.keys.auth.rotate();
		const authListed = await client.keys.auth.list();

		expect({
			retired,
			rotatedIsListed: rotated.keys.some(
				(key) => key.id === rotated.rotated.id
			),
			authRotatedListed: authListed.keys.some(
				(key) => key.kid === authRotated.rotated && key.active
			)
		}).toStrictEqual({
			retired: { id: rotated.rotated.id, stage: 'publication' },
			rotatedIsListed: true,
			authRotatedListed: true
		});
	});

	it('drives policies and trust rules through the derived client', async () => {
		await useTestServer('contract-policies-trust');
		const init = await bootstrap();
		const client = tenantClient(init.token);

		const policy = await client.policies.add({
			scope: 'root-name-prefix',
			pattern: 'pr-',
			ttlSeconds: 604_800
		});
		const policies = await client.policies.list();
		const policyRemoved = await client.policies.remove({ id: policy.id });

		const rule = await client.oidcTrust.add({
			issuer: 'https://token.actions.githubusercontent.com',
			audience: 'https://cache.example.workers.dev',
			claims: { repository_owner_id: '5678' },
			allowedRoots: ['github:owner/']
		});
		const ruleRemoved = await client.oidcTrust.remove({ id: rule.id });

		expect({
			policyListed: policies.policies.map((entry) => entry.id),
			policyRemoved,
			ruleScope: rule.scope,
			ruleRemoved
		}).toStrictEqual({
			policyListed: [policy.id],
			policyRemoved: { id: policy.id, removed: true },
			ruleScope: 'write',
			ruleRemoved: { id: rule.id, removed: true }
		});
	});

	it('serves stats, usage and check, addressing the default cache as _default', async () => {
		await useTestServer('contract-stats');
		const init = await bootstrap();
		const client = tenantClient(init.token);
		await pushPath(
			init.token,
			uploadMetadata({ fileSize: narBytes.byteLength })
		);

		const stats = await client.stats.cache({ cacheName: '_default' });
		const usage = await client.stats.usage();
		const report = await client.check.run({ deep: true });

		expect({
			storePaths: stats.storePaths,
			chargedBlobs: usage.narBlobs,
			report: {
				narInfosChecked: report.narInfosChecked,
				complete: report.complete,
				discrepancies: report.discrepancies
			}
		}).toStrictEqual({
			storePaths: 1,
			chargedBlobs: 1,
			report: { narInfosChecked: 1, complete: true, discrepancies: [] }
		});
	});

	it('drives roots, path deletion and gc through the derived client', async () => {
		await useTestServer('contract-roots');
		const init = await bootstrap();
		const client = tenantClient(init.token);
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		await pushPath(init.token, metadata);

		const set = await client.roots.set({
			cacheName: '_default',
			name: 'github:owner/repo/main',
			targets: [metadata.storePath]
		});
		const listed = await client.roots.list({ cacheName: '_default' });
		const removedRoot = await client.roots.remove({
			cacheName: '_default',
			name: 'github:owner/repo/main'
		});
		const removedPath = await client.paths.remove({
			cacheName: '_default',
			hash: metadata.storePathHash
		});
		const swept = await client.gc.runAll();

		expect({
			setTargets: set.targets.map((entry) => entry.present),
			listedNames: listed.roots.map((entry) => entry.name),
			removedRoot,
			removedPath: {
				deleted: removedPath.deleted,
				storePathHash: removedPath.storePathHash
			},
			sweptOk: swept.ok
		}).toStrictEqual({
			setTargets: [true],
			listedNames: ['github:owner/repo/main'],
			removedRoot: { name: 'github:owner/repo/main', removed: true },
			removedPath: { deleted: true, storePathHash: metadata.storePathHash },
			sweptOk: true
		});
	});

	it('refuses a write-scoped token on an admin procedure', async () => {
		await useTestServer('contract-scope');
		await bootstrap();
		const client = tenantClient(await mintServerSignedToken('write'));

		const [error, data, isDefined] = await safe(client.caches.list());

		if (!isDefinedError(error)) {
			throw new Error('expected a defined contract error');
		}

		expect({
			isDefined,
			data,
			code: error.code,
			status: error.status
		}).toStrictEqual({
			isDefined: true,
			data: undefined,
			code: 'FORBIDDEN',
			status: StatusCodes.FORBIDDEN
		});
	});
});

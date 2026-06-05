import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
	blobReferenceRows,
	blobStateNarHashes,
	clearBlobStorage,
	deleteTestBase,
	expectStats,
	expectStatsForTenant,
	handlerFetch,
	initialise,
	mintTokenForTenant,
	provisionNamedTenant,
	pushPath,
	pushPathToTenant,
	resetTestServer,
	tenantBlobRows,
	testServerFor,
	uploadMetadata,
	verifiableNar
} from '../test-support.ts';

import { defaultTenant } from './tenant-routing.ts';

// With the non-default-tenant write 501 lifted, a tenant writes through the Worker
// under its own `/t/<tenant>/` prefix. Its narinfo objects, reference edges and
// presence rows are tenant-scoped, while the verified NAR bytes are shared, so the
// store dedups at rest without leaking one tenant's mapping to another.

describe('multi-tenant writes', () => {
	beforeEach(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(deleteTestBase);
		await resetTestServer();
		await clearBlobStorage();
	});

	it('lets a non-default tenant push a path that serves only under its own prefix', async () => {
		const acmeIssuer = await provisionNamedTenant('acme');
		const token = await mintTokenForTenant(
			testServerFor('acme'),
			acmeIssuer,
			'write'
		);
		const nar = await verifiableNar('acme-write');
		const metadata = uploadMetadata({
			storePathHash: 'a'.repeat(32),
			references: [],
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});

		await pushPathToTenant('acme', token, metadata, nar);

		const served = await handlerFetch(
			`/t/acme/${metadata.storePathHash}.narinfo`
		);
		// The same store-path hash is unknown under the default tenant: the narinfo
		// object is tenant-scoped, so one tenant's mapping is invisible to another.
		const atDefault = await handlerFetch(
			`/t/${defaultTenant}/${metadata.storePathHash}.narinfo`
		);

		expect({
			served: served.status,
			atDefault: atDefault.status,
			edges: await blobReferenceRows(),
			presence: await tenantBlobRows()
		}).toStrictEqual({
			served: StatusCodes.OK,
			atDefault: StatusCodes.NOT_FOUND,
			edges: [
				{
					tenant: 'acme',
					cache: '',
					storePathHash: metadata.storePathHash,
					generation: 0,
					narHash: nar.narHash
				}
			],
			presence: [
				{
					tenant: 'acme',
					narHash: nar.narHash,
					fileSize: nar.narBytes.byteLength
				}
			]
		});
	});

	it('dedups a NAR pushed by two tenants into one shared blob with per-tenant edges', async () => {
		const acmeIssuer = await provisionNamedTenant('acme');
		const acmeToken = await mintTokenForTenant(
			testServerFor('acme'),
			acmeIssuer,
			'write'
		);
		const defaultToken = await initialise();
		const nar = await verifiableNar('shared-write');
		const metadata = uploadMetadata({
			storePathHash: 'a'.repeat(32),
			references: [],
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});

		// The default tenant pushes the NAR, then the other tenant pushes the same NAR.
		// Negotiate is existence-oracle-safe, so the second tenant still uploads; the
		// promote dedups onto the one shared blob.
		await pushPath(defaultToken, metadata, undefined, nar);
		await pushPathToTenant('acme', acmeToken, metadata, nar);

		const presence = await tenantBlobRows();
		const edges = await blobReferenceRows();

		expect({
			sharedBlobs: await blobStateNarHashes(),
			presenceTenants: presence.map((row) => row.tenant).toSorted(),
			presenceSizes: presence.map((row) => row.fileSize),
			edgeTenants: edges.map((edge) => edge.tenant).toSorted()
		}).toStrictEqual({
			sharedBlobs: [{ narHash: nar.narHash }],
			presenceTenants: ['acme', defaultTenant],
			presenceSizes: [nar.narBytes.byteLength, nar.narBytes.byteLength],
			edgeTenants: ['acme', defaultTenant]
		});
	});

	it('reports blob totals scoped to the tenant', async () => {
		const acmeIssuer = await provisionNamedTenant('acme');
		const acmeToken = await mintTokenForTenant(
			testServerFor('acme'),
			acmeIssuer,
			'admin'
		);
		const defaultToken = await initialise();
		const defaultNar = await verifiableNar('default-stats');
		const acmeNar = await verifiableNar('acme-stats');
		const defaultMetadata = uploadMetadata({
			storePathHash: 'a'.repeat(32),
			references: [],
			narHash: defaultNar.narHash,
			narSize: defaultNar.narSize,
			fileHash: defaultNar.fileHash,
			fileSize: defaultNar.narBytes.byteLength
		});
		const acmeMetadata = uploadMetadata({
			storePathHash: 'b'.repeat(32),
			references: [],
			narHash: acmeNar.narHash,
			narSize: acmeNar.narSize,
			fileHash: acmeNar.fileHash,
			fileSize: acmeNar.narBytes.byteLength
		});

		await pushPath(defaultToken, defaultMetadata, undefined, defaultNar);
		await pushPathToTenant('acme', acmeToken, acmeMetadata, acmeNar);

		await expectStats(defaultToken, {
			storePaths: 1,
			narBlobs: 1,
			pendingUploads: 0,
			totalFileSize: defaultNar.narBytes.byteLength
		});
		await expectStatsForTenant('acme', acmeToken, {
			storePaths: 1,
			narBlobs: 1,
			pendingUploads: 0,
			totalFileSize: acmeNar.narBytes.byteLength
		});
	});
});

import { env } from 'cloudflare:workers';
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
	stageDeferredForTenant,
	suspendTenant,
	tenantBlobRows,
	tenantMaintained,
	tenantUploadStatus,
	testServerFor,
	uploadMetadata,
	verifiableNar
} from '../test-support.ts';

import {
	enqueueMaintenanceJobs,
	executeMaintenanceQueueMessage,
	type MaintenanceQueueMessage,
	runCronSweep
} from './scheduled.ts';
import { fixtureTenant } from './tenant-routing.test-support.ts';

// Stages a deferred upload for a freshly provisioned tenant, returning the write
// token and the upload id to poll. Used to seed each tenant with work the cron's
// background verify pass must reach.
async function stageDeferredForNewTenant(
	id: string
): Promise<{ readonly token: string; readonly uploadId: string }> {
	const issuer = await provisionNamedTenant(id);
	const token = await mintTokenForTenant(testServerFor(id), issuer, 'write');
	const nar = await verifiableNar(`sweep-${id}`);
	const metadata = uploadMetadata({
		storePathHash: 'a'.repeat(32),
		references: [],
		narHash: nar.narHash,
		narSize: nar.narSize,
		fileHash: nar.fileHash,
		fileSize: nar.narBytes.byteLength
	});
	const uploadId = await stageDeferredForTenant(id, token, metadata, nar);

	return { token, uploadId };
}

// With the named-tenant write gate lifted, a tenant writes through the Worker
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

	it('lets a named tenant push a path that serves only under its own prefix', async () => {
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
		// The same store-path hash is unknown under the fixture tenant: the narinfo
		// object is tenant-scoped, so one tenant's mapping is invisible to another.
		const atFixture = await handlerFetch(
			`/t/${fixtureTenant}/${metadata.storePathHash}.narinfo`
		);

		expect({
			served: served.status,
			atFixture: atFixture.status,
			edges: await blobReferenceRows(),
			presence: await tenantBlobRows()
		}).toStrictEqual({
			served: StatusCodes.OK,
			atFixture: StatusCodes.NOT_FOUND,
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
		const fixtureToken = await initialise();
		const nar = await verifiableNar('shared-write');
		const metadata = uploadMetadata({
			storePathHash: 'a'.repeat(32),
			references: [],
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});

		// The fixture tenant pushes the NAR, then the other tenant pushes the same NAR.
		// Negotiate is existence-oracle-safe, so the second tenant still uploads; the
		// promote dedups onto the one shared blob.
		await pushPath(fixtureToken, metadata, undefined, nar);
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
			presenceTenants: ['acme', fixtureTenant],
			presenceSizes: [nar.narBytes.byteLength, nar.narBytes.byteLength],
			edgeTenants: ['acme', fixtureTenant]
		});
	});

	it('reports blob totals scoped to the tenant', async () => {
		const acmeIssuer = await provisionNamedTenant('acme');
		const acmeToken = await mintTokenForTenant(
			testServerFor('acme'),
			acmeIssuer,
			'admin'
		);
		const fixtureToken = await initialise();
		const fixtureNar = await verifiableNar('fixture-stats');
		const acmeNar = await verifiableNar('acme-stats');
		const fixtureMetadata = uploadMetadata({
			storePathHash: 'a'.repeat(32),
			references: [],
			narHash: fixtureNar.narHash,
			narSize: fixtureNar.narSize,
			fileHash: fixtureNar.fileHash,
			fileSize: fixtureNar.narBytes.byteLength
		});
		const acmeMetadata = uploadMetadata({
			storePathHash: 'b'.repeat(32),
			references: [],
			narHash: acmeNar.narHash,
			narSize: acmeNar.narSize,
			fileHash: acmeNar.fileHash,
			fileSize: acmeNar.narBytes.byteLength
		});

		await pushPath(fixtureToken, fixtureMetadata, undefined, fixtureNar);
		await pushPathToTenant('acme', acmeToken, acmeMetadata, acmeNar);

		await expectStats(fixtureToken, {
			storePaths: 1,
			narBlobs: 1,
			pendingUploads: 0,
			totalFileSize: fixtureNar.narBytes.byteLength
		});
		await expectStatsForTenant('acme', acmeToken, {
			storePaths: 1,
			narBlobs: 1,
			pendingUploads: 0,
			totalFileSize: acmeNar.narBytes.byteLength
		});
	});

	it('drives a named tenant deferred upload to servable from the scheduled handler', async () => {
		const acmeIssuer = await provisionNamedTenant('acme');
		const token = await mintTokenForTenant(
			testServerFor('acme'),
			acmeIssuer,
			'write'
		);
		const nar = await verifiableNar('acme-deferred');
		const metadata = uploadMetadata({
			storePathHash: 'a'.repeat(32),
			references: [],
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});

		// A deferred upload only becomes servable once the background verify pass runs.
		// The cron must reach acme's object, not just the fixture tenant's, or acme's
		// pending uploads would never commit.
		const uploadId = await stageDeferredForTenant('acme', token, metadata, nar);
		const whilePending = await tenantUploadStatus('acme', token, uploadId);

		await runQueuedMaintenanceTick();

		// The settled upload leaves no residue, so its status clears and the proof
		// of the commit is the narinfo serving under acme's prefix.
		const afterCron = await tenantUploadStatus('acme', token, uploadId);
		const served = await handlerFetch(
			`/t/acme/${metadata.storePathHash}.narinfo`
		);

		expect({ whilePending, afterCron, served: served.status }).toStrictEqual({
			whilePending: 'pending',
			afterCron: 'absent',
			served: StatusCodes.OK
		});
	});

	it('maintains the most-overdue tenants first, covering the fleet over ticks', async () => {
		// Three tenants, all never-maintained (NULL `last_maintained_at`); the fixture
		// tenant is suspended so the active fleet is exactly these three.
		await stageDeferredForNewTenant('acme');
		await stageDeferredForNewTenant('beta');
		await stageDeferredForNewTenant('gamma');
		await suspendTenant(fixtureTenant);

		// A batch of two: the first tick takes the two most-overdue (all NULL, so by
		// slug tiebreaker acme and beta), maintains and stamps them; gamma is left.
		await runCronSweep(env, 2);
		const afterFirst = {
			acme: await servedAt('acme'),
			beta: await servedAt('beta'),
			gamma: await servedAt('gamma'),
			acmeStamped: await tenantMaintained('acme'),
			gammaStamped: await tenantMaintained('gamma')
		};

		// The second tick: gamma is now the most overdue (still NULL, while acme and
		// beta carry a stamp), so it is maintained next.
		await runCronSweep(env, 2);
		const gammaAfterSecond = await servedAt('gamma');

		expect({
			afterFirst,
			gammaAfterSecond,
			gammaStampedAfterSecond: await tenantMaintained('gamma')
		}).toStrictEqual({
			afterFirst: {
				acme: StatusCodes.OK,
				beta: StatusCodes.OK,
				gamma: StatusCodes.NOT_FOUND,
				acmeStamped: true,
				gammaStamped: false
			},
			gammaAfterSecond: StatusCodes.OK,
			gammaStampedAfterSecond: true
		});
	});
});

// The staged uploads all share the `'a'.repeat(32)` store path, so whether its
// narinfo serves under a tenant's prefix shows whether that tenant's verify
// pass has run.
async function servedAt(id: string): Promise<number> {
	const response = await handlerFetch(`/t/${id}/${'a'.repeat(32)}.narinfo`);

	return response.status;
}

async function runQueuedMaintenanceTick(): Promise<void> {
	const messages = await enqueueMaintenanceJobs(env, queueCollector());

	for (const message of messages) {
		await executeMaintenanceQueueMessage(env, message);
	}
}

function queueCollector(): {
	readonly sendBatch: (
		batch: Iterable<{ readonly body: MaintenanceQueueMessage }>
	) => Promise<QueueSendBatchResponse>;
} {
	return { sendBatch: () => Promise.resolve(queueSendBatchResponse()) };
}

function queueSendBatchResponse(): QueueSendBatchResponse {
	return {
		metadata: {
			metrics: {
				backlogBytes: 0,
				backlogCount: 0
			}
		}
	};
}

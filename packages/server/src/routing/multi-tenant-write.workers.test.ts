import { rootLogger } from '@cupboard/logger';
import { tenantIdSchema } from '@cupboard/nix-store/scalars';
import type { UploadId } from '@cupboard/protocol/upload';
import { env } from 'cloudflare:workers';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
	adminGrants,
	blobReferenceRows,
	blobStateNarHashes,
	cacheWriteGrants,
	clearBlobStorage,
	expectStats,
	expectStatsForTenant,
	handlerFetch,
	initialise,
	issueTokenForTenant,
	provisionNamedTenant,
	pushPath,
	pushPathToTenant,
	resetTestServer,
	stageDeferredForTenant,
	suspendTenant,
	tenantBlobRows,
	tenantUploadStatus,
	testBase,
	testServerFor,
	uploadMetadata,
	verifiableNar,
	wasTenantMaintained
} from '../test-support.ts';

import {
	enqueueMaintenanceJobs,
	executeMaintenanceQueueMessage,
	type MaintenanceQueueMessage,
	runMaintenanceBatch
} from './scheduled.ts';
import { fixtureTenant } from './tenant-routing.test-support.ts';

const acme = tenantIdSchema.parse('acme');

function byCodeUnit(a: string, b: string): number {
	if (a < b) {
		return -1;
	}
	if (a > b) {
		return 1;
	}
	return 0;
}

async function stageDeferredForNewTenant(
	id: string
): Promise<{ readonly token: string; readonly uploadId: UploadId }> {
	const issuer = await provisionNamedTenant(id);
	const token = await issueTokenForTenant(
		testServerFor(id),
		issuer,
		cacheWriteGrants()
	);
	const nar = await verifiableNar(`collect-${id}`);
	const metadata = uploadMetadata({
		storePathHash: 'a'.repeat(32),
		references: [],
		narHash: nar.narHash,
		narSize: nar.narSize,
		fileHash: nar.fileHash,
		fileSize: nar.narBytes.byteLength
	});
	const uploadId = await stageDeferredForTenant(
		tenantIdSchema.parse(id),
		token,
		metadata,
		nar
	);

	return { token, uploadId };
}

// With the named-tenant write gate lifted, a tenant writes through the Worker
// under its own `/t/<tenant>/` prefix. Its narinfo objects, reference edges and
// presence rows are tenant-scoped, while the verified NAR bytes are shared, so the
// store dedups at rest without leaking one tenant's mapping to another.

describe('multi-tenant writes', () => {
	beforeEach(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(testBase);
		await resetTestServer();
		await clearBlobStorage();
	});

	it('lets a named tenant push a path that serves only under its own prefix', async () => {
		const acmeIssuer = await provisionNamedTenant('acme');
		const token = await issueTokenForTenant(
			testServerFor('acme'),
			acmeIssuer,
			cacheWriteGrants()
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

		await pushPathToTenant(acme, token, metadata, nar);

		const served = await handlerFetch(
			`/t/acme/${metadata.storePathHash}.narinfo`
		);
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
		const acmeToken = await issueTokenForTenant(
			testServerFor('acme'),
			acmeIssuer,
			cacheWriteGrants()
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

		await pushPath(fixtureToken, metadata, undefined, nar);
		await pushPathToTenant(acme, acmeToken, metadata, nar);

		const presence = await tenantBlobRows();
		const edges = await blobReferenceRows();

		expect({
			sharedBlobs: await blobStateNarHashes(),
			presenceTenants: presence.map((row) => row.tenant).toSorted(byCodeUnit),
			presenceSizes: presence.map((row) => row.fileSize),
			edgeTenants: edges.map((edge) => edge.tenant).toSorted(byCodeUnit)
		}).toStrictEqual({
			sharedBlobs: [{ narHash: nar.narHash }],
			presenceTenants: ['acme', fixtureTenant],
			presenceSizes: [nar.narBytes.byteLength, nar.narBytes.byteLength],
			edgeTenants: ['acme', fixtureTenant]
		});
	});

	it('reports blob totals scoped to the tenant', async () => {
		const acmeIssuer = await provisionNamedTenant('acme');
		const acmeToken = await issueTokenForTenant(
			testServerFor('acme'),
			acmeIssuer,
			adminGrants()
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
		await pushPathToTenant(acme, acmeToken, acmeMetadata, acmeNar);

		await expectStats(fixtureToken, {
			storePaths: 1,
			narBlobs: 1,
			pendingUploads: 0,
			totalFileSize: fixtureNar.narBytes.byteLength
		});
		await expectStatsForTenant(acme, acmeToken, {
			storePaths: 1,
			narBlobs: 1,
			pendingUploads: 0,
			totalFileSize: acmeNar.narBytes.byteLength
		});
	});

	it('drives a named tenant deferred upload to servable from the scheduled handler', async () => {
		const acmeIssuer = await provisionNamedTenant('acme');
		const token = await issueTokenForTenant(
			testServerFor('acme'),
			acmeIssuer,
			cacheWriteGrants()
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

		const uploadId = await stageDeferredForTenant(acme, token, metadata, nar);
		const whilePending = await tenantUploadStatus(acme, token, uploadId);

		await runQueuedMaintenanceTick();

		const afterCron = await tenantUploadStatus(acme, token, uploadId);
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
		// All three tenants have a null maintenance timestamp. Suspend the fixture
		// tenant so it does not enter the scheduler's tie-break.
		await stageDeferredForNewTenant('acme');
		await stageDeferredForNewTenant('beta');
		await stageDeferredForNewTenant('gamma');
		await suspendTenant(fixtureTenant);

		await runMaintenanceBatch(rootLogger(), env, 2);
		await verifyTenants(['acme', 'beta']);
		const afterFirst = {
			acme: await servedAt('acme'),
			beta: await servedAt('beta'),
			gamma: await servedAt('gamma'),
			acmeStamped: await wasTenantMaintained('acme'),
			gammaStamped: await wasTenantMaintained('gamma')
		};

		// Gamma still has a null timestamp, so the second bounded tick must process
		// it before acme and beta.
		await runMaintenanceBatch(rootLogger(), env, 2);
		await verifyTenants(['gamma']);
		const gammaAfterSecond = await servedAt('gamma');

		expect({
			afterFirst,
			gammaAfterSecond,
			gammaStampedAfterSecond: await wasTenantMaintained('gamma')
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

async function servedAt(id: string): Promise<number> {
	const response = await handlerFetch(`/t/${id}/${'a'.repeat(32)}.narinfo`);

	return response.status;
}

async function runQueuedMaintenanceTick(): Promise<void> {
	const messages = await enqueueMaintenanceJobs(env, queueCollector());

	for (const message of messages) {
		await executeMaintenanceQueueMessage(rootLogger(), env, message);
	}

	await verifyTenants(
		messages.flatMap((message) =>
			message.kind === 'tenant-maintenance' ? [message.tenant] : []
		)
	);
}

async function verifyTenants(ids: readonly string[]): Promise<void> {
	for (const id of ids) {
		await executeMaintenanceQueueMessage(rootLogger(), env, {
			kind: 'tenant-verify',
			tenant: tenantIdSchema.parse(id)
		});
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

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

	// A delivered alarm can outlive a storage purge. Keep each test on a distinct
	// tenant object so an alarm from an earlier test cannot initialise its successor.

	it('lets a named tenant push a path that serves only under its own prefix', async () => {
		const tenant = tenantIdSchema.parse('write-acme');
		const issuer = await provisionNamedTenant(tenant);
		const token = await issueTokenForTenant(
			testServerFor(tenant),
			issuer,
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

		await pushPathToTenant(tenant, token, metadata, nar);

		const served = await handlerFetch(
			`/t/${tenant}/${metadata.storePathHash}.narinfo`
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
					tenant,
					cache: { kind: 'default' },
					storePathHash: metadata.storePathHash,
					generation: 0,
					narHash: nar.narHash,
					cacheGeneration: 1
				}
			],
			presence: [
				{
					tenant,
					narHash: nar.narHash,
					fileSize: nar.narBytes.byteLength
				}
			]
		});
	});

	it('dedups a NAR pushed by two tenants into one shared blob with per-tenant edges', async () => {
		const tenant = tenantIdSchema.parse('shared-acme');
		const issuer = await provisionNamedTenant(tenant);
		const tenantToken = await issueTokenForTenant(
			testServerFor(tenant),
			issuer,
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
		await pushPathToTenant(tenant, tenantToken, metadata, nar);

		const presence = await tenantBlobRows();
		const edges = await blobReferenceRows();

		expect({
			sharedBlobs: await blobStateNarHashes(),
			presenceTenants: presence.map((row) => row.tenant).toSorted(byCodeUnit),
			presenceSizes: presence.map((row) => row.fileSize),
			edgeTenants: edges.map((edge) => edge.tenant).toSorted(byCodeUnit)
		}).toStrictEqual({
			sharedBlobs: [{ narHash: nar.narHash }],
			presenceTenants: [fixtureTenant, tenant].toSorted(byCodeUnit),
			presenceSizes: [nar.narBytes.byteLength, nar.narBytes.byteLength],
			edgeTenants: [fixtureTenant, tenant].toSorted(byCodeUnit)
		});
	});

	it('reports blob totals scoped to the tenant', async () => {
		const tenant = tenantIdSchema.parse('stats-acme');
		const issuer = await provisionNamedTenant(tenant);
		const tenantToken = await issueTokenForTenant(
			testServerFor(tenant),
			issuer,
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
		await pushPathToTenant(tenant, tenantToken, acmeMetadata, acmeNar);

		await expectStats(fixtureToken, {
			storePaths: 1,
			narBlobs: 1,
			pendingUploads: 0,
			totalFileSize: fixtureNar.narBytes.byteLength
		});
		await expectStatsForTenant(tenant, tenantToken, {
			storePaths: 1,
			narBlobs: 1,
			pendingUploads: 0,
			totalFileSize: acmeNar.narBytes.byteLength
		});
	});

	it('drives a named tenant deferred upload to servable from the scheduled handler', async () => {
		const tenant = tenantIdSchema.parse('deferred-acme');
		const issuer = await provisionNamedTenant(tenant);
		const token = await issueTokenForTenant(
			testServerFor(tenant),
			issuer,
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

		const uploadId = await stageDeferredForTenant(tenant, token, metadata, nar);
		const whilePending = await tenantUploadStatus(tenant, token, uploadId);

		await runQueuedMaintenanceTick();

		const afterCron = await tenantUploadStatus(tenant, token, uploadId);
		const served = await handlerFetch(
			`/t/${tenant}/${metadata.storePathHash}.narinfo`
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
		await stageDeferredForNewTenant('fleet-a');
		await stageDeferredForNewTenant('fleet-b');
		await stageDeferredForNewTenant('fleet-c');
		await suspendTenant(fixtureTenant);

		await runMaintenanceBatch(rootLogger(), env, 2);
		await verifyTenants(['fleet-a', 'fleet-b']);
		const afterFirst = {
			first: await servedAt('fleet-a'),
			second: await servedAt('fleet-b'),
			third: await servedAt('fleet-c'),
			firstStamped: await wasTenantMaintained('fleet-a'),
			thirdStamped: await wasTenantMaintained('fleet-c')
		};

		// The third tenant still has a null timestamp, so the second bounded tick
		// must process it before the first and second tenants.
		await runMaintenanceBatch(rootLogger(), env, 2);
		await verifyTenants(['fleet-c']);
		const thirdAfterSecond = await servedAt('fleet-c');

		expect({
			afterFirst,
			thirdAfterSecond,
			thirdStampedAfterSecond: await wasTenantMaintained('fleet-c')
		}).toStrictEqual({
			afterFirst: {
				first: StatusCodes.OK,
				second: StatusCodes.OK,
				third: StatusCodes.NOT_FOUND,
				firstStamped: true,
				thirdStamped: false
			},
			thirdAfterSecond: StatusCodes.OK,
			thirdStampedAfterSecond: true
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

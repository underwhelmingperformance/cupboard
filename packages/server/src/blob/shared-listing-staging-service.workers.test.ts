import { sha256HexDigestSchema } from '@cupboard/nix-store/scalars';
import { artifactTaskOwnerSchema } from '@cupboard/protocol/artifact-jobs';
import {
	currentListingGeneratorRevision,
	maxArtifactBytes
} from '@cupboard/protocol/artifacts';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';

import { sha256HexBytes } from '../crypto/crypto.ts';
import * as schema from '../db/d1-schema.ts';
import { SharedListingGenerationStore } from '../db/shared-listing-generation.ts';
import { SharedListingJobStore } from '../db/shared-listing-jobs.ts';
import { SharedListingStageStore } from '../db/shared-listing-staging.ts';
import { SharedListingTaskStore } from '../db/shared-listing-tasks.ts';
import { sharedNarDiscoveryFixture } from '../db/shared-nar-discovery.test-support.ts';
import { ArtifactTooLargeError } from '../errors.ts';

import { lateWriteTombstoneHorizonMs } from './object-incarnation.ts';
import { SharedListingStagingService } from './shared-listing-staging-service.ts';

const now = isoTimestamp(new Date('2026-01-01T00:00:00.000Z'));
const deadline = isoTimestamp(new Date('2026-01-01T00:01:00.000Z'));
const cleanupAt = isoTimestamp(
	new Date(Date.parse(now) + lateWriteTombstoneHorizonMs)
);
const retryAt = isoTimestamp(new Date(Date.parse(cleanupAt) + 30_000));
const owner = artifactTaskOwnerSchema.parse(
	'00000000-0000-4000-8000-000000000001'
);
const otherOwner = artifactTaskOwnerSchema.parse(
	'00000000-0000-4000-8000-000000000002'
);
const bytes = new TextEncoder().encode('native listing bytes');

async function fixture() {
	const { database } = await sharedNarDiscoveryFixture();
	const jobs = new SharedListingJobStore(database);
	const job = await jobs.start(currentListingGeneratorRevision, now);
	const discovery = await jobs.claim(job, owner, now);
	if (discovery.kind !== 'claimed') {
		throw new Error('Discovery ownership was not granted');
	}
	await jobs.discover(discovery.claim);
	const row = await database.select().from(schema.sharedListingTask).get();
	if (row === undefined) {
		throw new Error('The global task is missing');
	}
	const tasks = new SharedListingTaskStore(database);
	const task = await tasks.claim(
		{ job: { id: job.id, generation: job.generation }, id: row.id, owner },
		now
	);
	if (task.kind !== 'claimed') {
		throw new Error('Task ownership was not granted');
	}
	const generation = new SharedListingGenerationStore(database);
	const computation = await generation.claim(task.claim, now);
	if (computation.kind !== 'claimed') {
		throw new Error('Computation ownership was not granted');
	}
	const store = new SharedListingStageStore(database);
	const stage = await store.reserve(computation.claim, now);
	if (stage.kind !== 'writing') {
		throw new Error('An unsealed stage was not reserved');
	}
	const lease = stage.lease;
	let current = now;
	const service = new SharedListingStagingService({
		database: env.CUPBOARD_DB,
		blobs: env.BLOBS,
		now: () => current
	});
	const advance = (at: typeof now) => {
		current = at;
	};
	const measurement = {
		digest: sha256HexDigestSchema.parse(await sha256HexBytes(bytes)),
		size: bytes.byteLength
	};
	async function create() {
		const upload = await service.create(lease);
		if (upload === undefined) {
			throw new Error('The multipart upload was not created');
		}
		return upload;
	}
	async function complete() {
		const upload = await create();
		const part = await upload.uploadPart(1, bytes);
		await upload.complete([part]);
		return upload;
	}
	return {
		database,
		jobs,
		job,
		computation: computation.claim,
		stage,
		store,
		service,
		advance,
		measurement,
		create,
		complete
	};
}

describe('shared listing staging R2 lifecycle', () => {
	it('registers a real multipart upload and seals its measured completed bytes', async () => {
		const { service, store, stage, measurement, complete } = await fixture();
		const upload = await complete();
		const object = await env.BLOBS.get(stage.lease.key);
		expect({
			sealed: await service.seal(stage.lease, upload.uploadId, measurement),
			replay: await service.seal(stage.lease, upload.uploadId, measurement),
			ready: await store.ready(stage.lease, now),
			storedBytes: await object?.text()
		}).toStrictEqual({
			sealed: true,
			replay: true,
			ready: measurement,
			storedBytes: 'native listing bytes'
		});
	});

	it('aborts the extra multipart allocation when one stage is created concurrently', async () => {
		const { service, store, stage } = await fixture();
		const original = env.BLOBS.createMultipartUpload.bind(env.BLOBS);
		const created: R2MultipartUpload[] = [];
		const observed = vi
			.spyOn(env.BLOBS, 'createMultipartUpload')
			.mockImplementation(async (key) => {
				const upload = await original(key);
				created.push(upload);
				return upload;
			});
		try {
			const results = await Promise.all([
				service.create(stage.lease),
				service.create(stage.lease)
			]);
			const uploads = results.filter((upload) => upload !== undefined);
			const winner = uploads[0];
			const loser = created.find(
				(upload) => upload.uploadId !== winner?.uploadId
			);
			if (winner === undefined || loser === undefined) {
				throw new Error('The competing multipart allocations are missing');
			}
			expect({
				granted: uploads.map((upload) => upload.uploadId),
				reservation: await store.reserve(stage.lease.claim, now)
			}).toStrictEqual({
				granted: [winner.uploadId],
				reservation: { ...stage, multipartId: winner.uploadId }
			});
			await expect(loser.uploadPart(1, bytes)).rejects.toThrow();
			await winner.uploadPart(1, bytes);
		} finally {
			observed.mockRestore();
		}
	});

	it('does not create an upload after cancellation', async () => {
		const { service, stage, jobs, job } = await fixture();
		await jobs.cancel(job, now);
		const create = vi.spyOn(env.BLOBS, 'createMultipartUpload');
		try {
			expect(await service.create(stage.lease)).toBeUndefined();
			expect(create).not.toHaveBeenCalled();
		} finally {
			create.mockRestore();
		}
	});

	it('aborts a late creation after recording its upload identity for cleanup', async () => {
		const { service, store, stage, advance, computation } = await fixture();
		const original = env.BLOBS.createMultipartUpload.bind(env.BLOBS);
		let created: R2MultipartUpload | undefined;
		const delayed = vi
			.spyOn(env.BLOBS, 'createMultipartUpload')
			.mockImplementation(async (key) => {
				created = await original(key);
				advance(deadline);
				return created;
			});
		try {
			const result = await service.create(stage.lease);
			if (created === undefined) {
				throw new Error('The delayed upload was not created');
			}
			const cleanup = await store.claimCleanup(
				stage.lease.id,
				owner,
				cleanupAt
			);
			expect({
				result,
				cleanup,
				reservation: await store.reserve(computation, deadline)
			}).toStrictEqual({
				result: undefined,
				cleanup: {
					id: stage.lease.id,
					key: stage.lease.key,
					generation: 1,
					owner,
					leaseExpiresAt: retryAt,
					multipartId: created.uploadId
				},
				reservation: { kind: 'unavailable' }
			});
			await expect(created.uploadPart(1, bytes)).rejects.toThrow();
		} finally {
			delayed.mockRestore();
		}
	});

	it('aborts the upload when multipart registration commits but loses its reply', async () => {
		const { service, store, stage } = await fixture();
		const register = store.registerMultipart.bind(store);
		const lost = new Error('Registration reply was lost');
		const interrupted = vi
			.spyOn(SharedListingStageStore.prototype, 'registerMultipart')
			.mockImplementationOnce(async (...arguments_) => {
				await register(...arguments_);
				throw lost;
			});
		try {
			await expect(service.create(stage.lease)).rejects.toThrow(lost);
			const reservation = await store.reserve(stage.lease.claim, now);
			if (
				reservation.kind !== 'writing' ||
				reservation.multipartId === undefined
			) {
				throw new Error('The committed upload identity is missing');
			}
			await expect(
				env.BLOBS.resumeMultipartUpload(
					stage.lease.key,
					reservation.multipartId
				).uploadPart(1, bytes)
			).rejects.toThrow();
		} finally {
			interrupted.mockRestore();
		}
	});

	it('does not seal missing or differently sized R2 bytes', async () => {
		const { service, store, stage, measurement, create } = await fixture();
		const upload = await create();
		const isMissing = await service.seal(
			stage.lease,
			upload.uploadId,
			measurement
		);
		const part = await upload.uploadPart(1, bytes);
		await upload.complete([part]);
		expect({
			missing: isMissing,
			wrongSize: await service.seal(stage.lease, upload.uploadId, {
				...measurement,
				size: measurement.size + 1
			}),
			ready: await store.ready(stage.lease, now)
		}).toStrictEqual({ missing: false, wrongSize: false, ready: undefined });
	});

	it('refuses oversized measurements before reading R2 metadata', async () => {
		const { service, stage, measurement } = await fixture();
		const head = vi.spyOn(env.BLOBS, 'head');
		try {
			await expect(
				service.seal(stage.lease, 'upload', {
					...measurement,
					size: maxArtifactBytes.listing + 1
				})
			).rejects.toBeInstanceOf(ArtifactTooLargeError);
			expect(head).not.toHaveBeenCalled();
		} finally {
			head.mockRestore();
		}
	});

	it('records verified late completion as retired and removes its bytes', async () => {
		const { service, store, stage, measurement, complete, advance } =
			await fixture();
		const upload = await complete();
		advance(deadline);
		expect({
			sealed: await service.seal(stage.lease, upload.uploadId, measurement),
			ready: await store.ready(stage.lease, deadline),
			cleanup: await service.collect(stage.lease.id, owner),
			object: (await env.BLOBS.head(stage.lease.key)) ?? undefined,
			due: await store.due(deadline)
		}).toStrictEqual({
			sealed: false,
			ready: undefined,
			cleanup: { kind: 'removed' },
			object: undefined,
			due: { stages: [], hasMore: false }
		});
	});

	it('cleans completed bytes after a crash before the seal was recorded', async () => {
		const { service, store, stage, complete, advance } = await fixture();
		await complete();
		advance(cleanupAt);
		expect({
			cleanup: await service.collect(stage.lease.id, owner),
			object: (await env.BLOBS.head(stage.lease.key)) ?? undefined,
			due: await store.due(cleanupAt)
		}).toStrictEqual({
			cleanup: { kind: 'removed' },
			object: undefined,
			due: { stages: [], hasMore: false }
		});
	});

	it('defers failed deletion and retries after the multipart upload was already aborted', async () => {
		const { service, store, stage, create, advance } = await fixture();
		await create();
		advance(cleanupAt);
		const deletion = vi
			.spyOn(env.BLOBS, 'delete')
			.mockRejectedValueOnce(new Error('R2 deletion failed'));
		try {
			expect({
				result: await service.collect(stage.lease.id, owner),
				due: await store.due(cleanupAt)
			}).toStrictEqual({
				result: { kind: 'deferred', retryAt },
				due: { stages: [], hasMore: false }
			});
			advance(retryAt);
			expect({
				result: await service.collect(stage.lease.id, otherOwner),
				due: await store.due(retryAt)
			}).toStrictEqual({
				result: { kind: 'removed' },
				due: { stages: [], hasMore: false }
			});
		} finally {
			deletion.mockRestore();
		}
	});

	it.each([
		{
			description: 'missing upload',
			code: 10_024,
			result: { kind: 'removed' },
			expectedCalls: 1
		},
		{
			description: 'storage failure',
			code: 10_001,
			result: { kind: 'deferred', retryAt },
			expectedCalls: 0
		}
	])(
		'handles a multipart abort reporting $description',
		async ({ code, result, expectedCalls }) => {
			const { service, stage, create, advance } = await fixture();
			const created = await create();
			await created.abort();
			const handle = env.BLOBS.resumeMultipartUpload(
				stage.lease.key,
				created.uploadId
			);
			const abort = vi
				.spyOn(handle, 'abort')
				.mockRejectedValue(
					new Error(`abortMultipartUpload: provider failure (${String(code)})`)
				);
			const resume = vi
				.spyOn(env.BLOBS, 'resumeMultipartUpload')
				.mockReturnValue(handle);
			const deletion = vi.spyOn(env.BLOBS, 'delete');
			advance(cleanupAt);
			try {
				expect({
					result: await service.collect(stage.lease.id, owner),
					deleted: deletion.mock.calls.map(([key]) => key)
				}).toStrictEqual({
					result,
					deleted: expectedCalls === 0 ? [] : [stage.lease.key]
				});
			} finally {
				deletion.mockRestore();
				resume.mockRestore();
				abort.mockRestore();
			}
		}
	);

	it('rechecks cancellation after R2 confirms completed bytes', async () => {
		const { service, stage, jobs, job, measurement, complete } =
			await fixture();
		const upload = await complete();
		const original = env.BLOBS.head.bind(env.BLOBS);
		const delayed = vi
			.spyOn(env.BLOBS, 'head')
			.mockImplementation(async (key) => {
				const object = await original(key);
				await jobs.cancel(job, now);
				return object;
			});
		try {
			expect({
				sealed: await service.seal(stage.lease, upload.uploadId, measurement),
				cleanup: await service.collect(stage.lease.id, owner)
			}).toStrictEqual({ sealed: false, cleanup: { kind: 'removed' } });
		} finally {
			delayed.mockRestore();
		}
	});

	it('does not access R2 while a different cleanup owner has an active claim', async () => {
		const { service, store, stage, advance } = await fixture();
		await store.claimCleanup(stage.lease.id, owner, cleanupAt);
		advance(cleanupAt);
		const deletion = vi.spyOn(env.BLOBS, 'delete');
		try {
			expect(await service.collect(stage.lease.id, otherOwner)).toStrictEqual({
				kind: 'unavailable'
			});
			expect(deletion).not.toHaveBeenCalled();
		} finally {
			deletion.mockRestore();
		}
	});
});

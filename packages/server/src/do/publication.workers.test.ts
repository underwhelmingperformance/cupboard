import { publicationStagingKey } from '@cupboard/protocol/publication';
import {
	acceptCapabilitiesHeader,
	commitBatchMaxEntries,
	commitCapabilitiesValueWithCredit,
	type CommitSessionFrame,
	publicationCapability,
	type PublicationEntry,
	publicationRefusalReasonsCapability,
	pushCredentialSchema,
	uploadCapabilitiesHeader,
	type UploadPathNegotiation,
	uploadPlanResponseSchema
} from '@cupboard/protocol/upload';
import { uploadIdSchema } from '@cupboard/protocol/upload';
import { CountingSemaphore } from '@cupboard/shared/concurrency';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { StatusCodes } from 'http-status-codes';
import { decodeJwt } from 'jose';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../db/schema.ts';
import { defaultCommitEntryCreditBudget } from '../policy/commit-credit.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	authorisedFetch,
	closeSessionAndWait,
	commitCreditAccept,
	commitPath,
	commitUpload,
	currentNarObjectKey,
	currentServer,
	defaultCache,
	deletePath,
	initialise,
	namedCache,
	nixSha256Hash,
	openCommitSession,
	putNarBytes,
	recordClaimedVerification,
	resetTestServer,
	testPushId,
	testPushIdFor,
	uploadMetadata,
	uploadPathNegotiation,
	verifiableNar
} from '../test-support.ts';

import { CommitReuseGrantsService } from './commit-reuse-grants-service.ts';
import { PublicationStore } from './publication-store.ts';
import { UploadsService } from './uploads-service.ts';

it.each(
	[false, true].flatMap((accepted) =>
		['/uploads/credential', '/cache/new-cache/uploads/credential'].map(
			(path) => ({ accepted, path })
		)
	)
)(
	'selects publication credential scope over HTTP at $path with accepted=$accepted',
	async ({ accepted, path }) => {
		await resetTestServer();
		const token = await initialise();
		const before = await snapshot();
		const response = await authorisedFetch(path, token, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				...(accepted && { [acceptCapabilitiesHeader]: publicationCapability })
			},
			body: '{}'
		});
		const credential = pushCredentialSchema.parse(await response.json());
		const claims = decodeJwt(
			atob(credential.sessionToken).slice('jwt/'.length)
		);
		expect({
			status: response.status,
			capability: response.headers.get(uploadCapabilitiesHeader) ?? undefined,
			paths: claims.paths,
			state: await snapshot()
		}).toStrictEqual({
			status: 200,
			capability: accepted ? publicationCapability : undefined,
			paths: {
				prefixPaths: [
					`staging/${credential.pushId}/`,
					...(accepted
						? [`staging-v2/${fixtureTenant}/${credential.pushId}/`]
						: [])
				],
				objectPaths: []
			},
			state: before
		});
	}
);

const publicationSession = `${publicationCapability},${publicationRefusalReasonsCapability}`;

async function snapshot() {
	return runInDurableObject(currentServer(), (instance) =>
		Promise.resolve({
			caches: instance.context.db.select().from(schema.cacheIdentities).all(),
			pending: instance.context.db.select().from(schema.pendingUploads).all(),
			operations: instance.context.db
				.select()
				.from(schema.publicationOperations)
				.all(),
			roots: instance.context.db.select().from(schema.retentionRoots).all()
		})
	);
}

it('prunes terminal records only after their cleanup margin and retains active records', async () => {
	await resetTestServer();
	await initialise();
	const rows = await runInDurableObject(currentServer(), (instance) => {
		const now = new Date().toISOString();
		const cache = instance.context.db
			.select()
			.from(schema.cacheIdentities)
			.get();
		if (cache === undefined) {
			throw new Error('Expected the default cache');
		}
		const records = [
			{ character: 'a', state: 'accepted', pruneAfter: now },
			{ character: 'b', state: 'servable', pruneAfter: now },
			{ character: 'c', state: 'failed', pruneAfter: now },
			{ character: 'd', state: 'expired', pruneAfter: now },
			{
				character: 'e',
				state: 'expired',
				pruneAfter: new Date(Date.now() + 1).toISOString()
			}
		] as const;
		for (const record of records) {
			instance.context.db
				.insert(schema.publicationOperations)
				.values({
					id: uploadIdSchema.parse(record.character.repeat(64)),
					cacheId: cache.id,
					cacheGeneration: cache.generation,
					pushId: testPushId,
					canonicalJson: '[]',
					acceptedAt: now,
					pushExpiresAt: now,
					recoveryDeadline: now,
					pruneAfter: record.pruneAfter,
					graceDecisionJson: '{"reportsGrace":true}',
					state: record.state
				})
				.run();
		}
		new PublicationStore(instance.context).prune(now);
		return Promise.resolve(
			instance.context.db
				.select({
					id: schema.publicationOperations.id,
					state: schema.publicationOperations.state
				})
				.from(schema.publicationOperations)
				.orderBy(schema.publicationOperations.id)
				.all()
		);
	});
	expect(rows).toStrictEqual([
		{ id: 'a'.repeat(64), state: 'accepted' },
		{ id: 'e'.repeat(64), state: 'expired' }
	]);
});

describe('publication planning', () => {
	beforeEach(resetTestServer);
	it.each(['/uploads/plan', '/cache/new-cache/uploads/plan'])(
		'does not persist publication state for %s',
		async (path) => {
			const token = await initialise();
			const before = await snapshot();
			const metadata = uploadPathNegotiation(uploadMetadata({ fileSize: 1 }));
			const response = await authorisedFetch(path, token, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					pushId: testPushId,
					paths: [metadata],
					attachRoot: { name: 'run', retention: { kind: 'inherit' } }
				})
			});
			expect(response.status, await response.clone().text()).toBe(200);
			const result = uploadPlanResponseSchema.parse(await response.json());
			expect(result.uploads.map((entry) => entry.action)).toStrictEqual([
				'upload'
			]);
			expect(await snapshot()).toStrictEqual(before);
		}
	);
});

it('accepts one durable operation when a complete publication is replayed', async () => {
	await resetTestServer();
	const token = await initialise();
	const metadata = uploadPathNegotiation(uploadMetadata({ fileSize: 1 }));
	const response = await authorisedFetch('/cache/lazy/uploads/plan', token, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ pushId: testPushId, paths: [metadata] })
	});
	const planned = uploadPlanResponseSchema.parse(await response.json());
	const first = planned.uploads[0];
	if (first === undefined) {
		throw new Error('Expected a planned entry');
	}
	const conversation = await openCommitSession(
		token,
		namedCache('lazy'),
		publicationSession
	);
	try {
		const request = {
			op: 'publish-batch' as const,
			pushId: testPushId,
			entries: [
				{
					operationId: first.operationId,
					cacheGeneration: planned.cacheGeneration,
					metadata
				}
			]
		};
		conversation.send(request);
		expect(await conversation.nextFrame()).toStrictEqual({
			ev: 'publication-accepted',
			uploadId: first.operationId
		});
		expect(await conversation.nextFrame()).toStrictEqual({
			ev: 'upload-required',
			uploadId: first.operationId
		});
		const accepted = await snapshot();
		conversation.send(request);
		expect(await conversation.nextFrame()).toStrictEqual({
			ev: 'publication-accepted',
			uploadId: first.operationId
		});
		expect(await conversation.nextFrame()).toStrictEqual({
			ev: 'upload-required',
			uploadId: first.operationId
		});
		expect(await snapshot()).toStrictEqual(accepted);
	} finally {
		conversation.socket.close();
	}
});

it('admits concurrent commits into the same lazily created generation', async () => {
	await resetTestServer();
	const token = await initialise();
	const metadata = uploadPathNegotiation(uploadMetadata({ fileSize: 1 }));
	const response = await authorisedFetch(
		'/cache/concurrent/uploads/plan',
		token,
		{
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ pushId: testPushId, paths: [metadata] })
		}
	);
	const plan = uploadPlanResponseSchema.parse(await response.json());
	const first = plan.uploads[0];
	if (first === undefined) {
		throw new Error('Expected a planned entry');
	}
	const request = {
		op: 'publish-batch' as const,
		pushId: testPushId,
		entries: [
			{
				operationId: first.operationId,
				cacheGeneration: plan.cacheGeneration,
				metadata
			}
		]
	};
	const conversations = await Promise.all(
		[0, 1].map(() =>
			openCommitSession(token, namedCache('concurrent'), publicationSession)
		)
	);
	try {
		for (const conversation of conversations) {
			conversation.send(request);
		}
		await Promise.all(
			conversations.map(async (conversation) => {
				expect(await conversation.nextFrame()).toStrictEqual({
					ev: 'publication-accepted',
					uploadId: first.operationId
				});
				expect(await conversation.nextFrame()).toStrictEqual({
					ev: 'upload-required',
					uploadId: first.operationId
				});
			})
		);
		const after = await snapshot();
		expect({
			operations: after.operations.map((row) => row.id),
			pending: after.pending.map((row) => row.id),
			caches: after.caches
				.filter((row) => row.name === 'concurrent')
				.map((row) => row.generation)
		}).toStrictEqual({
			operations: [first.operationId],
			pending: [first.operationId],
			caches: [plan.cacheGeneration]
		});
	} finally {
		for (const conversation of conversations) {
			conversation.socket.close();
		}
	}
});

it('refuses a plan after its cache is deleted and reports the next generation', async () => {
	await resetTestServer();
	const token = await initialise();
	const created = await authorisedFetch('/caches/recreated', token, {
		method: 'PUT',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ access: 'public', priority: 50 })
	});
	expect(created.status).toBe(200);
	const metadata = uploadPathNegotiation(uploadMetadata({ fileSize: 1 }));
	const body = JSON.stringify({ pushId: testPushId, paths: [metadata] });
	const response = await authorisedFetch(
		'/cache/recreated/uploads/plan',
		token,
		{ method: 'POST', headers: { 'content-type': 'application/json' }, body }
	);
	const plan = uploadPlanResponseSchema.parse(await response.json());
	const first = plan.uploads[0];
	if (first === undefined) {
		throw new Error('Expected a planned entry');
	}
	const removed = await authorisedFetch('/caches/recreated?force=true', token, {
		method: 'DELETE'
	});
	expect(removed.status).toBe(200);
	const conversation = await openCommitSession(
		token,
		namedCache('recreated'),
		publicationSession
	);
	try {
		conversation.send({
			op: 'publish-batch',
			pushId: testPushId,
			entries: [
				{
					operationId: first.operationId,
					cacheGeneration: plan.cacheGeneration,
					metadata
				}
			]
		});
		expect(await conversation.nextFrame()).toMatchObject({
			ev: 'publication-refused',
			uploadId: first.operationId,
			reason: 'generation-conflict',
			status: 409
		});
		const replanned = await authorisedFetch(
			'/cache/recreated/uploads/plan',
			token,
			{ method: 'POST', headers: { 'content-type': 'application/json' }, body }
		);
		const next = uploadPlanResponseSchema.parse(await replanned.json());
		expect(next.cacheGeneration).toBe(plan.cacheGeneration + 1);
		const after = await snapshot();
		expect(after.operations).toStrictEqual([]);
	} finally {
		conversation.socket.close();
	}
});

it('replays a completed publication after pending cleanup and recovery expiry', async () => {
	await resetTestServer();
	const token = await initialise();
	const nar = await verifiableNar('publication-replay');
	const metadata = uploadMetadata({
		fileSize: nar.narBytes.byteLength,
		fileHash: nar.fileHash,
		narHash: nar.narHash,
		narSize: nar.narSize
	});
	await commitPath(token, metadata, nar);
	const response = await authorisedFetch('/uploads/plan', token, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			pushId: testPushId,
			paths: [uploadPathNegotiation(metadata)]
		})
	});
	const planned = uploadPlanResponseSchema.parse(await response.json());
	const first = planned.uploads[0];
	if (first === undefined) {
		throw new Error('Expected a planned entry');
	}
	expect(first.action).toBe('skip');
	const conversation = await openCommitSession(
		token,
		undefined,
		publicationSession
	);
	const request = {
		op: 'publish-batch' as const,
		pushId: testPushId,
		entries: [
			{
				operationId: first.operationId,
				cacheGeneration: planned.cacheGeneration,
				metadata: uploadPathNegotiation(metadata)
			}
		]
	};
	try {
		conversation.send(request);
		expect(await conversation.nextFrame()).toStrictEqual({
			ev: 'publication-accepted',
			uploadId: first.operationId
		});
		const outcome = await conversation.nextFrame();
		expect(outcome).toMatchObject({
			ev: 'settled',
			uploadId: first.operationId,
			response: {
				status: 'already-present',
				storePathHash: metadata.storePathHash,
				narHash: metadata.narHash
			}
		});
		await runInDurableObject(currentServer(), (instance) => {
			instance.context.db
				.update(schema.publicationOperations)
				.set({ recoveryDeadline: new Date(Date.now()).toISOString() })
				.where(eq(schema.publicationOperations.id, first.operationId))
				.run();
			return Promise.resolve();
		});
		const before = await snapshot();
		conversation.send(request);
		expect(await conversation.nextFrame()).toStrictEqual({
			ev: 'publication-accepted',
			uploadId: first.operationId
		});
		expect(await conversation.nextFrame()).toStrictEqual(outcome);
		expect(await snapshot()).toStrictEqual(before);
	} finally {
		conversation.socket.close();
	}
});

it.each(['skip', 'commit'] as const)(
	'requires bytes when the blob behind an advisory %s disappears',
	async (action) => {
		await resetTestServer();
		const token = await initialise();
		const nar = await verifiableNar(`publication-stale-${action}`);
		const metadata = uploadMetadata({
			fileSize: nar.narBytes.byteLength,
			fileHash: nar.fileHash,
			narHash: nar.narHash,
			narSize: nar.narSize
		});
		await commitPath(token, metadata, nar);
		const scope = action === 'skip' ? undefined : namedCache('reuse');
		const response = await authorisedFetch(
			action === 'skip' ? '/uploads/plan' : '/cache/reuse/uploads/plan',
			token,
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					pushId: testPushId,
					paths: [uploadPathNegotiation(metadata)]
				})
			}
		);
		const plan = uploadPlanResponseSchema.parse(await response.json());
		const first = plan.uploads[0];
		if (first === undefined) {
			throw new Error('Expected a planned entry');
		}
		expect(first.action).toBe(action);
		await env.BLOBS.delete(await currentNarObjectKey(nar.narHash));
		const conversation = await openCommitSession(
			token,
			scope,
			publicationSession
		);
		try {
			conversation.send({
				op: 'publish-batch',
				pushId: testPushId,
				entries: [
					{
						operationId: first.operationId,
						cacheGeneration: plan.cacheGeneration,
						metadata: uploadPathNegotiation(metadata)
					}
				]
			});
			expect(await conversation.nextFrame()).toStrictEqual({
				ev: 'publication-accepted',
				uploadId: first.operationId
			});
			expect(await conversation.nextFrame()).toStrictEqual({
				ev: 'upload-required',
				uploadId: first.operationId
			});
			const after = await snapshot();
			expect(
				after.operations.map((operation) => ({
					id: operation.id,
					state: operation.state
				}))
			).toStrictEqual([{ id: first.operationId, state: 'accepted' }]);
		} finally {
			conversation.socket.close();
		}
	}
);

it.each(
	['/uploads/plan', '/cache/empty/uploads/plan'].flatMap((path) =>
		[false, true].map((hasRoot) => ({ path, hasRoot }))
	)
)(
	'keeps an empty plan read-only at $path with root=$hasRoot',
	async ({ path, hasRoot }) => {
		await resetTestServer();
		const token = await initialise();
		if (path === '/uploads/plan') {
			const response = await authorisedFetch('/roots/run', token, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					targets: [],
					retention: { kind: 'duration', seconds: 3600 }
				})
			});
			expect(response.status).toBe(200);
		}
		const before = await snapshot();
		const response = await authorisedFetch(path, token, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				pushId: testPushId,
				paths: [],
				...(hasRoot && {
					attachRoot: {
						name: 'run',
						retention: { kind: 'duration', seconds: 7200 }
					}
				})
			})
		});
		const planned = uploadPlanResponseSchema.parse(await response.json());
		expect({
			status: response.status,
			planned,
			state: await snapshot()
		}).toStrictEqual({
			status: 200,
			planned: {
				cacheGeneration: 1,
				pushExpiresAt: '2106-02-07T06:28:15.000Z',
				uploads: []
			},
			state: before
		});
	}
);

it('recovers a newly uploaded publication after disconnect and rejects a changed declaration', async () => {
	vi.setSystemTime(vi.getRealSystemTime());
	await resetTestServer();
	const token = await initialise();
	const nar = await verifiableNar('publication-staged');
	const metadata = uploadMetadata({
		fileSize: nar.narBytes.byteLength,
		fileHash: nar.fileHash,
		narHash: nar.narHash,
		narSize: nar.narSize
	});
	const path = uploadPathNegotiation(metadata);
	const response = await authorisedFetch('/uploads/plan', token, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ pushId: testPushId, paths: [path] })
	});
	const planned = uploadPlanResponseSchema.parse(await response.json());
	const first = planned.uploads[0];
	if (first === undefined) {
		throw new Error('Expected a planned entry');
	}
	const entry = {
		operationId: first.operationId,
		cacheGeneration: planned.cacheGeneration,
		metadata: path,
		blob: { fileHash: nar.fileHash, fileSize: nar.narBytes.byteLength }
	};
	await putNarBytes(first.r2Key, nar);
	const conversation = await openCommitSession(
		token,
		undefined,
		publicationSession
	);
	try {
		conversation.send({
			op: 'publish-batch',
			pushId: testPushId,
			entries: [entry]
		});
		expect(await conversation.nextFrame()).toStrictEqual({
			ev: 'publication-accepted',
			uploadId: first.operationId
		});
		const result = await conversation.nextFrame();
		expect(['settled', 'deferred']).toContain(result.ev);
	} finally {
		conversation.socket.close();
	}
	await commitUpload(token, first.operationId);
	const completed = await snapshot();
	expect(
		completed.operations.map((operation) => ({
			id: operation.id,
			state: operation.state
		}))
	).toStrictEqual([{ id: first.operationId, state: 'servable' }]);
	const reconnected = await openCommitSession(
		token,
		undefined,
		publicationSession
	);
	try {
		reconnected.send({
			op: 'subscribe-publication',
			pushId: testPushId,
			entries: [entry]
		});
		expect(await reconnected.nextFrame()).toMatchObject({
			ev: 'settled',
			uploadId: first.operationId,
			response: { status: 'already-present', narHash: metadata.narHash }
		});
		reconnected.send({
			op: 'publish-batch',
			pushId: testPushId,
			entries: [
				{ ...entry, blob: { ...entry.blob, fileSize: entry.blob.fileSize + 1 } }
			]
		});
		expect(await reconnected.nextFrame()).toMatchObject({
			ev: 'publication-refused',
			uploadId: first.operationId,
			status: 409,
			message: 'The compressed declaration changed.'
		});
		expect(await snapshot()).toStrictEqual(completed);
	} finally {
		reconnected.socket.close();
	}
});

it.each([-1, 0])(
	'refuses recovery at deadline offset %i, stops claims and cleans unfinished ownership',
	async (offset) => {
		await resetTestServer();
		const token = await initialise();
		const metadata = uploadPathNegotiation(uploadMetadata({ fileSize: 1 }));
		const response = await authorisedFetch('/uploads/plan', token, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ pushId: testPushId, paths: [metadata] })
		});
		const plan = uploadPlanResponseSchema.parse(await response.json());
		const first = plan.uploads[0];
		if (first === undefined) {
			throw new Error('Expected a planned entry');
		}
		const entry = {
			operationId: first.operationId,
			cacheGeneration: plan.cacheGeneration,
			metadata
		};
		const conversation = await openCommitSession(
			token,
			undefined,
			publicationSession
		);
		try {
			conversation.send({
				op: 'publish-batch',
				pushId: testPushId,
				entries: [entry]
			});
			expect(await conversation.nextFrame()).toStrictEqual({
				ev: 'publication-accepted',
				uploadId: first.operationId
			});
			expect(await conversation.nextFrame()).toStrictEqual({
				ev: 'upload-required',
				uploadId: first.operationId
			});
			await runInDurableObject(currentServer(), (instance) => {
				instance.context.db
					.update(schema.pendingUploads)
					.set({ verdict: 'pending' })
					.where(eq(schema.pendingUploads.id, first.operationId))
					.run();
				return Promise.resolve();
			});
			const active = await currentServer().claimVerificationBatch(
				10,
				1_000_000
			);
			expect(
				active.claims.map((claim) => ({
					id: claim.uploadId,
					deadline: claim.recoveryDeadline
				}))
			).toStrictEqual([
				{
					id: first.operationId,
					deadline: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
				}
			]);
			await runInDurableObject(currentServer(), (instance) => {
				const deadline = new Date(Date.now() + offset).toISOString();
				instance.context.db
					.update(schema.publicationOperations)
					.set({ recoveryDeadline: deadline })
					.where(eq(schema.publicationOperations.id, first.operationId))
					.run();
				instance.context.db
					.update(schema.pendingUploads)
					.set({ recoveryDeadline: deadline, verdict: 'pending' })
					.where(eq(schema.pendingUploads.id, first.operationId))
					.run();
				return Promise.resolve();
			});
			expect(
				await currentServer().reserveCanonicalWrite(
					active.owner,
					first.operationId
				)
			).toStrictEqual({ kind: 'revoked' });
			expect(
				await currentServer().recordVerifications(active.owner, [
					{ uploadId: first.operationId, verdict: { kind: 'missing' } }
				])
			).toBe(0);
			conversation.send({
				op: 'publish-batch',
				pushId: testPushId,
				entries: [entry]
			});
			expect(await conversation.nextFrame()).toStrictEqual({
				ev: 'publication-refused',
				uploadId: first.operationId,
				reason: 'recovery-expired',
				status: 503,
				message: 'The upload recovery deadline expired. Start a fresh push.'
			});
			const claims = await currentServer().claimVerificationBatch(
				10,
				1_000_000
			);
			expect(claims.claims).toStrictEqual([]);
			await currentServer().runVerification();
			const after = await snapshot();
			expect({
				pending: after.pending,
				operations: after.operations.map((operation) => ({
					id: operation.id,
					state: operation.state
				}))
			}).toStrictEqual({
				pending: [],
				operations: [{ id: first.operationId, state: 'expired' }]
			});
		} finally {
			conversation.socket.close();
		}
	}
);

async function plannedEntries(
	token: string,
	planPath: string,
	paths: readonly UploadPathNegotiation[]
): Promise<PublicationEntry[]> {
	const response = await authorisedFetch(planPath, token, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ pushId: testPushId, paths })
	});
	const plan = uploadPlanResponseSchema.parse(await response.json());
	return paths.map((metadata, index) => {
		const planned = plan.uploads[index];
		if (planned === undefined) {
			throw new Error('Expected a planned entry for every path');
		}
		return {
			operationId: planned.operationId,
			cacheGeneration: plan.cacheGeneration,
			metadata
		};
	});
}

function distinctPath(character: string): UploadPathNegotiation {
	return uploadPathNegotiation(
		uploadMetadata({
			fileSize: 1,
			name: `publication-${character}`,
			storePathHash: character.repeat(32),
			narHash: nixSha256Hash(character)
		})
	);
}

/**
A point where code inside the Durable Object stops until the test releases it.
A promise continues in the I/O context that resolves it, and the test cannot
use the object's I/O context. The test therefore waits inside the object
through `runInDurableObject`, whose result returns in the test's context.
*/
class DurableObjectPause {
	private isReached = false;
	private isReleased = false;
	private onReached: (() => void) | undefined;
	private onReleased: (() => void) | undefined;

	// Called inside the Durable Object.
	async stop(): Promise<void> {
		this.isReached = true;
		this.onReached?.();
		if (this.isReleased) {
			return;
		}
		const { promise, resolve } = Promise.withResolvers<undefined>();
		this.onReleased = () => {
			resolve(undefined);
		};
		await promise;
	}

	reached(): Promise<void> {
		return runInDurableObject(currentServer(), async () => {
			if (this.isReached) {
				return;
			}
			const { promise, resolve } = Promise.withResolvers<undefined>();
			this.onReached = () => {
				resolve(undefined);
			};
			await promise;
		});
	}

	release(): Promise<void> {
		this.isReleased = true;
		return runInDurableObject(currentServer(), () => {
			this.onReleased?.();
			return Promise.resolve();
		});
	}
}

function refusalFacts(frame: CommitSessionFrame) {
	if (frame.ev !== 'publication-refused') {
		return frame;
	}
	const { message, ...facts } = frame;
	return { ...facts, hasMessage: message.length > 0 };
}

class GrantStorageFault extends Error {}

function isGrantsFailureRecord(
	record: unknown
): record is { readonly level: string; readonly op: string } {
	return (
		typeof record === 'object' &&
		record !== null &&
		'errorName' in record &&
		record.errorName === 'CommitSessionGrantsUnavailableError' &&
		'level' in record &&
		typeof record.level === 'string' &&
		'op' in record &&
		typeof record.op === 'string'
	);
}

// The v0.0.47 to v0.0.49 releases accept these capabilities.
const releasedPublication = `${commitCreditAccept},${publicationCapability}`;
const creditedPublication = `${releasedPublication},${publicationRefusalReasonsCapability}`;
const openingGrant = Math.floor(defaultCommitEntryCreditBudget / 2);

describe('publication commit credit', () => {
	beforeEach(resetTestServer);

	it('replays accepted publications on subscribe without charging credit or starting commits', async () => {
		const token = await initialise();
		const [uncommitted, committed] = await plannedEntries(
			token,
			'/uploads/plan',
			[distinctPath('1'), distinctPath('2')]
		);
		if (uncommitted === undefined || committed === undefined) {
			throw new Error('Expected two planned entries');
		}
		const session = await openCommitSession(
			token,
			defaultCache(),
			creditedPublication
		);
		let frames: unknown[];
		let before: Awaited<ReturnType<typeof snapshot>>;
		try {
			for (const entry of [uncommitted, committed]) {
				session.send({
					op: 'publish-batch',
					pushId: testPushId,
					entries: [entry]
				});
				expect([
					await session.nextFrame(),
					await session.nextFrame()
				]).toStrictEqual([
					{ ev: 'publication-accepted', uploadId: entry.operationId },
					{ ev: 'upload-required', uploadId: entry.operationId }
				]);
			}
			await runInDurableObject(currentServer(), (instance) => {
				instance.context.db
					.update(schema.pendingUploads)
					.set({ verdict: 'pending' })
					.where(eq(schema.pendingUploads.id, committed.operationId))
					.run();
				return Promise.resolve();
			});
			before = await snapshot();
			session.send({
				op: 'subscribe-publication',
				pushId: testPushId,
				entries: [uncommitted, committed]
			});
			frames = [
				refusalFacts(await session.nextFrame()),
				refusalFacts(await session.nextFrame())
			];
		} finally {
			await closeSessionAndWait(session.socket);
		}
		const after = await snapshot();
		const next = await openCommitSession(
			token,
			defaultCache(),
			creditedPublication
		);
		await closeSessionAndWait(next.socket);
		expect({
			frames,
			pending: after.pending.map((row) => ({
				id: row.id,
				verdict: row.verdict
			})),
			operations: after.operations,
			capabilities: next.capabilities
		}).toStrictEqual({
			frames: [
				{
					ev: 'publication-refused',
					uploadId: uncommitted.operationId,
					reason: 'resend',
					status: StatusCodes.SERVICE_UNAVAILABLE,
					hasMessage: true
				},
				{
					ev: 'deferred',
					uploadId: committed.operationId,
					storePathHash: committed.metadata.storePathHash,
					narHash: committed.metadata.narHash,
					grace: {}
				}
			],
			pending: before.pending.map((row) => ({
				id: row.id,
				verdict: row.verdict
			})),
			operations: before.operations,
			capabilities: commitCapabilitiesValueWithCredit(openingGrant)
		});
	});

	it("admits a released client's subscription to an operation whose commit has not started", async () => {
		vi.setSystemTime(vi.getRealSystemTime());
		const token = await initialise();
		const nar = await verifiableNar('publication-released-subscription');
		const [planned] = await plannedEntries(token, '/uploads/plan', [
			uploadPathNegotiation(
				uploadMetadata({
					fileSize: nar.narBytes.byteLength,
					fileHash: nar.fileHash,
					narHash: nar.narHash,
					narSize: nar.narSize
				})
			)
		]);
		if (planned === undefined) {
			throw new Error('Expected a planned entry');
		}
		const entry = {
			...planned,
			blob: { fileHash: nar.fileHash, fileSize: nar.narBytes.byteLength }
		};
		const first = await openCommitSession(
			token,
			defaultCache(),
			releasedPublication
		);
		try {
			first.send({ op: 'publish-batch', pushId: testPushId, entries: [entry] });
			expect([await first.nextFrame(), await first.nextFrame()]).toStrictEqual([
				{ ev: 'publication-accepted', uploadId: entry.operationId },
				{ ev: 'upload-required', uploadId: entry.operationId }
			]);
		} finally {
			await closeSessionAndWait(first.socket);
		}
		// The bytes arrive, and the connection drops before the client sends the
		// entry again.
		await putNarBytes(
			publicationStagingKey(fixtureTenant, testPushId, entry.operationId),
			nar
		);
		const admission = new DurableObjectPause();
		const admit = vi
			.spyOn(UploadsService.prototype, 'admitPublication')
			.mockImplementationOnce(async function (
				this: UploadsService,
				...arguments_
			) {
				admit.mockRestore();
				await admission.stop();
				return this.admitPublication(...arguments_);
			});
		const reconnected = await openCommitSession(
			token,
			defaultCache(),
			releasedPublication
		);
		try {
			reconnected.send({
				op: 'subscribe-publication',
				pushId: testPushId,
				entries: [entry]
			});
			const firstFrame = reconnected.nextFrame();
			const answered = async () => refusalFacts(await firstFrame);
			const isAdmitted = async () => {
				await admission.reached();
				return true;
			};
			expect(await Promise.race([isAdmitted(), answered()])).toBe(true);
			// Admission takes one entry of the tenant's credit while it runs.
			const during = await openCommitSession(
				token,
				defaultCache(),
				creditedPublication
			);
			await closeSessionAndWait(during.socket);
			await admission.release();
			expect([await firstFrame, await reconnected.nextFrame()]).toStrictEqual([
				{ ev: 'publication-accepted', uploadId: entry.operationId },
				{
					ev: 'deferred',
					uploadId: entry.operationId,
					storePathHash: entry.metadata.storePathHash,
					narHash: entry.metadata.narHash,
					grace: {}
				}
			]);
			await recordClaimedVerification(entry.operationId, {
				ok: true,
				fileHash: nar.fileHash,
				fileSize: nar.narBytes.byteLength
			});
			const verdict = await reconnected.nextFrame();
			const after = await openCommitSession(
				token,
				defaultCache(),
				creditedPublication
			);
			await closeSessionAndWait(after.socket);
			const { operations } = await snapshot();
			expect({
				verdict,
				during: during.capabilities,
				after: after.capabilities,
				states: operations.map((operation) => operation.state)
			}).toStrictEqual({
				verdict: {
					ev: 'verdict',
					uploadId: entry.operationId,
					status: 'servable',
					grace: {}
				},
				during: commitCapabilitiesValueWithCredit(
					Math.floor((defaultCommitEntryCreditBudget - openingGrant - 1) / 2)
				),
				after: commitCapabilitiesValueWithCredit(
					Math.floor((defaultCommitEntryCreditBudget - openingGrant) / 2)
				),
				states: ['servable']
			});
		} finally {
			admit.mockRestore();
			await admission.release();
			await closeSessionAndWait(reconnected.socket);
		}
	});

	it("admits the entries of a released client's subscription concurrently", async () => {
		vi.setSystemTime(vi.getRealSystemTime());
		const token = await initialise();
		const entries = await plannedEntries(token, '/uploads/plan', [
			distinctPath('m'),
			distinctPath('n')
		]);
		const first = await openCommitSession(
			token,
			defaultCache(),
			releasedPublication
		);
		try {
			first.send({ op: 'publish-batch', pushId: testPushId, entries });
			for (let frame = 0; frame < 2 * entries.length; frame += 1) {
				await first.nextFrame();
			}
		} finally {
			await closeSessionAndWait(first.socket);
		}
		// The client reconnects before it uploads any bytes.
		const acquire = vi.spyOn(CountingSemaphore.prototype, 'acquire');
		const acquiredAtAdmission: number[] = [];
		const admission = vi
			.spyOn(UploadsService.prototype, 'admitPublication')
			.mockImplementation(function (this: UploadsService, ...arguments_) {
				acquiredAtAdmission.push(acquire.mock.calls.length);
				admission.mockRestore();
				return this.admitPublication(...arguments_);
			});
		const reconnected = await openCommitSession(
			token,
			defaultCache(),
			releasedPublication
		);
		try {
			reconnected.send({
				op: 'subscribe-publication',
				pushId: testPushId,
				entries
			});
			const frames: CommitSessionFrame[] = [];
			for (let frame = 0; frame < 2 * entries.length; frame += 1) {
				frames.push(await reconnected.nextFrame());
			}
			expect({
				acquiredAtAdmission,
				frames: entries.map((entry) =>
					frames.filter(
						(frame) =>
							'uploadId' in frame && frame.uploadId === entry.operationId
					)
				)
			}).toStrictEqual({
				acquiredAtAdmission: [entries.length],
				frames: entries.map((entry) => [
					{ ev: 'publication-accepted', uploadId: entry.operationId },
					{ ev: 'upload-required', uploadId: entry.operationId }
				])
			});
		} finally {
			admission.mockRestore();
			acquire.mockRestore();
			await closeSessionAndWait(reconnected.socket);
		}
	});

	it("admits a released client's subscription when the tenant has no unallocated credit", async () => {
		const token = await initialise();
		const [entry] = await plannedEntries(token, '/uploads/plan', [
			distinctPath('r')
		]);
		if (entry === undefined) {
			throw new Error('Expected a planned entry');
		}
		const first = await openCommitSession(
			token,
			defaultCache(),
			releasedPublication
		);
		try {
			first.send({ op: 'publish-batch', pushId: testPushId, entries: [entry] });
			await first.nextFrame();
			await first.nextFrame();
		} finally {
			await closeSessionAndWait(first.socket);
		}
		const before = await snapshot();
		// Another session has the tenant's whole credit budget.
		const holder = await openCommitSession(
			token,
			defaultCache(),
			creditedPublication
		);
		holder.send({
			op: 'request-credit',
			entries: defaultCommitEntryCreditBudget
		});
		const grants = [];
		for (
			let remaining = defaultCommitEntryCreditBudget;
			remaining > 0;
			remaining -= commitBatchMaxEntries
		) {
			grants.push(await holder.nextFrame());
		}
		const reconnected = await openCommitSession(
			token,
			defaultCache(),
			releasedPublication
		);
		try {
			reconnected.send({
				op: 'subscribe-publication',
				pushId: testPushId,
				entries: [entry]
			});
			const answer = [
				refusalFacts(await reconnected.nextFrame()),
				refusalFacts(await reconnected.nextFrame())
			];
			expect({ grants, answer, state: await snapshot() }).toStrictEqual({
				grants: [
					{ ev: 'credit', grant: commitBatchMaxEntries },
					{ ev: 'credit', grant: commitBatchMaxEntries }
				],
				answer: [
					{ ev: 'publication-accepted', uploadId: entry.operationId },
					{ ev: 'upload-required', uploadId: entry.operationId }
				],
				state: before
			});
		} finally {
			await closeSessionAndWait(reconnected.socket);
			await closeSessionAndWait(holder.socket);
		}
	});

	it.each(['commit', 'commit-batch'] as const)(
		"answers each entry of a %s message whose cache does not exist, and leaves the session's credit equal to the client's count",
		async (op) => {
			const token = await initialise();
			const commits = (op === 'commit' ? ['1'] : ['1', '2', '3']).map(
				(character) => ({
					uploadId: uploadIdSchema.parse(`missing-${character}`),
					storePathHash: distinctPath(character).storePathHash,
					narHash: nixSha256Hash(character)
				})
			);
			const [first] = commits;
			if (first === undefined) {
				throw new Error('Expected a commit');
			}
			const session = await openCommitSession(
				token,
				namedCache('absent'),
				creditedPublication
			);
			const answers: unknown[] = [];
			let capabilities: string | null;
			try {
				session.send(
					op === 'commit' ? { op, uploadId: first.uploadId } : { op, commits }
				);
				for (const _commit of commits) {
					const answer = await session.nextFrame();
					answers.push(
						answer.ev === 'error'
							? {
									ev: answer.ev,
									uploadId: answer.uploadId,
									status: answer.status
								}
							: answer
					);
				}
				// The client spent credit on the message. Another session opens while
				// this session still has unspent credit.
				const next = await openCommitSession(
					token,
					defaultCache(),
					creditedPublication
				);
				capabilities = next.capabilities;
				await closeSessionAndWait(next.socket);
			} finally {
				await closeSessionAndWait(session.socket);
			}
			expect({ answers, capabilities }).toStrictEqual({
				answers: commits.map(({ uploadId }) => ({
					ev: 'error',
					uploadId,
					status: StatusCodes.NOT_FOUND
				})),
				capabilities: commitCapabilitiesValueWithCredit(
					Math.floor(
						(defaultCommitEntryCreditBudget - (openingGrant - commits.length)) /
							2
					)
				)
			});
		}
	);

	it.each(['publish-batch', 'subscribe-publication'] as const)(
		"refuses every entry of a %s message whose grants cannot be read, and leaves the session's credit equal to the client's count",
		async (op) => {
			const token = await initialise();
			const entries = await plannedEntries(token, '/uploads/plan', [
				distinctPath('1'),
				distinctPath('2')
			]);
			const session = await openCommitSession(
				token,
				defaultCache(),
				creditedPublication
			);
			const read = vi
				.spyOn(CommitReuseGrantsService.prototype, 'read')
				.mockRejectedValueOnce(new GrantStorageFault());
			const logged = vi.spyOn(console, 'error');
			const records: unknown[] = [];
			const refused: unknown[] = [];
			const resent: unknown[] = [];
			let capabilities: string | null;
			try {
				session.send({ op, pushId: testPushId, entries });
				for (const _entry of entries) {
					refused.push(refusalFacts(await session.nextFrame()));
				}
				// The client spent credit on a publish-batch message. Another session
				// opens while this session still has unspent credit.
				const next = await openCommitSession(
					token,
					defaultCache(),
					creditedPublication
				);
				capabilities = next.capabilities;
				await closeSessionAndWait(next.socket);
				session.send({ op, pushId: testPushId, entries });
				const answers =
					op === 'publish-batch' ? [...entries, ...entries] : entries;
				for (const _answer of answers) {
					resent.push(refusalFacts(await session.nextFrame()));
				}
			} finally {
				await closeSessionAndWait(session.socket);
				read.mockRestore();
				records.push(...logged.mock.calls.map(([record]: unknown[]) => record));
				logged.mockRestore();
			}
			const failures = records
				.filter((record) => isGrantsFailureRecord(record))
				.map((record) => ({ level: record.level, op: record.op }));
			const spent = op === 'publish-batch' ? entries.length : 0;
			expect({ refused, capabilities, resent, failures }).toStrictEqual({
				refused: entries.map((entry) => ({
					ev: 'publication-refused',
					uploadId: entry.operationId,
					reason: 'temporary-failure',
					status: StatusCodes.SERVICE_UNAVAILABLE,
					hasMessage: true
				})),
				capabilities: commitCapabilitiesValueWithCredit(
					Math.floor(
						(defaultCommitEntryCreditBudget - (openingGrant - spent)) / 2
					)
				),
				resent:
					op === 'publish-batch'
						? entries.flatMap((entry) => [
								{ ev: 'publication-accepted', uploadId: entry.operationId },
								{ ev: 'upload-required', uploadId: entry.operationId }
							])
						: entries.map((entry) => ({
								ev: 'publication-refused',
								uploadId: entry.operationId,
								reason: 'invalid-publication',
								status: StatusCodes.NOT_FOUND,
								hasMessage: true
							})),
				failures: [{ level: 'error', op }]
			});
		}
	);
});

describe('publication subscriptions', () => {
	beforeEach(resetTestServer);

	it('asks for a resend when a completed publication is no longer served, and repairs it from the resend', async () => {
		vi.setSystemTime(vi.getRealSystemTime());
		const token = await initialise();
		const nar = await verifiableNar('publication-subscribe-repair');
		const path = uploadPathNegotiation(
			uploadMetadata({
				fileSize: nar.narBytes.byteLength,
				fileHash: nar.fileHash,
				narHash: nar.narHash,
				narSize: nar.narSize
			})
		);
		const [planned] = await plannedEntries(token, '/uploads/plan', [path]);
		if (planned === undefined) {
			throw new Error('Expected a planned entry');
		}
		const entry = {
			...planned,
			blob: { fileHash: nar.fileHash, fileSize: nar.narBytes.byteLength }
		};
		await putNarBytes(
			publicationStagingKey(fixtureTenant, testPushId, entry.operationId),
			nar
		);
		const first = await openCommitSession(token, undefined, publicationSession);
		try {
			first.send({ op: 'publish-batch', pushId: testPushId, entries: [entry] });
			await first.nextFrame();
			await first.nextFrame();
		} finally {
			await closeSessionAndWait(first.socket);
		}
		await commitUpload(token, entry.operationId);
		await deletePath(token, path.storePathHash);
		const reconnected = await openCommitSession(
			token,
			undefined,
			publicationSession
		);
		try {
			reconnected.send({
				op: 'subscribe-publication',
				pushId: testPushId,
				entries: [entry]
			});
			const subscribed = refusalFacts(await reconnected.nextFrame());
			reconnected.send({
				op: 'publish-batch',
				pushId: testPushId,
				entries: [entry]
			});
			const resent = [
				await reconnected.nextFrame(),
				await reconnected.nextFrame()
			];
			expect({ subscribed, resent }).toStrictEqual({
				subscribed: {
					ev: 'publication-refused',
					uploadId: entry.operationId,
					reason: 'resend',
					status: StatusCodes.SERVICE_UNAVAILABLE,
					hasMessage: true
				},
				resent: [
					{ ev: 'publication-accepted', uploadId: entry.operationId },
					{ ev: 'upload-required', uploadId: entry.operationId }
				]
			});
		} finally {
			await closeSessionAndWait(reconnected.socket);
		}
	});

	it('refuses a subscription with push-expired when an expired push has no operation record', async () => {
		const token = await initialise();
		const expiresAt = Math.floor(Date.now() / 1000) + 60;
		const pushId = await testPushIdFor(fixtureTenant, 4, expiresAt);
		const metadata = distinctPath('1');
		const response = await authorisedFetch('/uploads/plan', token, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ pushId, paths: [metadata] })
		});
		const plan = uploadPlanResponseSchema.parse(await response.json());
		const planned = plan.uploads[0];
		if (planned === undefined) {
			throw new Error('Expected a planned entry');
		}
		const entry = {
			operationId: planned.operationId,
			cacheGeneration: plan.cacheGeneration,
			metadata
		};
		vi.setSystemTime(new Date((expiresAt + 1) * 1000));
		const session = await openCommitSession(
			token,
			undefined,
			publicationSession
		);
		try {
			session.send({ op: 'subscribe-publication', pushId, entries: [entry] });
			expect(refusalFacts(await session.nextFrame())).toStrictEqual({
				ev: 'publication-refused',
				uploadId: entry.operationId,
				reason: 'push-expired',
				status: StatusCodes.SERVICE_UNAVAILABLE,
				hasMessage: true
			});
		} finally {
			await closeSessionAndWait(session.socket);
		}
	});

	it('takes the commit entry semaphore for each subscribed entry', async () => {
		const token = await initialise();
		const entries = await plannedEntries(token, '/uploads/plan', [
			distinctPath('1'),
			distinctPath('2')
		]);
		const [published] = entries;
		if (published === undefined) {
			throw new Error('Expected a planned entry');
		}
		const session = await openCommitSession(
			token,
			undefined,
			publicationSession
		);
		const acquire = vi.spyOn(CountingSemaphore.prototype, 'acquire');
		let semaphores: unknown[];
		try {
			// A publish-batch entry takes the commit entry semaphore.
			session.send({
				op: 'publish-batch',
				pushId: testPushId,
				entries: [published]
			});
			await session.nextFrame();
			await session.nextFrame();
			session.send({
				op: 'subscribe-publication',
				pushId: testPushId,
				entries
			});
			await session.nextFrame();
			await session.nextFrame();
			semaphores = [...acquire.mock.contexts];
		} finally {
			acquire.mockRestore();
			await closeSessionAndWait(session.socket);
		}
		const [commitEntries, ...subscribed] = semaphores;
		expect({
			subscribed: subscribed.length,
			isCommitEntrySemaphore: subscribed.every(
				(semaphore) => semaphore === commitEntries
			)
		}).toStrictEqual({
			subscribed: entries.length,
			isCommitEntrySemaphore: true
		});
	});

	it.each([
		{ subject: 'an operation that was never accepted', cacheName: undefined },
		{ subject: 'a cache that does not exist', cacheName: 'absent' }
	])('refuses a subscription to $subject', async ({ cacheName }) => {
		const token = await initialise();
		const [entry] = await plannedEntries(
			token,
			cacheName === undefined
				? '/uploads/plan'
				: `/cache/${cacheName}/uploads/plan`,
			[distinctPath('1')]
		);
		if (entry === undefined) {
			throw new Error('Expected a planned entry');
		}
		const session = await openCommitSession(
			token,
			cacheName === undefined ? undefined : namedCache(cacheName),
			publicationSession
		);
		try {
			session.send({
				op: 'subscribe-publication',
				pushId: testPushId,
				entries: [entry]
			});
			expect(refusalFacts(await session.nextFrame())).toStrictEqual({
				ev: 'publication-refused',
				uploadId: entry.operationId,
				reason: 'invalid-publication',
				status: StatusCodes.NOT_FOUND,
				hasMessage: true
			});
		} finally {
			await closeSessionAndWait(session.socket);
		}
	});
});

it('requires bytes on a replay when a reusable NAR appears after a staged acceptance', async () => {
	await resetTestServer();
	const token = await initialise();
	const nar = await verifiableNar('publication-late-reuse');
	const narFields = {
		fileSize: nar.narBytes.byteLength,
		fileHash: nar.fileHash,
		narHash: nar.narHash,
		narSize: nar.narSize
	};
	const [entry] = await plannedEntries(token, '/uploads/plan', [
		uploadPathNegotiation(uploadMetadata(narFields))
	]);
	if (entry === undefined) {
		throw new Error('Expected a planned entry');
	}
	const session = await openCommitSession(token, undefined, publicationSession);
	try {
		const request = {
			op: 'publish-batch' as const,
			pushId: testPushId,
			entries: [entry]
		};
		session.send(request);
		const accepted = [await session.nextFrame(), await session.nextFrame()];
		await commitPath(
			token,
			uploadMetadata({
				...narFields,
				name: 'late-reuse',
				storePathHash: '2'.repeat(32)
			}),
			nar
		);
		session.send(request);
		const replayed = [await session.nextFrame(), await session.nextFrame()];
		const expected = [
			{ ev: 'publication-accepted', uploadId: entry.operationId },
			{ ev: 'upload-required', uploadId: entry.operationId }
		];
		expect({ accepted, replayed }).toStrictEqual({
			accepted: expected,
			replayed: expected
		});
	} finally {
		session.socket.close();
	}
});

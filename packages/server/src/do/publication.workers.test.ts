import {
	acceptCapabilitiesHeader,
	publicationCapability,
	pushCredentialSchema,
	uploadCapabilitiesHeader,
	uploadPlanResponseSchema
} from '@cupboard/protocol/upload';
import { uploadIdSchema } from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { decodeJwt } from 'jose';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../db/schema.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	authorisedFetch,
	commitPath,
	commitUpload,
	currentNarObjectKey,
	currentServer,
	initialise,
	namedCache,
	openCommitSession,
	putNarBytes,
	resetTestServer,
	testPushId,
	uploadMetadata,
	uploadPathNegotiation,
	verifiableNar
} from '../test-support.ts';

import { PublicationStore } from './publication-store.ts';

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
		publicationCapability
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
			openCommitSession(token, namedCache('concurrent'), publicationCapability)
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
		publicationCapability
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
		publicationCapability
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
			publicationCapability
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
		publicationCapability
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
		publicationCapability
	);
	try {
		reconnected.send({
			op: 'subscribe-publication',
			pushId: testPushId,
			entries: [entry]
		});
		expect(await reconnected.nextFrame()).toStrictEqual({
			ev: 'publication-accepted',
			uploadId: first.operationId
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
			publicationCapability
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

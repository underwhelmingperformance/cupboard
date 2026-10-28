import { rootLogger } from '@cupboard/logger';
import {
	cacheGenerationSchema,
	type CacheScope,
	narInfoGenerationSchema,
	rootNameSchema
} from '@cupboard/nix-store/scalars';
import { publicationStagingKey } from '@cupboard/protocol/publication';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import {
	acceptCapabilitiesHeader,
	commitBatchMaxEntries,
	commitCapabilitiesValueWithCredit,
	type CommitSessionFrame,
	publicationCapability,
	type PublicationEntry,
	publicationRefusalReasonsCapability,
	pushCredentialSchema,
	type PushId,
	uploadCapabilitiesHeader,
	type UploadId,
	type UploadPathNegotiation,
	uploadPlanResponseSchema
} from '@cupboard/protocol/upload';
import { uploadIdSchema } from '@cupboard/protocol/upload';
import { CountingSemaphore } from '@cupboard/shared/concurrency';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { eq, isNotNull, sql } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { StatusCodes } from 'http-status-codes';
import { decodeJwt } from 'jose';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PushCredentialIssuer } from '../blob/push-credential.ts';
import { resumeTenant } from '../control/tenant-registry.ts';
import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { SubrequestTimeoutError } from '../errors.ts';
import { narObjectKey, r2ObjectKeySchema } from '../http/http.ts';
import { defaultCommitEntryCreditBudget } from '../policy/commit-credit.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	asOneInvocation,
	authorisedFetch,
	closeSessionAndWait,
	collectVerificationPasses,
	type CommitConversation,
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
	suspendTenant,
	testPushId,
	testPushIdFor,
	uploadMetadata,
	uploadPathNegotiation,
	uploadStateOf,
	verifiableNar,
	verificationOf,
	verifyCurrentTenant
} from '../test-support.ts';

import { CommitPipelineService } from './commit-pipeline-service.ts';
import { CommitReuseGrantsService } from './commit-reuse-grants-service.ts';
import { NarInfoObjectsService } from './narinfo-objects-service.ts';
import {
	publicationFailureJson,
	PublicationStore
} from './publication-store.ts';
import { type CupboardServer } from './server.ts';
import { UploadStateService } from './upload-state-service.ts';
import { UploadsService } from './uploads-service.ts';
import { VerificationService } from './verification-service.ts';
import { WorkSequenceService } from './work-sequence-service.ts';

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
		expect(refusalFacts(await conversation.nextFrame())).toStrictEqual({
			ev: 'publication-refused',
			uploadId: first.operationId,
			reason: 'generation-conflict',
			status: StatusCodes.CONFLICT,
			hasMessage: true
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
		expect(outcome).toStrictEqual({
			ev: 'settled',
			uploadId: first.operationId,
			response: {
				status: 'already-present',
				storePathHash: metadata.storePathHash,
				narHash: metadata.narHash
			},
			grace: {}
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

it('recovers a newly uploaded publication after disconnect and rejects changed inputs', async () => {
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
		expect(await conversation.nextFrame()).toStrictEqual({
			ev: 'deferred',
			uploadId: first.operationId,
			storePathHash: metadata.storePathHash,
			narHash: metadata.narHash,
			grace: {}
		});
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
		expect(await reconnected.nextFrame()).toStrictEqual({
			ev: 'settled',
			uploadId: first.operationId,
			response: {
				status: 'already-present',
				storePathHash: metadata.storePathHash,
				narHash: metadata.narHash
			},
			grace: {}
		});
		reconnected.send({
			op: 'publish-batch',
			pushId: testPushId,
			entries: [
				{ ...entry, blob: { ...entry.blob, fileSize: entry.blob.fileSize + 1 } }
			]
		});
		expect(refusalFacts(await reconnected.nextFrame())).toStrictEqual({
			ev: 'publication-refused',
			uploadId: first.operationId,
			reason: 'declaration-changed',
			status: StatusCodes.CONFLICT,
			hasMessage: true
		});
		reconnected.send({
			op: 'publish-batch',
			pushId: testPushId,
			entries: [{ ...entry, metadata: { ...path, narSize: path.narSize + 1 } }]
		});
		expect(refusalFacts(await reconnected.nextFrame())).toStrictEqual({
			ev: 'publication-refused',
			uploadId: first.operationId,
			reason: 'parameters-changed',
			status: 409,
			hasMessage: true
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
			expect(refusalFacts(await conversation.nextFrame())).toStrictEqual({
				ev: 'publication-refused',
				uploadId: first.operationId,
				reason: 'recovery-expired',
				status: 503,
				hasMessage: true
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
	paths: readonly UploadPathNegotiation[],
	attachRoot?: PublicationEntry['attachRoot'],
	pushId = testPushId
): Promise<PublicationEntry[]> {
	const response = await authorisedFetch(planPath, token, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ pushId, paths, attachRoot })
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
			metadata,
			...(attachRoot !== undefined && { attachRoot })
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

/**
Records, for each call that `around` wraps, whether a critical section was
running, and stops the first call made outside one until the test releases
it. A call made inside a critical section is not stopped, because the test
could not reach the object while the input gate is closed.
*/
class GateProbe {
	private running = 0;
	private isStopped = false;
	readonly calls: boolean[] = [];
	readonly pause = new DurableObjectPause();

	// Called inside the Durable Object.
	watch(context: CupboardServer['context']) {
		const enter = context.criticalSection.bind(context);
		return vi.spyOn(context, 'criticalSection').mockImplementation((run) =>
			enter(async () => {
				this.running += 1;
				try {
					return await run();
				} finally {
					this.running -= 1;
				}
			})
		);
	}

	// Called inside the Durable Object.
	async around<T>(call: () => Promise<T>): Promise<T> {
		const isInGate = this.running > 0;
		this.calls.push(isInGate);
		if (!isInGate && !this.isStopped) {
			this.isStopped = true;
			await this.pause.stop();
		}
		return call();
	}

	// Resolves with `stopped` when the probe stops a call, and with `finished`
	// when `work` ends first.
	async first(work: Promise<unknown>): Promise<'stopped' | 'finished'> {
		const stopped = async () => {
			await this.pause.reached();
			return 'stopped' as const;
		};
		const finished = async () => {
			await work;
			return 'finished' as const;
		};
		return Promise.race([stopped(), finished()]);
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

	it.each(
		(['publish-batch', 'subscribe-publication'] as const).flatMap((op) => [
			{
				op,
				capabilities: releasedPublication,
				declaration: 'invalid-publication',
				parameters: 'invalid-publication'
			},
			{
				op,
				capabilities: creditedPublication,
				declaration: 'declaration-changed',
				parameters: 'parameters-changed'
			}
		])
	)(
		'refuses changed publication inputs in $op with $declaration and $parameters for a session that accepts $capabilities',
		async ({ op, capabilities, declaration, parameters }) => {
			vi.setSystemTime(vi.getRealSystemTime());
			const token = await initialise();
			const { entry, pushId } = await completedPublication(
				token,
				'publication-changed-inputs'
			);
			const { blob } = entry;
			const session = await openCommitSession(
				token,
				defaultCache(),
				capabilities
			);
			const answers = [];
			try {
				for (const changed of [
					{ ...entry, blob: { ...blob, fileSize: blob.fileSize + 1 } },
					{
						...entry,
						metadata: {
							...entry.metadata,
							narSize: entry.metadata.narSize + 1
						}
					}
				]) {
					session.send({ op, pushId, entries: [changed] });
					answers.push(refusalFacts(await session.nextFrame()));
				}
			} finally {
				await closeSessionAndWait(session.socket);
			}
			expect(answers).toStrictEqual(
				[declaration, parameters].map((reason) => ({
					ev: 'publication-refused',
					uploadId: entry.operationId,
					reason,
					status: StatusCodes.CONFLICT,
					hasMessage: true
				}))
			);
		}
	);

	it.each([
		{ capabilities: releasedPublication, isReleased: true },
		{ capabilities: creditedPublication, isReleased: false }
	])(
		'answers a subscription to a completed operation whose path is gone for a session that accepts $capabilities',
		async ({ capabilities, isReleased }) => {
			vi.setSystemTime(vi.getRealSystemTime());
			const token = await initialise();
			const { entry, pushId } = await completedPublication(
				token,
				'publication-subscribed-path-gone'
			);
			await deletePath(token, entry.metadata.storePathHash);
			const session = await openCommitSession(
				token,
				defaultCache(),
				capabilities
			);
			const answers = [];
			try {
				session.send({ op: 'subscribe-publication', pushId, entries: [entry] });
				answers.push(refusalFacts(await session.nextFrame()));
				if (isReleased) {
					answers.push(refusalFacts(await session.nextFrame()));
				}
			} finally {
				await closeSessionAndWait(session.socket);
			}
			// A released session never receives `resend`. The server repairs the
			// operation, which needs the bytes again.
			expect(answers).toStrictEqual(
				isReleased
					? [
							{ ev: 'publication-accepted', uploadId: entry.operationId },
							{ ev: 'upload-required', uploadId: entry.operationId }
						]
					: [
							{
								ev: 'publication-refused',
								uploadId: entry.operationId,
								reason: 'resend',
								status: StatusCodes.SERVICE_UNAVAILABLE,
								hasMessage: true
							}
						]
			);
		}
	);

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

	it('returns commit credit and answers a single commit whose grants cannot be read', async () => {
		const token = await initialise();
		const uploadId = uploadIdSchema.parse('missing-1');
		const session = await openCommitSession(
			token,
			defaultCache(),
			creditedPublication
		);
		const read = vi
			.spyOn(CommitReuseGrantsService.prototype, 'read')
			.mockRejectedValueOnce(new GrantStorageFault());
		let frame: unknown;
		try {
			session.send({ op: 'commit', uploadId });
			const answer = await session.nextFrame();
			frame =
				answer.ev === 'error'
					? { ev: answer.ev, uploadId: answer.uploadId, status: answer.status }
					: answer;
		} finally {
			await closeSessionAndWait(session.socket);
			read.mockRestore();
		}
		const next = await openCommitSession(
			token,
			defaultCache(),
			creditedPublication
		);
		await closeSessionAndWait(next.socket);
		expect({ frame, capabilities: next.capabilities }).toStrictEqual({
			frame: { ev: 'error', uploadId, status: StatusCodes.SERVICE_UNAVAILABLE },
			capabilities: commitCapabilitiesValueWithCredit(openingGrant)
		});
	});

	it('returns commit credit and answers every entry of a commit batch whose grants cannot be read', async () => {
		const token = await initialise();
		const commits = ['1', '2', '3'].map((character) => ({
			uploadId: uploadIdSchema.parse(`missing-${character}`),
			storePathHash: distinctPath(character).storePathHash,
			narHash: nixSha256Hash(character)
		}));
		const session = await openCommitSession(
			token,
			defaultCache(),
			creditedPublication
		);
		const read = vi
			.spyOn(CommitReuseGrantsService.prototype, 'read')
			.mockRejectedValueOnce(new GrantStorageFault());
		let frames: unknown[];
		try {
			session.send({ op: 'commit-batch', commits });
			frames = [];
			for (const _commit of commits) {
				const frame = await session.nextFrame();
				frames.push(
					frame.ev === 'error'
						? { ev: frame.ev, uploadId: frame.uploadId, status: frame.status }
						: frame
				);
			}
		} finally {
			await closeSessionAndWait(session.socket);
			read.mockRestore();
		}
		const next = await openCommitSession(
			token,
			defaultCache(),
			creditedPublication
		);
		await closeSessionAndWait(next.socket);
		expect({ frames, capabilities: next.capabilities }).toStrictEqual({
			frames: commits.map((commit) => ({
				ev: 'error',
				uploadId: commit.uploadId,
				status: StatusCodes.SERVICE_UNAVAILABLE
			})),
			capabilities: commitCapabilitiesValueWithCredit(openingGrant)
		});
	});
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

	it('refuses a subscription whose parameters differ from the accepted operation', async () => {
		const token = await initialise();
		const [entry] = await plannedEntries(token, '/uploads/plan', [
			distinctPath('1')
		]);
		if (entry === undefined) {
			throw new Error('Expected a planned entry');
		}
		const session = await openCommitSession(
			token,
			undefined,
			publicationSession
		);
		try {
			session.send({
				op: 'publish-batch',
				pushId: testPushId,
				entries: [entry]
			});
			await session.nextFrame();
			await session.nextFrame();
			session.send({
				op: 'subscribe-publication',
				pushId: testPushId,
				entries: [
					{
						...entry,
						metadata: { ...entry.metadata, narSize: entry.metadata.narSize + 1 }
					}
				]
			});
			expect(refusalFacts(await session.nextFrame())).toStrictEqual({
				ev: 'publication-refused',
				uploadId: entry.operationId,
				reason: 'parameters-changed',
				status: StatusCodes.CONFLICT,
				hasMessage: true
			});
		} finally {
			await closeSessionAndWait(session.socket);
		}
	});

	it.each(['publish-batch', 'subscribe-publication'] as const)(
		'refuses a %s entry as a retryable failure when a D1-backed read is overloaded',
		async (op) => {
			vi.setSystemTime(vi.getRealSystemTime());
			const token = await initialise();
			const nar = await verifiableNar(`publication-overload-${op}`);
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
			const first = await openCommitSession(
				token,
				undefined,
				publicationSession
			);
			try {
				first.send({
					op: 'publish-batch',
					pushId: testPushId,
					entries: [entry]
				});
				await first.nextFrame();
				await first.nextFrame();
			} finally {
				await closeSessionAndWait(first.socket);
			}
			await commitUpload(token, entry.operationId);
			// Both messages read the completed path's availability from D1 and R2.
			const fault = vi
				.spyOn(NarInfoObjectsService.prototype, 'servableNarInfoVersions')
				.mockRejectedValueOnce(
					new Error('D1_ERROR: D1 DB is overloaded. Too many requests queued.')
				);
			const session = await openCommitSession(
				token,
				undefined,
				publicationSession
			);
			try {
				session.send({ op, pushId: testPushId, entries: [entry] });
				expect({
					frame: refusalFacts(await session.nextFrame()),
					reads: fault.mock.calls.length
				}).toStrictEqual({
					frame: {
						ev: 'publication-refused',
						uploadId: entry.operationId,
						reason: 'temporary-failure',
						status: StatusCodes.SERVICE_UNAVAILABLE,
						hasMessage: true
					},
					reads: 1
				});
			} finally {
				fault.mockRestore();
				await closeSessionAndWait(session.socket);
			}
		}
	);

	it('sends the verdict of a failed verification to a subscription', async () => {
		const token = await initialise();
		const [entry] = await plannedEntries(token, '/uploads/plan', [
			distinctPath('1')
		]);
		if (entry === undefined) {
			throw new Error('Expected a planned entry');
		}
		const session = await openCommitSession(
			token,
			undefined,
			publicationSession
		);
		try {
			session.send({
				op: 'publish-batch',
				pushId: testPushId,
				entries: [entry]
			});
			await session.nextFrame();
			await session.nextFrame();
			await runInDurableObject(currentServer(), (instance) => {
				instance.context.db
					.update(schema.pendingUploads)
					.set({ verdict: 'pending' })
					.where(eq(schema.pendingUploads.id, entry.operationId))
					.run();
				return uploadStateOf(instance).markUploadTerminal(
					entry.operationId,
					'mismatch',
					rootLogger()
				);
			});
			session.send({
				op: 'subscribe-publication',
				pushId: testPushId,
				entries: [entry]
			});
			expect(await session.nextFrame()).toStrictEqual({
				ev: 'verdict',
				uploadId: entry.operationId,
				status: 'mismatch',
				grace: {}
			});
		} finally {
			await closeSessionAndWait(session.socket);
		}
	});

	it('sends the absent verdict to a subscription whose cache was deleted', async () => {
		const token = await initialise();
		const created = await authorisedFetch('/caches/removed', token, {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ access: 'public', priority: 50 })
		});
		expect(created.status).toBe(StatusCodes.OK);
		const [entry] = await plannedEntries(token, '/cache/removed/uploads/plan', [
			distinctPath('1')
		]);
		if (entry === undefined) {
			throw new Error('Expected a planned entry');
		}
		const first = await openCommitSession(
			token,
			namedCache('removed'),
			publicationSession
		);
		try {
			first.send({ op: 'publish-batch', pushId: testPushId, entries: [entry] });
			await first.nextFrame();
			await first.nextFrame();
		} finally {
			await closeSessionAndWait(first.socket);
		}
		const removed = await authorisedFetch('/caches/removed?force=true', token, {
			method: 'DELETE'
		});
		expect(removed.status).toBe(StatusCodes.OK);
		const session = await openCommitSession(
			token,
			namedCache('removed'),
			publicationSession
		);
		try {
			session.send({
				op: 'subscribe-publication',
				pushId: testPushId,
				entries: [entry]
			});
			expect(await session.nextFrame()).toStrictEqual({
				ev: 'verdict',
				uploadId: entry.operationId,
				status: 'absent',
				grace: {}
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

	it('sends the verdict that verification records while a subscription computes its identity', async () => {
		const token = await initialise();
		const [entry] = await plannedEntries(token, '/uploads/plan', [
			distinctPath('1')
		]);
		if (entry === undefined) {
			throw new Error('Expected a planned entry');
		}
		const session = await openCommitSession(
			token,
			undefined,
			publicationSession
		);
		const digest = crypto.subtle.digest.bind(crypto.subtle);
		try {
			session.send({
				op: 'publish-batch',
				pushId: testPushId,
				entries: [entry]
			});
			await session.nextFrame();
			await session.nextFrame();
			const failVerification = await runInDurableObject(
				currentServer(),
				(instance) => {
					instance.context.db
						.update(schema.pendingUploads)
						.set({ verdict: 'pending' })
						.where(eq(schema.pendingUploads.id, entry.operationId))
						.run();
					return Promise.resolve(async () => {
						await uploadStateOf(instance).markUploadTerminal(
							entry.operationId,
							'mismatch',
							rootLogger()
						);
					});
				}
			);
			// Verification records the verdict while the identity hash runs.
			vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(
				async (algorithm, data) => {
					await failVerification();
					return digest(algorithm, data);
				}
			);
			session.send({
				op: 'subscribe-publication',
				pushId: testPushId,
				entries: [entry]
			});
			expect(await session.nextFrame()).toStrictEqual({
				ev: 'verdict',
				uploadId: entry.operationId,
				status: 'mismatch',
				grace: {}
			});
		} finally {
			vi.restoreAllMocks();
			await closeSessionAndWait(session.socket);
		}
	});

	it('refuses a subscription with a changed compressed declaration', async () => {
		const token = await initialise();
		const [planned] = await plannedEntries(token, '/uploads/plan', [
			distinctPath('1')
		]);
		if (planned === undefined) {
			throw new Error('Expected a planned entry');
		}
		const entry = {
			...planned,
			blob: { fileHash: nixSha256Hash('3'), fileSize: 10 }
		};
		const session = await openCommitSession(
			token,
			undefined,
			publicationSession
		);
		try {
			session.send({
				op: 'publish-batch',
				pushId: testPushId,
				entries: [entry]
			});
			await session.nextFrame();
			await session.nextFrame();
			session.send({
				op: 'subscribe-publication',
				pushId: testPushId,
				entries: [{ ...entry, blob: { ...entry.blob, fileSize: 11 } }]
			});
			expect(refusalFacts(await session.nextFrame())).toStrictEqual({
				ev: 'publication-refused',
				uploadId: entry.operationId,
				reason: 'declaration-changed',
				status: StatusCodes.CONFLICT,
				hasMessage: true
			});
		} finally {
			await closeSessionAndWait(session.socket);
		}
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

// With `isConfirmationPending`, verification has committed the generation, but
// the operation is still accepted and its pending row remains, as when the
// recovery deadline passes before anything confirms the operation.
async function completedPublication(
	token: string,
	label: string,
	options: {
		readonly cacheName?: string;
		readonly pushId?: PushId;
		readonly isConfirmationPending?: boolean;
	} = {}
) {
	const nar = await verifiableNar(label);
	const path = uploadPathNegotiation(
		uploadMetadata({
			fileSize: nar.narBytes.byteLength,
			fileHash: nar.fileHash,
			narHash: nar.narHash,
			narSize: nar.narSize
		})
	);
	const pushId = options.pushId ?? testPushId;
	const cache =
		options.cacheName === undefined ? undefined : namedCache(options.cacheName);
	const [planned] = await plannedEntries(
		token,
		options.cacheName === undefined
			? '/uploads/plan'
			: `/cache/${options.cacheName}/uploads/plan`,
		[path],
		undefined,
		pushId
	);
	if (planned === undefined) {
		throw new Error('Expected a planned entry');
	}
	const entry = {
		...planned,
		blob: { fileHash: nar.fileHash, fileSize: nar.narBytes.byteLength }
	};
	await putNarBytes(
		publicationStagingKey(fixtureTenant, pushId, entry.operationId),
		nar
	);
	const session = await openCommitSession(token, cache, publicationSession);
	try {
		session.send({ op: 'publish-batch', pushId, entries: [entry] });
		await session.nextFrame();
		await session.nextFrame();
	} finally {
		await closeSessionAndWait(session.socket);
	}
	const pending =
		options.isConfirmationPending === true
			? await runInDurableObject(currentServer(), (instance) =>
					Promise.resolve(
						instance.context.db
							.select()
							.from(schema.pendingUploads)
							.where(eq(schema.pendingUploads.id, entry.operationId))
							.get()
					)
				)
			: undefined;
	await commitUpload(token, entry.operationId, cache);
	if (pending !== undefined) {
		await runInDurableObject(currentServer(), (instance) => {
			instance.context.db
				.insert(schema.pendingUploads)
				.values({ ...pending, verdict: 'committing' })
				.run();
			instance.context.db
				.update(schema.publicationOperations)
				.set({ state: 'accepted' })
				.where(eq(schema.publicationOperations.id, entry.operationId))
				.run();
			return Promise.resolve();
		});
	}
	return { entry, path, pushId, cache };
}

async function subscribe(
	token: string,
	cache: CacheScope | undefined,
	pushId: PushId,
	entry: PublicationEntry,
	op: 'subscribe-publication' | 'publish-batch' = 'subscribe-publication'
) {
	const session = await openCommitSession(token, cache, publicationSession);
	try {
		session.send({ op, pushId, entries: [entry] });
		const answer = refusalFacts(await session.nextFrame());
		await expectNoFurtherFrame(session, pushId, entry);
		return answer;
	} finally {
		await closeSessionAndWait(session.socket);
	}
}

// Sends the entry in `publish-batch` and returns every frame for it. An
// accepted entry receives a second frame: the request for its bytes or the
// answer of its commit.
async function admit(token: string, pushId: PushId, entry: PublicationEntry) {
	const session = await openCommitSession(token, undefined, publicationSession);
	try {
		session.send({ op: 'publish-batch', pushId, entries: [entry] });
		const first = refusalFacts(await session.nextFrame());
		const frames =
			first.ev === 'publication-accepted'
				? [first, refusalFacts(await session.nextFrame())]
				: [first];
		await expectNoFurtherFrame(session, pushId, entry);
		return frames;
	} finally {
		await closeSessionAndWait(session.socket);
	}
}

// Subscribes to an operation whose identity does not match its entry, and
// fails when any frame arrives before the refusal of that subscription.
async function expectNoFurtherFrame(
	session: CommitConversation,
	pushId: PushId,
	entry: PublicationEntry
) {
	const sentinel = uploadIdSchema.parse('f'.repeat(64));
	session.send({
		op: 'subscribe-publication',
		pushId,
		entries: [{ ...entry, operationId: sentinel }]
	});
	expect(refusalFacts(await session.nextFrame())).toStrictEqual({
		ev: 'publication-refused',
		uploadId: sentinel,
		reason: 'parameters-changed',
		status: StatusCodes.CONFLICT,
		hasMessage: true
	});
}

describe('publication subscriptions to terminal operations', () => {
	beforeEach(async () => {
		vi.setSystemTime(vi.getRealSystemTime());
		await resetTestServer();
	});

	it('refuses with generation-conflict a subscription to a completed operation whose cache was deleted', async () => {
		const token = await initialise();
		const created = await authorisedFetch('/caches/gone', token, {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ access: 'public', priority: 50 })
		});
		expect(created.status).toBe(StatusCodes.OK);
		const { entry, pushId, cache } = await completedPublication(
			token,
			'publication-gone-cache',
			{ cacheName: 'gone' }
		);
		const removed = await authorisedFetch('/caches/gone?force=true', token, {
			method: 'DELETE'
		});
		expect(removed.status).toBe(StatusCodes.OK);
		expect(await subscribe(token, cache, pushId, entry)).toStrictEqual({
			ev: 'publication-refused',
			uploadId: entry.operationId,
			reason: 'generation-conflict',
			status: StatusCodes.CONFLICT,
			hasMessage: true
		});
	});

	it('refuses an expired operation with recovery-expired', async () => {
		const token = await initialise();
		const [entry] = await plannedEntries(token, '/uploads/plan', [
			distinctPath('1')
		]);
		if (entry === undefined) {
			throw new Error('Expected a planned entry');
		}
		expect(await admit(token, testPushId, entry)).toStrictEqual([
			{ ev: 'publication-accepted', uploadId: entry.operationId },
			{ ev: 'upload-required', uploadId: entry.operationId }
		]);
		await runInDurableObject(currentServer(), (instance) => {
			instance.context.db
				.update(schema.publicationOperations)
				.set({ state: 'expired' })
				.where(eq(schema.publicationOperations.id, entry.operationId))
				.run();
			return Promise.resolve();
		});
		expect(await subscribe(token, undefined, testPushId, entry)).toStrictEqual({
			ev: 'publication-refused',
			uploadId: entry.operationId,
			reason: 'recovery-expired',
			status: StatusCodes.SERVICE_UNAVAILABLE,
			hasMessage: true
		});
	});

	it.each([
		{ op: 'subscribe-publication', when: 'before expiry runs' },
		{ op: 'publish-batch', when: 'before expiry runs' },
		{
			op: 'subscribe-publication',
			when: 'while expiry waits for its retry time'
		}
	] as const)(
		'answers $op for a committed generation after the recovery deadline $when',
		async ({ op, when }) => {
			const token = await initialise();
			const { entry, path, pushId } = await completedPublication(
				token,
				`publication-late-${op}-${when}`,
				{ isConfirmationPending: true }
			);
			await runInDurableObject(currentServer(), async (instance, state) => {
				instance.context.db
					.update(schema.publicationOperations)
					.set({ recoveryDeadline: new Date(Date.now() - 1).toISOString() })
					.where(eq(schema.publicationOperations.id, entry.operationId))
					.run();
				if (when !== 'before expiry runs') {
					await state.storage.put(
						'maintenance:publication-expiry-retry-at',
						Date.now() + 10 * 60 * 1000
					);
				}
			});
			const answer = await subscribe(token, undefined, pushId, entry, op);
			const { operations } = await snapshot();
			expect({
				answer,
				states: operations.map((operation) => operation.state)
			}).toStrictEqual({
				answer: {
					ev: 'settled',
					uploadId: entry.operationId,
					response: {
						storePathHash: path.storePathHash,
						narHash: path.narHash,
						status: 'already-present'
					},
					grace: {}
				},
				states: ['servable']
			});
		}
	);

	it('refuses with parameters-changed a subscription with no record whose identity does not match', async () => {
		const token = await initialise();
		const [entry] = await plannedEntries(token, '/uploads/plan', [
			distinctPath('1')
		]);
		if (entry === undefined) {
			throw new Error('Expected a planned entry');
		}
		expect(
			await subscribe(token, undefined, testPushId, {
				...entry,
				metadata: { ...entry.metadata, narSize: entry.metadata.narSize + 1 }
			})
		).toStrictEqual({
			ev: 'publication-refused',
			uploadId: entry.operationId,
			reason: 'parameters-changed',
			status: StatusCodes.CONFLICT,
			hasMessage: true
		});
	});

	it('answers a subscription from the state after a repair during the reads for a served path', async () => {
		const token = await initialise();
		const { entry, pushId } = await completedPublication(
			token,
			'publication-replay-repaired'
		);
		// A repair accepts the operation again while the replay reads the
		// narinfo for its served path, and the path is deleted.
		const read = await runInDurableObject(currentServer(), (instance) => {
			const { db } = instance.context;
			const cache = db.select().from(schema.cacheIdentities).get();
			if (cache === undefined) {
				throw new Error('Expected the default cache');
			}
			const staged = r2ObjectKeySchema.parse(
				publicationStagingKey(fixtureTenant, pushId, entry.operationId)
			);
			const createdAt = isoTimestamp(new Date());
			const expiresAt = isoTimestamp(new Date(Date.now() + 60_000));
			const spy = vi.spyOn(
				NarInfoObjectsService.prototype,
				'committedNarInfoRow'
			);
			spy.mockImplementationOnce(() => {
				db.update(schema.publicationOperations)
					.set({ state: 'accepted' })
					.where(eq(schema.publicationOperations.id, entry.operationId))
					.run();
				db.insert(schema.pendingUploads)
					.values({
						id: entry.operationId,
						cacheId: cache.id,
						narHash: entry.metadata.narHash,
						r2Key: staged,
						metadataJson: JSON.stringify(entry.metadata),
						createdAt,
						expiresAt
					})
					.run();
				return Promise.resolve(undefined);
			});
			return Promise.resolve(spy);
		});
		try {
			expect(await subscribe(token, undefined, pushId, entry)).toStrictEqual({
				ev: 'publication-refused',
				uploadId: entry.operationId,
				reason: 'resend',
				status: StatusCodes.SERVICE_UNAVAILABLE,
				hasMessage: true
			});
		} finally {
			read.mockRestore();
		}
	});

	it('asks a subscription to resend when its completed path is deleted after the replay proves it served', async () => {
		const token = await initialise();
		const { entry, pushId } = await completedPublication(
			token,
			'publication-replay-deleted-late'
		);
		const committed = await runInDurableObject(currentServer(), (instance) => {
			const { db } = instance.context;
			const spy = vi.spyOn(
				NarInfoObjectsService.prototype,
				'committedNarInfoRow'
			);
			spy.mockImplementationOnce(function (
				this: NarInfoObjectsService,
				...arguments_
			) {
				spy.mockRestore();
				// The path is deleted after the replay proves it served.
				db.delete(schema.narInfos)
					.where(
						eq(schema.narInfos.storePathHash, entry.metadata.storePathHash)
					)
					.run();
				return this.committedNarInfoRow(...arguments_);
			});
			return Promise.resolve(spy);
		});
		try {
			expect(await subscribe(token, undefined, pushId, entry)).toStrictEqual({
				ev: 'publication-refused',
				uploadId: entry.operationId,
				reason: 'resend',
				status: StatusCodes.SERVICE_UNAVAILABLE,
				hasMessage: true
			});
		} finally {
			committed.mockRestore();
		}
	});

	it('sends a settled frame when a completed path is recommitted with its NAR during the replay', async () => {
		const token = await initialise();
		const { entry, path, pushId } = await completedPublication(
			token,
			'publication-replay-recommitted'
		);
		const committed = await runInDurableObject(currentServer(), () => {
			const spy = vi.spyOn(
				NarInfoObjectsService.prototype,
				'committedNarInfoRow'
			);
			spy.mockImplementationOnce(async function (
				this: NarInfoObjectsService,
				...arguments_
			) {
				spy.mockRestore();
				const row = await this.committedNarInfoRow(...arguments_);
				// A recommit of the same NAR gives the path a later generation
				// after the replay proved the earlier one.
				return row === undefined
					? undefined
					: {
							...row,
							generation: narInfoGenerationSchema.parse(row.generation + 1)
						};
			});
			return Promise.resolve(spy);
		});
		try {
			expect(await subscribe(token, undefined, pushId, entry)).toStrictEqual({
				ev: 'settled',
				uploadId: entry.operationId,
				response: {
					storePathHash: path.storePathHash,
					narHash: path.narHash,
					status: 'already-present'
				},
				grace: {}
			});
		} finally {
			committed.mockRestore();
		}
	});

	it('refuses a replay as retryable when its path is recommitted during every read', async () => {
		const token = await initialise();
		const { entry, pushId } = await completedPublication(
			token,
			'publication-replay-always-recommitted'
		);
		const servable = await runInDurableObject(currentServer(), (instance) => {
			const { db } = instance.context;
			const spy = vi.spyOn(
				NarInfoObjectsService.prototype,
				'servableNarInfoVersions'
			);
			// Another push recommits the path during every read of it. The replay
			// discards a read when the path changes, so the read finds nothing.
			spy.mockImplementation(() => {
				db.update(schema.narInfos)
					.set({ generation: sql`${schema.narInfos.generation} + 1` })
					.where(
						eq(schema.narInfos.storePathHash, entry.metadata.storePathHash)
					)
					.run();
				return Promise.resolve(new Map());
			});
			return Promise.resolve(spy);
		});
		try {
			const answer = await subscribe(token, undefined, pushId, entry);
			expect({ answer, reads: servable.mock.calls.length }).toStrictEqual({
				answer: {
					ev: 'publication-refused',
					uploadId: entry.operationId,
					reason: 'temporary-failure',
					status: StatusCodes.SERVICE_UNAVAILABLE,
					hasMessage: true
				},
				reads: 3
			});
		} finally {
			servable.mockRestore();
		}
	});

	it('refuses a replay as retryable when R2 fails transiently during its reads', async () => {
		const token = await initialise();
		const { entry, pushId } = await completedPublication(
			token,
			'publication-replay-transient-r2'
		);
		const head = await runInDurableObject(currentServer(), (instance) => {
			const blobs = instance.context.env.BLOBS;
			return Promise.resolve(
				vi
					.spyOn(blobs, 'head')
					.mockRejectedValue(
						new Error(
							'head: We encountered an internal error. Please try again. (10001)'
						)
					)
			);
		});
		try {
			expect(await subscribe(token, undefined, pushId, entry)).toStrictEqual({
				ev: 'publication-refused',
				uploadId: entry.operationId,
				reason: 'temporary-failure',
				status: StatusCodes.SERVICE_UNAVAILABLE,
				hasMessage: true
			});
		} finally {
			head.mockRestore();
		}
	});

	it('refuses a pruned operation with generation-conflict when the cache is recreated during the replay', async () => {
		const token = await initialise();
		const expiresAt = Math.floor(Date.now() / 1000) + 60;
		const { entry, pushId } = await completedPublication(
			token,
			'publication-pruned-recreated',
			{ pushId: await testPushIdFor(fixtureTenant, 10, expiresAt) }
		);
		const versions = await runInDurableObject(currentServer(), (instance) => {
			const { db } = instance.context;
			db.delete(schema.publicationOperations)
				.where(eq(schema.publicationOperations.id, entry.operationId))
				.run();
			const spy = vi.spyOn(
				NarInfoObjectsService.prototype,
				'servableNarInfoVersions'
			);
			spy.mockImplementationOnce(async function (
				this: NarInfoObjectsService,
				...arguments_
			) {
				spy.mockRestore();
				const proven = await this.servableNarInfoVersions(...arguments_);
				// The cache is recreated while the replay reads the path.
				db.update(schema.cacheIdentities)
					.set({
						generation: cacheGenerationSchema.parse(entry.cacheGeneration + 1)
					})
					.run();
				return proven;
			});
			return Promise.resolve(spy);
		});
		vi.setSystemTime(new Date((expiresAt + 1) * 1000));
		try {
			expect(await subscribe(token, undefined, pushId, entry)).toStrictEqual({
				ev: 'publication-refused',
				uploadId: entry.operationId,
				reason: 'generation-conflict',
				status: StatusCodes.CONFLICT,
				hasMessage: true
			});
		} finally {
			versions.mockRestore();
		}
	});

	it('answers absent when a completed path has a committed replacement whose NAR is not served', async () => {
		const token = await initialise();
		const { entry, pushId } = await completedPublication(
			token,
			'publication-replay-replacement'
		);
		const spies = await runInDurableObject(currentServer(), () => {
			// The path was recommitted with another NAR, and that NAR's canonical
			// object is missing, so no NAR is served for the path.
			const versions = vi
				.spyOn(NarInfoObjectsService.prototype, 'servableNarInfoVersions')
				.mockResolvedValueOnce(new Map());
			const committed = vi.spyOn(
				NarInfoObjectsService.prototype,
				'committedNarInfoRow'
			);
			committed.mockImplementationOnce(async function (
				this: NarInfoObjectsService,
				...arguments_
			) {
				committed.mockRestore();
				const row = await this.committedNarInfoRow(...arguments_);
				return row === undefined
					? undefined
					: { ...row, narHash: nixSha256Hash('9') };
			});
			return Promise.resolve([versions, committed]);
		});
		try {
			expect(await subscribe(token, undefined, pushId, entry)).toStrictEqual({
				ev: 'verdict',
				uploadId: entry.operationId,
				status: 'absent'
			});
		} finally {
			for (const spy of spies) {
				spy.mockRestore();
			}
		}
	});

	it('admits a publish-batch replay of a completed operation whose path is gone', async () => {
		const token = await initialise();
		const { entry, pushId } = await completedPublication(
			token,
			'publication-replay-admits'
		);
		await deletePath(token, entry.metadata.storePathHash);
		// The operation is accepted past its deadline when the entry arrives,
		// and the replay's expiry pass completes it. The alarm's expiry pass
		// does not run.
		const alarmExpiry = vi
			.spyOn(VerificationService.prototype, 'expirePublications')
			.mockResolvedValue(undefined);
		const expiry = await runInDurableObject(currentServer(), (instance) => {
			const { db } = instance.context;
			db.update(schema.publicationOperations)
				.set({ state: 'accepted', recoveryDeadline: new Date(0).toISOString() })
				.where(eq(schema.publicationOperations.id, entry.operationId))
				.run();
			const deadline = new Date(Date.now() + 60_000).toISOString();
			return Promise.resolve(
				vi
					.spyOn(VerificationService.prototype, 'expireOperation')
					.mockImplementation((_logger, id) => {
						if (id === entry.operationId) {
							db.update(schema.publicationOperations)
								.set({ state: 'servable', recoveryDeadline: deadline })
								.where(eq(schema.publicationOperations.id, id))
								.run();
						}
						return Promise.resolve();
					})
			);
		});
		const session = await openCommitSession(
			token,
			undefined,
			publicationSession
		);
		try {
			session.send({ op: 'publish-batch', pushId, entries: [entry] });
			expect([
				refusalFacts(await session.nextFrame()),
				refusalFacts(await session.nextFrame())
			]).toStrictEqual([
				{ ev: 'publication-accepted', uploadId: entry.operationId },
				{ ev: 'upload-required', uploadId: entry.operationId }
			]);
		} finally {
			expiry.mockRestore();
			alarmExpiry.mockRestore();
			await closeSessionAndWait(session.socket);
		}
	});

	it.each([
		{ name: 'fails', isWaiting: false },
		{ name: 'fails while it waits for its retry time', isWaiting: true }
	])(
		'refuses a subscription as a retryable failure when expiry $name',
		async ({ name, isWaiting }) => {
			const token = await initialise();
			const { entry, pushId } = await completedPublication(
				token,
				`publication-expiry-${name}`,
				{ isConfirmationPending: true }
			);
			const isGenerationCommitted = await runInDurableObject(
				currentServer(),
				async (instance, state) => {
					instance.context.db
						.update(schema.publicationOperations)
						.set({ recoveryDeadline: new Date(0).toISOString() })
						.where(eq(schema.publicationOperations.id, entry.operationId))
						.run();
					if (isWaiting) {
						await state.storage.put(
							'maintenance:publication-expiry-retry-at',
							Date.now() + 10 * 60 * 1000
						);
					}
					return vi
						.spyOn(CommitPipelineService.prototype, 'isGenerationCommitted')
						.mockRejectedValue(new PublicationExpiryFault());
				}
			);
			try {
				const answer = await subscribe(token, undefined, pushId, entry);
				const { operations } = await snapshot();
				expect({
					answer,
					states: operations.map((operation) => operation.state)
				}).toStrictEqual({
					answer: {
						ev: 'publication-refused',
						uploadId: entry.operationId,
						reason: 'temporary-failure',
						status: StatusCodes.SERVICE_UNAVAILABLE,
						hasMessage: true
					},
					states: ['accepted']
				});
			} finally {
				isGenerationCommitted.mockRestore();
			}
		}
	);

	it('refuses a pruned operation with generation-conflict when the cache generation changed', async () => {
		const token = await initialise();
		const expiresAt = Math.floor(Date.now() / 1000) + 60;
		const { entry, pushId } = await completedPublication(
			token,
			'publication-pruned-generation',
			{ pushId: await testPushIdFor(fixtureTenant, 9, expiresAt) }
		);
		await runInDurableObject(currentServer(), (instance) => {
			const { db } = instance.context;
			db.delete(schema.publicationOperations)
				.where(eq(schema.publicationOperations.id, entry.operationId))
				.run();
			db.update(schema.cacheIdentities)
				.set({
					generation: cacheGenerationSchema.parse(entry.cacheGeneration + 1)
				})
				.run();
			return Promise.resolve();
		});
		vi.setSystemTime(new Date((expiresAt + 1) * 1000));
		expect(await subscribe(token, undefined, pushId, entry)).toStrictEqual({
			ev: 'publication-refused',
			uploadId: entry.operationId,
			reason: 'generation-conflict',
			status: StatusCodes.CONFLICT,
			hasMessage: true
		});
	});

	it('answers a pruned operation with its served path after the push expires', async () => {
		const token = await initialise();
		const expiresAt = Math.floor(Date.now() / 1000) + 60;
		const { entry, path, pushId } = await completedPublication(
			token,
			'publication-pruned-served',
			{ pushId: await testPushIdFor(fixtureTenant, 5, expiresAt) }
		);
		await runInDurableObject(currentServer(), (instance) => {
			instance.context.db
				.delete(schema.publicationOperations)
				.where(eq(schema.publicationOperations.id, entry.operationId))
				.run();
			return Promise.resolve();
		});
		vi.setSystemTime(new Date((expiresAt + 1) * 1000));
		expect(await subscribe(token, undefined, pushId, entry)).toStrictEqual({
			ev: 'settled',
			uploadId: entry.operationId,
			response: {
				storePathHash: path.storePathHash,
				narHash: path.narHash,
				status: 'already-present'
			},
			grace: {}
		});
	});

	it.each([
		{ name: 'includes', isRootTarget: true },
		{ name: 'does not include', isRootTarget: false }
	])(
		'answers an entry with no record whose run root $name its served path after the push expires',
		async ({ isRootTarget }) => {
			const token = await initialise();
			const { path } = await completedPublication(
				token,
				'publication-unrecorded-root'
			);
			const expiresAt = Math.floor(Date.now() / 1000) + 60;
			const pushId = await testPushIdFor(fixtureTenant, 9, expiresAt);
			const root = rootNameSchema.parse('run');
			// Another push published the path. This push's entry for it never
			// reached the server, so its run root has the path only when another
			// operation attached it.
			const [entry] = await plannedEntries(
				token,
				'/uploads/plan',
				[path],
				{ name: root, retention: { kind: 'inherit' } },
				pushId
			);
			if (entry === undefined) {
				throw new Error('Expected a planned entry');
			}
			if (isRootTarget) {
				await runInDurableObject(currentServer(), (instance) => {
					const cache =
						instance.context.cacheRepository.require(defaultCache());
					instance.context.db
						.insert(schema.retentionRootTargets)
						.values({
							cacheId: cache.id,
							rootName: root,
							storePathHash: path.storePathHash,
							storePath: path.storePath
						})
						.run();
					return Promise.resolve();
				});
			}
			vi.setSystemTime(new Date((expiresAt + 1) * 1000));
			expect(await subscribe(token, undefined, pushId, entry)).toStrictEqual(
				isRootTarget
					? {
							ev: 'settled',
							uploadId: entry.operationId,
							response: {
								storePathHash: path.storePathHash,
								narHash: path.narHash,
								status: 'already-present'
							},
							grace: {}
						}
					: {
							ev: 'publication-refused',
							uploadId: entry.operationId,
							reason: 'push-expired',
							status: StatusCodes.SERVICE_UNAVAILABLE,
							hasMessage: true
						}
			);
		}
	);
});

describe('publication admission of an operation that changes state', () => {
	beforeEach(async () => {
		vi.setSystemTime(vi.getRealSystemTime());
		await resetTestServer();
	});

	it.each([
		{
			name: 'fails',
			change: {
				state: 'failed' as const,
				resultJson: publicationFailureJson('mismatch')
			},
			answer: (entry: PublicationEntry) => ({
				ev: 'verdict',
				uploadId: entry.operationId,
				status: 'mismatch',
				grace: {}
			})
		},
		{
			name: 'passes its recovery deadline with its generation committed',
			change: { recoveryDeadline: new Date(0).toISOString() },
			answer: (entry: PublicationEntry, path: UploadPathNegotiation) => ({
				ev: 'settled',
				uploadId: entry.operationId,
				response: {
					storePathHash: path.storePathHash,
					narHash: path.narHash,
					status: 'already-present'
				},
				grace: {}
			})
		}
	])(
		'answers from the current state when an operation $name during admission',
		async ({ name, change, answer }) => {
			const token = await initialise();
			const { entry, path, pushId } = await completedPublication(
				token,
				`publication-admission-${name}`,
				{ isConfirmationPending: true }
			);
			const live = await runInDurableObject(currentServer(), (instance) => {
				const { db } = instance.context;
				const spy = vi.spyOn(PublicationStore.prototype, 'assertLive');
				spy.mockImplementationOnce(function (this: PublicationStore, id, now) {
					db.update(schema.publicationOperations)
						.set(change)
						.where(eq(schema.publicationOperations.id, id))
						.run();
					spy.mockRestore();
					this.assertLive(id, now);
				});
				return Promise.resolve(spy);
			});
			try {
				expect(
					await subscribe(token, undefined, pushId, entry, 'publish-batch')
				).toStrictEqual(answer(entry, path));
			} finally {
				live.mockRestore();
			}
		}
	);

	it('sends the settled frame when an operation completes during admission and then passes its recovery deadline', async () => {
		const token = await initialise();
		const { entry, path, pushId } = await completedPublication(
			token,
			'publication-admission-completed-late'
		);
		const live = await runInDurableObject(currentServer(), (instance) => {
			const { db } = instance.context;
			db.update(schema.publicationOperations)
				.set({ state: 'accepted' })
				.where(eq(schema.publicationOperations.id, entry.operationId))
				.run();
			const spy = vi.spyOn(PublicationStore.prototype, 'assertLive');
			spy.mockImplementationOnce(function (this: PublicationStore, id, now) {
				db.update(schema.publicationOperations)
					.set({
						state: 'servable',
						recoveryDeadline: new Date(0).toISOString()
					})
					.where(eq(schema.publicationOperations.id, id))
					.run();
				spy.mockRestore();
				this.assertLive(id, now);
			});
			return Promise.resolve(spy);
		});
		const session = await openCommitSession(
			token,
			undefined,
			publicationSession
		);
		try {
			session.send({ op: 'publish-batch', pushId, entries: [entry] });
			expect([refusalFacts(await session.nextFrame())]).toStrictEqual([
				{
					ev: 'settled',
					uploadId: entry.operationId,
					response: {
						storePathHash: path.storePathHash,
						narHash: path.narHash,
						status: 'already-present'
					},
					grace: {}
				}
			]);
		} finally {
			live.mockRestore();
			await closeSessionAndWait(session.socket);
		}
	});

	it('answers a commit from the current state when its recovery deadline passes after admission', async () => {
		const token = await initialise();
		const { entry, path, pushId } = await completedPublication(
			token,
			'publication-commit-late',
			{ isConfirmationPending: true }
		);
		const commit = await runInDurableObject(currentServer(), (instance) => {
			const { db } = instance.context;
			const spy = vi.spyOn(CommitPipelineService.prototype, 'commit');
			spy.mockImplementationOnce(function (
				this: CommitPipelineService,
				...arguments_
			) {
				db.update(schema.publicationOperations)
					.set({ recoveryDeadline: new Date(0).toISOString() })
					.where(eq(schema.publicationOperations.id, entry.operationId))
					.run();
				spy.mockRestore();
				return this.commit(...arguments_);
			});
			return Promise.resolve(spy);
		});
		const session = await openCommitSession(
			token,
			undefined,
			publicationSession
		);
		try {
			session.send({ op: 'publish-batch', pushId, entries: [entry] });
			// The expiry pass that the replay runs also notifies the session that
			// started the commit.
			expect([
				refusalFacts(await session.nextFrame()),
				refusalFacts(await session.nextFrame()),
				refusalFacts(await session.nextFrame())
			]).toStrictEqual([
				{ ev: 'publication-accepted', uploadId: entry.operationId },
				{
					ev: 'verdict',
					uploadId: entry.operationId,
					status: 'servable',
					grace: {}
				},
				{
					ev: 'settled',
					uploadId: entry.operationId,
					response: {
						storePathHash: path.storePathHash,
						narHash: path.narHash,
						status: 'already-present'
					},
					grace: {}
				}
			]);
		} finally {
			commit.mockRestore();
			await closeSessionAndWait(session.socket);
		}
	});

	it('answers a commit from the current state when its pending row is cleared but its operation remains accepted', async () => {
		const token = await initialise();
		const [entry] = await plannedEntries(token, '/uploads/plan', [
			distinctPath('9')
		]);
		if (entry === undefined) {
			throw new Error('Expected a planned entry');
		}
		await putNarBytes(
			publicationStagingKey(fixtureTenant, testPushId, entry.operationId),
			await verifiableNar('publication-commit-cleared')
		);
		const commit = await runInDurableObject(currentServer(), (instance) => {
			const { db } = instance.context;
			const spy = vi.spyOn(CommitPipelineService.prototype, 'commit');
			spy.mockImplementationOnce(function (
				this: CommitPipelineService,
				...arguments_
			) {
				db.delete(schema.pendingUploads)
					.where(eq(schema.pendingUploads.id, entry.operationId))
					.run();
				spy.mockRestore();
				return this.commit(...arguments_);
			});
			return Promise.resolve(spy);
		});
		const session = await openCommitSession(
			token,
			undefined,
			publicationSession
		);
		try {
			session.send({
				op: 'publish-batch',
				pushId: testPushId,
				entries: [entry]
			});
			expect([
				refusalFacts(await session.nextFrame()),
				refusalFacts(await session.nextFrame())
			]).toStrictEqual([
				{ ev: 'publication-accepted', uploadId: entry.operationId },
				{
					ev: 'publication-refused',
					uploadId: entry.operationId,
					reason: 'temporary-failure',
					status: StatusCodes.SERVICE_UNAVAILABLE,
					hasMessage: true
				}
			]);
		} finally {
			commit.mockRestore();
			await closeSessionAndWait(session.socket);
		}
	});

	it('answers a commit from the current state when verification completes its operation after admission and its path is gone', async () => {
		const token = await initialise();
		const [entry] = await plannedEntries(token, '/uploads/plan', [
			distinctPath('a')
		]);
		if (entry === undefined) {
			throw new Error('Expected a planned entry');
		}
		await putNarBytes(
			publicationStagingKey(fixtureTenant, testPushId, entry.operationId),
			await verifiableNar('publication-commit-completed')
		);
		const commit = await runInDurableObject(currentServer(), (instance) => {
			const { db } = instance.context;
			const spy = vi.spyOn(CommitPipelineService.prototype, 'commit');
			spy.mockImplementationOnce(function (
				this: CommitPipelineService,
				...arguments_
			) {
				db.delete(schema.pendingUploads)
					.where(eq(schema.pendingUploads.id, entry.operationId))
					.run();
				db.update(schema.publicationOperations)
					.set({ state: 'servable' })
					.where(eq(schema.publicationOperations.id, entry.operationId))
					.run();
				spy.mockRestore();
				return this.commit(...arguments_);
			});
			return Promise.resolve(spy);
		});
		const session = await openCommitSession(
			token,
			undefined,
			publicationSession
		);
		try {
			session.send({
				op: 'publish-batch',
				pushId: testPushId,
				entries: [entry]
			});
			expect([
				refusalFacts(await session.nextFrame()),
				refusalFacts(await session.nextFrame())
			]).toStrictEqual([
				{ ev: 'publication-accepted', uploadId: entry.operationId },
				{
					ev: 'publication-refused',
					uploadId: entry.operationId,
					reason: 'temporary-failure',
					status: StatusCodes.SERVICE_UNAVAILABLE,
					hasMessage: true
				}
			]);
		} finally {
			commit.mockRestore();
			await closeSessionAndWait(session.socket);
		}
	});

	it('admits again a replay whose path another operation publishes during the staged object check', async () => {
		const token = await initialise();
		const expiresAt = Math.floor(Date.now() / 1000) + 60;
		const pushId = await testPushIdFor(fixtureTenant, 11, expiresAt);
		const nar = await verifiableNar('publication-admission-path-published');
		const path = uploadPathNegotiation(
			uploadMetadata({
				fileSize: nar.narBytes.byteLength,
				fileHash: nar.fileHash,
				narHash: nar.narHash,
				narSize: nar.narSize
			})
		);
		const [waiting] = await plannedEntries(
			token,
			'/uploads/plan',
			[path],
			undefined,
			pushId
		);
		const [publishing] = await plannedEntries(token, '/uploads/plan', [path], {
			name: rootNameSchema.parse('run'),
			retention: { kind: 'inherit' }
		});
		if (waiting === undefined || publishing === undefined) {
			throw new Error('Expected two planned entries');
		}
		// The waiting operation is accepted, and its bytes never arrive. The
		// publishing operation starts its commit with the same path and NAR.
		expect(await admit(token, pushId, waiting)).toStrictEqual([
			{ ev: 'publication-accepted', uploadId: waiting.operationId },
			{ ev: 'upload-required', uploadId: waiting.operationId }
		]);
		await putNarBytes(
			publicationStagingKey(fixtureTenant, testPushId, publishing.operationId),
			nar
		);
		const first = await openCommitSession(token, undefined, publicationSession);
		try {
			first.send({
				op: 'publish-batch',
				pushId: testPushId,
				entries: [
					{
						...publishing,
						blob: { fileHash: nar.fileHash, fileSize: nar.narBytes.byteLength }
					}
				]
			});
			await first.nextFrame();
			await first.nextFrame();
		} finally {
			await closeSessionAndWait(first.socket);
		}
		const staged = publicationStagingKey(
			fixtureTenant,
			pushId,
			waiting.operationId
		);
		const replay = await openCommitSession(
			token,
			undefined,
			publicationSession
		);
		const pause = new DurableObjectPause();
		let isPaused = false;
		const head = await runInDurableObject(currentServer(), (instance) => {
			const blobs = instance.context.env.BLOBS;
			const originalHead = blobs.head.bind(blobs);
			return Promise.resolve(
				vi.spyOn(blobs, 'head').mockImplementation(async (key) => {
					if (key !== staged || isPaused) {
						return originalHead(key);
					}
					isPaused = true;
					await pause.stop();
					return originalHead(key);
				})
			);
		});
		try {
			vi.setSystemTime(new Date((expiresAt + 1) * 1000));
			replay.send({ op: 'publish-batch', pushId, entries: [waiting] });
			await pause.reached();
			// Verification completes the publishing operation while the waiting
			// operation's admission checks its staged object.
			await commitUpload(token, publishing.operationId);
			await pause.release();
			expect([
				refusalFacts(await replay.nextFrame()),
				refusalFacts(await replay.nextFrame())
			]).toStrictEqual([
				{ ev: 'publication-accepted', uploadId: waiting.operationId },
				{
					ev: 'settled',
					uploadId: waiting.operationId,
					response: {
						storePathHash: path.storePathHash,
						narHash: path.narHash,
						status: 'already-present'
					},
					grace: {}
				}
			]);
		} finally {
			await pause.release();
			head.mockRestore();
			await closeSessionAndWait(replay.socket);
		}
	});

	it('commits again from the canonical NAR an entry whose served path is deleted during admission', async () => {
		const token = await initialise();
		const nar = await verifiableNar('publication-admission-path-deleted');
		const metadata = uploadMetadata({
			fileSize: nar.narBytes.byteLength,
			fileHash: nar.fileHash,
			narHash: nar.narHash,
			narSize: nar.narSize
		});
		await commitPath(token, metadata, nar);
		const [entry] = await plannedEntries(token, '/uploads/plan', [
			uploadPathNegotiation(metadata)
		]);
		if (entry === undefined) {
			throw new Error('Expected a planned entry');
		}
		const reuse = await runInDurableObject(currentServer(), (instance) => {
			const { db } = instance.context;
			const spy = vi.spyOn(UploadStateService.prototype, 'peekReusableBlobs');
			spy.mockImplementationOnce(function (
				this: UploadStateService,
				...arguments_
			) {
				spy.mockRestore();
				// The path is deleted after the availability check found it served.
				db.delete(schema.narInfos)
					.where(
						eq(schema.narInfos.storePathHash, entry.metadata.storePathHash)
					)
					.run();
				return this.peekReusableBlobs(...arguments_);
			});
			return Promise.resolve(spy);
		});
		const session = await openCommitSession(
			token,
			undefined,
			publicationSession
		);
		try {
			// Admission runs again and reads the path again.
			session.send({
				op: 'publish-batch',
				pushId: testPushId,
				entries: [entry]
			});
			expect([
				refusalFacts(await session.nextFrame()),
				refusalFacts(await session.nextFrame())
			]).toStrictEqual([
				{ ev: 'publication-accepted', uploadId: entry.operationId },
				{
					ev: 'settled',
					uploadId: entry.operationId,
					response: {
						storePathHash: metadata.storePathHash,
						narHash: metadata.narHash,
						status: 'committed'
					},
					grace: {}
				}
			]);
		} finally {
			reuse.mockRestore();
			await closeSessionAndWait(session.socket);
		}
	});

	it('refuses as retryable an entry whose path changes during every admission', async () => {
		const token = await initialise();
		const [entry] = await plannedEntries(token, '/uploads/plan', [
			distinctPath('g')
		]);
		if (entry === undefined) {
			throw new Error('Expected a planned entry');
		}
		const staged = publicationStagingKey(
			fixtureTenant,
			testPushId,
			entry.operationId
		);
		const head = await runInDurableObject(currentServer(), (instance) => {
			const { db } = instance.context;
			const cache = db.select().from(schema.cacheIdentities).get();
			if (cache === undefined) {
				throw new Error('Expected the default cache');
			}
			const blobs = instance.context.env.BLOBS;
			const originalHead = blobs.head.bind(blobs);
			// Another push commits or deletes the path during each admission's
			// staged object check.
			return Promise.resolve(
				vi.spyOn(blobs, 'head').mockImplementation(async (key) => {
					const object = await originalHead(key);
					if (key !== staged) {
						return object;
					}
					const rows = db
						.delete(schema.narInfos)
						.where(
							eq(schema.narInfos.storePathHash, entry.metadata.storePathHash)
						)
						.returning()
						.all();
					if (rows.length === 0) {
						db.insert(schema.narInfos)
							.values({
								cacheId: cache.id,
								storePathHash: entry.metadata.storePathHash,
								storePath: entry.metadata.storePath,
								narHash: entry.metadata.narHash,
								narSize: entry.metadata.narSize,
								referencesJson: '[]',
								createdAt: isoTimestamp(new Date())
							})
							.run();
					}
					return object;
				})
			);
		});
		try {
			const answer = await subscribe(
				token,
				undefined,
				testPushId,
				entry,
				'publish-batch'
			);
			expect({
				answer,
				admissions: head.mock.calls.filter(([key]) => key === staged).length
			}).toStrictEqual({
				answer: {
					ev: 'publication-refused',
					uploadId: entry.operationId,
					reason: 'temporary-failure',
					status: StatusCodes.SERVICE_UNAVAILABLE,
					hasMessage: true
				},
				admissions: 3
			});
		} finally {
			head.mockRestore();
		}
	});

	it('admits an entry while other operations of its path are admitted during every admission', async () => {
		const token = await initialise();
		const [entry] = await plannedEntries(token, '/uploads/plan', [
			distinctPath('h')
		]);
		if (entry === undefined) {
			throw new Error('Expected a planned entry');
		}
		const staged = publicationStagingKey(
			fixtureTenant,
			testPushId,
			entry.operationId
		);
		const head = await runInDurableObject(currentServer(), (instance) => {
			const { db } = instance.context;
			const cache = db.select().from(schema.cacheIdentities).get();
			if (cache === undefined) {
				throw new Error('Expected the default cache');
			}
			const blobs = instance.context.env.BLOBS;
			const originalHead = blobs.head.bind(blobs);
			// Other pushes record operations for the path, and their verdicts
			// change, during each admission's staged object check.
			return Promise.resolve(
				vi.spyOn(blobs, 'head').mockImplementation(async (key) => {
					const object = await originalHead(key);
					if (key !== staged) {
						return object;
					}
					const now = isoTimestamp(new Date());
					db.update(schema.pendingUploads)
						.set({ verdict: 'pending' })
						.where(isNotNull(schema.pendingUploads.attachRootName))
						.run();
					db.insert(schema.pendingUploads)
						.values({
							id: uploadIdSchema.parse(crypto.randomUUID()),
							cacheId: cache.id,
							narHash: entry.metadata.narHash,
							r2Key: r2ObjectKeySchema.parse(`staging/${crypto.randomUUID()}`),
							metadataJson: JSON.stringify(entry.metadata),
							createdAt: now,
							expiresAt: now,
							attachRootName: rootNameSchema.parse('other')
						})
						.run();
					return object;
				})
			);
		});
		const session = await openCommitSession(
			token,
			undefined,
			publicationSession
		);
		try {
			session.send({
				op: 'publish-batch',
				pushId: testPushId,
				entries: [entry]
			});
			// A refusal is the only frame for the entry.
			const first = refusalFacts(await session.nextFrame());
			const answer =
				first.ev === 'publication-accepted'
					? [first, refusalFacts(await session.nextFrame())]
					: [first];
			expect({
				answer,
				admissions: head.mock.calls.filter(([key]) => key === staged).length
			}).toStrictEqual({
				answer: [
					{ ev: 'publication-accepted', uploadId: entry.operationId },
					{ ev: 'upload-required', uploadId: entry.operationId }
				],
				admissions: 1
			});
		} finally {
			head.mockRestore();
			await closeSessionAndWait(session.socket);
		}
	});

	it('answers a publish-batch entry as a subscription does when its push expires during admission', async () => {
		const token = await initialise();
		const expiresAt = Math.floor(Date.now() / 1000) + 60;
		const pushId = await testPushIdFor(fixtureTenant, 8, expiresAt);
		const { entry, path } = await completedPublication(
			token,
			'publication-push-expires',
			{ pushId }
		);
		const isPushIdVerified = await runInDurableObject(
			currentServer(),
			(instance) => {
				instance.context.db
					.delete(schema.publicationOperations)
					.where(eq(schema.publicationOperations.id, entry.operationId))
					.run();
				const isVerified = vi.spyOn(PushCredentialIssuer.prototype, 'verify');
				isVerified.mockImplementationOnce(function (
					this: PushCredentialIssuer,
					...arguments_
				) {
					vi.setSystemTime(new Date((expiresAt + 1) * 1000));
					isVerified.mockRestore();
					return this.verify(...arguments_);
				});
				return Promise.resolve(isVerified);
			}
		);
		try {
			expect(
				await subscribe(token, undefined, pushId, entry, 'publish-batch')
			).toStrictEqual({
				ev: 'settled',
				uploadId: entry.operationId,
				response: {
					storePathHash: path.storePathHash,
					narHash: path.narHash,
					status: 'already-present'
				},
				grace: {}
			});
		} finally {
			isPushIdVerified.mockRestore();
		}
	});

	it.each([
		{ name: 'served', isServed: true },
		{ name: 'not served', isServed: false }
	])(
		'answers a publish-batch entry with no record and an expired push as a subscription does when the path is $name',
		async ({ name, isServed }) => {
			const token = await initialise();
			const expiresAt = Math.floor(Date.now() / 1000) + 60;
			const pushId = await testPushIdFor(fixtureTenant, 7, expiresAt);
			const completed = isServed
				? await completedPublication(token, `publication-pruned-${name}`, {
						pushId
					})
				: undefined;
			const planned = await plannedEntries(
				token,
				'/uploads/plan',
				[distinctPath('1')],
				undefined,
				pushId
			);
			const entry = completed?.entry ?? planned[0];
			if (entry === undefined) {
				throw new Error('Expected a planned entry');
			}
			await runInDurableObject(currentServer(), (instance) => {
				instance.context.db
					.delete(schema.publicationOperations)
					.where(eq(schema.publicationOperations.id, entry.operationId))
					.run();
				return Promise.resolve();
			});
			vi.setSystemTime(new Date((expiresAt + 1) * 1000));
			expect(
				await subscribe(token, undefined, pushId, entry, 'publish-batch')
			).toStrictEqual(
				isServed
					? {
							ev: 'settled',
							uploadId: entry.operationId,
							response: {
								storePathHash: entry.metadata.storePathHash,
								narHash: entry.metadata.narHash,
								status: 'already-present'
							},
							grace: {}
						}
					: {
							ev: 'publication-refused',
							uploadId: entry.operationId,
							reason: 'push-expired',
							status: StatusCodes.SERVICE_UNAVAILABLE,
							hasMessage: true
						}
			);
		}
	);

	it('refuses a repair as a retryable failure when the delete of its staged object outlasts the wait', async () => {
		const token = await initialise();
		const { entry, pushId } = await completedPublication(
			token,
			'publication-repair-deleting'
		);
		await deletePath(token, entry.metadata.storePathHash);
		const staged = r2ObjectKeySchema.parse(
			publicationStagingKey(fixtureTenant, pushId, entry.operationId)
		);
		const ending = () =>
			runInDurableObject(currentServer(), (instance) => {
				instance.context.stagingDeletes.end(staged);
				return Promise.resolve();
			});
		// The wait for the delete reaches its bound. `staging-deletes.test.ts`
		// tests the bound itself.
		const wait = await runInDurableObject(currentServer(), (instance) => {
			instance.context.stagingDeletes.begin(staged);
			return Promise.resolve(
				vi
					.spyOn(instance.context.stagingDeletes, 'finished')
					.mockRejectedValueOnce(
						new SubrequestTimeoutError('r2.staging-delete-wait')
					)
			);
		});
		try {
			const refused = await subscribe(
				token,
				undefined,
				pushId,
				entry,
				'publish-batch'
			);
			const during = await snapshot();
			const waits = wait.mock.calls.map(([key]) => key);
			await ending();
			// Once the delete finishes, the same repair is accepted.
			const accepted = await admit(token, pushId, entry);
			expect({
				refused,
				waits,
				states: during.operations.map((operation) => operation.state),
				pending: during.pending.length,
				accepted
			}).toStrictEqual({
				refused: {
					ev: 'publication-refused',
					uploadId: entry.operationId,
					reason: 'temporary-failure',
					status: StatusCodes.SERVICE_UNAVAILABLE,
					hasMessage: true
				},
				waits: [staged],
				states: ['servable'],
				pending: 0,
				accepted: [
					{ ev: 'publication-accepted', uploadId: entry.operationId },
					{ ev: 'upload-required', uploadId: entry.operationId }
				]
			});
		} finally {
			wait.mockRestore();
			await ending();
		}
	});

	it('waits for a staging delete that outlived its timeout and then accepts the repair', async () => {
		const token = await initialise();
		const [entry] = await plannedEntries(token, '/uploads/plan', [
			distinctPath('d')
		]);
		if (entry === undefined) {
			throw new Error('Expected a planned entry');
		}
		// The first admission accepts the operation, and its bytes never arrive.
		expect(await admit(token, testPushId, entry)).toStrictEqual([
			{ ev: 'publication-accepted', uploadId: entry.operationId },
			{ ev: 'upload-required', uploadId: entry.operationId }
		]);
		const staged = r2ObjectKeySchema.parse(
			publicationStagingKey(fixtureTenant, testPushId, entry.operationId)
		);
		const { promise: abandoned, resolve: finish } =
			Promise.withResolvers<undefined>();
		// Verification completes the operation, and the R2 delete of its staged
		// object outlives the bounded wait.
		const cleared = await runInDurableObject(
			currentServer(),
			async (instance) => {
				const blobs = instance.context.env.BLOBS;
				const originalDelete = blobs.delete.bind(blobs);
				const deletion = vi
					.spyOn(blobs, 'delete')
					.mockImplementation((keys) =>
						keys === staged
							? Promise.reject(
									new SubrequestTimeoutError('r2.delete', abandoned)
								)
							: originalDelete(keys)
					);
				try {
					await new UploadStateService(
						instance.context
					).clearPendingUploadAndStaging(
						entry.operationId,
						staged,
						entry.metadata.narHash,
						{ logger: rootLogger(), outcome: 'servable' }
					);
					return 'resolved';
				} catch (error) {
					return error instanceof SubrequestTimeoutError
						? 'timed out'
						: 'other';
				} finally {
					deletion.mockRestore();
				}
			}
		);
		const isTrackedBefore = await runInDurableObject(
			currentServer(),
			(instance) => Promise.resolve(instance.context.stagingDeletes.has(staged))
		);
		// Admission starts to wait for the abandoned delete. The test finishes
		// the delete after it has seen the wait.
		const waiting = new DurableObjectPause();
		const wait = await runInDurableObject(currentServer(), (instance) => {
			const deletes = instance.context.stagingDeletes;
			const finished = deletes.finished.bind(deletes);
			return Promise.resolve(
				vi.spyOn(deletes, 'finished').mockImplementationOnce((key) => {
					const done = finished(key);
					void waiting.stop();
					return done;
				})
			);
		});
		const session = await openCommitSession(
			token,
			undefined,
			publicationSession
		);
		try {
			session.send({
				op: 'publish-batch',
				pushId: testPushId,
				entries: [entry]
			});
			const first = session.nextFrame();
			await waiting.reached();
			// Admission has not accepted the repair while it waits.
			const during = await snapshot();
			finish(undefined);
			const answer = [
				refusalFacts(await first),
				refusalFacts(await session.nextFrame())
			];
			const after = await snapshot();
			const states = (state: typeof after) => ({
				operations: state.operations.map((operation) => operation.state),
				pending: state.pending.length
			});
			expect({
				cleared,
				isTrackedBefore,
				during: states(during),
				answer,
				after: states(after)
			}).toStrictEqual({
				cleared: 'timed out',
				isTrackedBefore: true,
				during: { operations: ['servable'], pending: 0 },
				answer: [
					{ ev: 'publication-accepted', uploadId: entry.operationId },
					{ ev: 'upload-required', uploadId: entry.operationId }
				],
				after: { operations: ['accepted'], pending: 1 }
			});
		} finally {
			wait.mockRestore();
			finish(undefined);
			await waiting.release();
			await closeSessionAndWait(session.socket);
		}
	});

	it('refuses an entry as a retryable failure when a delete of its staged object starts after the wait', async () => {
		const token = await initialise();
		const [entry] = await plannedEntries(token, '/uploads/plan', [
			distinctPath('g')
		]);
		if (entry === undefined) {
			throw new Error('Expected a planned entry');
		}
		const staged = r2ObjectKeySchema.parse(
			publicationStagingKey(fixtureTenant, testPushId, entry.operationId)
		);
		// The wait finds no delete, and a delete of the key starts before the gate.
		const wait = await runInDurableObject(currentServer(), (instance) => {
			const deletes = instance.context.stagingDeletes;
			const finished = deletes.finished.bind(deletes);
			return Promise.resolve(
				vi.spyOn(deletes, 'finished').mockImplementationOnce(async (key) => {
					await finished(key);
					deletes.begin(key);
				})
			);
		});
		try {
			const answer = await admit(token, testPushId, entry);
			const { operations, pending } = await snapshot();
			expect({ answer, operations, pending }).toStrictEqual({
				answer: [
					{
						ev: 'publication-refused',
						uploadId: entry.operationId,
						reason: 'temporary-failure',
						status: StatusCodes.SERVICE_UNAVAILABLE,
						hasMessage: true
					}
				],
				operations: [],
				pending: []
			});
		} finally {
			wait.mockRestore();
			await runInDurableObject(currentServer(), (instance) => {
				instance.context.stagingDeletes.end(staged);
				return Promise.resolve();
			});
		}
	});

	it('answers from the current state when a repair accepts a completed operation during the availability check', async () => {
		const token = await initialise();
		const { entry, pushId } = await completedPublication(
			token,
			'publication-repair-during-check'
		);
		const availability = await runInDurableObject(
			currentServer(),
			(instance) => {
				const { db } = instance.context;
				const cache = db.select().from(schema.cacheIdentities).get();
				if (cache === undefined) {
					throw new Error('Expected the default cache');
				}
				const staged = r2ObjectKeySchema.parse(
					publicationStagingKey(fixtureTenant, pushId, entry.operationId)
				);
				const createdAt = isoTimestamp(new Date());
				const expiresAt = isoTimestamp(new Date(Date.now() + 60_000));
				let isRepaired = false;
				const spy = vi.spyOn(
					NarInfoObjectsService.prototype,
					'servableStorePathHashes'
				);
				spy.mockImplementation(function (
					this: NarInfoObjectsService,
					...arguments_
				) {
					const [, hashes] = arguments_;
					if (!isRepaired && hashes.includes(entry.metadata.storePathHash)) {
						isRepaired = true;
						db.update(schema.publicationOperations)
							.set({ state: 'accepted' })
							.where(eq(schema.publicationOperations.id, entry.operationId))
							.run();
						db.insert(schema.pendingUploads)
							.values({
								id: entry.operationId,
								cacheId: cache.id,
								narHash: entry.metadata.narHash,
								r2Key: staged,
								metadataJson: JSON.stringify(entry.metadata),
								createdAt,
								expiresAt
							})
							.run();
					}
					spy.mockRestore();
					const served = this.servableStorePathHashes(...arguments_);
					return served;
				});
				return Promise.resolve(spy);
			}
		);
		try {
			expect(
				await subscribe(token, undefined, pushId, entry, 'publish-batch')
			).toStrictEqual({
				ev: 'publication-refused',
				uploadId: entry.operationId,
				reason: 'temporary-failure',
				status: StatusCodes.SERVICE_UNAVAILABLE,
				hasMessage: true
			});
		} finally {
			availability.mockRestore();
		}
	});

	it.each([
		{
			name: 'a mismatch',
			change: (database: CupboardServer['context']['db'], id: UploadId) => {
				database
					.update(schema.pendingUploads)
					.set({ verdict: 'mismatch' })
					.where(eq(schema.pendingUploads.id, id))
					.run();
				database
					.update(schema.publicationOperations)
					.set({
						state: 'failed',
						resultJson: publicationFailureJson('mismatch')
					})
					.where(eq(schema.publicationOperations.id, id))
					.run();
			},
			answer: (id: UploadId) => ({
				ev: 'verdict',
				uploadId: id,
				status: 'mismatch',
				grace: {}
			})
		},
		{
			name: 'an expiry',
			change: (database: CupboardServer['context']['db'], id: UploadId) => {
				database
					.delete(schema.pendingUploads)
					.where(eq(schema.pendingUploads.id, id))
					.run();
				database
					.update(schema.publicationOperations)
					.set({ state: 'expired' })
					.where(eq(schema.publicationOperations.id, id))
					.run();
			},
			answer: (id: UploadId) => ({
				ev: 'publication-refused',
				uploadId: id,
				reason: 'recovery-expired',
				status: StatusCodes.SERVICE_UNAVAILABLE,
				hasMessage: true
			})
		}
	])(
		'answers from the state when $name is recorded during the staged object check',
		async ({ change, answer }) => {
			const token = await initialise();
			const [entry] = await plannedEntries(token, '/uploads/plan', [
				distinctPath('1')
			]);
			if (entry === undefined) {
				throw new Error('Expected a planned entry');
			}
			expect(await admit(token, testPushId, entry)).toStrictEqual([
				{ ev: 'publication-accepted', uploadId: entry.operationId },
				{ ev: 'upload-required', uploadId: entry.operationId }
			]);
			const staged = publicationStagingKey(
				fixtureTenant,
				testPushId,
				entry.operationId
			);
			const head = await runInDurableObject(currentServer(), (instance) => {
				const { db } = instance.context;
				const blobs = instance.context.env.BLOBS;
				const originalHead = blobs.head.bind(blobs);
				return Promise.resolve(
					vi.spyOn(blobs, 'head').mockImplementation((key) => {
						if (key === staged) {
							change(db, entry.operationId);
						}
						return originalHead(key);
					})
				);
			});
			try {
				expect(
					await subscribe(token, undefined, testPushId, entry, 'publish-batch')
				).toStrictEqual(answer(entry.operationId));
			} finally {
				head.mockRestore();
			}
		}
	);

	it('answers a replay that verification completes during the staged object check', async () => {
		const token = await initialise();
		const expiresAt = Math.floor(Date.now() / 1000) + 60;
		const pushId = await testPushIdFor(fixtureTenant, 6, expiresAt);
		const nar = await verifiableNar('publication-admission-staged-race');
		const path = uploadPathNegotiation(
			uploadMetadata({
				fileSize: nar.narBytes.byteLength,
				fileHash: nar.fileHash,
				narHash: nar.narHash,
				narSize: nar.narSize
			})
		);
		const [planned] = await plannedEntries(
			token,
			'/uploads/plan',
			[path],
			undefined,
			pushId
		);
		if (planned === undefined) {
			throw new Error('Expected a planned entry');
		}
		const entry = {
			...planned,
			blob: { fileHash: nar.fileHash, fileSize: nar.narBytes.byteLength }
		};
		const staged = publicationStagingKey(
			fixtureTenant,
			pushId,
			entry.operationId
		);
		await putNarBytes(staged, nar);
		expect(await admit(token, pushId, entry)).toStrictEqual([
			{ ev: 'publication-accepted', uploadId: entry.operationId },
			{
				ev: 'deferred',
				uploadId: entry.operationId,
				storePathHash: path.storePathHash,
				narHash: path.narHash,
				grace: {}
			}
		]);
		const replay = await openCommitSession(
			token,
			undefined,
			publicationSession
		);
		// Admission reads the staged object through the Durable Object's binding.
		const pause = new DurableObjectPause();
		let isPaused = false;
		const head = await runInDurableObject(currentServer(), (instance) => {
			const blobs = instance.context.env.BLOBS;
			const originalHead = blobs.head.bind(blobs);
			return Promise.resolve(
				vi.spyOn(blobs, 'head').mockImplementation(async (key) => {
					if (key !== staged || isPaused) {
						return originalHead(key);
					}
					isPaused = true;
					await pause.stop();
					return originalHead(key);
				})
			);
		});
		try {
			vi.setSystemTime(new Date((expiresAt + 1) * 1000));
			replay.send({ op: 'publish-batch', pushId, entries: [entry] });
			await pause.reached();
			await commitUpload(token, entry.operationId);
			await pause.release();
			expect([refusalFacts(await replay.nextFrame())]).toStrictEqual([
				{
					ev: 'settled',
					uploadId: entry.operationId,
					response: {
						storePathHash: path.storePathHash,
						narHash: path.narHash,
						status: 'already-present'
					},
					grace: {}
				}
			]);
		} finally {
			await pause.release();
			head.mockRestore();
			await closeSessionAndWait(replay.socket);
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

it("keeps another operation's reservation when an upload of the same path fails verification", async () => {
	await resetTestServer();
	const token = await initialise();
	const nar = await verifiableNar('publication-shared-mismatch');
	const path = uploadPathNegotiation(
		uploadMetadata({
			fileSize: nar.narBytes.byteLength,
			fileHash: nar.fileHash,
			narHash: nar.narHash,
			narSize: nar.narSize
		})
	);
	const [mismatched] = await plannedEntries(token, '/uploads/plan', [path]);
	const [live] = await plannedEntries(token, '/uploads/plan', [path], {
		name: rootNameSchema.parse('run'),
		retention: { kind: 'inherit' }
	});
	if (mismatched === undefined || live === undefined) {
		throw new Error('Expected two planned entries');
	}
	const session = await openCommitSession(token, undefined, publicationSession);
	try {
		// Both operations start their commits, which share one reservation.
		for (const entry of [mismatched, live]) {
			await putNarBytes(
				publicationStagingKey(fixtureTenant, testPushId, entry.operationId),
				nar
			);
			session.send({
				op: 'publish-batch',
				pushId: testPushId,
				entries: [
					{
						...entry,
						blob: { fileHash: nar.fileHash, fileSize: nar.narBytes.byteLength }
					}
				]
			});
			await session.nextFrame();
			await session.nextFrame();
		}
	} finally {
		session.socket.close();
	}
	const claim = await currentServer().claimVerificationBatch(
		10,
		Number.MAX_SAFE_INTEGER
	);
	await currentServer().recordVerifications(claim.owner, [
		{
			uploadId: mismatched.operationId,
			verdict: {
				kind: 'verified',
				verification: {
					ok: false,
					reason: 'nar-hash-mismatch',
					actualNarHash: nixSha256Hash('9')
				}
			}
		}
	]);
	const outcome = await runInDurableObject(currentServer(), (instance) => {
		const store = new PublicationStore(instance.context);
		return Promise.resolve({
			claimed: claim.claims
				.map((claimed) => claimed.uploadId)
				.toSorted((left, right) => left.localeCompare(right)),
			narInfos: instance.context.db
				.select({ storePathHash: schema.narInfos.storePathHash })
				.from(schema.narInfos)
				.all(),
			mismatched: store.get(mismatched.operationId)?.state,
			live: store.get(live.operationId)?.state
		});
	});
	expect(outcome).toStrictEqual({
		claimed: [mismatched.operationId, live.operationId].toSorted(
			(left, right) => left.localeCompare(right)
		),
		narInfos: [{ storePathHash: path.storePathHash }],
		mismatched: 'failed',
		live: 'accepted'
	});
});

it("keeps another operation's reservation when an exhausted upload of the same path fails", async () => {
	await resetTestServer();
	const token = await initialise();
	const nar = await verifiableNar('publication-shared-exhausted');
	const path = uploadPathNegotiation(
		uploadMetadata({
			fileSize: nar.narBytes.byteLength,
			fileHash: nar.fileHash,
			narHash: nar.narHash,
			narSize: nar.narSize
		})
	);
	const [exhausted] = await plannedEntries(token, '/uploads/plan', [path]);
	const [live] = await plannedEntries(token, '/uploads/plan', [path], {
		name: rootNameSchema.parse('run'),
		retention: { kind: 'inherit' }
	});
	if (exhausted === undefined || live === undefined) {
		throw new Error('Expected two planned entries');
	}
	const session = await openCommitSession(token, undefined, publicationSession);
	try {
		// Both operations start their commits, which share one reservation.
		for (const entry of [exhausted, live]) {
			await putNarBytes(
				publicationStagingKey(fixtureTenant, testPushId, entry.operationId),
				nar
			);
			session.send({
				op: 'publish-batch',
				pushId: testPushId,
				entries: [
					{
						...entry,
						blob: { fileHash: nar.fileHash, fileSize: nar.narBytes.byteLength }
					}
				]
			});
			await session.nextFrame();
			await session.nextFrame();
		}
	} finally {
		session.socket.close();
	}
	const outcome = await runInDurableObject(
		currentServer(),
		async (instance) => {
			const { db } = instance.context;
			db.update(schema.pendingUploads)
				.set({ verdict: 'pending', settleExhaustion: 'attempt-limit' })
				.where(eq(schema.pendingUploads.id, exhausted.operationId))
				.run();
			await asOneInvocation(() =>
				verificationOf(instance).processExhaustedUploads(rootLogger())
			);
			const store = new PublicationStore(instance.context);
			return {
				narInfos: db
					.select({ storePathHash: schema.narInfos.storePathHash })
					.from(schema.narInfos)
					.all(),
				exhausted: store.get(exhausted.operationId)?.state,
				live: store.get(live.operationId)?.state
			};
		}
	);
	expect(outcome).toStrictEqual({
		narInfos: [{ storePathHash: path.storePathHash }],
		exhausted: 'failed',
		live: 'accepted'
	});
});

it('attaches the run root of an exhausted upload whose shared generation is charged before its narinfo object is published', async () => {
	vi.setSystemTime(vi.getRealSystemTime());
	await resetTestServer();
	const token = await initialise();
	const nar = await verifiableNar('publication-shared-exhausted-charged');
	const path = uploadPathNegotiation(
		uploadMetadata({
			fileSize: nar.narBytes.byteLength,
			fileHash: nar.fileHash,
			narHash: nar.narHash,
			narSize: nar.narSize
		})
	);
	const exhaustedRoot = rootNameSchema.parse('exhausted');
	const [exhausted] = await plannedEntries(token, '/uploads/plan', [path], {
		name: exhaustedRoot,
		retention: { kind: 'inherit' }
	});
	const [live] = await plannedEntries(token, '/uploads/plan', [path], {
		name: rootNameSchema.parse('run'),
		retention: { kind: 'inherit' }
	});
	if (exhausted === undefined || live === undefined) {
		throw new Error('Expected two planned entries');
	}
	const blob = { fileHash: nar.fileHash, fileSize: nar.narBytes.byteLength };
	// Both operations start their commits, which share one reservation.
	for (const entry of [live, exhausted]) {
		await putNarBytes(
			publicationStagingKey(fixtureTenant, testPushId, entry.operationId),
			nar
		);
		await admit(token, testPushId, { ...entry, blob });
	}
	const claim = await currentServer().claimVerificationBatch(
		10,
		Number.MAX_SAFE_INTEGER
	);
	// The live operation's verification charges the commit and stops before it
	// publishes the narinfo object.
	const publication = new DurableObjectPause();
	const isPublished = vi
		.spyOn(NarInfoObjectsService.prototype, 'publishNarInfoObjectWhile')
		.mockImplementationOnce(async function (
			this: NarInfoObjectsService,
			...arguments_
		) {
			isPublished.mockRestore();
			await publication.stop();
			return this.publishNarInfoObjectWhile(...arguments_);
		});
	try {
		const recorded = currentServer().recordVerifications(claim.owner, [
			{
				uploadId: live.operationId,
				verdict: { kind: 'verified', verification: { ok: true, ...blob } }
			}
		]);
		await publication.reached();
		const outcome = await runInDurableObject(
			currentServer(),
			async (instance) => {
				const { db } = instance.context;
				// The other operation's upload is exhausted, and its claim lease
				// ends.
				db.update(schema.pendingUploads)
					.set({
						verdict: 'pending',
						settleExhaustion: 'attempt-limit',
						claimOwner: sql`null`,
						claimedAt: sql`null`
					})
					.where(eq(schema.pendingUploads.id, exhausted.operationId))
					.run();
				await asOneInvocation(() =>
					verificationOf(instance).processExhaustedUploads(rootLogger())
				);
				return {
					exhausted: new PublicationStore(instance.context).get(
						exhausted.operationId
					)?.state,
					targets: db
						.select({
							rootName: schema.retentionRootTargets.rootName,
							storePathHash: schema.retentionRootTargets.storePathHash
						})
						.from(schema.retentionRootTargets)
						.all()
				};
			}
		);
		await publication.release();
		await recorded;
		expect(outcome).toStrictEqual({
			exhausted: 'accepted',
			targets: [
				{ rootName: exhaustedRoot, storePathHash: path.storePathHash },
				{ rootName: 'run', storePathHash: path.storePathHash }
			]
		});
	} finally {
		isPublished.mockRestore();
		await publication.release();
	}
});

it("keeps another operation's reservation when an upload of the same path verifies while the tenant is suspended", async () => {
	await resetTestServer();
	const token = await initialise();
	const nar = await verifiableNar('publication-shared-suspended');
	const path = uploadPathNegotiation(
		uploadMetadata({
			fileSize: nar.narBytes.byteLength,
			fileHash: nar.fileHash,
			narHash: nar.narHash,
			narSize: nar.narSize
		})
	);
	const [stopped] = await plannedEntries(token, '/uploads/plan', [path]);
	const [live] = await plannedEntries(token, '/uploads/plan', [path], {
		name: rootNameSchema.parse('run'),
		retention: { kind: 'inherit' }
	});
	if (stopped === undefined || live === undefined) {
		throw new Error('Expected two planned entries');
	}
	const session = await openCommitSession(token, undefined, publicationSession);
	try {
		// Both operations start their commits, which share one reservation.
		for (const entry of [stopped, live]) {
			await putNarBytes(
				publicationStagingKey(fixtureTenant, testPushId, entry.operationId),
				nar
			);
			session.send({
				op: 'publish-batch',
				pushId: testPushId,
				entries: [
					{
						...entry,
						blob: { fileHash: nar.fileHash, fileSize: nar.narBytes.byteLength }
					}
				]
			});
			await session.nextFrame();
			await session.nextFrame();
		}
	} finally {
		session.socket.close();
	}
	const claim = await currentServer().claimVerificationBatch(
		10,
		Number.MAX_SAFE_INTEGER
	);
	// The tenant is suspended after the verification pass reads it as active
	// and before the commit is charged. A suspended tenant can be resumed, and
	// the live operation can then commit on the reservation.
	const materialised: unknown[] = [];
	const materialise = vi
		.spyOn(CommitPipelineService.prototype, 'materialiseBatched')
		.mockImplementationOnce(async function (
			this: CommitPipelineService,
			...arguments_
		) {
			materialise.mockRestore();
			await suspendTenant(fixtureTenant);
			const result = await this.materialiseBatched(...arguments_);
			materialised.push(result);
			return result;
		});
	try {
		await currentServer().recordVerifications(claim.owner, [
			{
				uploadId: stopped.operationId,
				verdict: {
					kind: 'verified',
					verification: {
						ok: true,
						fileHash: nar.fileHash,
						fileSize: nar.narBytes.byteLength
					}
				}
			}
		]);
	} finally {
		materialise.mockRestore();
	}
	const outcome = await runInDurableObject(currentServer(), (instance) => {
		const store = new PublicationStore(instance.context);
		return Promise.resolve({
			claimed: claim.claims
				.map((claimed) => claimed.uploadId)
				.toSorted((left, right) => left.localeCompare(right)),
			narInfos: instance.context.db
				.select({ storePathHash: schema.narInfos.storePathHash })
				.from(schema.narInfos)
				.all(),
			stopped: store.get(stopped.operationId)?.state,
			live: store.get(live.operationId)?.state
		});
	});
	expect({ ...outcome, materialised }).toStrictEqual({
		claimed: [stopped.operationId, live.operationId].toSorted((left, right) =>
			left.localeCompare(right)
		),
		narInfos: [{ storePathHash: path.storePathHash }],
		stopped: 'accepted',
		live: 'accepted',
		materialised: [{ kind: 'tenant-inactive', tenantStatus: 'suspended' }]
	});
});

it("keeps another operation's reservation when a reuse commit of the same path finds the tenant suspended", async () => {
	await resetTestServer();
	const token = await initialise();
	const nar = await verifiableNar('publication-shared-session-suspended');
	const narFields = {
		fileSize: nar.narBytes.byteLength,
		fileHash: nar.fileHash,
		narHash: nar.narHash,
		narSize: nar.narSize
	};
	const path = uploadPathNegotiation(uploadMetadata(narFields));
	const [reusing] = await plannedEntries(token, '/uploads/plan', [path]);
	const [live] = await plannedEntries(token, '/uploads/plan', [path], {
		name: rootNameSchema.parse('run'),
		retention: { kind: 'inherit' }
	});
	if (reusing === undefined || live === undefined) {
		throw new Error('Expected two planned entries');
	}
	const blob = { fileHash: nar.fileHash, fileSize: nar.narBytes.byteLength };
	const session = await openCommitSession(token, undefined, publicationSession);
	try {
		session.send({ op: 'publish-batch', pushId: testPushId, entries: [live] });
		expect([
			await session.nextFrame(),
			await session.nextFrame()
		]).toStrictEqual([
			{ ev: 'publication-accepted', uploadId: live.operationId },
			{ ev: 'upload-required', uploadId: live.operationId }
		]);
		// Another path makes the NAR reusable, and the live operation's bytes
		// arrive.
		await commitPath(
			token,
			uploadMetadata({
				...narFields,
				name: 'shared-session-suspended',
				storePathHash: '3'.repeat(32)
			}),
			nar
		);
		await putNarBytes(
			publicationStagingKey(fixtureTenant, testPushId, live.operationId),
			nar
		);
		// After the reuse commit reserves the row, the live operation starts its
		// commit, which shares the reservation. The tenant is then suspended
		// before the reuse commit is charged.
		const materialised: unknown[] = [];
		const materialise = await runInDurableObject(
			currentServer(),
			(instance) => {
				const { db } = instance.context;
				const spy = vi
					.spyOn(CommitPipelineService.prototype, 'materialiseBatched')
					.mockImplementationOnce(async function (
						this: CommitPipelineService,
						...arguments_
					) {
						spy.mockRestore();
						db.update(schema.pendingUploads)
							.set({ verdict: 'pending' })
							.where(eq(schema.pendingUploads.id, live.operationId))
							.run();
						await suspendTenant(fixtureTenant);
						const result = await this.materialiseBatched(...arguments_);
						materialised.push(result);
						return result;
					});
				return Promise.resolve(spy);
			}
		);
		try {
			session.send({
				op: 'publish-batch',
				pushId: testPushId,
				entries: [{ ...reusing, blob }]
			});
			const answer = [];
			for (const frame of [
				await session.nextFrame(),
				await session.nextFrame()
			]) {
				if (frame.ev !== 'error') {
					answer.push(frame);
					continue;
				}
				const { message, ...facts } = frame;
				answer.push({ ...facts, hasMessage: message.length > 0 });
			}
			// An operator resumes the tenant, and the live operation's commit can
			// then use the reservation.
			await resumeTenant(
				drizzleD1(env.CUPBOARD_DB, { schema: d1Schema }),
				fixtureTenant
			);
			const resumed = await runInDurableObject(currentServer(), (instance) => {
				const store = new PublicationStore(instance.context);
				return Promise.resolve({
					narInfos: instance.context.db
						.select({ storePathHash: schema.narInfos.storePathHash })
						.from(schema.narInfos)
						.where(eq(schema.narInfos.storePathHash, path.storePathHash))
						.all(),
					reusing: store.get(reusing.operationId)?.state,
					live: store.get(live.operationId)?.state
				});
			});
			expect({ answer, materialised, resumed }).toStrictEqual({
				answer: [
					{ ev: 'publication-accepted', uploadId: reusing.operationId },
					{
						ev: 'error',
						uploadId: reusing.operationId,
						status: StatusCodes.FORBIDDEN,
						hasMessage: true
					}
				],
				materialised: [{ kind: 'tenant-inactive', tenantStatus: 'suspended' }],
				resumed: {
					narInfos: [{ storePathHash: path.storePathHash }],
					reusing: 'accepted',
					live: 'accepted'
				}
			});
		} finally {
			materialise.mockRestore();
		}
	} finally {
		await closeSessionAndWait(session.socket);
	}
});

it('decides whether another operation committed a shared reservation outside the input gate', async () => {
	await resetTestServer();
	const token = await initialise();
	const nar = await verifiableNar('publication-shared-exhausted-gate');
	const path = uploadPathNegotiation(
		uploadMetadata({
			fileSize: nar.narBytes.byteLength,
			fileHash: nar.fileHash,
			narHash: nar.narHash,
			narSize: nar.narSize
		})
	);
	const [exhausted] = await plannedEntries(token, '/uploads/plan', [path]);
	const [live] = await plannedEntries(token, '/uploads/plan', [path], {
		name: rootNameSchema.parse('run'),
		retention: { kind: 'inherit' }
	});
	if (exhausted === undefined || live === undefined) {
		throw new Error('Expected two planned entries');
	}
	const session = await openCommitSession(token, undefined, publicationSession);
	try {
		// Both operations start their commits, which share one reservation.
		for (const entry of [exhausted, live]) {
			await putNarBytes(
				publicationStagingKey(fixtureTenant, testPushId, entry.operationId),
				nar
			);
			session.send({
				op: 'publish-batch',
				pushId: testPushId,
				entries: [
					{
						...entry,
						blob: { fileHash: nar.fileHash, fileSize: nar.narBytes.byteLength }
					}
				]
			});
			await session.nextFrame();
			await session.nextFrame();
		}
	} finally {
		session.socket.close();
	}
	const probe = new GateProbe();
	const spies = await runInDurableObject(currentServer(), (instance) => {
		instance.context.db
			.update(schema.pendingUploads)
			.set({ verdict: 'pending', settleExhaustion: 'attempt-limit' })
			.where(eq(schema.pendingUploads.id, exhausted.operationId))
			.run();
		const isGenerationCharged = vi
			.spyOn(CommitPipelineService.prototype, 'isGenerationCharged')
			.mockImplementation(function (
				this: CommitPipelineService,
				...arguments_
			) {
				isGenerationCharged.mockRestore();
				return probe.around(() => this.isGenerationCharged(...arguments_));
			});
		return Promise.resolve([
			probe.watch(instance.context),
			isGenerationCharged
		]);
	});
	try {
		const pass = runInDurableObject(currentServer(), (instance) =>
			asOneInvocation(() =>
				verificationOf(instance).processExhaustedUploads(rootLogger())
			)
		);
		const first = await probe.first(pass);
		// Another request reaches the object while the read waits.
		const during = await snapshot();
		await probe.pause.release();
		await pass;
		const outcome = await runInDurableObject(currentServer(), (instance) => {
			const store = new PublicationStore(instance.context);
			return Promise.resolve({
				narInfos: instance.context.db
					.select({ storePathHash: schema.narInfos.storePathHash })
					.from(schema.narInfos)
					.all(),
				exhausted: store.get(exhausted.operationId)?.state,
				live: store.get(live.operationId)?.state
			});
		});
		expect({
			first,
			calls: probe.calls,
			during: during.operations.map((operation) => operation.state),
			outcome
		}).toStrictEqual({
			first: 'stopped',
			calls: [false],
			during: ['accepted', 'accepted'],
			outcome: {
				narInfos: [{ storePathHash: path.storePathHash }],
				exhausted: 'failed',
				live: 'accepted'
			}
		});
	} finally {
		await probe.pause.release();
		for (const spy of spies) {
			spy.mockRestore();
		}
	}
});

it("keeps a newer publication's run root target when a failed upload of the same path cleans up", async () => {
	await resetTestServer();
	const token = await initialise();
	const nar = await verifiableNar('publication-prune-newer-root');
	const path = uploadPathNegotiation(
		uploadMetadata({
			fileSize: nar.narBytes.byteLength,
			fileHash: nar.fileHash,
			narHash: nar.narHash,
			narSize: nar.narSize
		})
	);
	const [failing] = await plannedEntries(token, '/uploads/plan', [path]);
	if (failing === undefined) {
		throw new Error('Expected a planned entry');
	}
	await putNarBytes(
		publicationStagingKey(fixtureTenant, testPushId, failing.operationId),
		nar
	);
	const session = await openCommitSession(token, undefined, publicationSession);
	try {
		session.send({
			op: 'publish-batch',
			pushId: testPushId,
			entries: [
				{
					...failing,
					blob: { fileHash: nar.fileHash, fileSize: nar.narBytes.byteLength }
				}
			]
		});
		await session.nextFrame();
		await session.nextFrame();
	} finally {
		await closeSessionAndWait(session.socket);
	}
	const claim = await currentServer().claimVerificationBatch(
		10,
		Number.MAX_SAFE_INTEGER
	);
	// The failing upload's cleanup stops after the gate that reclaims its
	// reservation.
	const cleanup = new DurableObjectPause();
	const isMarkedTerminal = vi
		.spyOn(UploadStateService.prototype, 'markUploadTerminal')
		.mockImplementationOnce(async function (
			this: UploadStateService,
			...arguments_
		) {
			isMarkedTerminal.mockRestore();
			await cleanup.stop();
			return this.markUploadTerminal(...arguments_);
		});
	try {
		const failed = currentServer().recordVerifications(claim.owner, [
			{
				uploadId: failing.operationId,
				verdict: {
					kind: 'verified',
					verification: {
						ok: false,
						reason: 'nar-hash-mismatch',
						actualNarHash: nixSha256Hash('8')
					}
				}
			}
		]);
		await cleanup.reached();
		// A newer publication of the path attaches it to its run root meanwhile.
		await runInDurableObject(currentServer(), (instance) => {
			const cache = instance.context.cacheRepository.require(defaultCache());
			instance.context.db
				.insert(schema.retentionRootTargets)
				.values({
					cacheId: cache.id,
					rootName: rootNameSchema.parse('run'),
					storePathHash: path.storePathHash,
					storePath: path.storePath
				})
				.run();
			return Promise.resolve();
		});
		await cleanup.release();
		await failed;
	} finally {
		isMarkedTerminal.mockRestore();
		await cleanup.release();
	}
	const after = await runInDurableObject(currentServer(), (instance) =>
		Promise.resolve({
			targets: instance.context.db
				.select({
					rootName: schema.retentionRootTargets.rootName,
					storePathHash: schema.retentionRootTargets.storePathHash
				})
				.from(schema.retentionRootTargets)
				.all(),
			narInfos: instance.context.db
				.select({ storePathHash: schema.narInfos.storePathHash })
				.from(schema.narInfos)
				.all(),
			failing: new PublicationStore(instance.context).get(failing.operationId)
				?.state
		})
	);
	expect(after).toStrictEqual({
		targets: [{ rootName: 'run', storePathHash: path.storePathHash }],
		narInfos: [],
		failing: 'failed'
	});
});

it('removes the retention targets of a reservation that a reuse commit reclaims when the tenant is suspended', async () => {
	await resetTestServer();
	const token = await initialise();
	const nar = await verifiableNar('publication-session-suspended-prune');
	const narFields = {
		fileSize: nar.narBytes.byteLength,
		fileHash: nar.fileHash,
		narHash: nar.narHash,
		narSize: nar.narSize
	};
	const path = uploadPathNegotiation(uploadMetadata(narFields));
	const [reusing] = await plannedEntries(token, '/uploads/plan', [path]);
	if (reusing === undefined) {
		throw new Error('Expected a planned entry');
	}
	// Another path makes the NAR reusable.
	await commitPath(
		token,
		uploadMetadata({
			...narFields,
			name: 'session-suspended-prune',
			storePathHash: '5'.repeat(32)
		}),
		nar
	);
	// A root includes the path. The tenant is suspended after the reuse commit
	// reserves the row and before it is charged.
	const materialise = await runInDurableObject(currentServer(), (instance) => {
		const cache = instance.context.cacheRepository.require(defaultCache());
		instance.context.db
			.insert(schema.retentionRootTargets)
			.values({
				cacheId: cache.id,
				rootName: rootNameSchema.parse('run'),
				storePathHash: path.storePathHash,
				storePath: path.storePath
			})
			.run();
		const spy = vi
			.spyOn(CommitPipelineService.prototype, 'materialiseBatched')
			.mockImplementationOnce(async function (
				this: CommitPipelineService,
				...arguments_
			) {
				spy.mockRestore();
				await suspendTenant(fixtureTenant);
				return this.materialiseBatched(...arguments_);
			});
		return Promise.resolve(spy);
	});
	let answer: unknown[];
	try {
		const frames = await admit(token, testPushId, {
			...reusing,
			blob: { fileHash: nar.fileHash, fileSize: nar.narBytes.byteLength }
		});
		answer = frames.map((frame) => {
			if (frame.ev !== 'error') {
				return frame;
			}
			const { message, ...facts } = frame;
			return { ...facts, hasMessage: message.length > 0 };
		});
	} finally {
		materialise.mockRestore();
	}
	const after = await runInDurableObject(currentServer(), (instance) =>
		Promise.resolve({
			narInfos: instance.context.db
				.select({ storePathHash: schema.narInfos.storePathHash })
				.from(schema.narInfos)
				.where(eq(schema.narInfos.storePathHash, path.storePathHash))
				.all(),
			targets: instance.context.db
				.select({ storePathHash: schema.retentionRootTargets.storePathHash })
				.from(schema.retentionRootTargets)
				.where(
					eq(schema.retentionRootTargets.storePathHash, path.storePathHash)
				)
				.all()
		})
	);
	expect({ answer, after }).toStrictEqual({
		answer: [
			{ ev: 'publication-accepted', uploadId: reusing.operationId },
			{
				ev: 'error',
				uploadId: reusing.operationId,
				status: StatusCodes.FORBIDDEN,
				hasMessage: true
			}
		],
		after: { narInfos: [], targets: [] }
	});
});

it("keeps another operation's reservation when an operation without bytes expires", async () => {
	await resetTestServer();
	const token = await initialise();
	const nar = await verifiableNar('publication-shared-path');
	const path = uploadPathNegotiation(
		uploadMetadata({
			fileSize: nar.narBytes.byteLength,
			fileHash: nar.fileHash,
			narHash: nar.narHash,
			narSize: nar.narSize
		})
	);
	const [expiring] = await plannedEntries(token, '/uploads/plan', [path]);
	const [live] = await plannedEntries(token, '/uploads/plan', [path], {
		name: rootNameSchema.parse('run'),
		retention: { kind: 'inherit' }
	});
	if (expiring === undefined || live === undefined) {
		throw new Error('Expected two planned entries');
	}
	await putNarBytes(
		publicationStagingKey(fixtureTenant, testPushId, live.operationId),
		nar
	);
	const session = await openCommitSession(token, undefined, publicationSession);
	try {
		session.send({
			op: 'publish-batch',
			pushId: testPushId,
			entries: [expiring]
		});
		expect([
			await session.nextFrame(),
			await session.nextFrame()
		]).toStrictEqual([
			{ ev: 'publication-accepted', uploadId: expiring.operationId },
			{ ev: 'upload-required', uploadId: expiring.operationId }
		]);
		session.send({
			op: 'publish-batch',
			pushId: testPushId,
			entries: [
				{
					...live,
					blob: { fileHash: nar.fileHash, fileSize: nar.narBytes.byteLength }
				}
			]
		});
		expect([
			await session.nextFrame(),
			await session.nextFrame()
		]).toStrictEqual([
			{ ev: 'publication-accepted', uploadId: live.operationId },
			{
				ev: 'deferred',
				uploadId: live.operationId,
				storePathHash: path.storePathHash,
				narHash: path.narHash,
				grace: {}
			}
		]);
	} finally {
		session.socket.close();
	}
	const reservation = () =>
		runInDurableObject(currentServer(), (instance) =>
			Promise.resolve({
				narInfos: instance.context.db
					.select({
						storePathHash: schema.narInfos.storePathHash,
						generation: schema.narInfos.generation
					})
					.from(schema.narInfos)
					.all(),
				targets: instance.context.db
					.select({
						rootName: schema.retentionRootTargets.rootName,
						storePathHash: schema.retentionRootTargets.storePathHash
					})
					.from(schema.retentionRootTargets)
					.all()
			})
		);
	// A root can include the path while the live operation's bytes are being
	// verified.
	await runInDurableObject(currentServer(), (instance) => {
		const cache = instance.context.cacheRepository.require(defaultCache());
		instance.context.db
			.insert(schema.retentionRootTargets)
			.values({
				cacheId: cache.id,
				rootName: rootNameSchema.parse('run'),
				storePathHash: path.storePathHash,
				storePath: path.storePath
			})
			.onConflictDoNothing()
			.run();
		return Promise.resolve();
	});
	const reserved = await reservation();
	await runInDurableObject(currentServer(), (instance) => {
		const deadline = new Date(Date.now() - 1).toISOString();
		instance.context.db
			.update(schema.publicationOperations)
			.set({ recoveryDeadline: deadline })
			.where(eq(schema.publicationOperations.id, expiring.operationId))
			.run();
		instance.context.db
			.update(schema.pendingUploads)
			.set({ recoveryDeadline: deadline })
			.where(eq(schema.pendingUploads.id, expiring.operationId))
			.run();
		return Promise.resolve();
	});
	await currentServer().runVerification();
	const after = await snapshot();
	expect({
		reservation: await reservation(),
		pending: after.pending.map((row) => row.id),
		operations: after.operations
			.map((operation) => ({ id: operation.id, state: operation.state }))
			.toSorted((left, right) => left.id.localeCompare(right.id))
	}).toStrictEqual({
		reservation: reserved,
		pending: [live.operationId],
		operations: [
			{ id: expiring.operationId, state: 'expired' },
			{ id: live.operationId, state: 'accepted' }
		].toSorted((left, right) => left.id.localeCompare(right.id))
	});
});

it('reclaims an expiring reservation when another upload for the path has a different NAR', async () => {
	await resetTestServer();
	const token = await initialise();
	const nars = [
		await verifiableNar('publication-reserved-x'),
		await verifiableNar('publication-reserved-y')
	];
	const paths = nars.map((nar) =>
		uploadPathNegotiation(
			uploadMetadata({
				fileSize: nar.narBytes.byteLength,
				fileHash: nar.fileHash,
				narHash: nar.narHash,
				narSize: nar.narSize
			})
		)
	);
	const entries = [];
	for (const [index, path] of paths.entries()) {
		const nar = nars[index];
		const [planned] = await plannedEntries(token, '/uploads/plan', [path]);
		if (nar === undefined || planned === undefined) {
			throw new Error('Expected a planned entry for each NAR');
		}
		await putNarBytes(
			publicationStagingKey(fixtureTenant, testPushId, planned.operationId),
			nar
		);
		entries.push({
			...planned,
			blob: { fileHash: nar.fileHash, fileSize: nar.narBytes.byteLength }
		});
	}
	const [expiring, other] = entries;
	if (expiring === undefined || other === undefined) {
		throw new Error('Expected two entries');
	}
	const session = await openCommitSession(token, undefined, publicationSession);
	try {
		for (const entry of entries) {
			session.send({
				op: 'publish-batch',
				pushId: testPushId,
				entries: [entry]
			});
			await session.nextFrame();
			await session.nextFrame();
		}
	} finally {
		await closeSessionAndWait(session.socket);
	}
	const outcome = await runInDurableObject(
		currentServer(),
		async (instance) => {
			const reserved = instance.context.db
				.select({ narHash: schema.narInfos.narHash })
				.from(schema.narInfos)
				.all();
			const deadline = new Date(Date.now() - 1).toISOString();
			instance.context.db
				.update(schema.publicationOperations)
				.set({ recoveryDeadline: deadline })
				.where(eq(schema.publicationOperations.id, expiring.operationId))
				.run();
			instance.context.db
				.update(schema.pendingUploads)
				.set({ recoveryDeadline: deadline })
				.where(eq(schema.pendingUploads.id, expiring.operationId))
				.run();
			await asOneInvocation(() =>
				verificationOf(instance).expirePublications(rootLogger())
			);
			return {
				reserved,
				after: instance.context.db
					.select({ narHash: schema.narInfos.narHash })
					.from(schema.narInfos)
					.all(),
				pending: instance.context.db
					.select({
						id: schema.pendingUploads.id,
						verdict: schema.pendingUploads.verdict
					})
					.from(schema.pendingUploads)
					.all()
			};
		}
	);
	expect(outcome).toStrictEqual({
		reserved: [{ narHash: expiring.metadata.narHash }],
		after: [],
		pending: [{ id: other.operationId, verdict: 'pending' }]
	});
});

function insertServable(
	instance: CupboardServer,
	count: number,
	pruneAfter: string
): void {
	const cache = instance.context.db.select().from(schema.cacheIdentities).get();
	if (cache === undefined) {
		throw new Error('Expected the default cache');
	}
	const now = new Date().toISOString();
	for (let index = 0; index < count; index += 1) {
		instance.context.db
			.insert(schema.publicationOperations)
			.values({
				id: uploadIdSchema.parse(index.toString(16).padStart(64, '0')),
				cacheId: cache.id,
				cacheGeneration: cache.generation,
				pushId: testPushId,
				canonicalJson: '[]',
				acceptedAt: now,
				pushExpiresAt: now,
				recoveryDeadline: now,
				pruneAfter,
				graceDecisionJson: '{"reportsGrace":true}',
				state: 'servable'
			})
			.run();
	}
}

describe('terminal publication pruning', () => {
	// Durable Object alarms use the real clock, so these tests run on it.
	beforeEach(async () => {
		vi.setSystemTime(vi.getRealSystemTime());
		await resetTestServer();
	});

	it('arms an alarm for the next terminal record to prune', async () => {
		await initialise();
		const pruneAfter = new Date(Date.now() + 60 * 60 * 1000).toISOString();
		const alarm = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				insertServable(instance, 1, pruneAfter);
				await state.storage.deleteAlarm();
				await new PublicationStore(instance.context).armRecoveryAlarm();
				return state.storage.getAlarm();
			}
		);
		expect(alarm).toBe(Date.parse(pruneAfter));
	});

	it('continues pruning when one pass reaches its limit', async () => {
		await initialise();
		const passedAt = Date.now();
		const result = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				insertServable(instance, 1001, new Date().toISOString());
				await state.storage.deleteAlarm();
				await instance.alarm();
				const remaining = instance.context.db
					.select({ id: schema.publicationOperations.id })
					.from(schema.publicationOperations)
					.all().length;
				const next = await state.storage.getAlarm();
				return {
					remaining,
					// The pass arms the alarm at once. Durable Object storage keeps
					// real time, so the stored alarm lies between the frozen test
					// clock and the real clock.
					isArmedNow:
						next !== null && next >= passedAt && next <= vi.getRealSystemTime()
				};
			}
		);
		expect(result).toStrictEqual({ remaining: 1, isArmedNow: true });
	});
});

// A pending row whose metadata does not parse makes its operation's expiry
// throw.
function insertExpiringOperation(
	instance: CupboardServer,
	idPrefix: string,
	recoveryDeadline: Date,
	hasBrokenUpload: boolean
): UploadId {
	const cache = instance.context.db.select().from(schema.cacheIdentities).get();
	if (cache === undefined) {
		throw new Error('Expected the default cache');
	}
	const id = uploadIdSchema.parse(idPrefix.padEnd(64, idPrefix.slice(-1)));
	const deadline = isoTimestamp(recoveryDeadline);
	const pruneAfter = isoTimestamp(new Date(Date.now() + 60 * 60 * 1000));
	instance.context.db
		.insert(schema.publicationOperations)
		.values({
			id,
			cacheId: cache.id,
			cacheGeneration: cache.generation,
			pushId: testPushId,
			canonicalJson: '[]',
			acceptedAt: deadline,
			pushExpiresAt: deadline,
			recoveryDeadline: deadline,
			pruneAfter,
			graceDecisionJson: '{"reportsGrace":true}'
		})
		.run();
	if (hasBrokenUpload) {
		instance.context.db
			.insert(schema.pendingUploads)
			.values({
				id,
				cacheId: cache.id,
				narHash: nixSha256Hash('1'),
				r2Key: r2ObjectKeySchema.parse(`staging/broken/${id}`),
				metadataJson: '{}',
				createdAt: deadline,
				expiresAt: deadline,
				recoveryDeadline: deadline,
				verdict: 'pending'
			})
			.run();
	}
	return id;
}

// Returns the rows that two expiry runs read when `backlog` failing operations
// share one recovery deadline. The first run reads the first page, and the
// second run reads the page after the position that the first run stores.
async function expiryRunRowsRead(backlog: number): Promise<{
	readonly first: number;
	readonly next: number;
}> {
	vi.setSystemTime(vi.getRealSystemTime());
	await resetTestServer();
	await initialise();
	return runInDurableObject(currentServer(), async (instance) => {
		const deadline = new Date(Date.now() - 1000);
		for (let index = 0; index < backlog; index += 1) {
			insertExpiringOperation(
				instance,
				index.toString(16).padStart(3, '0'),
				deadline,
				true
			);
		}
		const { dbCost } = instance.context;
		const run = async () => {
			dbCost.recordOutstanding();
			const before = dbCost.rowsRead;
			await asOneInvocation(() =>
				verificationOf(instance).expirePublications(rootLogger())
			);
			dbCost.recordOutstanding();
			return dbCost.rowsRead - before;
		};
		const first = await run();
		// A run that only failed waits ten minutes before the next one.
		vi.setSystemTime(new Date(Date.now() + 10 * 60 * 1000));
		const next = await run();
		return { first, next };
	});
}

describe('publication expiry failures', () => {
	// Durable Object alarms use the real clock, so these tests run on it.
	beforeEach(async () => {
		vi.setSystemTime(vi.getRealSystemTime());
		await resetTestServer();
	});

	it('expires the other operations and prunes when one operation fails', async () => {
		await initialise();
		const outcome = await runInDurableObject(
			currentServer(),
			async (instance) => {
				const broken = insertExpiringOperation(
					instance,
					'b',
					new Date(Date.now() - 2000),
					true
				);
				const expiring = insertExpiringOperation(
					instance,
					'c',
					new Date(Date.now() - 1000),
					false
				);
				insertServable(instance, 1, new Date().toISOString());
				await asOneInvocation(() =>
					verificationOf(instance).expirePublications(rootLogger())
				);
				return {
					operations: instance.context.db
						.select({
							id: schema.publicationOperations.id,
							state: schema.publicationOperations.state
						})
						.from(schema.publicationOperations)
						.orderBy(schema.publicationOperations.id)
						.all(),
					expected: [
						{ id: broken, state: 'accepted' },
						{ id: expiring, state: 'expired' }
					]
				};
			}
		);
		expect(outcome.operations).toStrictEqual(outcome.expected);
	});

	it('reaches an expirable operation behind a full page of failing operations', async () => {
		await initialise();
		const state = await runInDurableObject(
			currentServer(),
			async (instance) => {
				for (let index = 0; index < 26; index += 1) {
					insertExpiringOperation(
						instance,
						index.toString(16).padStart(2, '0'),
						new Date(Date.now() - 100_000 + index),
						true
					);
				}
				const expiring = insertExpiringOperation(
					instance,
					'ff',
					new Date(Date.now() - 1000),
					false
				);
				for (let run = 0; run < 2; run += 1) {
					await asOneInvocation(() =>
						verificationOf(instance).expirePublications(rootLogger())
					);
					// A run that only failed waits ten minutes before the next one.
					vi.setSystemTime(new Date(Date.now() + 10 * 60 * 1000));
				}
				return instance.context.db
					.select({ state: schema.publicationOperations.state })
					.from(schema.publicationOperations)
					.where(eq(schema.publicationOperations.id, expiring))
					.get();
			}
		);
		expect(state).toStrictEqual({ state: 'expired' });
	});

	it('reads the same rows for a page of due operations whatever the number that share its deadline', async () => {
		const small = await expiryRunRowsRead(100);
		const large = await expiryRunRowsRead(1000);
		expect(large).toStrictEqual(small);
	});

	it('skips expiry until the retry time after a run that expired no operation and had a failure', async () => {
		await initialise();
		const states = await runInDurableObject(
			currentServer(),
			async (instance) => {
				insertExpiringOperation(
					instance,
					'b',
					new Date(Date.now() - 2000),
					true
				);
				const verification = verificationOf(instance);
				await asOneInvocation(() =>
					verification.expirePublications(rootLogger())
				);
				const expiring = insertExpiringOperation(
					instance,
					'c',
					new Date(Date.now() - 1000),
					false
				);
				const state = () =>
					instance.context.db
						.select({ state: schema.publicationOperations.state })
						.from(schema.publicationOperations)
						.where(eq(schema.publicationOperations.id, expiring))
						.get()?.state;
				await asOneInvocation(() =>
					verification.expirePublications(rootLogger())
				);
				const beforeRetry = state();
				vi.setSystemTime(new Date(Date.now() + 10 * 60 * 1000));
				await asOneInvocation(() =>
					verification.expirePublications(rootLogger())
				);
				return { beforeRetry, afterRetry: state() };
			}
		);
		expect(states).toStrictEqual({
			beforeRetry: 'accepted',
			afterRetry: 'expired'
		});
	});

	it('ends expiry at once when the pass is aborted', async () => {
		await initialise();
		const outcome = await runInDurableObject(
			currentServer(),
			async (instance) => {
				const expiring = insertExpiringOperation(
					instance,
					'c',
					new Date(Date.now() - 1000),
					false
				);
				const controller = new AbortController();
				controller.abort(new ExpiryAbortReason());
				let failure: unknown;
				try {
					await asOneInvocation(() =>
						verificationOf(instance).expirePublications(
							rootLogger(),
							controller.signal
						)
					);
				} catch (error) {
					failure = error;
				}
				return {
					isAborted: failure instanceof ExpiryAbortReason,
					state: instance.context.db
						.select({ state: schema.publicationOperations.state })
						.from(schema.publicationOperations)
						.where(eq(schema.publicationOperations.id, expiring))
						.get()?.state
				};
			}
		);
		expect(outcome).toStrictEqual({ isAborted: true, state: 'accepted' });
	});

	it('ends expiry without throwing when it cannot arm its next alarm', async () => {
		await initialise();
		const outcome = await runInDurableObject(
			currentServer(),
			async (instance) => {
				const expiring = insertExpiringOperation(
					instance,
					'c',
					new Date(Date.now() - 1000),
					false
				);
				const arming = vi
					.spyOn(PublicationStore.prototype, 'armRecoveryAlarm')
					.mockRejectedValueOnce(new PublicationExpiryFault());
				let failure: unknown;
				try {
					await asOneInvocation(() =>
						verificationOf(instance).expirePublications(rootLogger())
					);
				} catch (error) {
					failure = error;
				}
				const arms = arming.mock.calls.length;
				arming.mockRestore();
				return {
					arms,
					isFault: failure instanceof PublicationExpiryFault,
					state: instance.context.db
						.select({ state: schema.publicationOperations.state })
						.from(schema.publicationOperations)
						.where(eq(schema.publicationOperations.id, expiring))
						.get()?.state
				};
			}
		);
		expect(outcome).toStrictEqual({
			arms: 1,
			isFault: false,
			state: 'expired'
		});
	});

	it('ends expiry without throwing when it cannot read its retry time', async () => {
		await initialise();
		const outcome = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				const expiring = insertExpiringOperation(
					instance,
					'c',
					new Date(Date.now() - 1000),
					false
				);
				const storageRead = vi
					.spyOn(state.storage, 'get')
					.mockRejectedValueOnce(new PublicationExpiryFault());
				let failure: unknown;
				try {
					await asOneInvocation(() =>
						verificationOf(instance).expirePublications(rootLogger())
					);
				} catch (error) {
					failure = error;
				}
				const reads = [...storageRead.mock.calls];
				storageRead.mockRestore();
				return {
					reads,
					isFault: failure instanceof PublicationExpiryFault,
					state: instance.context.db
						.select({ state: schema.publicationOperations.state })
						.from(schema.publicationOperations)
						.where(eq(schema.publicationOperations.id, expiring))
						.get()?.state
				};
			}
		);
		expect(outcome).toStrictEqual({
			reads: [['maintenance:publication-expiry-retry-at']],
			isFault: false,
			state: 'accepted'
		});
	});

	it('arms a delayed retry when every due operation fails', async () => {
		await initialise();
		const alarm = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				insertExpiringOperation(
					instance,
					'b',
					new Date(Date.now() - 1000),
					true
				);
				await state.storage.deleteAlarm();
				await asOneInvocation(() =>
					verificationOf(instance).expirePublications(rootLogger())
				);
				return state.storage.getAlarm();
			}
		);
		expect(alarm).toBe(Date.now() + 10 * 60 * 1000);
	});

	it('keeps the retry alarm when an earlier alarm runs expiry before the retry time', async () => {
		await initialise();
		const alarms = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				insertExpiringOperation(
					instance,
					'b',
					new Date(Date.now() - 1000),
					true
				);
				const verification = verificationOf(instance);
				await asOneInvocation(() =>
					verification.expirePublications(rootLogger())
				);
				const armed = await state.storage.getAlarm();
				// Delivering an earlier alarm clears the stored alarm.
				await state.storage.deleteAlarm();
				await asOneInvocation(() =>
					verification.expirePublications(rootLogger())
				);
				return { armed, rearmed: await state.storage.getAlarm() };
			}
		);
		expect(alarms).toStrictEqual({
			armed: Date.now() + 10 * 60 * 1000,
			rearmed: Date.now() + 10 * 60 * 1000
		});
	});
});

class PublicationExpiryFault extends Error {}

class ExpiryAbortReason extends Error {}

it.each([
	{
		pass: 'alarm',
		run: (instance: CupboardServer) => instance.alarm(),
		laterStep: () =>
			vi.spyOn(CommitReuseGrantsService.prototype, 'cleanupExpired')
	},
	{
		pass: 'verification pass',
		run: (instance: CupboardServer) => instance.runVerification(),
		laterStep: () =>
			vi.spyOn(VerificationService.prototype, 'processPendingWithoutDecode')
	}
])(
	'continues the $pass after publication expiry fails',
	async ({ run, laterStep }) => {
		await resetTestServer();
		await initialise();
		const prune = vi
			.spyOn(PublicationStore.prototype, 'prune')
			.mockImplementation(() => {
				throw new PublicationExpiryFault();
			});
		const later = laterStep();
		try {
			const outcome = await runInDurableObject(
				currentServer(),
				async (instance) => {
					try {
						await run(instance);
						return 'completed';
					} catch (error) {
						return error instanceof PublicationExpiryFault
							? 'expiry failed'
							: 'other failure';
					}
				}
			);
			expect({
				outcome,
				prunes: prune.mock.calls.length,
				laterSteps: later.mock.calls.length
			}).toStrictEqual({ outcome: 'completed', prunes: 1, laterSteps: 1 });
		} finally {
			prune.mockRestore();
			later.mockRestore();
		}
	}
);

it('leaves an exhausted publication accepted when cleanup loses its claim', async () => {
	await resetTestServer();
	const token = await initialise();
	const [entry] = await plannedEntries(token, '/uploads/plan', [
		distinctPath('1')
	]);
	if (entry === undefined) {
		throw new Error('Expected a planned entry');
	}
	const session = await openCommitSession(token, undefined, publicationSession);
	try {
		session.send({ op: 'publish-batch', pushId: testPushId, entries: [entry] });
		expect([
			await session.nextFrame(),
			await session.nextFrame()
		]).toStrictEqual([
			{ ev: 'publication-accepted', uploadId: entry.operationId },
			{ ev: 'upload-required', uploadId: entry.operationId }
		]);
	} finally {
		session.socket.close();
	}
	const outcome = await runInDurableObject(
		currentServer(),
		async (instance) => {
			const entryRow = eq(schema.pendingUploads.id, entry.operationId);
			instance.context.db
				.update(schema.pendingUploads)
				.set({ verdict: 'pending', settleExhaustion: 'attempt-limit' })
				.where(entryRow)
				.run();
			const deletion = vi.spyOn(
				UploadStateService.prototype,
				'clearDeliveredNarRefresh'
			);
			deletion.mockImplementationOnce(function (this: UploadStateService, id) {
				instance.context.db
					.update(schema.pendingUploads)
					.set({ claimOwner: 'another-pass' })
					.where(entryRow)
					.run();
				deletion.mockRestore();
				return this.clearDeliveredNarRefresh(id);
			});
			try {
				const completed = await asOneInvocation(() =>
					verificationOf(instance).processExhaustedUploads(rootLogger())
				);
				return {
					completed,
					pending: instance.context.db
						.select({ owner: schema.pendingUploads.claimOwner })
						.from(schema.pendingUploads)
						.all(),
					operations: instance.context.db
						.select({ state: schema.publicationOperations.state })
						.from(schema.publicationOperations)
						.all()
				};
			} finally {
				deletion.mockRestore();
			}
		}
	);
	expect(outcome).toStrictEqual({
		completed: 0,
		pending: [{ owner: 'another-pass' }],
		operations: [{ state: 'accepted' }]
	});
});

it("deletes an exhausted upload's staged object only after its operation is terminal, and tracks the key until the delete finishes", async () => {
	await resetTestServer();
	const token = await initialise();
	const [entry] = await plannedEntries(token, '/uploads/plan', [
		distinctPath('1')
	]);
	if (entry === undefined) {
		throw new Error('Expected a planned entry');
	}
	expect(await admit(token, testPushId, entry)).toStrictEqual([
		{ ev: 'publication-accepted', uploadId: entry.operationId },
		{ ev: 'upload-required', uploadId: entry.operationId }
	]);
	const staged = publicationStagingKey(
		fixtureTenant,
		testPushId,
		entry.operationId
	);
	const atDelete = await runInDurableObject(
		currentServer(),
		async (instance) => {
			const { db } = instance.context;
			db.update(schema.pendingUploads)
				.set({ verdict: 'pending', settleExhaustion: 'attempt-limit' })
				.where(eq(schema.pendingUploads.id, entry.operationId))
				.run();
			const observed: unknown[] = [];
			const isKeyTracked = () =>
				instance.context.stagingDeletes.has(r2ObjectKeySchema.parse(staged));
			const isPendingUploadCleared = vi.spyOn(
				UploadStateService.prototype,
				'clearPendingUpload'
			);
			isPendingUploadCleared.mockImplementationOnce(function (
				this: UploadStateService,
				...arguments_
			) {
				observed.push({ step: 'clear', isTracked: isKeyTracked() });
				isPendingUploadCleared.mockRestore();
				return this.clearPendingUpload(...arguments_);
			});
			const blobs = instance.context.env.BLOBS;
			const originalDelete = blobs.delete.bind(blobs);
			const deletion = vi.spyOn(blobs, 'delete').mockImplementation((keys) => {
				if (keys === staged) {
					observed.push({
						step: 'delete',
						isTracked: isKeyTracked(),
						states: db
							.select({ state: schema.publicationOperations.state })
							.from(schema.publicationOperations)
							.all(),
						pending: db.select().from(schema.pendingUploads).all().length
					});
				}
				return originalDelete(keys);
			});
			try {
				await asOneInvocation(() =>
					verificationOf(instance).processExhaustedUploads(rootLogger())
				);
			} finally {
				deletion.mockRestore();
			}
			return observed;
		}
	);
	expect({
		observed: atDelete,
		isTrackedAfter: await runInDurableObject(currentServer(), (instance) =>
			Promise.resolve(
				instance.context.stagingDeletes.has(r2ObjectKeySchema.parse(staged))
			)
		)
	}).toStrictEqual({
		observed: [
			{ step: 'clear', isTracked: true },
			{
				step: 'delete',
				isTracked: true,
				states: [{ state: 'failed' }],
				pending: 0
			}
		],
		isTrackedAfter: false
	});
});

function insertCommittedUploads(
	instance: CupboardServer,
	count: number,
	label: string,
	recoveryDeadline: Date,
	kind: 'fresh' | 'reuse' = 'fresh'
): void {
	const cache = instance.context.db.select().from(schema.cacheIdentities).get();
	if (cache === undefined) {
		throw new Error('Expected the default cache');
	}
	const now = isoTimestamp(new Date());
	const deadline = isoTimestamp(recoveryDeadline);
	for (let index = 0; index < count; index += 1) {
		const id = uploadIdSchema.parse(`${label}-${String(index)}`);
		instance.context.db
			.insert(schema.pendingUploads)
			.values({
				id,
				cacheId: cache.id,
				narHash: nixSha256Hash('1'),
				r2Key:
					kind === 'reuse'
						? narObjectKey(nixSha256Hash('1'))
						: r2ObjectKeySchema.parse(`staging/${label}/${id}`),
				metadataJson: JSON.stringify(distinctPath('1')),
				createdAt: now,
				expiresAt: deadline,
				recoveryDeadline: deadline,
				verdict: 'pending'
			})
			.run();
	}
}

async function repeatedClaimRowsRead(backlog: number): Promise<{
	readonly hasPending: boolean;
	readonly rowsRead: number;
}> {
	await resetTestServer();
	await initialise();
	return runInDurableObject(currentServer(), (instance) => {
		const day = 24 * 60 * 60 * 1000;
		insertCommittedUploads(
			instance,
			backlog,
			'expired',
			new Date(Date.now() - day)
		);
		insertCommittedUploads(instance, 1, 'live', new Date(Date.now() + day));
		const verification = verificationOf(instance);
		verification.hasPendingUploads();
		const { dbCost } = instance.context;
		dbCost.recordOutstanding();
		const before = dbCost.rowsRead;
		const hasPending = verification.hasPendingUploads();
		dbCost.recordOutstanding();
		return Promise.resolve({ hasPending, rowsRead: dbCost.rowsRead - before });
	});
}

it('reports expired uploads as work and reads the same rows whatever the expired backlog', async () => {
	const small = await repeatedClaimRowsRead(100);
	const large = await repeatedClaimRowsRead(1000);
	expect({
		hasPending: large.hasPending,
		rowsRead: large.rowsRead
	}).toStrictEqual({ hasPending: true, rowsRead: small.rowsRead });
});

async function sharedReservationRowsRead(siblings: number): Promise<{
	readonly isShared: boolean;
	readonly rowsRead: number;
}> {
	await resetTestServer();
	await initialise();
	return runInDurableObject(currentServer(), (instance) => {
		insertCommittedUploads(
			instance,
			siblings,
			'sibling',
			new Date(Date.now() + 24 * 60 * 60 * 1000)
		);
		const cache = instance.context.cacheRepository.require(defaultCache());
		const { dbCost } = instance.context;
		dbCost.recordOutstanding();
		const before = dbCost.rowsRead;
		const isShared = uploadStateOf(instance).hasOtherStartedCommit(
			uploadIdSchema.parse('failing'),
			cache,
			{
				storePathHash: distinctPath('1').storePathHash,
				narHash: nixSha256Hash('1')
			}
		);
		dbCost.recordOutstanding();
		return Promise.resolve({ isShared, rowsRead: dbCost.rowsRead - before });
	});
}

it('finds a shared reservation with the same rows read however many uploads share it', async () => {
	const small = await sharedReservationRowsRead(10);
	const large = await sharedReservationRowsRead(1000);
	expect(large).toStrictEqual({ isShared: true, rowsRead: small.rowsRead });
});

it('refuses a repair of an operation that completes during admission when its push ID does not verify', async () => {
	vi.setSystemTime(vi.getRealSystemTime());
	await resetTestServer();
	const token = await initialise();
	const [entry] = await plannedEntries(token, '/uploads/plan', [
		distinctPath('r')
	]);
	if (entry === undefined) {
		throw new Error('Expected a planned entry');
	}
	expect(await admit(token, testPushId, entry)).toStrictEqual([
		{ ev: 'publication-accepted', uploadId: entry.operationId },
		{ ev: 'upload-required', uploadId: entry.operationId }
	]);
	// The push ID no longer verifies, although its expiry time has not passed.
	const isPushIdVerified = vi
		.spyOn(PushCredentialIssuer.prototype, 'verify')
		.mockResolvedValue(false);
	// Admission reads the operation as accepted. The operation then completes,
	// and its path is removed, before admission's gate.
	let completions = 0;
	const peek = await runInDurableObject(currentServer(), (instance) => {
		const { db } = instance.context;
		const spy = vi
			.spyOn(UploadStateService.prototype, 'peekReusableBlobs')
			.mockImplementationOnce(function (
				this: UploadStateService,
				...arguments_
			) {
				spy.mockRestore();
				completions += 1;
				db.update(schema.publicationOperations)
					.set({ state: 'servable' })
					.where(eq(schema.publicationOperations.id, entry.operationId))
					.run();
				db.delete(schema.pendingUploads)
					.where(eq(schema.pendingUploads.id, entry.operationId))
					.run();
				return this.peekReusableBlobs(...arguments_);
			});
		return Promise.resolve(spy);
	});
	try {
		const answer = await admit(token, testPushId, entry);
		const { operations, pending } = await snapshot();
		expect({
			completions,
			answer,
			states: operations.map((operation) => operation.state),
			pending
		}).toStrictEqual({
			completions: 1,
			answer: [
				{
					ev: 'publication-refused',
					uploadId: entry.operationId,
					reason: 'push-expired',
					status: StatusCodes.SERVICE_UNAVAILABLE,
					hasMessage: true
				}
			],
			states: ['servable'],
			pending: []
		});
	} finally {
		peek.mockRestore();
		isPushIdVerified.mockRestore();
	}
});

it('refuses a repair whose push expires before admission records it', async () => {
	vi.setSystemTime(vi.getRealSystemTime());
	await resetTestServer();
	const token = await initialise();
	const expiresAt = Math.floor(Date.now() / 1000) + 60;
	const pushId = await testPushIdFor(fixtureTenant, 3, expiresAt);
	const nar = await verifiableNar('publication-late-repair');
	const path = uploadPathNegotiation(
		uploadMetadata({
			fileSize: nar.narBytes.byteLength,
			fileHash: nar.fileHash,
			narHash: nar.narHash,
			narSize: nar.narSize
		})
	);
	const [entry] = await plannedEntries(
		token,
		'/uploads/plan',
		[path],
		undefined,
		pushId
	);
	if (entry === undefined) {
		throw new Error('Expected a planned entry');
	}
	await putNarBytes(
		publicationStagingKey(fixtureTenant, pushId, entry.operationId),
		nar
	);
	const request = {
		op: 'publish-batch' as const,
		pushId,
		entries: [
			{
				...entry,
				blob: { fileHash: nar.fileHash, fileSize: nar.narBytes.byteLength }
			}
		]
	};
	const first = await openCommitSession(token, undefined, publicationSession);
	try {
		first.send(request);
		expect([await first.nextFrame(), await first.nextFrame()]).toStrictEqual([
			{ ev: 'publication-accepted', uploadId: entry.operationId },
			{
				ev: 'deferred',
				uploadId: entry.operationId,
				storePathHash: path.storePathHash,
				narHash: path.narHash,
				grace: {}
			}
		]);
	} finally {
		first.socket.close();
	}
	await commitUpload(token, entry.operationId);
	await deletePath(token, path.storePathHash);
	const replay = await openCommitSession(token, undefined, publicationSession);
	// Admission checks the push ID's expiry before its transaction. Let the push
	// expire between that check and the transaction, and record the push ID
	// checks that ran before the transaction.
	const isPushIdVerified = vi.spyOn(PushCredentialIssuer.prototype, 'verify');
	let checksBeforeTransaction = 0;
	const gate = await runInDurableObject(currentServer(), (instance) => {
		const { db } = instance.context;
		const transaction = db.transaction.bind(db);
		return Promise.resolve(
			vi.spyOn(db, 'transaction').mockImplementationOnce((run) => {
				checksBeforeTransaction = isPushIdVerified.mock.calls.length;
				vi.setSystemTime(new Date((expiresAt + 1) * 1000));
				return transaction(run);
			})
		);
	});
	try {
		replay.send(request);
		const refused = refusalFacts(await replay.nextFrame());
		const after = await snapshot();
		expect({
			pushIdChecks: isPushIdVerified.mock.settledResults
				.slice(0, checksBeforeTransaction)
				.map((result) => result.type === 'fulfilled' && result.value),
			transactions: gate.mock.calls.length,
			refused,
			pending: after.pending
		}).toStrictEqual({
			pushIdChecks: [true],
			transactions: 1,
			refused: {
				ev: 'publication-refused',
				uploadId: entry.operationId,
				reason: 'push-expired',
				status: StatusCodes.SERVICE_UNAVAILABLE,
				hasMessage: true
			},
			pending: []
		});
	} finally {
		gate.mockRestore();
		isPushIdVerified.mockRestore();
		replay.socket.close();
	}
});

it('claims a live upload behind more than one window of expired uploads that expiry cannot remove', async () => {
	await resetTestServer();
	await initialise();
	await runInDurableObject(currentServer(), (instance) => {
		const day = 24 * 60 * 60 * 1000;
		for (let index = 0; index < 70; index += 1) {
			insertExpiringOperation(
				instance,
				index.toString(16).padStart(2, '0'),
				new Date(Date.now() - day),
				true
			);
		}
		insertCommittedUploads(instance, 1, 'live', new Date(Date.now() + day));
		return Promise.resolve();
	});
	const claimed: string[][] = [];
	for (let pass = 0; pass < 2; pass += 1) {
		const batch = await currentServer().claimVerificationBatch(
			10,
			1_000_000_000
		);
		claimed.push(batch.claims.map((claim) => claim.uploadId));
	}
	expect(claimed).toStrictEqual([[], ['live-0']]);
});

it('requests another verification pass when a claim passes a window of expired uploads', async () => {
	vi.setSystemTime(vi.getRealSystemTime());
	await resetTestServer();
	await initialise();
	await runInDurableObject(currentServer(), (instance) => {
		const day = 24 * 60 * 60 * 1000;
		for (let index = 0; index < 200; index += 1) {
			insertExpiringOperation(
				instance,
				index.toString(16).padStart(2, '0'),
				new Date(Date.now() - day),
				true
			);
		}
		insertCommittedUploads(instance, 1, 'live', new Date(Date.now() + day));
		return Promise.resolve();
	});
	const sent = await collectVerificationPasses();
	const live = uploadIdSchema.parse('live-0');
	const liveVerdict = () =>
		runInDurableObject(currentServer(), (instance) =>
			Promise.resolve(
				instance.context.db
					.select({ verdict: schema.pendingUploads.verdict })
					.from(schema.pendingUploads)
					.where(eq(schema.pendingUploads.id, live))
					.get()?.verdict
			)
		);
	// Each pass of the queue consumer claims once. A pass that only moves past
	// expired uploads must request the next pass, as the queue would deliver it.
	const passes: { readonly requested: number; readonly verdict: unknown }[] =
		[];
	let delivered = 0;
	for (let pass = 0; pass < 10; pass += 1) {
		await verifyCurrentTenant();
		passes.push({
			requested: sent.length - delivered,
			verdict: await liveVerdict()
		});
		delivered = sent.length;
		if (passes.at(-1)?.requested === 0) {
			break;
		}
	}
	expect({
		reachesLive: passes.at(-1)?.verdict,
		isChained: passes.slice(0, -1).every((pass) => pass.requested === 1)
	}).toStrictEqual({ reachesLive: 'mismatch', isChained: true });
});

it('releases the leases of a claim whose request for the next pass fails', async () => {
	await resetTestServer();
	await initialise();
	const outcome = await runInDurableObject(
		currentServer(),
		async (instance) => {
			const day = 24 * 60 * 60 * 1000;
			// The live uploads sort between two runs of expired uploads, so the
			// claim takes them from a full window and stores a position.
			for (let index = 0; index < 50; index += 1) {
				// Hexadecimal IDs sort before the live uploads, and IDs that start
				// with `m` sort after them.
				const prefix = index < 20 ? '' : 'm';
				insertExpiringOperation(
					instance,
					`${prefix}${index.toString(16).padStart(2, '0')}`,
					new Date(Date.now() - day),
					true
				);
			}
			insertCommittedUploads(instance, 5, 'live', new Date(Date.now() + day));
			const request = vi
				.spyOn(CommitPipelineService.prototype, 'requestVerification')
				.mockRejectedValueOnce(new PublicationExpiryFault());
			try {
				let failure: unknown;
				try {
					await asOneInvocation(() =>
						verificationOf(instance).claimPendingForVerify(10, 1_000_000_000)
					);
				} catch (error) {
					failure = error;
				}
				return {
					failed: failure instanceof PublicationExpiryFault,
					requested: request.mock.calls.length,
					leased: instance.context.db
						.select({ id: schema.pendingUploads.id })
						.from(schema.pendingUploads)
						.where(isNotNull(schema.pendingUploads.claimOwner))
						.all()
				};
			} finally {
				request.mockRestore();
			}
		}
	);
	expect(outcome).toStrictEqual({ failed: true, requested: 1, leased: [] });
});

it('stops requesting passes through expired uploads while expiry waits, until new work starts', async () => {
	vi.setSystemTime(vi.getRealSystemTime());
	await resetTestServer();
	await initialise();
	const day = 24 * 60 * 60 * 1000;
	await runInDurableObject(currentServer(), (instance) => {
		for (let index = 0; index < 200; index += 1) {
			insertExpiringOperation(
				instance,
				index.toString(16).padStart(2, '0'),
				new Date(Date.now() - day),
				true
			);
		}
		insertCommittedUploads(instance, 1, 'live', new Date(Date.now() + day));
		return Promise.resolve();
	});
	const sent = await collectVerificationPasses();
	const verdict = (id: string) => {
		const uploadId = uploadIdSchema.parse(id);
		return runInDurableObject(currentServer(), (instance) =>
			Promise.resolve(
				instance.context.db
					.select({ verdict: schema.pendingUploads.verdict })
					.from(schema.pendingUploads)
					.where(eq(schema.pendingUploads.id, uploadId))
					.get()?.verdict
			)
		);
	};
	// Runs queue passes, as the queue would deliver them, until a pass
	// requests no other pass, and returns the number of passes.
	const scan = async () => {
		for (let pass = 1; pass <= 10; pass += 1) {
			const before = sent.length;
			await verifyCurrentTenant();
			if (sent.length === before) {
				return pass;
			}
		}
		return Infinity;
	};
	const first = {
		isChained: (await scan()) > 1,
		live: await verdict('live-0')
	};
	// Expiry is waiting for its retry time and nothing new has started, so a
	// later trigger makes one claim.
	const idle = await scan();
	// A new commit starts behind the expired uploads.
	await runInDurableObject(currentServer(), (instance) => {
		insertCommittedUploads(instance, 1, 'next', new Date(Date.now() + day));
		new WorkSequenceService(instance.context.db).allocate();
		return Promise.resolve();
	});
	const next = { isChained: (await scan()) > 1, next: await verdict('next-0') };
	// Another operation is accepted. The scan through the expired uploads
	// finds nothing, starts again after its first window, and stops there.
	await runInDurableObject(currentServer(), (instance) => {
		new WorkSequenceService(instance.context.db).allocate();
		return Promise.resolve();
	});
	const empty = await scan();
	expect({
		first,
		idle,
		next,
		isEmptyScanFinite: Number.isFinite(empty)
	}).toStrictEqual({
		first: { isChained: true, live: 'mismatch' },
		idle: 1,
		next: { isChained: true, next: 'mismatch' },
		isEmptyScanFinite: true
	});
});

it('claims every live upload behind a backlog of expired uploads after one empty claim', async () => {
	await resetTestServer();
	await initialise();
	const outcome = await runInDurableObject(
		currentServer(),
		async (instance) => {
			const day = 24 * 60 * 60 * 1000;
			for (let index = 0; index < 70; index += 1) {
				insertExpiringOperation(
					instance,
					index.toString(16).padStart(2, '0'),
					new Date(Date.now() - day),
					true
				);
			}
			insertCommittedUploads(instance, 30, 'live', new Date(Date.now() + day));
			const verification = verificationOf(instance);
			const passes: string[][] = [];
			for (let pass = 0; pass < 5; pass += 1) {
				const batch = await asOneInvocation(() =>
					verification.claimPendingForVerify(10, 1_000_000_000)
				);
				passes.push(batch.claims.map((claim) => claim.uploadId));
			}
			return passes;
		}
	);
	const live = Array.from(
		{ length: 30 },
		(_, index) => `live-${String(index)}`
	).toSorted((left, right) => left.localeCompare(right));
	expect(outcome).toStrictEqual([
		[],
		live.slice(0, 10),
		live.slice(10, 20),
		live.slice(20, 30),
		[]
	]);
});

it('claims a fresh upload at once while the claim position is stored after it', async () => {
	await resetTestServer();
	await initialise();
	const claimed = await runInDurableObject(
		currentServer(),
		async (instance) => {
			const day = 24 * 60 * 60 * 1000;
			for (let index = 0; index < 40; index += 1) {
				insertExpiringOperation(
					instance,
					index.toString(16).padStart(2, '0'),
					new Date(Date.now() - day),
					true
				);
			}
			insertCommittedUploads(instance, 30, 'live', new Date(Date.now() + day));
			const verification = verificationOf(instance);
			const first = await asOneInvocation(() =>
				verification.claimPendingForVerify(10, 1_000_000_000)
			);
			// The fresh upload sorts before the expired uploads and the stored
			// position.
			insertCommittedUploads(
				instance,
				1,
				'0-fresh',
				new Date(Date.now() + day)
			);
			const second = await asOneInvocation(() =>
				verification.claimPendingForVerify(10, 1_000_000_000)
			);
			return [first, second].map((batch) =>
				batch.claims.map((claim) => claim.uploadId)
			);
		}
	);
	const live = Array.from(
		{ length: 30 },
		(_, index) => `live-${String(index)}`
	).toSorted((left, right) => left.localeCompare(right));
	expect(claimed).toStrictEqual([
		live.slice(0, 7),
		['0-fresh-0', ...live.slice(7, 16)]
	]);
});

it('leases no rows when a claim is aborted while it stores its position', async () => {
	await resetTestServer();
	await initialise();
	const outcome = await runInDurableObject(
		currentServer(),
		async (instance, state) => {
			const day = 24 * 60 * 60 * 1000;
			for (let index = 0; index < 40; index += 1) {
				insertExpiringOperation(
					instance,
					index.toString(16).padStart(2, '0'),
					new Date(Date.now() - day),
					true
				);
			}
			insertCommittedUploads(instance, 30, 'live', new Date(Date.now() + day));
			const controller = new AbortController();
			// The claim's deadline passes while it stores its position.
			const put = vi.spyOn(state.storage, 'put').mockImplementation(() => {
				controller.abort(new Error('The claim deadline passed.'));
				return Promise.resolve();
			});
			let failure: unknown;
			try {
				await verificationOf(instance).claimPendingForVerify(
					10,
					1_000_000_000,
					controller.signal
				);
			} catch (error) {
				failure = error;
			} finally {
				put.mockRestore();
			}
			return {
				isAborted: failure !== undefined,
				leased: instance.context.db
					.select({ id: schema.pendingUploads.id })
					.from(schema.pendingUploads)
					.where(isNotNull(schema.pendingUploads.claimOwner))
					.all()
			};
		}
	);
	expect(outcome).toStrictEqual({ isAborted: true, leased: [] });
});

it('writes no storage when a decode-free pass claims no rows', async () => {
	await resetTestServer();
	await initialise();
	const writes = await runInDurableObject(
		currentServer(),
		async (instance, state) => {
			const put = vi.spyOn(state.storage, 'put');
			const remove = vi.spyOn(state.storage, 'delete');
			try {
				await asOneInvocation(() =>
					verificationOf(instance).processPendingWithoutDecode(rootLogger(), 10)
				);
				return {
					puts: put.mock.calls.length,
					deletes: remove.mock.calls.length
				};
			} finally {
				put.mockRestore();
				remove.mockRestore();
			}
		}
	);
	expect(writes).toStrictEqual({ puts: 0, deletes: 0 });
});

it('writes no storage when publication expiry finds nothing due', async () => {
	await resetTestServer();
	await initialise();
	const writes = await runInDurableObject(
		currentServer(),
		async (instance, state) => {
			const put = vi.spyOn(state.storage, 'put');
			const remove = vi.spyOn(state.storage, 'delete');
			try {
				await asOneInvocation(() =>
					verificationOf(instance).expirePublications(rootLogger())
				);
				return {
					puts: put.mock.calls.length,
					deletes: remove.mock.calls.length
				};
			} finally {
				put.mockRestore();
				remove.mockRestore();
			}
		}
	);
	expect(writes).toStrictEqual({ puts: 0, deletes: 0 });
});

it('claims a fresh upload behind more than one window of reuse uploads', async () => {
	await resetTestServer();
	await initialise();
	const claimed = await runInDurableObject(
		currentServer(),
		async (instance) => {
			const day = 24 * 60 * 60 * 1000;
			insertCommittedUploads(
				instance,
				70,
				'a-reuse',
				new Date(Date.now() + day),
				'reuse'
			);
			insertCommittedUploads(
				instance,
				1,
				'b-fresh',
				new Date(Date.now() + day)
			);
			const verification = verificationOf(instance);
			const passes: string[][] = [];
			for (let pass = 0; pass < 2; pass += 1) {
				const batch = await asOneInvocation(() =>
					verification.claimPendingForVerify(10, 1_000_000_000)
				);
				passes.push(batch.claims.map((claim) => claim.uploadId));
			}
			return passes;
		}
	);
	expect(claimed).toStrictEqual([[], ['b-fresh-0']]);
});

it('claims a live upload behind more than one window of expired uploads once claiming passes have run expiry', async () => {
	await resetTestServer();
	await initialise();
	await runInDurableObject(currentServer(), (instance) => {
		const day = 24 * 60 * 60 * 1000;
		for (let index = 0; index < 70; index += 1) {
			insertExpiringOperation(
				instance,
				index.toString(16).padStart(2, '0'),
				new Date(Date.now() - day),
				false
			);
		}
		insertCommittedUploads(instance, 1, 'live', new Date(Date.now() + day));
		const cache = instance.context.db
			.select()
			.from(schema.cacheIdentities)
			.get();
		if (cache === undefined) {
			throw new Error('Expected the default cache');
		}
		const deadline = isoTimestamp(new Date(Date.now() - day));
		const operations = instance.context.db
			.select({ id: schema.publicationOperations.id })
			.from(schema.publicationOperations)
			.all();
		for (const operation of operations) {
			instance.context.db
				.insert(schema.pendingUploads)
				.values({
					id: operation.id,
					cacheId: cache.id,
					narHash: nixSha256Hash('1'),
					r2Key: r2ObjectKeySchema.parse(`staging/expired/${operation.id}`),
					metadataJson: JSON.stringify(distinctPath('1')),
					createdAt: deadline,
					expiresAt: deadline,
					recoveryDeadline: deadline,
					verdict: 'pending'
				})
				.run();
		}
		return Promise.resolve();
	});
	const claimed: string[][] = [];
	for (let pass = 0; pass < 2; pass += 1) {
		const batch = await currentServer().claimVerificationBatch(
			10,
			1_000_000_000
		);
		claimed.push(batch.claims.map((claim) => claim.uploadId));
	}
	expect(claimed).toStrictEqual([['live-0'], []]);
});

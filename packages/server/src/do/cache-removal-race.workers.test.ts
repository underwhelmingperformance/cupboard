import { rootLogger } from '@cupboard/logger';
import { type StorePathHash } from '@cupboard/nix-store/scalars';
import {
	cacheRemovedVerdictCapability,
	type CommitSessionFrame,
	publicationCapability,
	type PublicationEntry,
	publicationRefusalReasonsCapability,
	type PushId,
	type SessionId,
	type UploadId,
	uploadIdSchema,
	type UploadPathNegotiation,
	uploadPlanResponseSchema
} from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import {
	deliverAlarms,
	ignoreAlarmDeliveries
} from '../alarm-fence.test-support.ts';
import { type ResolvedCache } from '../db/cache.ts';
import * as schema from '../db/schema.ts';
import { CacheNotFoundError } from '../errors.ts';
import { narInfoObjectKey, requestOriginSchema } from '../http/http.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	adminGrants,
	authorisedFetch,
	blobReferenceRows,
	cacheScopedPath,
	closeSessionAndWait,
	commitPath,
	commitPipelineOf,
	currentServer,
	expectSingleUploadDecision,
	framesThroughProbe,
	initialise,
	namedCache,
	negotiateUploads,
	openCommitSession,
	probeAnswer,
	pushPath,
	putNarBytes,
	putTestCache,
	resetTestServer,
	tenantUsageRow,
	testPushId,
	uploadMetadata,
	uploadPathNegotiation,
	verifiableNar,
	verifyCurrentTenant
} from '../test-support.ts';

import { AttestationCasService } from './attestation-cas-service.ts';
import { AttestationsService } from './attestations-service.ts';
import { CacheRegistrationService } from './cache-registration-service.ts';
import { drainTeardown } from './cache-teardown.test-support.ts';
import { CommitPipelineService } from './commit-pipeline-service.ts';
import { type ServerContext } from './context.ts';
import { NarInfoObjectsService } from './narinfo-objects-service.ts';
import { RetentionService } from './retention-service.ts';
import { ReuseAuthority } from './reuse-authority.ts';
import { SigningKeysService } from './signing-keys-service.ts';
import { UploadStateService } from './upload-state-service.ts';

const builds = namedCache('builds');
const origin = requestOriginSchema.parse('https://cache.example');
const releasedPublicationSession = `${publicationCapability},${publicationRefusalReasonsCapability}`;
const capablePublicationSession = `${releasedPublicationSession},${cacheRemovedVerdictCapability}`;
const subscriptionOps: readonly ('subscribe' | 'subscribe-identity')[] = [
	'subscribe',
	'subscribe-identity'
];
const publicationReplayOps: readonly (
	'subscribe-publication' | 'publish-batch'
)[] = ['subscribe-publication', 'publish-batch'];

function pipelineFor(context: ServerContext): CommitPipelineService {
	const narInfoObjects = new NarInfoObjectsService(context);
	const attestations = new AttestationsService(
		context,
		new CacheRegistrationService(context),
		new AttestationCasService(context),
		narInfoObjects
	);

	return new CommitPipelineService(
		context,
		new SigningKeysService(context, narInfoObjects),
		new UploadStateService(context),
		narInfoObjects,
		new RetentionService(context),
		attestations
	);
}

function narInfoRows(context: ServerContext, storePathHash: StorePathHash) {
	return context.db
		.select({
			cacheId: schema.narInfos.cacheId,
			generation: schema.narInfos.generation
		})
		.from(schema.narInfos)
		.where(eq(schema.narInfos.storePathHash, storePathHash))
		.all();
}

async function isNarInfoObjectPresent(
	storePathHash: StorePathHash,
	cache: ResolvedCache
): Promise<boolean> {
	const object = await env.BLOBS.head(
		narInfoObjectKey(
			fixtureTenant,
			storePathHash,
			cache.scope,
			cache.generation
		)
	);

	return object !== null;
}

function uploadSessionId(uploadId: UploadId): Promise<SessionId> {
	return runInDurableObject(currentServer(), (instance) => {
		const row = instance.context.db
			.select({ sessionId: schema.pendingUploads.sessionId })
			.from(schema.pendingUploads)
			.where(eq(schema.pendingUploads.id, uploadId))
			.get();

		if (row?.sessionId === undefined || row.sessionId === null) {
			throw new Error('expected a session recorded on the upload');
		}

		return row.sessionId;
	});
}

// Negotiates an upload of a fresh path into `builds` and stages its NAR, so a
// commit of the upload reserves the path's row before it defers.
async function stagedUpload(token: string, label: string, hash: string) {
	const nar = await verifiableNar(label);
	const path = uploadMetadata({
		storePathHash: hash.repeat(32),
		narHash: nar.narHash,
		fileHash: nar.fileHash,
		fileSize: nar.narBytes.byteLength,
		narSize: nar.narSize
	});
	const decision = expectSingleUploadDecision(
		await negotiateUploads(token, [path], builds),
		path
	);
	await putNarBytes(decision.r2Key, nar);

	return { path, uploadId: decision.uploadId };
}

function cacheRemovedFrame(
	uploadId: UploadId,
	grace?: Record<string, never>
): CommitSessionFrame {
	return {
		ev: 'verdict',
		uploadId,
		status: 'absent',
		reason: 'cache-removed',
		...(grace !== undefined && { grace })
	};
}

type ErrorFrame = Extract<CommitSessionFrame, { ev: 'error' }>;
type ComparedFrame =
	Exclude<CommitSessionFrame, ErrorFrame> | Omit<ErrorFrame, 'message'>;

// Error frames are compared without their message.
function withoutMessage(frame: CommitSessionFrame): ComparedFrame {
	return frame.ev === 'error'
		? { ev: frame.ev, uploadId: frame.uploadId, status: frame.status }
		: frame;
}

// Plans one path into `builds` for `pushId`, as `cupboard push` does before
// it publishes the path, and returns the publication entry.
async function plannedEntry(
	token: string,
	pushId: PushId,
	metadata: UploadPathNegotiation
): Promise<PublicationEntry> {
	const response = await authorisedFetch(
		cacheScopedPath(builds, '/uploads/plan'),
		token,
		{
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ pushId, paths: [metadata] })
		}
	);
	const plan = uploadPlanResponseSchema.parse(await response.json());
	const [planned] = plan.uploads;
	if (planned === undefined) {
		throw new Error('expected a planned entry');
	}

	return {
		operationId: planned.operationId,
		cacheGeneration: plan.cacheGeneration,
		metadata
	};
}

// A path whose NAR the tenant already stores, so a publication of it in
// `builds` commits by reusing the stored blob.
async function reusablePath(token: string, label: string, hash: string) {
	const nar = await verifiableNar(label);
	const fields = {
		fileSize: nar.narBytes.byteLength,
		fileHash: nar.fileHash,
		narHash: nar.narHash,
		narSize: nar.narSize
	};
	await commitPath(
		token,
		uploadMetadata({ ...fields, storePathHash: '2'.repeat(32) }),
		nar
	);

	return {
		metadata: uploadPathNegotiation(
			uploadMetadata({ ...fields, storePathHash: hash.repeat(32) })
		),
		blob: { fileHash: nar.fileHash, fileSize: nar.narBytes.byteLength }
	};
}

function liveBuilds(): Promise<ResolvedCache> {
	return runInDurableObject(currentServer(), (instance) =>
		instance.context.cacheRepository.require(builds)
	);
}

// A removal marks the cache removed and leaves its rows until the teardown
// drain deletes them. A cache registered again under the name, and commits
// into either cache, must not see or change the other cache's rows.
describe('cache removal races', () => {
	beforeEach(async () => {
		await resetTestServer();
		const id = currentServer().id;
		ignoreAlarmDeliveries(id);
		onTestFinished(() => {
			deliverAlarms(id);
		});
	});

	it('keeps a path recommitted into a recreated cache while the removed one drains', async () => {
		const token = await initialise();
		const path = uploadMetadata({ fileSize: 1, storePathHash: 'a'.repeat(32) });
		await putTestCache(token, builds);
		const removed = await liveBuilds();
		await pushPath(token, path, builds);

		const removal = await authorisedFetch('/caches/builds?force=true', token, {
			method: 'DELETE'
		});
		await putTestCache(token, builds);
		const recreated = await liveBuilds();
		await pushPath(token, path, builds);
		await drainTeardown(removed.id);

		const usage = await tenantUsageRow();
		const edges = await blobReferenceRows();

		expect({
			removal: removal.status,
			rows: await runInDurableObject(currentServer(), (instance) =>
				narInfoRows(instance.context, path.storePathHash)
			),
			edges: edges.map((edge) => ({
				cache: edge.cache,
				generation: edge.generation,
				cacheGeneration: edge.cacheGeneration
			})),
			objects: {
				removed: await isNarInfoObjectPresent(path.storePathHash, removed),
				recreated: await isNarInfoObjectPresent(path.storePathHash, recreated)
			},
			narinfos: usage?.narinfos
		}).toStrictEqual({
			removal: StatusCodes.OK,
			rows: [{ cacheId: recreated.id, generation: 1 }],
			edges: [
				{
					cache: builds,
					generation: 1,
					cacheGeneration: recreated.generation
				}
			],
			objects: { removed: false, recreated: true },
			narinfos: 1
		});
	});

	it('refuses a commit that resolved the cache before the removal', async () => {
		const token = await initialise();
		await putTestCache(token, builds);
		const nar = await verifiableNar('removal-race');
		const path = uploadMetadata({
			storePathHash: 'b'.repeat(32),
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength,
			narSize: nar.narSize
		});
		const decision = expectSingleUploadDecision(
			await negotiateUploads(token, [path], builds),
			path
		);
		await putNarBytes(decision.r2Key, nar);

		const observed = await runInDurableObject(
			currentServer(),
			async (instance) => {
				const pipeline = pipelineFor(instance.context);
				const cache = instance.context.cacheRepository.require(builds);
				const probe = pipeline.probeMaterialisation.bind(pipeline);
				// The removal runs while the commit waits for its probe, after the
				// commit has read the upload and its cache.
				vi.spyOn(pipeline, 'probeMaterialisation').mockImplementationOnce(
					async (...parameters) => {
						await instance.runCacheTeardown(builds, origin);

						return probe(...parameters);
					}
				);
				const authority = new ReuseAuthority({
					destination: cache.scope,
					grants: adminGrants(),
					views: []
				});
				let isRefusedAsNotFound = false;

				try {
					await pipeline.commit(
						rootLogger(),
						cache,
						decision.uploadId,
						authority
					);
				} catch (error) {
					isRefusedAsNotFound = error instanceof CacheNotFoundError;
				}

				return {
					isRefusedAsNotFound,
					rows: narInfoRows(instance.context, path.storePathHash),
					uploads: instance.context.db
						.select({ id: schema.pendingUploads.id })
						.from(schema.pendingUploads)
						.all()
				};
			}
		);

		expect(observed).toStrictEqual({
			isRefusedAsNotFound: true,
			rows: [],
			uploads: []
		});
	});

	// A client that reconnects while its commit runs subscribes from a new
	// session, and the upload then records that session.
	it.each([
		{
			session: 'a session that accepts the reason',
			accepted: cacheRemovedVerdictCapability,
			committing: (uploadId: UploadId) => [cacheRemovedFrame(uploadId)],
			subscribed: (uploadId: UploadId) => [cacheRemovedFrame(uploadId)]
		},
		{
			// A released client keeps its 404 for the commit and receives no
			// other frame.
			session: 'a session that does not accept the reason',
			accepted: undefined,
			committing: (uploadId: UploadId) => [
				{ ev: 'error', uploadId, status: StatusCodes.NOT_FOUND }
			],
			subscribed: () => []
		}
	])(
		'answers a commit that the removal refuses, and the other session of its upload, for $session',
		async ({ accepted, committing, subscribed }) => {
			const token = await initialise();
			await putTestCache(token, builds);
			const { path, uploadId } = await stagedUpload(
				token,
				'removal-race-sessions',
				'c'
			);
			const committer = await openCommitSession(token, builds, accepted);
			const subscriber = await openCommitSession(token, builds, accepted);

			try {
				subscriber.send({ op: 'subscribe', uploadIds: [uploadId] });
				const subscribedReply = await subscriber.nextFrame();
				const subscriberSession = await uploadSessionId(uploadId);
				await runInDurableObject(currentServer(), (instance) => {
					const pipeline = commitPipelineOf(instance);
					const cache = instance.context.cacheRepository.require(builds);
					const probe = pipeline.probeMaterialisation.bind(pipeline);
					const reserve = pipeline.reserveNarInfoRow.bind(pipeline);
					// The other session subscribes while the commit probes the path,
					// before the commit marks the upload committing. The removal
					// follows before the commit reserves the path.
					vi.spyOn(pipeline, 'probeMaterialisation').mockImplementationOnce(
						async (...parameters) => {
							new UploadStateService(instance.context).attachSession(
								cache,
								uploadId,
								subscriberSession
							);

							return probe(...parameters);
						}
					);
					vi.spyOn(pipeline, 'reserveNarInfoRow').mockImplementationOnce(
						async (...parameters) => {
							await instance.runCacheTeardown(builds, origin);

							return reserve(...parameters);
						}
					);
				});

				committer.send({ op: 'commit', uploadId });
				const commitAnswer = await committer.nextFrame();

				expect({
					committer: [
						commitAnswer,
						...(await framesThroughProbe(committer))
					].map((frame) => withoutMessage(frame)),
					subscriber: [
						subscribedReply,
						...(await framesThroughProbe(subscriber))
					]
				}).toStrictEqual({
					committer: [...committing(uploadId), probeAnswer],
					subscriber: [
						{
							ev: 'deferred',
							uploadId,
							storePathHash: path.storePathHash,
							narHash: path.narHash
						},
						...subscribed(uploadId),
						probeAnswer
					]
				});
			} finally {
				await closeSessionAndWait(committer.socket);
				await closeSessionAndWait(subscriber.socket);
			}
		}
	);

	it.each([
		{
			session: 'a session that accepts the reason',
			accepted: cacheRemovedVerdictCapability,
			answer: (uploadId: UploadId) => cacheRemovedFrame(uploadId)
		},
		{
			session: 'a session that does not accept the reason',
			accepted: undefined,
			answer: (uploadId: UploadId) => ({
				ev: 'error',
				uploadId,
				status: StatusCodes.NOT_FOUND
			})
		}
	])(
		'answers a commit sent after the removal for $session',
		async ({ accepted, answer }) => {
			const token = await initialise();
			await putTestCache(token, builds);
			const uploadId = uploadIdSchema.parse('d'.repeat(64));
			const session = await openCommitSession(token, builds, accepted);

			try {
				await authorisedFetch('/caches/builds?force=true', token, {
					method: 'DELETE'
				});
				session.send({ op: 'commit', uploadId });
				const commitAnswer = await session.nextFrame();

				expect(
					[commitAnswer, ...(await framesThroughProbe(session))].map((frame) =>
						withoutMessage(frame)
					)
				).toStrictEqual([answer(uploadId), probeAnswer]);
			} finally {
				await closeSessionAndWait(session.socket);
			}
		}
	);

	// A publication-capable session opens on a name with no cache, because a
	// push opens its session before negotiation creates the cache.
	it.each([
		{ op: 'commit', answer: 'a 404', isAnswered: true },
		...subscriptionOps.map((op) => ({
			op,
			answer: 'no verdict',
			isAnswered: false
		}))
	] as const)(
		'answers $op on a name that never had a cache with $answer',
		async ({ op, isAnswered }) => {
			const token = await initialise();
			const uploadId = uploadIdSchema.parse('d'.repeat(64));
			const session = await openCommitSession(
				token,
				namedCache('never'),
				capablePublicationSession
			);

			try {
				session.send(
					op === 'commit'
						? { op, uploadId }
						: op === 'subscribe'
							? { op, uploadIds: [uploadId] }
							: {
									op,
									entries: [
										{
											uploadId,
											storePathHash: 'n'.repeat(32),
											narHash: `sha256:${'0'.repeat(52)}`
										}
									]
								}
				);

				const frames = await framesThroughProbe(session);

				expect(frames.map((frame) => withoutMessage(frame))).toStrictEqual([
					...(isAnswered
						? [{ ev: 'error', uploadId, status: StatusCodes.NOT_FOUND }]
						: []),
					probeAnswer
				]);
			} finally {
				await closeSessionAndWait(session.socket);
			}
		}
	);

	// A client that reconnects after the removal subscribes to its deferred
	// uploads again.
	it.each(subscriptionOps)(
		'answers %s from a session of the removed cache that accepts the reason',
		async (op) => {
			const token = await initialise();
			await putTestCache(token, builds);
			const { path, uploadId } = await stagedUpload(
				token,
				'removal-race-subscription',
				'h'
			);
			const session = await openCommitSession(
				token,
				builds,
				cacheRemovedVerdictCapability
			);

			try {
				await authorisedFetch('/caches/builds?force=true', token, {
					method: 'DELETE'
				});
				session.send(
					op === 'subscribe'
						? { op, uploadIds: [uploadId] }
						: {
								op,
								entries: [
									{
										uploadId,
										storePathHash: path.storePathHash,
										narHash: path.narHash
									}
								]
							}
				);

				// The server answers the subscription before it reads the probe.
				expect(await framesThroughProbe(session)).toStrictEqual([
					cacheRemovedFrame(uploadId),
					probeAnswer
				]);
			} finally {
				await closeSessionAndWait(session.socket);
			}
		}
	);

	it.each([
		{
			session: 'a session that accepts the reason',
			accepted: capablePublicationSession,
			verdict: (uploadId: UploadId) => cacheRemovedFrame(uploadId, {})
		},
		{
			session: 'a session that does not accept the reason',
			accepted: releasedPublicationSession,
			verdict: (uploadId: UploadId) => ({
				ev: 'verdict',
				uploadId,
				status: 'absent',
				grace: {}
			})
		}
	])(
		'answers a publication commit that the removal refuses for $session',
		async ({ accepted, verdict }) => {
			const token = await initialise();
			await putTestCache(token, builds);
			const { metadata, blob } = await reusablePath(
				token,
				'removal-race-publication',
				'g'
			);
			const entry = await plannedEntry(token, testPushId, metadata);
			const session = await openCommitSession(token, builds, accepted);

			try {
				await runInDurableObject(currentServer(), (instance) => {
					const pipeline = commitPipelineOf(instance);
					const reserve = pipeline.reserveNarInfoRow.bind(pipeline);
					vi.spyOn(pipeline, 'reserveNarInfoRow').mockImplementationOnce(
						async (...parameters) => {
							await instance.runCacheTeardown(builds, origin);

							return reserve(...parameters);
						}
					);
				});
				session.send({
					op: 'publish-batch',
					pushId: testPushId,
					entries: [{ ...entry, blob }]
				});
				const accepted = await session.nextFrame();
				const answer = await session.nextFrame();

				expect([
					accepted,
					answer,
					...(await framesThroughProbe(session))
				]).toStrictEqual([
					{ ev: 'publication-accepted', uploadId: entry.operationId },
					verdict(entry.operationId),
					probeAnswer
				]);
			} finally {
				await closeSessionAndWait(session.socket);
			}
		}
	);

	// A client that reconnects after the removal subscribes to its accepted
	// operations, or sends an entry again.
	it.each(
		publicationReplayOps.flatMap((op) => [
			{
				op,
				session: 'a session that accepts the reason',
				accepted: capablePublicationSession,
				verdict: (uploadId: UploadId) => cacheRemovedFrame(uploadId, {})
			},
			{
				op,
				session: 'a session that does not accept the reason',
				accepted: releasedPublicationSession,
				verdict: (uploadId: UploadId) => ({
					ev: 'verdict',
					uploadId,
					status: 'absent',
					grace: {}
				})
			}
		])
	)(
		'answers $op for an operation of the removed cache for $session',
		async ({ op, accepted, verdict }) => {
			const token = await initialise();
			await putTestCache(token, builds);
			const path = uploadMetadata({
				fileSize: 1,
				storePathHash: 'j'.repeat(32)
			});
			const entry = await plannedEntry(
				token,
				testPushId,
				uploadPathNegotiation(path)
			);
			const first = await openCommitSession(
				token,
				builds,
				releasedPublicationSession
			);
			let admitted: CommitSessionFrame[];
			try {
				first.send({
					op: 'publish-batch',
					pushId: testPushId,
					entries: [entry]
				});
				admitted = [await first.nextFrame(), await first.nextFrame()];
			} finally {
				await closeSessionAndWait(first.socket);
			}
			await authorisedFetch('/caches/builds?force=true', token, {
				method: 'DELETE'
			});
			const session = await openCommitSession(token, builds, accepted);

			try {
				session.send({ op, pushId: testPushId, entries: [entry] });
				const answer = await session.nextFrame();

				expect({
					admitted,
					answered: [answer, ...(await framesThroughProbe(session))]
				}).toStrictEqual({
					admitted: [
						{ ev: 'publication-accepted', uploadId: entry.operationId },
						{ ev: 'upload-required', uploadId: entry.operationId }
					],
					answered: [verdict(entry.operationId), probeAnswer]
				});
			} finally {
				await closeSessionAndWait(session.socket);
			}
		}
	);

	it.each([
		{
			session: 'a session that accepts the reason',
			accepted: cacheRemovedVerdictCapability,
			verdict: (uploadId: UploadId) => cacheRemovedFrame(uploadId)
		},
		{
			session: 'a session that does not accept the reason',
			accepted: undefined,
			verdict: (uploadId: UploadId) => ({
				ev: 'verdict',
				uploadId,
				status: 'absent'
			})
		}
	])(
		'answers the deferred upload of a cache that is removed during its verification for $session',
		async ({ accepted, verdict }) => {
			const token = await initialise();
			await putTestCache(token, builds);
			const { path, uploadId } = await stagedUpload(
				token,
				'removal-race-verification',
				'f'
			);
			const session = await openCommitSession(token, builds, accepted);

			try {
				session.send({ op: 'commit', uploadId });
				const deferred = await session.nextFrame();
				await runInDurableObject(currentServer(), (instance) => {
					const pipeline = commitPipelineOf(instance);
					const reserve = pipeline.reserveNarInfoRow.bind(pipeline);
					vi.spyOn(pipeline, 'reserveNarInfoRow').mockImplementationOnce(
						async (...parameters) => {
							await instance.runCacheTeardown(builds, origin);

							return reserve(...parameters);
						}
					);
				});
				await verifyCurrentTenant();

				expect([
					deferred,
					...(await framesThroughProbe(session))
				]).toStrictEqual([
					{
						ev: 'deferred',
						uploadId,
						storePathHash: path.storePathHash,
						narHash: path.narHash
					},
					verdict(uploadId),
					probeAnswer
				]);
			} finally {
				await closeSessionAndWait(session.socket);
			}
		}
	);
});

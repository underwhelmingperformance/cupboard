import { rootLogger } from '@cupboard/logger';
import {
	cachePrioritySchema,
	type CacheScope,
	graceSecondsSchema,
	narInfoGenerationSchema,
	rootNameSchema,
	sha256HexDigestSchema,
	type StorePathHash,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import {
	type CommitSessionFrame,
	type CommitSessionRequestInput,
	sessionIdSchema,
	type UploadId,
	uploadIdSchema,
	uploadStatusResponseSchema
} from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { and, eq, isNotNull, ne, sql } from 'drizzle-orm';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it, onTestFinished } from 'vitest';

import {
	deliverAlarms,
	ignoreAlarmDeliveries
} from '../alarm-fence.test-support.ts';
import { type CacheId, type ResolvedCache } from '../db/cache.ts';
import * as schema from '../db/schema.ts';
import {
	AttestationUploadCacheMismatchError,
	AttestationUploadNotFoundError,
	CacheNotFoundError,
	CacheRemovedDuringPushError,
	UploadCacheMismatchError,
	UploadNotFoundError
} from '../errors.ts';
import { r2ObjectKeySchema } from '../http/http.ts';
import {
	adminGrants,
	asOneInvocation,
	authorisedFetch,
	closeSessionAndWait,
	currentServer,
	drivenDirectly,
	garbageCollectionOf,
	initialise,
	namedCache,
	narBytes,
	openCommitSession,
	pushPath,
	putTestCache,
	resetTestServer,
	testPushId,
	uploadMetadata,
	verificationOf
} from '../test-support.ts';

import { AttestationCasService } from './attestation-cas-service.ts';
import { AttestationsService } from './attestations-service.ts';
import { CacheRegistrationService } from './cache-registration-service.ts';
import { CommitPipelineService } from './commit-pipeline-service.ts';
import { type ServerContext } from './context.ts';
import { pastInstant } from './garbage-collection.test-support.ts';
import { confirmGrace } from './grace-decision.ts';
import { IntegrityCheckService } from './integrity-check-service.ts';
import { NarInfoObjectsService } from './narinfo-objects-service.ts';
import { PublicationStore } from './publication-store.ts';
import { liveNarInfoPage } from './removed-cache.ts';
import { RetentionService } from './retention-service.ts';
import { ReuseAuthority } from './reuse-authority.ts';
import { type CupboardServer } from './server.ts';
import { SigningKeysService } from './signing-keys-service.ts';
import { UploadRetrySchedule } from './upload-retry-schedule.ts';
import { UploadStateService } from './upload-state-service.ts';

const builds = namedCache('builds');
const pathHash = storePathHashSchema.parse('a'.repeat(32));
const path = uploadMetadata({ fileSize: 1, storePathHash: pathHash });
const operationId = uploadIdSchema.parse('c'.repeat(64));
const liveUploadId = uploadIdSchema.parse('7'.repeat(64));
const other = namedCache('other');
const attestationId = uploadIdSchema.parse('d'.repeat(32));
const liveAttestationId = uploadIdSchema.parse('6'.repeat(32));
const exhaustedUploadId = uploadIdSchema.parse('9'.repeat(64));
const ownerSessionId = sessionIdSchema.parse('owner-session');

function pipelineFor(context: ServerContext): CommitPipelineService {
	const narInfoObjects = new NarInfoObjectsService(context);

	return new CommitPipelineService(
		context,
		new SigningKeysService(context, narInfoObjects),
		new UploadStateService(context),
		narInfoObjects,
		new RetentionService(context),
		new AttestationsService(
			context,
			new CacheRegistrationService(context),
			new AttestationCasService(context),
			narInfoObjects
		)
	);
}

function inAnHour(): Date {
	return new Date(Date.now() + 60 * 60 * 1000);
}

function insertPendingAttestation(
	context: ServerContext,
	cacheId: CacheId,
	id: UploadId
): void {
	context.db
		.insert(schema.pendingAttestations)
		.values({
			id,
			cacheId,
			storePathHash: pathHash,
			digest: sha256HexDigestSchema.parse('b'.repeat(64)),
			r2Key: r2ObjectKeySchema.parse(`staging/attestations/${id}`),
			createdAt: isoTimestamp(new Date()),
			expiresAt: isoTimestamp(inAnHour())
		})
		.run();
}

async function attachRefusal(
	context: ServerContext,
	scope: CacheScope,
	id: UploadId
): Promise<string> {
	const attestations = drivenDirectly(
		new AttestationsService(
			context,
			new CacheRegistrationService(context),
			new AttestationCasService(context),
			new NarInfoObjectsService(context)
		)
	);

	try {
		await attestations.attach(scope, id);

		return 'attached';
	} catch (error) {
		if (error instanceof AttestationUploadNotFoundError) {
			return 'not-found';
		}

		if (error instanceof AttestationUploadCacheMismatchError) {
			return 'cache-mismatch';
		}

		if (error instanceof CacheRemovedDuringPushError) {
			return 'cache-removed';
		}

		return error instanceof Error ? error.name : 'unknown';
	}
}

function insertNarInfo(
	context: ServerContext,
	cacheId: CacheId,
	createdAt = new Date()
): void {
	context.db
		.insert(schema.narInfos)
		.values({
			cacheId,
			storePathHash: path.storePathHash,
			storePath: path.storePath,
			narHash: path.narHash,
			narSize: path.narSize,
			referencesJson: '[]',
			generation: narInfoGenerationSchema.parse(0),
			createdAt: isoTimestamp(createdAt)
		})
		.run();
}

function insertPendingUpload(
	context: ServerContext,
	cacheId: CacheId,
	verdict: 'pending' | 'committing',
	id: UploadId = operationId
): void {
	const expiresAt = isoTimestamp(inAnHour());

	context.db
		.insert(schema.pendingUploads)
		.values({
			id,
			cacheId,
			narHash: path.narHash,
			r2Key: r2ObjectKeySchema.parse(`staging/${id}`),
			metadataJson: JSON.stringify(path),
			createdAt: isoTimestamp(new Date()),
			expiresAt,
			verdict
		})
		.run();
}

function insertAcceptedOperation(
	context: ServerContext,
	cache: ResolvedCache,
	recoveryDeadline: Date
): void {
	const now = new Date().toISOString();

	context.db
		.insert(schema.publicationOperations)
		.values({
			id: operationId,
			cacheId: cache.id,
			cacheGeneration: cache.generation,
			pushId: testPushId,
			canonicalJson: '[]',
			acceptedAt: now,
			pushExpiresAt: now,
			recoveryDeadline: recoveryDeadline.toISOString(),
			pruneAfter: inAnHour().toISOString(),
			graceDecisionJson: '{"reportsGrace":true}'
		})
		.run();
}

// Marks `builds` removed the way the gated step of a removal does, and leaves
// its rows for the teardown drain.
function markRemoved(context: ServerContext): ResolvedCache {
	const cache = context.cacheRepository.require(builds);

	context.db
		.update(schema.cacheIdentities)
		.set({ deletedAt: isoTimestamp(new Date()) })
		.where(eq(schema.cacheIdentities.id, cache.id))
		.run();
	context.db.insert(schema.cacheTeardowns).values({ cacheId: cache.id }).run();

	return cache;
}

function narInfoRows(context: ServerContext, cacheId: CacheId) {
	return context.db
		.select({
			storePathHash: schema.narInfos.storePathHash,
			generation: schema.narInfos.generation
		})
		.from(schema.narInfos)
		.where(eq(schema.narInfos.cacheId, cacheId))
		.all();
}

function pendingUploadIds(context: ServerContext) {
	return context.db
		.select({ id: schema.pendingUploads.id })
		.from(schema.pendingUploads)
		.all()
		.map((row) => row.id);
}

function retentionRows(context: ServerContext, cacheId: CacheId) {
	return {
		grace: context.db
			.select({ storePathHash: schema.retentionGrace.storePathHash })
			.from(schema.retentionGrace)
			.where(eq(schema.retentionGrace.cacheId, cacheId))
			.all(),
		targets: context.db
			.select({ storePathHash: schema.retentionRootTargets.storePathHash })
			.from(schema.retentionRootTargets)
			.where(eq(schema.retentionRootTargets.cacheId, cacheId))
			.all()
	};
}

interface FenceCase {
	readonly name: string;
	// Adds rows to `builds` before the removal.
	readonly seed?: (context: ServerContext, cache: ResolvedCache) => void;
	// Runs the entry point against the removed cache and reports what it did.
	readonly act: (
		instance: CupboardServer,
		removed: ResolvedCache
	) => Promise<unknown>;
	readonly expected: unknown;
}

const fenceCases: readonly FenceCase[] = [
	{
		name: 'verification claims none of its uploads',
		seed: (context, cache) => {
			insertPendingUpload(context, cache.id, 'pending');
		},
		act: (instance) =>
			Promise.resolve({
				hasPendingUploads: verificationOf(instance).hasPendingUploads(),
				projectedAt: new UploadRetrySchedule(instance.context).projectedAt(),
				uploads: pendingUploadIds(instance.context)
			}),
		expected: {
			hasPendingUploads: false,
			projectedAt: undefined,
			uploads: [operationId]
		}
	},
	{
		name: 'a reservation writes no narinfo row',
		act: async (instance, removed) => {
			const outcome = await drivenDirectly(
				pipelineFor(instance.context)
			).reserveNarInfoRow(removed, path, 0);

			return {
				outcome,
				rows: narInfoRows(instance.context, removed.id)
			};
		},
		expected: { outcome: { kind: 'cache-removed' }, rows: [] }
	},
	{
		name: 'expiry fails its operation without reading the recreated cache',
		seed: (context, cache) => {
			insertPendingUpload(context, cache.id, 'committing');
			insertNarInfo(context, cache.id);
			insertAcceptedOperation(context, cache, new Date(Date.now() - 1000));
		},
		act: async (instance) => {
			const recreated = instance.context.cacheRepository.create(builds, {
				access: 'public',
				priority: cachePrioritySchema.parse(40)
			});
			insertNarInfo(instance.context, recreated.id);
			await asOneInvocation(() =>
				verificationOf(instance).expirePublications(rootLogger())
			);
			const operation = instance.context.db
				.select({
					state: schema.publicationOperations.state,
					resultJson: schema.publicationOperations.resultJson
				})
				.from(schema.publicationOperations)
				.get();

			return {
				operation,
				uploads: pendingUploadIds(instance.context),
				recreated: {
					rows: narInfoRows(instance.context, recreated.id),
					...retentionRows(instance.context, recreated.id)
				}
			};
		},
		expected: {
			operation: { state: 'failed', resultJson: '{"verdict":"absent"}' },
			uploads: [operationId],
			recreated: {
				rows: [{ storePathHash: pathHash, generation: 0 }],
				grace: [],
				targets: []
			}
		}
	},
	{
		name: 'readers see its accepted operation as failed',
		seed: (context, cache) => {
			insertAcceptedOperation(context, cache, inAnHour());
		},
		act: (instance) => {
			const operation = new PublicationStore(instance.context).get(operationId);
			const stored = instance.context.db
				.select({ state: schema.publicationOperations.state })
				.from(schema.publicationOperations)
				.get();

			return Promise.resolve({
				read: {
					state: operation?.state,
					resultJson: operation?.resultJson
				},
				stored
			});
		},
		expected: {
			read: { state: 'failed', resultJson: '{"verdict":"absent"}' },
			stored: { state: 'accepted' }
		}
	},
	{
		name: 'completing its accepted operation stores the failure',
		seed: (context, cache) => {
			insertPendingUpload(context, cache.id, 'committing');
			insertAcceptedOperation(context, cache, inAnHour());
		},
		act: (instance) => {
			const pending = instance.context.db
				.select()
				.from(schema.pendingUploads)
				.get();
			if (pending !== undefined) {
				new PublicationStore(instance.context).complete(pending);
			}

			return Promise.resolve(
				instance.context.db
					.select({
						state: schema.publicationOperations.state,
						resultJson: schema.publicationOperations.resultJson
					})
					.from(schema.publicationOperations)
					.get()
			);
		},
		expected: { state: 'failed', resultJson: '{"verdict":"absent"}' }
	},
	{
		name: 'garbage collection does not scan it',
		seed: (context, cache) => {
			// Collection deletes unretained paths only from a grace-managed cache.
			context.db
				.update(schema.cacheIdentities)
				.set({ graceManaged: true })
				.where(eq(schema.cacheIdentities.id, cache.id))
				.run();
			insertNarInfo(context, cache.id, new Date(pastInstant));
		},
		act: async (instance, removed) => {
			// Only the removed cache needs a scan, so the tenant-wide pass reaches
			// it.
			instance.context.db
				.update(schema.garbageCollectionInputs)
				.set({ inputsChanged: false })
				.where(ne(schema.garbageCollectionInputs.cacheId, removed.id))
				.run();
			instance.context.db
				.insert(schema.garbageCollectionInputs)
				.values({ cacheId: removed.id, inputsChanged: true })
				.onConflictDoUpdate({
					target: schema.garbageCollectionInputs.cacheId,
					set: { inputsChanged: true, scanCompletedAt: sql`null` }
				})
				.run();
			await asOneInvocation(() =>
				garbageCollectionOf(instance).collectGarbage(rootLogger(), {
					scope: 'tenant'
				})
			);

			return {
				rows: narInfoRows(instance.context, removed.id),
				queued: instance.context.db
					.select({ storePathHash: schema.narInfoDeletions.storePathHash })
					.from(schema.narInfoDeletions)
					.all(),
				scans: instance.context.db
					.select({ cacheId: schema.garbageCollectionScans.cacheId })
					.from(schema.garbageCollectionScans)
					.all()
			};
		},
		expected: {
			rows: [{ storePathHash: pathHash, generation: 0 }],
			queued: [],
			scans: []
		}
	},
	{
		name: 'the verification scan skips its narinfo rows',
		seed: (context, cache) => {
			insertNarInfo(context, cache.id);
			insertNarInfo(context, laterCache(context).id);
		},
		act: async (instance, removed) => {
			const report = await asOneInvocation(() =>
				verificationOf(instance).verifyBatch(rootLogger(), undefined, 10)
			);

			return { report, rows: narInfoRows(instance.context, removed.id) };
		},
		expected: {
			report: {
				scanned: 1,
				narInfoObjectsRestored: 0,
				danglingNarInfosRemoved: 0,
				wrapped: true
			},
			rows: [{ storePathHash: pathHash, generation: 0 }]
		}
	},
	{
		name: 'an attestation attach refuses its upload',
		seed: (context, cache) => {
			insertPendingAttestation(context, cache.id, attestationId);
		},
		act: (instance) => attachRefusal(instance.context, builds, attestationId),
		expected: 'cache-removed'
	},
	{
		name: 'the integrity check skips its narinfo rows',
		seed: (context, cache) => {
			insertNarInfo(context, cache.id);
			insertNarInfo(context, laterCache(context).id);
		},
		act: (instance) =>
			drivenDirectly(new IntegrityCheckService(instance.context)).check(false, {
				cache: 0,
				storePathHash: ''
			}),
		// Only the live cache's row is checked. It has neither a narinfo object
		// nor a NAR.
		expected: {
			narInfosChecked: 1,
			narBlobsChecked: 1,
			cursor: '',
			cursorCache: 0,
			discrepancies: (['missing-narinfo-object', 'missing-nar'] as const).map(
				(kind) => ({
					kind,
					cache: namedCache('later'),
					storePathHash: pathHash,
					narHash: path.narHash
				})
			)
		}
	},
	{
		name: 'verification claims none of its recorded or exhausted uploads',
		seed: (context, cache) => {
			const expiresAt = isoTimestamp(inAnHour());
			const upload = {
				cacheId: cache.id,
				narHash: path.narHash,
				metadataJson: JSON.stringify(path),
				createdAt: isoTimestamp(new Date()),
				expiresAt,
				verdict: 'pending' as const
			};

			context.db
				.insert(schema.pendingUploads)
				.values([
					{
						...upload,
						id: operationId,
						r2Key: r2ObjectKeySchema.parse(`staging/${operationId}`),
						recordedVerdictJson: JSON.stringify({
							owner: 'held-owner',
							verdict: { kind: 'missing' }
						}),
						claimOwner: 'held-owner'
					},
					{
						...upload,
						id: exhaustedUploadId,
						r2Key: r2ObjectKeySchema.parse(`staging/${exhaustedUploadId}`),
						settleExhaustion: 'attempt-limit'
					}
				])
				.run();
		},
		act: async (instance) => {
			const verification = verificationOf(instance);

			return {
				projectedAt: new UploadRetrySchedule(instance.context).projectedAt(),
				recorded: await asOneInvocation(() =>
					verification.applyRecordedVerdicts(rootLogger())
				),
				exhausted: await asOneInvocation(() =>
					verification.processExhaustedUploads(rootLogger())
				),
				uploads: pendingUploadIds(instance.context)
			};
		},
		expected: {
			projectedAt: undefined,
			recorded: { applied: 0, resolved: 0, unresolved: 0, beingApplied: 0 },
			exhausted: 0,
			uploads: [exhaustedUploadId, operationId]
		}
	},
	{
		name: 'the signing-key backfill neither re-signs nor counts its narinfo rows',
		seed: (context, cache) => {
			insertNarInfo(context, cache.id);
		},
		act: async (instance, removed) => {
			const signingKeys = drivenDirectly(
				new SigningKeysService(
					instance.context,
					new NarInfoObjectsService(instance.context)
				)
			);
			const rotation = await signingKeys.rotateKey();
			const progress = await signingKeys.runBackfillOnce();

			return {
				remaining: rotation.rotated.backfill.remaining,
				progress,
				staged: instance.context.db
					.select({ storePathHash: schema.narInfos.storePathHash })
					.from(schema.narInfos)
					.where(
						and(
							eq(schema.narInfos.cacheId, removed.id),
							isNotNull(schema.narInfos.pendingSignatureGeneration)
						)
					)
					.all(),
				backfills: instance.context.db
					.select({ state: schema.signingKeyBackfills.state })
					.from(schema.signingKeyBackfills)
					.all()
			};
		},
		expected: {
			remaining: 0,
			progress: 'progressed',
			staged: [],
			backfills: [{ state: 'complete' }]
		}
	}
];

const insertNarInfoRows = `WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < ?2)
	INSERT INTO narinfo (cache_id, store_path_hash, store_path, nar_hash, nar_size, references_json, created_at)
	SELECT ?1, printf('%s%031d', ?3, n), printf('/nix/store/%s%031d-p', ?3, n), ?4, 1, '[]', ?5 FROM sequence`;

interface WalkPosition {
	readonly cacheId: CacheId;
	readonly storePathHash: StorePathHash;
}

// The narinfo rows that a walk's page processed, and the store path hash that
// the next page resumes after.
interface WalkedPage {
	readonly rows: number;
	readonly resumeAfter: string | undefined;
}

interface ResumedWalk {
	readonly name: string;
	// Stores `after` where the walk reads its cursor, outside the measurement.
	readonly prepare?: (instance: CupboardServer, after: WalkPosition) => void;
	// Reads one page of ten rows after `after`.
	readonly act: (
		instance: CupboardServer,
		after: WalkPosition
	) => Promise<WalkedPage>;
	// The rows that one page reads, wherever the page starts.
	readonly rowsRead: number;
}

// The two walks over every cache's narinfo rows, each resumed from a cursor.
const resumedWalks: readonly ResumedWalk[] = [
	{
		name: 'the integrity check',
		act: async (instance, after) => {
			const report = await drivenDirectly(
				new IntegrityCheckService(instance.context, 10)
			).check(false, {
				cache: after.cacheId,
				storePathHash: after.storePathHash
			});

			return { rows: report.narInfosChecked, resumeAfter: report.cursor };
		},
		rowsRead: 25
	},
	{
		name: 'the verification scan',
		prepare: (instance, after) => {
			instance.context.db
				.insert(schema.verificationCursor)
				.values({
					id: 'active',
					cacheId: after.cacheId,
					lastStorePathHash: after.storePathHash,
					updatedAt: isoTimestamp(new Date())
				})
				.onConflictDoUpdate({
					target: schema.verificationCursor.id,
					set: {
						cacheId: after.cacheId,
						lastStorePathHash: after.storePathHash
					}
				})
				.run();
		},
		act: async (instance) => {
			const report = await asOneInvocation(() =>
				verificationOf(instance).verifyBatch(rootLogger(), undefined, 10)
			);

			return { rows: report.scanned, resumeAfter: report.cursor };
		},
		rowsRead: 70
	}
];

// Seeds an upload of `builds`, removes the cache and registers the name again,
// so the upload's scope resolves to the new cache.
async function seedUploadOfReplacedCache(token: string): Promise<void> {
	await putTestCache(token, builds);
	await runInDurableObject(currentServer(), (instance) => {
		insertPendingUpload(
			instance.context,
			instance.context.cacheRepository.require(builds).id,
			'pending'
		);
		markRemoved(instance.context);
	});
	await putTestCache(token, builds);
}

// Seeds an upload of a removed cache whose name was registered again, a
// live upload of the cache registered again, and the cache `other`.
async function seedUploadsOfAnotherCache(token: string): Promise<void> {
	await seedUploadOfReplacedCache(token);
	await putTestCache(token, other);
	await runInDurableObject(currentServer(), (instance) => {
		insertPendingUpload(
			instance.context,
			instance.context.cacheRepository.require(builds).id,
			'pending',
			liveUploadId
		);
	});
}

async function commitRefusal(
	pipeline: CommitPipelineService,
	cache: ResolvedCache,
	uploadId: UploadId
): Promise<string> {
	try {
		await pipeline.commit(
			rootLogger(),
			cache,
			uploadId,
			new ReuseAuthority({
				destination: cache.scope,
				grants: adminGrants(),
				views: []
			})
		);

		return 'committed';
	} catch (error) {
		if (error instanceof UploadNotFoundError) {
			return 'not-found';
		}

		if (error instanceof UploadCacheMismatchError) {
			return 'cache-mismatch';
		}

		return error instanceof Error ? error.name : 'unknown';
	}
}

function sessionRequest(
	op: 'subscribe' | 'subscribe-identity' | 'commit' | 'commit-batch',
	uploadId: UploadId
): CommitSessionRequestInput {
	const entry = {
		uploadId,
		storePathHash: path.storePathHash,
		narHash: path.narHash
	};

	switch (op) {
		case 'subscribe': {
			return { op, uploadIds: [uploadId] };
		}
		case 'subscribe-identity': {
			return { op, entries: [entry] };
		}
		case 'commit': {
			return { op, uploadId };
		}
		case 'commit-batch': {
			return { op, commits: [entry] };
		}
	}
}

function uploadSession(id: UploadId) {
	return runInDurableObject(currentServer(), (instance) =>
		instance.context.db
			.select({
				id: schema.pendingUploads.id,
				sessionId: schema.pendingUploads.sessionId
			})
			.from(schema.pendingUploads)
			.where(eq(schema.pendingUploads.id, id))
			.get()
	);
}

// Error frames are compared without their message text.
function frameFacts(frame: CommitSessionFrame): object {
	if (frame.ev !== 'error') {
		return frame;
	}

	return { ev: frame.ev, uploadId: frame.uploadId, status: frame.status };
}

// A live cache registered after `builds`, so the walks over every cache's
// narinfo rows reach it after the removed cache.
function laterCache(context: ServerContext): ResolvedCache {
	return context.cacheRepository.create(namedCache('later'), {
		access: 'public',
		priority: cachePrioritySchema.parse(40)
	});
}

const committedPath = uploadMetadata({
	fileSize: narBytes.byteLength,
	storePathHash: 'f'.repeat(32),
	name: 'committed'
});
const sharingUploadId = uploadIdSchema.parse('e'.repeat(64));
const sharingStagingKey = r2ObjectKeySchema.parse(`staging/${sharingUploadId}`);
const runRoot = rootNameSchema.parse('run');
const graceDecision = {
	reportsGrace: true,
	graceSeconds: graceSecondsSchema.parse(3600)
};

// An upload of the committed path whose commit has started, so it shares the
// path's reservation.
function insertSharingUpload(
	context: ServerContext,
	cache: ResolvedCache
): void {
	const expiresAt = isoTimestamp(inAnHour());

	context.db
		.insert(schema.pendingUploads)
		.values({
			id: sharingUploadId,
			cacheId: cache.id,
			narHash: committedPath.narHash,
			r2Key: sharingStagingKey,
			metadataJson: JSON.stringify(committedPath),
			createdAt: isoTimestamp(new Date()),
			expiresAt,
			verdict: 'committing'
		})
		.run();
}

// Leaves the removed cache as the teardown drain leaves it: no narinfo row and
// no teardown record.
function markDrained(context: ServerContext, cache: ResolvedCache): void {
	context.db
		.delete(schema.narInfos)
		.where(eq(schema.narInfos.cacheId, cache.id))
		.run();
	context.db
		.delete(schema.cacheTeardowns)
		.where(eq(schema.cacheTeardowns.cacheId, cache.id))
		.run();
}

interface RetentionCase {
	readonly name: string;
	readonly act: (
		context: ServerContext,
		removed: ResolvedCache
	) => Promise<unknown>;
	readonly expected: unknown;
}

// The paths that confirm grace or attach a root target for a committed path
// after a commit or verification has decided that the path is committed.
const retentionCases: readonly RetentionCase[] = [
	{
		name: 'a commit concedes to the committed path',
		act: async (context, removed) => {
			try {
				await drivenDirectly(pipelineFor(context)).concedeToWinner(
					rootLogger(),
					removed,
					sharingUploadId,
					committedPath,
					sharingStagingKey,
					graceDecision,
					runRoot
				);

				return 'conceded';
			} catch (error) {
				return error instanceof CacheNotFoundError ? 'refused' : 'failed';
			}
		},
		expected: 'refused'
	},
	{
		name: 'a reservation release finds another started commit',
		act: (context, removed) =>
			drivenDirectly(pipelineFor(context)).releaseReservation({
				uploadId: uploadIdSchema.parse('b'.repeat(64)),
				cache: removed,
				path: committedPath,
				generation: narInfoGenerationSchema.parse(0),
				reason: 'failed-upload',
				read: {
					generation: narInfoGenerationSchema.parse(0),
					isCharged: true,
					mark: 0
				}
			}),
		expected: 'superseded'
	},
	{
		name: 'verification confirms grace for the committed generation',
		act: (context, removed) =>
			Promise.resolve(
				confirmGrace(
					context,
					new RetentionService(context),
					removed,
					committedPath.storePathHash,
					narInfoGenerationSchema.parse(0),
					committedPath.narHash,
					graceDecision
				)
			),
		expected: { matched: false }
	},
	{
		name: 'a run root target is attached',
		act: (context, removed) => {
			pipelineFor(context).attachRootTarget(
				removed,
				runRoot,
				committedPath.storePathHash,
				committedPath.storePath
			);

			return Promise.resolve('attached');
		},
		expected: 'attached'
	}
];

// A removal marks the cache removed and leaves its rows. Until the teardown
// drain deletes them, every entry point that reaches them through the cache's
// id treats them as absent.
describe('removed cache fence', () => {
	beforeEach(async () => {
		await resetTestServer();
		const id = currentServer().id;
		ignoreAlarmDeliveries(id);
		onTestFinished(() => {
			deliverAlarms(id);
		});
	});

	it.each(fenceCases)('$name', async ({ seed, act, expected }) => {
		const token = await initialise();
		await putTestCache(token, builds);

		const observed = await runInDurableObject(
			currentServer(),
			async (instance) => {
				seed?.(
					instance.context,
					instance.context.cacheRepository.require(builds)
				);

				return act(instance, markRemoved(instance.context));
			}
		);

		expect(observed).toStrictEqual(expected);
	});

	it.each(
		retentionCases.flatMap((retentionCase) =>
			(['undrained', 'drained'] as const).map((state) => ({
				...retentionCase,
				state
			}))
		)
	)(
		'inserts no grace or root target when $name for a $state removed cache',
		async ({ act, expected, state }) => {
			const token = await initialise();
			await putTestCache(token, builds);
			await pushPath(token, committedPath, builds);

			const observed = await runInDurableObject(
				currentServer(),
				async (instance) => {
					insertSharingUpload(
						instance.context,
						instance.context.cacheRepository.require(builds)
					);
					const removed = markRemoved(instance.context);
					if (state === 'drained') {
						markDrained(instance.context, removed);
					}

					return {
						outcome: await act(instance.context, removed),
						...retentionRows(instance.context, removed.id)
					};
				}
			);

			expect(observed).toStrictEqual({
				outcome: expected,
				grace: [],
				targets: []
			});
		}
	);

	it('walks past removed caches without reading their narinfo rows', async () => {
		await initialise();

		const walked = await runInDurableObject(
			currentServer(),
			(instance, state) => {
				const now = isoTimestamp(new Date());
				for (const prefix of ['b', 'c', 'd']) {
					const removed = instance.context.cacheRepository.create(
						namedCache(`removed-${prefix}`),
						{ access: 'public', priority: cachePrioritySchema.parse(40) }
					);
					state.storage.sql.exec(
						insertNarInfoRows,
						removed.id,
						100,
						prefix,
						path.narHash,
						now
					);
					instance.context.db
						.update(schema.cacheIdentities)
						.set({ deletedAt: now })
						.where(eq(schema.cacheIdentities.id, removed.id))
						.run();
				}
				const live = laterCache(instance.context);
				state.storage.sql.exec(
					insertNarInfoRows,
					live.id,
					2,
					'f',
					path.narHash,
					now
				);

				instance.context.dbCost.recordOutstanding();
				const before = instance.context.dbCost.rowsRead;
				const page = liveNarInfoPage(instance.context, undefined, 50);
				instance.context.dbCost.recordOutstanding();

				return {
					rows: page.map((row) => row.storePathHash),
					rowsRead: instance.context.dbCost.rowsRead - before
				};
			}
		);

		// Each cache costs a probe of its first row and a read of its identity.
		// The live cache adds its two rows, and a last probe finds no row.
		expect(walked).toStrictEqual({
			rows: [`f${'1'.padStart(31, '0')}`, `f${'2'.padStart(31, '0')}`],
			rowsRead: 11
		});
	});

	it.each(resumedWalks)(
		'resumes $name deep inside a cache at the cost of one page',
		async ({ prepare, act, rowsRead }) => {
			await initialise();

			const costs = await runInDurableObject(
				currentServer(),
				async (instance, state) => {
					const live = laterCache(instance.context);
					state.storage.sql.exec(
						insertNarInfoRows,
						live.id,
						5000,
						'f',
						path.narHash,
						isoTimestamp(new Date())
					);
					const pageCost = async (position: number): Promise<number> => {
						const after = {
							cacheId: live.id,
							storePathHash: storePathHashSchema.parse(
								`f${String(position).padStart(31, '0')}`
							)
						};
						prepare?.(instance, after);
						instance.context.dbCost.recordOutstanding();
						const before = instance.context.dbCost.rowsRead;
						await act(instance, after);
						instance.context.dbCost.recordOutstanding();

						return instance.context.dbCost.rowsRead - before;
					};

					return { early: await pageCost(10), deep: await pageCost(4980) };
				}
			);

			expect(costs).toStrictEqual({ early: rowsRead, deep: rowsRead });
		}
	);

	it.each(resumedWalks)(
		'resumes $name into a later cache whose hashes sort below the cursor',
		async ({ prepare, act }) => {
			await initialise();

			const walked = await runInDurableObject(
				currentServer(),
				async (instance, state) => {
					const now = isoTimestamp(new Date());
					const first = laterCache(instance.context);
					const second = instance.context.cacheRepository.create(
						namedCache('latest'),
						{ access: 'public', priority: cachePrioritySchema.parse(40) }
					);
					state.storage.sql.exec(
						insertNarInfoRows,
						first.id,
						5,
						'f',
						path.narHash,
						now
					);
					state.storage.sql.exec(
						insertNarInfoRows,
						second.id,
						20,
						'c',
						path.narHash,
						now
					);
					const after = {
						cacheId: first.id,
						storePathHash: storePathHashSchema.parse(
							`f${'3'.padStart(31, '0')}`
						)
					};
					prepare?.(instance, after);

					return act(instance, after);
				}
			);

			// The page takes the last two rows of `later`, then the first eight rows
			// of `latest`, whose hashes all sort below the cursor's hash.
			expect(walked).toStrictEqual({
				rows: 10,
				resumeAfter: `c${'8'.padStart(31, '0')}`
			});
		}
	);

	it('reports its upload as absent through the upload status', async () => {
		const token = await initialise();
		await seedUploadOfReplacedCache(token);

		const response = await authorisedFetch(
			`/uploads/${operationId}/status`,
			token
		);

		expect({
			status: response.status,
			body: uploadStatusResponseSchema.parse(await response.json())
		}).toStrictEqual({
			status: StatusCodes.OK,
			body: { status: 'absent' }
		});
	});

	it.each([
		...(['subscribe', 'subscribe-identity'] as const).map((op) => ({
			op,
			session: 'the cache registered again under its name',
			scope: builds,
			expected: [{ ev: 'verdict', uploadId: operationId, status: 'absent' }]
		})),
		{
			op: 'commit' as const,
			session: 'the cache registered again under its name',
			scope: builds,
			expected: [
				{ ev: 'error', uploadId: operationId, status: StatusCodes.NOT_FOUND }
			]
		},
		{
			// The cache registered again does not serve the path.
			op: 'commit-batch' as const,
			session: 'the cache registered again under its name',
			scope: builds,
			expected: [{ ev: 'verdict', uploadId: operationId, status: 'absent' }]
		},
		// The second upload is a live upload of another cache.
		...(
			[
				['subscribe', StatusCodes.NOT_FOUND],
				['subscribe-identity', StatusCodes.NOT_FOUND],
				['commit', StatusCodes.BAD_REQUEST],
				['commit-batch', StatusCodes.BAD_REQUEST]
			] as const
		).map(([op, status]) => ({
			op,
			session: 'another cache',
			scope: other,
			expected: [
				{ ev: 'error', uploadId: operationId, status },
				{ ev: 'error', uploadId: liveUploadId, status }
			]
		}))
	])(
		'answers $op for its upload from a session of $session',
		async ({ op, scope, expected }) => {
			const token = await initialise();
			await seedUploadsOfAnotherCache(token);
			const session = await openCommitSession(token, scope);
			const frames: CommitSessionFrame[] = [];

			try {
				for (const { uploadId } of expected) {
					session.send(sessionRequest(op, uploadId));
					frames.push(await session.nextFrame());
				}
			} finally {
				session.socket.close();
			}

			expect(frames.map((frame) => frameFacts(frame))).toStrictEqual(expected);
		}
	);

	it('includes an empty grace fact in the absent verdict of an upload that accepted grace facts', async () => {
		const token = await initialise();
		await seedUploadOfReplacedCache(token);
		await runInDurableObject(currentServer(), (instance) => {
			instance.context.db
				.update(schema.pendingUploads)
				.set({ graceDecisionJson: '{"reportsGrace":true}' })
				.where(eq(schema.pendingUploads.id, operationId))
				.run();
		});
		const session = await openCommitSession(token, builds);
		let received: CommitSessionFrame;

		try {
			session.send(sessionRequest('subscribe', operationId));
			received = await session.nextFrame();
		} finally {
			await closeSessionAndWait(session.socket);
		}

		expect(received).toStrictEqual({
			ev: 'verdict',
			uploadId: operationId,
			status: 'absent',
			grace: {}
		});
	});

	// Verification sends an upload's verdict to the session recorded on its row,
	// so a session of another cache must not replace that session.
	it.each([
		{
			op: 'subscribe' as const,
			frame: { ev: 'verdict', uploadId: operationId, status: 'absent' }
		},
		{
			op: 'subscribe-identity' as const,
			frame: { ev: 'verdict', uploadId: operationId, status: 'absent' }
		},
		{
			op: 'commit' as const,
			frame: {
				ev: 'error',
				uploadId: operationId,
				status: StatusCodes.NOT_FOUND
			}
		},
		{
			op: 'commit-batch' as const,
			frame: { ev: 'verdict', uploadId: operationId, status: 'absent' }
		}
	])(
		'keeps the session recorded on its upload after $op from a session of the cache registered again under its name',
		async ({ op, frame }) => {
			const token = await initialise();
			await seedUploadOfReplacedCache(token);
			await runInDurableObject(currentServer(), (instance) => {
				instance.context.db
					.update(schema.pendingUploads)
					.set({ sessionId: ownerSessionId })
					.where(eq(schema.pendingUploads.id, operationId))
					.run();
			});
			const session = await openCommitSession(token, builds);
			let received: CommitSessionFrame;

			try {
				session.send(sessionRequest(op, operationId));
				received = await session.nextFrame();
			} finally {
				await closeSessionAndWait(session.socket);
			}

			expect({
				frame: frameFacts(received),
				upload: await uploadSession(operationId)
			}).toStrictEqual({
				frame,
				upload: { id: operationId, sessionId: ownerSessionId }
			});
		}
	);

	it.each([
		{
			session: 'the cache registered again under its name',
			scope: builds,
			expected: [{ uploadId: operationId, refusal: 'not-found' }]
		},
		{
			// The second upload is a live upload of another cache.
			session: 'another cache',
			scope: other,
			expected: [
				{ uploadId: operationId, refusal: 'cache-mismatch' },
				{ uploadId: liveUploadId, refusal: 'cache-mismatch' }
			]
		}
	])(
		'refuses a commit of its upload from a session of $session',
		async ({ scope, expected }) => {
			const token = await initialise();
			await seedUploadsOfAnotherCache(token);

			const refusals = await runInDurableObject(
				currentServer(),
				async (instance) => {
					const cache = instance.context.cacheRepository.require(scope);
					const pipeline = drivenDirectly(pipelineFor(instance.context));
					const observed = [];
					for (const { uploadId } of expected) {
						observed.push({
							uploadId,
							refusal: await commitRefusal(pipeline, cache, uploadId)
						});
					}

					return observed;
				}
			);

			expect(refusals).toStrictEqual(expected);
		}
	);
	it.each([
		{
			session: 'the cache registered again under its name',
			scope: builds,
			expected: [{ id: attestationId, refusal: 'cache-removed' }]
		},
		{
			// The second upload is a live attestation upload of another cache.
			session: 'another cache',
			scope: other,
			expected: [
				{ id: attestationId, refusal: 'cache-mismatch' },
				{ id: liveAttestationId, refusal: 'cache-mismatch' }
			]
		}
	])(
		'refuses an attestation attach of its upload through $session',
		async ({ scope, expected }) => {
			const token = await initialise();
			await putTestCache(token, builds);
			await runInDurableObject(currentServer(), (instance) => {
				insertPendingAttestation(
					instance.context,
					instance.context.cacheRepository.require(builds).id,
					attestationId
				);
				markRemoved(instance.context);
			});
			await putTestCache(token, builds);
			await putTestCache(token, other);

			const refusals = await runInDurableObject(
				currentServer(),
				async (instance) => {
					insertPendingAttestation(
						instance.context,
						instance.context.cacheRepository.require(builds).id,
						liveAttestationId
					);
					const observed = [];
					for (const { id } of expected) {
						observed.push({
							id,
							refusal: await attachRefusal(instance.context, scope, id)
						});
					}

					return observed;
				}
			);

			expect(refusals).toStrictEqual(expected);
		}
	);
});

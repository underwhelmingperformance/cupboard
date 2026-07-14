import { rootLogger } from '@cupboard/logger';
import {
	DEFAULT_CACHE,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { narObjectKey } from '../http/http.ts';
import {
	authorisedFetch,
	bootstrap,
	clearBlobStorage,
	currentServer,
	deletePath,
	expectSingleUploadDecision,
	markUploadPendingVerification,
	narBytes,
	narInfoGeneration,
	negotiateUploads,
	pendingUploadVerdict,
	pushPath,
	putNarBytes,
	removeRoot,
	resetTestServer,
	setRoot,
	uploadMetadata,
	uploadPathNegotiation,
	useTestServer,
	verifiableNar
} from '../test-support.ts';

import { AttestationCasService } from './attestation-cas-service.ts';
import { AttestationsService } from './attestations-service.ts';
import { CacheAdminService } from './cache-admin-service.ts';
import { CommitPipelineService } from './commit-pipeline-service.ts';
import { ServerContext } from './context.ts';
import { DeletionQueueService } from './deletion-queue-service.ts';
import { parseStoredGraceDecision } from './grace-decision.ts';
import { NarInfoObjectsService } from './narinfo-objects-service.ts';
import { RetentionService } from './retention-service.ts';
import { gcContinuationKey } from './server.ts';
import { SigningKeysService } from './signing-keys-service.ts';
import { UploadStateService } from './upload-state-service.ts';
import { VerificationService } from './verification-service.ts';

const repeated = (character: string): string => character.repeat(32);

// The pipeline over a live instance's context, as the server itself builds it.
function pipelineFor(context: ServerContext): CommitPipelineService {
	const narInfoObjects = new NarInfoObjectsService(context);
	const attestationCas = new AttestationCasService(context);
	const attestations = new AttestationsService(
		context,
		attestationCas,
		narInfoObjects
	);
	const deletionQueue = new DeletionQueueService(
		context,
		attestationCas,
		attestations,
		narInfoObjects
	);

	return new CommitPipelineService(
		context,
		new CacheAdminService(context, deletionQueue),
		new SigningKeysService(context),
		new UploadStateService(context),
		narInfoObjects,
		new RetentionService(context)
	);
}

// The shared test clock is pinned to 2026-01-01, so these bracket "now".
const liveDeadline = '2026-06-01T00:00:00.000Z';
const expiredDeadline = '2025-12-01T00:00:00.000Z';

async function seedGraceDeadline(
	cache: string,
	storePathHash: string,
	retainUntil: string
): Promise<void> {
	await runInDurableObject(currentServer(), (instance) => {
		instance.context.db
			.insert(schema.retentionGrace)
			.values({
				cache,
				storePathHash: storePathHashSchema.parse(storePathHash),
				retainUntil
			})
			.run();
	});
}

async function markGraceManaged(cache: string): Promise<void> {
	await runInDurableObject(currentServer(), (instance) => {
		instance.context.db
			.update(schema.caches)
			.set({ graceManaged: true })
			.where(eq(schema.caches.name, cache))
			.run();
	});
}

async function graceDeadlines(cache: string): Promise<readonly string[]> {
	return runInDurableObject(currentServer(), (instance) =>
		instance.context.db
			.select({ storePathHash: schema.retentionGrace.storePathHash })
			.from(schema.retentionGrace)
			.where(eq(schema.retentionGrace.cache, cache))
			.all()
			.map((row) => row.storePathHash)
	);
}

async function runGc(): Promise<void> {
	await currentServer().runGarbageCollection();
}

describe('retention grace deadlines in garbage collection', () => {
	beforeEach(resetTestServer);

	it('keeps a live deadline and its transitive closure through a sweep', async () => {
		await useTestServer('grace-live-closure');
		const { token } = await bootstrap();

		const dependency = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('a'),
			name: 'dependency'
		});
		const kept = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('b'),
			name: 'kept',
			references: [
				`${repeated('b')}-kept`,
				`${dependency.storePathHash}-dependency`
			]
		});
		const collectable = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('c'),
			name: 'collectable'
		});

		await pushPath(token, dependency);
		await pushPath(token, kept);
		await pushPath(token, collectable);
		await seedGraceDeadline(DEFAULT_CACHE, kept.storePathHash, liveDeadline);

		await runGc();

		expect({
			kept: (await narInfoGeneration(kept.storePathHash)) !== undefined,
			dependency:
				(await narInfoGeneration(dependency.storePathHash)) !== undefined,
			collectable:
				(await narInfoGeneration(collectable.storePathHash)) !== undefined,
			deadlines: await graceDeadlines(DEFAULT_CACHE)
		}).toStrictEqual({
			kept: true,
			dependency: true,
			collectable: false,
			deadlines: [kept.storePathHash]
		});
	});

	it('drains a grace-managed cache once its deadlines expire', async () => {
		await useTestServer('grace-expiry-drain');
		const { token } = await bootstrap();

		const path = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('d'),
			name: 'expiring'
		});

		await pushPath(token, path);
		await seedGraceDeadline(DEFAULT_CACHE, path.storePathHash, expiredDeadline);
		await markGraceManaged(DEFAULT_CACHE);

		await runGc();

		expect({
			path: await narInfoGeneration(path.storePathHash),
			deadlines: await graceDeadlines(DEFAULT_CACHE)
		}).toStrictEqual({ path: undefined, deadlines: [] });
	});

	it('drains a grace-managed cache that holds no deadlines at all', async () => {
		await useTestServer('grace-managed-empty');
		const { token } = await bootstrap();

		const path = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('g'),
			name: 'drained'
		});

		await pushPath(token, path);
		await markGraceManaged(DEFAULT_CACHE);

		await runGc();

		expect(await narInfoGeneration(path.storePathHash)).toBeUndefined();
	});

	it('keeps the empty-cache guard for a cache never grace-managed', async () => {
		await useTestServer('grace-guard-kept');
		const { token } = await bootstrap();

		const path = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('f'),
			name: 'guarded'
		});

		await pushPath(token, path);

		await runGc();

		expect(await narInfoGeneration(path.storePathHash)).not.toBeUndefined();
	});

	it('drains a large expired closure across capped continuation runs', async () => {
		await useTestServer('grace-capped-drain');
		const { token } = await bootstrap();

		const first = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('1'),
			name: 'first'
		});
		const second = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('2'),
			name: 'second'
		});

		await pushPath(token, first);
		await pushPath(token, second);
		await seedGraceDeadline(
			DEFAULT_CACHE,
			first.storePathHash,
			expiredDeadline
		);
		await seedGraceDeadline(
			DEFAULT_CACHE,
			second.storePathHash,
			expiredDeadline
		);
		await markGraceManaged(DEFAULT_CACHE);

		await currentServer().runGarbageCollection(1);

		const remaining = async (): Promise<number> => {
			const generations = await Promise.all([
				narInfoGeneration(first.storePathHash),
				narInfoGeneration(second.storePathHash)
			]);

			return generations.filter((generation) => generation !== undefined)
				.length;
		};

		await vi.waitFor(async () => {
			await runInDurableObject(currentServer(), (instance) => instance.alarm());
			expect(await remaining()).toBe(0);
			expect(
				await runInDurableObject(currentServer(), (_instance, state) =>
					state.storage.get<number>(gcContinuationKey)
				)
			).toBeUndefined();
		});
	});

	it('deletes the deadline with its narinfo', async () => {
		await useTestServer('grace-delete-cascade');
		const { token } = await bootstrap();

		const path = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('9'),
			name: 'deleted'
		});

		await pushPath(token, path);
		await seedGraceDeadline(DEFAULT_CACHE, path.storePathHash, liveDeadline);

		const outcome = await deletePath(
			token,
			storePathHashSchema.parse(path.storePathHash)
		);

		expect({
			deleted: outcome.deleted,
			deadlines: await graceDeadlines(DEFAULT_CACHE)
		}).toStrictEqual({ deleted: true, deadlines: [] });
	});

	it('cache deletion removes its deadlines and grace-managed marker', async () => {
		await useTestServer('grace-cache-deletion');
		const { token } = await bootstrap();

		const path = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('8'),
			name: 'torn-down'
		});

		await pushPath(token, path, 'builds');
		await seedGraceDeadline('builds', path.storePathHash, liveDeadline);
		await markGraceManaged('builds');

		const response = await authorisedFetch('/caches/builds?force=true', token, {
			method: 'DELETE'
		});
		const registryRow = await runInDurableObject(currentServer(), (instance) =>
			instance.context.db
				.select({ name: schema.caches.name })
				.from(schema.caches)
				.where(eq(schema.caches.name, 'builds'))
				.get()
		);

		expect({
			status: response.status,
			deadlines: await graceDeadlines('builds'),
			registryRow
		}).toStrictEqual({
			status: StatusCodes.OK,
			deadlines: [],
			registryRow: undefined
		});
	});
});

async function addGracePolicy(
	cachePrefix: string,
	graceSeconds: number
): Promise<string> {
	return runInDurableObject(
		currentServer(),
		(instance) =>
			new RetentionService(instance.context).addGracePolicy({
				cachePrefix,
				graceSeconds
			}).id
	);
}

async function removeGracePolicy(id: string): Promise<void> {
	await runInDurableObject(currentServer(), (instance) => {
		new RetentionService(instance.context).removeGracePolicy(id);
	});
}

async function graceDeadlineRows(
	cache: string
): Promise<readonly { storePathHash: string; retainUntil: string }[]> {
	return runInDurableObject(currentServer(), (instance) =>
		instance.context.db
			.select({
				storePathHash: schema.retentionGrace.storePathHash,
				retainUntil: schema.retentionGrace.retainUntil
			})
			.from(schema.retentionGrace)
			.where(eq(schema.retentionGrace.cache, cache))
			.orderBy(schema.retentionGrace.storePathHash)
			.all()
	);
}

async function graceManagedMarker(cache: string): Promise<boolean> {
	return runInDurableObject(
		currentServer(),
		(instance) =>
			instance.context.db
				.select({ graceManaged: schema.caches.graceManaged })
				.from(schema.caches)
				.where(eq(schema.caches.name, cache))
				.get()?.graceManaged ?? false
	);
}

describe('retention grace transitions', () => {
	beforeEach(resetTestServer);

	// The shared clock starts at 2026-01-01T00:00:00Z, so a 24-hour grace from a
	// transition processed immediately lands on the next midnight.
	const dayGraceSeconds = 86_400;
	const dayAfterStart = '2026-01-02T00:00:00.000Z';

	it('grants deadlines to the targets a replacement releases', async () => {
		await useTestServer('transition-replace');
		const { token } = await bootstrap();

		const kept = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('a'),
			name: 'kept'
		});
		const released = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('b'),
			name: 'released'
		});

		await pushPath(token, kept);
		await pushPath(token, released);
		// The policy arrives only after publication, so the replacement below is
		// the sole source of any deadline.
		await addGracePolicy('', dayGraceSeconds);
		await setRoot(token, {
			name: 'channel',
			targets: [kept.storePath, released.storePath]
		});
		await setRoot(token, { name: 'channel', targets: [kept.storePath] });

		expect({
			deadlines: await graceDeadlineRows(DEFAULT_CACHE),
			graceManaged: await graceManagedMarker(DEFAULT_CACHE)
		}).toStrictEqual({
			deadlines: [
				{ storePathHash: released.storePathHash, retainUntil: dayAfterStart }
			],
			graceManaged: true
		});
	});

	it('grants no deadline to a released target whose path was deleted', async () => {
		await useTestServer('transition-deleted');
		const { token } = await bootstrap();

		const kept = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('7'),
			name: 'kept'
		});
		const deleted = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('8'),
			name: 'deleted'
		});

		await pushPath(token, kept);
		await pushPath(token, deleted);
		await addGracePolicy('', dayGraceSeconds);
		await setRoot(token, {
			name: 'channel',
			targets: [kept.storePath, deleted.storePath]
		});
		// The delete leaves the root's target row behind, so the removal below
		// still releases the vanished hash; no deadline may back it.
		await deletePath(token, deleted.storePathHash);
		await removeRoot(token, 'channel');

		expect(await graceDeadlineRows(DEFAULT_CACHE)).toStrictEqual([
			{ storePathHash: kept.storePathHash, retainUntil: dayAfterStart }
		]);
	});

	it('grants deadlines to every target of a removed root, surviving a sweep', async () => {
		await useTestServer('transition-remove');
		const { token } = await bootstrap();

		const first = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('1'),
			name: 'first'
		});
		const second = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('2'),
			name: 'second'
		});

		await pushPath(token, first);
		await pushPath(token, second);
		// The policy arrives only after publication, so the removal below is the
		// sole source of the deadlines.
		await addGracePolicy('', dayGraceSeconds);
		await setRoot(token, {
			name: 'channel',
			targets: [first.storePath, second.storePath]
		});
		await removeRoot(token, 'channel');
		await runGc();

		expect({
			deadlines: await graceDeadlineRows(DEFAULT_CACHE),
			first: (await narInfoGeneration(first.storePathHash)) !== undefined,
			second: (await narInfoGeneration(second.storePathHash)) !== undefined
		}).toStrictEqual({
			deadlines: [
				{ storePathHash: first.storePathHash, retainUntil: dayAfterStart },
				{ storePathHash: second.storePathHash, retainUntil: dayAfterStart }
			],
			first: true,
			second: true
		});
	});

	it('anchors an expiry transition at the nominal expiry, not the sweep', async () => {
		await useTestServer('transition-expiry');
		const { token } = await bootstrap();
		await addGracePolicy('', dayGraceSeconds);

		const path = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('3'),
			name: 'expiring'
		});

		await pushPath(token, path);
		await setRoot(token, {
			name: 'channel',
			targets: [path.storePath],
			ttlSeconds: 3600
		});

		// The sweep runs an hour after the root's expiry; the deadline must still
		// measure from the expiry itself.
		vi.setSystemTime(new Date('2026-01-01T02:00:00.000Z'));
		await runGc();

		expect({
			deadlines: await graceDeadlineRows(DEFAULT_CACHE),
			path: (await narInfoGeneration(path.storePathHash)) !== undefined,
			graceManaged: await graceManagedMarker(DEFAULT_CACHE)
		}).toStrictEqual({
			deadlines: [
				{
					storePathHash: path.storePathHash,
					retainUntil: '2026-01-02T01:00:00.000Z'
				}
			],
			path: true,
			graceManaged: true
		});
	});

	it('cannot shorten a deadline with a later, earlier-anchored event', async () => {
		await useTestServer('transition-monotonic');
		await bootstrap();

		const hash = storePathHashSchema.parse(repeated('7'));

		await runInDurableObject(currentServer(), (instance) => {
			const service = new RetentionService(instance.context);
			service.extendGraceDeadlines('', [hash], '2026-03-01T00:00:00.000Z');
			service.extendGraceDeadlines('', [hash], '2026-02-01T00:00:00.000Z');
		});

		expect(await graceDeadlineRows(DEFAULT_CACHE)).toStrictEqual([
			{ storePathHash: hash, retainUntil: '2026-03-01T00:00:00.000Z' }
		]);
	});

	it('marks the cache on a zero grace without granting a deadline', async () => {
		await useTestServer('transition-zero');
		const { token } = await bootstrap();
		await addGracePolicy('', 0);

		const path = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('4'),
			name: 'zero'
		});

		await pushPath(token, path);
		await setRoot(token, { name: 'channel', targets: [path.storePath] });
		await removeRoot(token, 'channel');

		expect({
			deadlines: await graceDeadlineRows(DEFAULT_CACHE),
			graceManaged: await graceManagedMarker(DEFAULT_CACHE)
		}).toStrictEqual({ deadlines: [], graceManaged: true });
	});

	it('leaves a cache with no matching policy untouched', async () => {
		await useTestServer('transition-no-policy');
		const { token } = await bootstrap();

		const path = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('5'),
			name: 'unmatched'
		});

		await pushPath(token, path);
		await setRoot(token, { name: 'channel', targets: [path.storePath] });
		await removeRoot(token, 'channel');

		expect({
			deadlines: await graceDeadlineRows(DEFAULT_CACHE),
			graceManaged: await graceManagedMarker(DEFAULT_CACHE)
		}).toStrictEqual({ deadlines: [], graceManaged: false });
	});

	it('resolves the longest matching prefix', async () => {
		await useTestServer('transition-longest-prefix');
		await bootstrap();

		const resolved = await runInDurableObject(currentServer(), (instance) => {
			const service = new RetentionService(instance.context);
			const withoutPolicies = service.resolveGraceSeconds('pr-5');

			service.addGracePolicy({ cachePrefix: '', graceSeconds: 604_800 });
			service.addGracePolicy({ cachePrefix: 'pr-', graceSeconds: 3600 });

			return {
				withoutPolicies,
				prCache: service.resolveGraceSeconds('pr-5'),
				otherCache: service.resolveGraceSeconds('builds')
			};
		});

		expect(resolved).toStrictEqual({
			withoutPolicies: undefined,
			prCache: 3600,
			otherCache: 604_800
		});
	});
});

describe('retention grace at publication', () => {
	beforeEach(resetTestServer);

	const dayGraceSeconds = 86_400;
	const dayAfterStart = '2026-01-02T00:00:00.000Z';

	it('grants the deadline atomically with an immediate publication', async () => {
		await useTestServer('publication-immediate');
		const { token } = await bootstrap();
		await addGracePolicy('', dayGraceSeconds);

		const path = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('a'),
			name: 'published'
		});

		await pushPath(token, path);
		await runGc();

		expect({
			deadlines: await graceDeadlineRows(DEFAULT_CACHE),
			graceManaged: await graceManagedMarker(DEFAULT_CACHE),
			path: (await narInfoGeneration(path.storePathHash)) !== undefined
		}).toStrictEqual({
			deadlines: [
				{ storePathHash: path.storePathHash, retainUntil: dayAfterStart }
			],
			graceManaged: true,
			path: true
		});
	});

	it('grants the deadline to a rooted publication too', async () => {
		await useTestServer('publication-rooted');
		const { token } = await bootstrap();
		await addGracePolicy('', dayGraceSeconds);

		const path = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('b'),
			name: 'rooted'
		});

		await pushPath(token, path);
		await setRoot(token, { name: 'channel', targets: [path.storePath] });

		expect(await graceDeadlineRows(DEFAULT_CACHE)).toStrictEqual([
			{ storePathHash: path.storePathHash, retainUntil: dayAfterStart }
		]);
	});

	it('keeps the captured grace across policy removal on a deferred upload', async () => {
		await useTestServer('publication-deferred');
		await clearBlobStorage();
		const { token } = await bootstrap();
		const policyId = await addGracePolicy('', dayGraceSeconds);

		const nar = await verifiableNar('grace-deferred');
		const metadata = uploadMetadata({
			storePathHash: repeated('c'),
			references: [],
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);

		await putNarBytes(upload.r2Key, nar);
		await markUploadPendingVerification(upload.uploadId);

		const pendingDecision = await runInDurableObject(
			currentServer(),
			(instance) =>
				parseStoredGraceDecision(
					instance.context.db
						.select({
							graceDecisionJson: schema.pendingUploads.graceDecisionJson
						})
						.from(schema.pendingUploads)
						.where(eq(schema.pendingUploads.id, upload.uploadId))
						.get()?.graceDecisionJson
				)
		);
		const beforeVerification = await graceDeadlineRows(DEFAULT_CACHE);

		await removeGracePolicy(policyId);
		await currentServer().runVerification();

		expect({
			pendingDecision,
			beforeVerification,
			afterVerification: await graceDeadlineRows(DEFAULT_CACHE)
		}).toStrictEqual({
			pendingDecision: { plan: false, graceSeconds: dayGraceSeconds },
			beforeVerification: [],
			afterVerification: [
				{ storePathHash: metadata.storePathHash, retainUntil: dayAfterStart }
			]
		});
	});

	// A pending upload negotiated before the grace-decision column existed
	// carries NULL there. Verification must still materialise it, treating the
	// row as though no policy matched, even when a policy now covers the cache.
	it('materialises a pre-decision pending row without granting grace', async () => {
		await useTestServer('publication-null-decision');
		await clearBlobStorage();
		const { token } = await bootstrap();
		await addGracePolicy('', dayGraceSeconds);

		const nar = await verifiableNar('grace-null-decision');
		const metadata = uploadMetadata({
			storePathHash: repeated('h'),
			references: [],
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);

		await putNarBytes(upload.r2Key, nar);
		await markUploadPendingVerification(upload.uploadId);
		await runInDurableObject(currentServer(), (_instance, state) => {
			state.storage.sql.exec(
				'UPDATE pending_upload SET grace_decision_json = NULL WHERE id = ?',
				upload.uploadId
			);
		});
		await currentServer().runVerification();

		expect({
			materialised:
				(await narInfoGeneration(metadata.storePathHash)) !== undefined,
			deadlines: await graceDeadlineRows(DEFAULT_CACHE),
			graceManaged: await graceManagedMarker(DEFAULT_CACHE)
		}).toStrictEqual({
			materialised: true,
			deadlines: [],
			graceManaged: false
		});
	});

	it('grants nothing when verification fails', async () => {
		await useTestServer('publication-mismatch');
		await clearBlobStorage();
		const { token } = await bootstrap();
		await addGracePolicy('', dayGraceSeconds);

		const good = await verifiableNar('grace-good');
		const wrong = await verifiableNar('grace-wrong');
		const metadata = uploadMetadata({
			storePathHash: repeated('d'),
			references: [],
			narHash: good.narHash,
			narSize: good.narSize,
			fileHash: wrong.fileHash,
			fileSize: wrong.narBytes.byteLength
		});
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);

		// Bytes whose checksum matches the declared fileHash but which decompress
		// to a different NAR than the declared hash: a background mismatch.
		await putNarBytes(upload.r2Key, wrong);
		await markUploadPendingVerification(upload.uploadId);
		await currentServer().runVerification();

		expect({
			deadlines: await graceDeadlineRows(DEFAULT_CACHE),
			graceManaged: await graceManagedMarker(DEFAULT_CACHE)
		}).toStrictEqual({ deadlines: [], graceManaged: false });
	});

	it('marks the cache grace-managed at publication on a zero grace', async () => {
		await useTestServer('publication-zero');
		const { token } = await bootstrap();
		await addGracePolicy('', 0);

		const path = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('f'),
			name: 'zero-grace'
		});

		await pushPath(token, path);

		const beforeSweep = {
			deadlines: await graceDeadlineRows(DEFAULT_CACHE),
			graceManaged: await graceManagedMarker(DEFAULT_CACHE)
		};

		await runGc();

		expect({
			...beforeSweep,
			path: await narInfoGeneration(path.storePathHash)
		}).toStrictEqual({
			deadlines: [],
			graceManaged: true,
			path: undefined
		});
	});

	it('leaves a publication with no matching policy unmanaged', async () => {
		await useTestServer('publication-no-policy');
		const { token } = await bootstrap();

		const path = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('g'),
			name: 'unmatched'
		});

		await pushPath(token, path);

		expect({
			deadlines: await graceDeadlineRows(DEFAULT_CACHE),
			graceManaged: await graceManagedMarker(DEFAULT_CACHE)
		}).toStrictEqual({ deadlines: [], graceManaged: false });
	});

	it('applies captured grace when a fresh reservation concedes to a committed winner', async () => {
		await useTestServer('concede-to-winner');
		const { token } = await bootstrap();
		await addGracePolicy('', 3600);

		const nar = await verifiableNar('concede-to-winner');
		const metadata = uploadMetadata({
			storePathHash: repeated('s'),
			name: 'contested',
			references: [],
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});

		// Commit the winner so its canonical blob and its narinfo row both
		// exist, then call concedeToWinner directly for the identical store
		// path: the deterministic shape a losing reservation reaches when
		// committedNarInfoRow now finds the winner. A synthetic upload id and
		// the canonical staging key are safe here, matching how the sibling
		// "defers when no committed winner exists" test in
		// commit-reservation-reclaim.workers.test.ts drives this same method.
		await pushPath(token, metadata, DEFAULT_CACHE, nar);

		const outcome = await runInDurableObject(currentServer(), (instance) =>
			pipelineFor(instance.context).concedeToWinner(
				rootLogger(),
				DEFAULT_CACHE,
				'loser-upload',
				uploadPathNegotiation(metadata),
				narObjectKey(metadata.narHash),
				{ plan: true, graceSeconds: 3600 }
			)
		);

		expect({
			outcome,
			graceManaged: await graceManagedMarker(DEFAULT_CACHE),
			deadlines: await graceDeadlineRows(DEFAULT_CACHE)
		}).toStrictEqual({
			outcome: {
				kind: 'settled',
				response: {
					storePathHash: metadata.storePathHash,
					narHash: metadata.narHash,
					status: 'already-present'
				},
				grace: { retainUntil: '2026-01-01T01:00:00.000Z' }
			},
			graceManaged: true,
			deadlines: [
				{
					storePathHash: metadata.storePathHash,
					retainUntil: '2026-01-01T01:00:00.000Z'
				}
			]
		});
	});

	// The concede destroys the pending row (and its staging object) as its
	// bookkeeping, and the captured decision lives on that row: the grace
	// application must precede the destruction, or an interruption between
	// the two would lose the grant with the row. Faulting the staging delete
	// proves the order — the deadline exists even though the concede failed.
	it('applies the captured grace before the concede destroys the decision', async () => {
		await useTestServer('concede-ordering');
		const { token } = await bootstrap();

		const nar = await verifiableNar('concede-ordering');
		const metadata = uploadMetadata({
			storePathHash: repeated('w'),
			name: 'contested',
			references: [],
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});

		await pushPath(token, metadata, DEFAULT_CACHE, nar);

		const outcome = await runInDurableObject(
			currentServer(),
			async (instance) => {
				instance.context.env = {
					...instance.context.env,
					BLOBS: failingDeleteBucket(instance.context.env.BLOBS)
				};

				// A private, non-canonical staging key so the concede's clean-up
				// issues the faulting delete.
				try {
					await pipelineFor(instance.context).concedeToWinner(
						rootLogger(),
						DEFAULT_CACHE,
						'loser-upload',
						uploadPathNegotiation(metadata),
						'staging/loser-upload',
						{ plan: true, graceSeconds: 3600 }
					);

					return 'settled' as const;
				} catch {
					return 'failed' as const;
				}
			}
		);

		expect({
			outcome,
			deadlines: await graceDeadlineRows(DEFAULT_CACHE)
		}).toStrictEqual({
			outcome: 'failed',
			deadlines: [
				{
					storePathHash: metadata.storePathHash,
					retainUntil: '2026-01-01T01:00:00.000Z'
				}
			]
		});
	});

	// The flush charges the durable edge before applying the captured grace,
	// so an interruption between the two leaves a committed generation whose
	// decision still sits on the pending row. The verify pass that re-claims
	// such a row must reapply the decision before clearing it, not just
	// finish the marker bookkeeping.
	it('reapplies the stored decision when recovery re-claims a committed generation', async () => {
		await useTestServer('grace-recovery');
		await clearBlobStorage();
		const { token } = await bootstrap();
		await addGracePolicy('', dayGraceSeconds);

		const nar = await verifiableNar('grace-recovery');
		const metadata = uploadMetadata({
			storePathHash: repeated('x'),
			references: [],
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);

		await putNarBytes(upload.r2Key, nar);
		await markUploadPendingVerification(upload.uploadId);

		const row = await pendingRowSnapshot(upload.uploadId);
		await currentServer().runVerification();

		// Reconstruct the interruption: the generation is committed and
		// charged, but the captured decision was never applied and the row
		// holding it never cleared.
		await runInDurableObject(currentServer(), (instance) => {
			instance.context.db
				.delete(schema.retentionGrace)
				.where(eq(schema.retentionGrace.cache, DEFAULT_CACHE))
				.run();
			instance.context.db
				.update(schema.caches)
				.set({ graceManaged: false })
				.where(eq(schema.caches.name, DEFAULT_CACHE))
				.run();
			instance.context.db
				.insert(schema.pendingUploads)
				.values({ ...row, verdict: 'pending', claimedAt: undefined })
				.run();
		});

		await currentServer().runVerification();

		expect({
			deadlines: await graceDeadlineRows(DEFAULT_CACHE),
			graceManaged: await graceManagedMarker(DEFAULT_CACHE),
			verdict: await pendingUploadVerdict(upload.uploadId)
		}).toStrictEqual({
			deadlines: [
				{ storePathHash: metadata.storePathHash, retainUntil: dayAfterStart }
			],
			graceManaged: true,
			verdict: undefined
		});
	});

	// A concede reads its winner, awaits an object heal, and only then applies
	// the captured grace, so the row can move inside the window. Settling on
	// the stale read would report a row that no longer holds the path and
	// silently drop the grant; the concede must re-resolve, and a moved row
	// whose new holder has not committed defers to the verify pass.
	it('refuses to settle on a winner that moved during the concede', async () => {
		await useTestServer('concede-moved-winner');
		const { token } = await bootstrap();

		const nar = await verifiableNar('concede-moved-winner');
		const metadata = uploadMetadata({
			storePathHash: repeated('0'),
			name: 'contested',
			references: [],
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});

		await pushPath(token, metadata, DEFAULT_CACHE, nar);

		const hash = storePathHashSchema.parse(metadata.storePathHash);
		const result = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				// The first head probe of the object heal bumps the winner's
				// generation, the shape of a recommit landing inside the
				// concede's await window; the retry that follows sees the row
				// hold still.
				let hasMoved = false;
				const moveWinner = (): void => {
					if (hasMoved) {
						return;
					}

					hasMoved = true;
					instance.context.db
						.update(schema.narInfos)
						.set({ generation: sql`${schema.narInfos.generation} + 1` })
						.where(
							and(
								eq(schema.narInfos.cache, DEFAULT_CACHE),
								eq(schema.narInfos.storePathHash, hash)
							)
						)
						.run();
				};
				const context = new ServerContext(state, {
					...instance.context.env,
					BLOBS: headTappingBucket(instance.context.env.BLOBS, moveWinner)
				});
				const outcome = await pipelineFor(context).concedeToWinner(
					rootLogger(),
					DEFAULT_CACHE,
					'loser-upload',
					uploadPathNegotiation(metadata),
					narObjectKey(metadata.narHash),
					{ plan: true, graceSeconds: 3600 }
				);

				return { outcome, hasMoved };
			}
		);

		// The moved row's new generation has no committed edge, so the re-read
		// finds no committed winner: the concede defers, keeping the upload row
		// (and its captured decision) live for the verify pass, instead of
		// settling on the stale winner with no deadline behind it.
		expect({
			...result,
			deadlines: await graceDeadlineRows(DEFAULT_CACHE)
		}).toStrictEqual({
			outcome: {
				kind: 'deferred',
				storePathHash: metadata.storePathHash,
				narHash: metadata.narHash
			},
			hasMoved: true,
			deadlines: []
		});
	});

	// The concede's re-resolution is bounded: sustained recommit churn would
	// otherwise keep one request re-reading the winner and healing its object
	// indefinitely. Past the cap the upload defers, keeping its row and
	// captured decision for the verify pass.
	it('defers after bounded attempts when the winner keeps moving', async () => {
		await useTestServer('concede-churn');
		const { token } = await bootstrap();

		const nar = await verifiableNar('concede-churn');
		const metadata = uploadMetadata({
			storePathHash: repeated('8'),
			name: 'churned',
			references: [],
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});

		await pushPath(token, metadata, DEFAULT_CACHE, nar);

		const hash = storePathHashSchema.parse(metadata.storePathHash);
		const result = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				// Every object-heal probe bumps the winner again, and an edge is
				// pre-seeded for each future generation so every re-read still
				// finds a committed winner: the shape of sustained recommit
				// churn that never lets the path hold still.
				const database = drizzleD1(instance.context.env.CUPBOARD_DB, {
					schema: d1Schema
				});
				const live = instance.context.db
					.select({
						generation: schema.narInfos.generation,
						narHash: schema.narInfos.narHash
					})
					.from(schema.narInfos)
					.where(
						and(
							eq(schema.narInfos.cache, DEFAULT_CACHE),
							eq(schema.narInfos.storePathHash, hash)
						)
					)
					.get();

				if (live === undefined) {
					throw new Error('the churned path must be committed');
				}

				await database.insert(d1Schema.blobReference).values(
					Array.from({ length: 8 }, (_, index) => ({
						tenant: instance.context.requireTenant(),
						cache: DEFAULT_CACHE,
						storePathHash: hash,
						generation: live.generation + index + 1,
						narHash: live.narHash
					}))
				);

				let bumpCount = 0;
				const churn = (): void => {
					bumpCount += 1;
					instance.context.db
						.update(schema.narInfos)
						.set({ generation: sql`${schema.narInfos.generation} + 1` })
						.where(
							and(
								eq(schema.narInfos.cache, DEFAULT_CACHE),
								eq(schema.narInfos.storePathHash, hash)
							)
						)
						.run();
				};
				const context = new ServerContext(state, {
					...instance.context.env,
					BLOBS: headTappingBucket(instance.context.env.BLOBS, churn)
				});
				const outcome = await pipelineFor(context).concedeToWinner(
					rootLogger(),
					DEFAULT_CACHE,
					'loser-upload',
					uploadPathNegotiation(metadata),
					narObjectKey(metadata.narHash),
					{ plan: true, graceSeconds: 3600 }
				);

				return { outcome, bumpCount };
			}
		);

		expect({
			outcome: result.outcome,
			// One heal probe per attempt, so a bounded loop probes a bounded
			// number of times.
			boundedBumps: result.bumpCount <= 6,
			deadlines: await graceDeadlineRows(DEFAULT_CACHE)
		}).toStrictEqual({
			outcome: {
				kind: 'deferred',
				storePathHash: metadata.storePathHash,
				narHash: metadata.narHash
			},
			boundedBumps: true,
			deadlines: []
		});
	});

	// The recovery short-circuit checks the committed edge over D1, so the
	// local row can move inside that await. Its "already committed" conclusion
	// is then stale: finishing the bookkeeping would clear the upload as a
	// success it never had. The pass must decline the short-circuit and drive
	// the upload to an honest terminal verdict instead.
	it('declines the recovery short-circuit when the row moves during the edge check', async () => {
		await useTestServer('recovery-moved-row');
		await clearBlobStorage();
		const { token } = await bootstrap();
		await addGracePolicy('', dayGraceSeconds);

		const nar = await verifiableNar('recovery-moved-row');
		const metadata = uploadMetadata({
			storePathHash: repeated('6'),
			references: [],
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);

		await putNarBytes(upload.r2Key, nar);
		await markUploadPendingVerification(upload.uploadId);

		const row = await pendingRowSnapshot(upload.uploadId);
		await currentServer().runVerification();

		// Reconstruct the interrupted flush, exactly as the recovery test
		// above does, so the next pass re-claims a committed generation.
		const hash = storePathHashSchema.parse(metadata.storePathHash);
		await runInDurableObject(currentServer(), (instance) => {
			instance.context.db
				.delete(schema.retentionGrace)
				.where(eq(schema.retentionGrace.cache, DEFAULT_CACHE))
				.run();
			instance.context.db
				.insert(schema.pendingUploads)
				.values({ ...row, verdict: 'pending', claimedAt: undefined })
				.run();
		});

		// Drive the pass through a context whose committed-edge read moves the
		// row, the shape of a recommit landing inside the short-circuit's
		// window.
		const hasMoved = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				let hasMoved = false;
				const context = new ServerContext(state, {
					...instance.context.env,
					CUPBOARD_DB: prepareTappingD1(
						instance.context.env.CUPBOARD_DB,
						(query) => query.includes('blob_ref'),
						() => {
							if (hasMoved) {
								return;
							}

							hasMoved = true;
							instance.context.db
								.update(schema.narInfos)
								.set({ generation: sql`${schema.narInfos.generation} + 1` })
								.where(
									and(
										eq(schema.narInfos.cache, DEFAULT_CACHE),
										eq(schema.narInfos.storePathHash, hash)
									)
								)
								.run();
						}
					)
				});

				await verificationFor(context).verifyPendingUploads(rootLogger(), 10);

				return hasMoved;
			}
		);

		// The moved row means the short-circuit's success is stale: the pass
		// declines it and, finding the row superseded by a replacement, settles
		// the upload to an honest terminal verdict in the same pass. No
		// deadline is ever granted against the moved identity.
		expect({
			hasMoved,
			verdict: await pendingUploadVerdict(upload.uploadId),
			deadlines: await graceDeadlineRows(DEFAULT_CACHE)
		}).toStrictEqual({
			hasMoved: true,
			verdict: 'mismatch',
			deadlines: []
		});
	});
});

// An R2 binding whose head probes run the given tap before delegating: a
// deterministic point for a test to interleave a concurrent mutation with the
// code under test.
function headTappingBucket(inner: R2Bucket, onHead: () => void): R2Bucket {
	return {
		head(key) {
			onHead();

			return inner.head(key);
		},
		get: inner.get.bind(inner),
		put: inner.put.bind(inner),
		delete: inner.delete.bind(inner),
		list: inner.list.bind(inner),
		createMultipartUpload: inner.createMultipartUpload.bind(inner),
		resumeMultipartUpload: inner.resumeMultipartUpload.bind(inner)
	};
}

// A D1 binding whose matching prepared queries run the given tap before
// delegating, the same deterministic interleaving point for reads that go to
// the shared database.
function prepareTappingD1(
	inner: D1Database,
	isMatch: (query: string) => boolean,
	onMatch: () => void
): D1Database {
	return {
		prepare(query) {
			if (isMatch(query)) {
				onMatch();
			}

			return inner.prepare(query);
		},
		batch: inner.batch.bind(inner),
		exec: inner.exec.bind(inner),
		withSession: inner.withSession.bind(inner),
		dump: () => Promise.reject(new Error('dump is not supported here'))
	};
}

// The verification service over a live instance's context, as the server
// itself builds it. Failed verifications prune retention targets through the
// roots service; these tests never fail one into a root, so the prune is
// inert.
function verificationFor(context: ServerContext): VerificationService {
	const narInfoObjects = new NarInfoObjectsService(context);
	const attestationCas = new AttestationCasService(context);
	const attestations = new AttestationsService(
		context,
		attestationCas,
		narInfoObjects
	);
	const deletionQueue = new DeletionQueueService(
		context,
		attestationCas,
		attestations,
		narInfoObjects
	);
	const uploadState = new UploadStateService(context);
	const retention = new RetentionService(context);

	return new VerificationService(
		context,
		new CommitPipelineService(
			context,
			new CacheAdminService(context, deletionQueue),
			new SigningKeysService(context),
			uploadState,
			narInfoObjects,
			retention
		),
		deletionQueue,
		narInfoObjects,
		uploadState,
		retention,
		() => {
			// These tests never fail a rooted upload, so nothing is pruned.
		}
	);
}

// An R2 binding whose deletes throw, the shape of a fault in the staging
// clean-up that follows a concede.
function failingDeleteBucket(inner: R2Bucket): R2Bucket {
	return {
		head: inner.head.bind(inner),
		get: inner.get.bind(inner),
		put: inner.put.bind(inner),
		delete: () => Promise.reject(new Error('staging delete fault')),
		list: inner.list.bind(inner),
		createMultipartUpload: inner.createMultipartUpload.bind(inner),
		resumeMultipartUpload: inner.resumeMultipartUpload.bind(inner)
	};
}

async function pendingRowSnapshot(
	uploadId: string
): Promise<typeof schema.pendingUploads.$inferSelect> {
	const row = await runInDurableObject(currentServer(), (instance) =>
		instance.context.db
			.select()
			.from(schema.pendingUploads)
			.where(eq(schema.pendingUploads.id, uploadId))
			.get()
	);

	if (row === undefined) {
		throw new Error(`no pending row for ${uploadId}`);
	}

	return row;
}

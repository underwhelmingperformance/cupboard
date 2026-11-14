import {
	signingKeyGenerationSchema,
	signingKeyIdSchema,
	storePathHashSchema,
	storePathSchema
} from '@cupboard/nix-store/scalars';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import type {
	KeyAbortResponseInput,
	KeyRetireResponseInput,
	KeyRotateResponseInput
} from '@cupboard/protocol/keys';
import {
	keyAbortResponseSchema,
	keyListResponseSchema,
	keyRetireResponseSchema,
	keyRotateResponseSchema
} from '@cupboard/protocol/keys';
import { workersInvocationAllowances } from '@cupboard/protocol/platform';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { eq, sql } from 'drizzle-orm';
import { StatusCodes } from 'http-status-codes';
import {
	beforeEach,
	describe,
	expect,
	it,
	type MockInstance,
	vi
} from 'vitest';
import { z } from 'zod';

import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { SubrequestTimeoutError, WorkersCachePurgeError } from '../errors.ts';
import { narInfoObjectKey } from '../http/http.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	asOneInvocation,
	authorisedFetch,
	bootstrap,
	cacheWriteGrants,
	currentServer,
	deployedSubrequestAllowance,
	type FakeAlarm,
	fakeAlarm,
	fetchNarInfo,
	fetchPath,
	isNarInfoSignatureValid,
	issueServerSignedToken,
	narBytes,
	provisionNamedTenant,
	pushPath,
	resetTestServer,
	resolvedCache,
	syntheticStorePathHash,
	testServerFor,
	uploadMetadata,
	withoutAlarmArming
} from '../test-support.ts';
import { CachedTenantReads } from '../test-worker.ts';

import { maintenanceRetryKey, noProgressRetryMs } from './alarm.ts';
import {
	BackfillPurgePace,
	defaultBackfillPurgeIntervalMs
} from './backfill-purge-pace.ts';
import { CachePurgeQueueService } from './cache-purge-queue-service.ts';
import { CachePurgeRetryPolicy } from './cache-purge-retry.ts';
import { ServerContext, tagsPerPurgeRequest } from './context.ts';
import { withDeadlineBudget } from './deadline.ts';
import { NarInfoObjectsService } from './narinfo-objects-service.ts';
import type { CupboardServer } from './server.ts';
import {
	backfillEntriesPerPass,
	SigningKeysService
} from './signing-keys-service.ts';
import { withSubrequestSlice } from './subrequest-slice.ts';

// The jitter source returns the midpoint, so each purge retry waits three
// quarters of its exponential delay.
const retryPolicy = new CachePurgeRetryPolicy(() => 0.5);

// Store-path hashes are nix-base32, which omits `e`, `o`, `t` and `u`. Returns
// the 32-character hash whose last digits are `index` in base 32.
function nixBase32Hash(index: number): string {
	const alphabet = '0123456789abcdfghijklmnpqrsvwxyz';
	let digits = '';

	for (let rest = index; rest > 0; rest = Math.floor(rest / alphabet.length)) {
		digits = alphabet.charAt(rest % alphabet.length) + digits;
	}

	return digits.padStart(32, '0');
}

// The time between two backfill purge requests in these tests. It differs from
// the production default, so a test that passes only if the default were used
// fails.
const paceIntervalMs = 7000;

// A clock that a test moves. It starts at the frozen test time.
interface TestClock {
	readonly now: () => number;
	set(at: number): void;
}

function testClock(): TestClock {
	let at = Date.now();

	return {
		now: () => at,
		set: (next) => {
			at = next;
		}
	};
}

function pacedService(
	context: ServerContext,
	clock: TestClock
): SigningKeysService {
	return new SigningKeysService(
		context,
		new NarInfoObjectsService(context),
		retryPolicy,
		clock.now,
		new BackfillPurgePace(context, paceIntervalMs)
	);
}

function rateLimitedPurge(): WorkersCachePurgeError {
	return new WorkersCachePurgeError([
		{ code: 1134, message: 'Unable to purge, rate limit reached.' }
	]);
}

interface StagedBackfill {
	readonly instance: CupboardServer;
	readonly storage: DurableObjectStorage;
	readonly context: ServerContext;
	readonly signingKeys: SigningKeysService;
	readonly alarm: FakeAlarm;
	readonly clock: TestClock;
	readonly purge: MockInstance<ServerContext['purgeCacheTags']>;
	readonly publish: MockInstance<NarInfoObjectsService['publishNarInfoObject']>;
}

// Pushes one path, rotates the signing key and stages the backfill, so the
// next backfill pass publishes the page and purges its tags. `body` runs in
// the tenant object with the purge and publication spied on and the alarm
// faked.
async function withStagedBackfill<T>(
	hashCharacter: string,
	body: (staged: StagedBackfill) => Promise<T>,
	intervalMs = paceIntervalMs
): Promise<T> {
	const init = await bootstrap();
	const path = uploadMetadata({
		fileSize: narBytes.byteLength,
		storePathHash: hashCharacter.repeat(32),
		name: 'staged-backfill'
	});
	await withoutAlarmArming(() => pushPath(init.token, path));

	return runInDurableObject(currentServer(), async (instance, state) => {
		const narInfoObjects = new NarInfoObjectsService(instance.context);
		const clock = testClock();
		const signingKeys = new SigningKeysService(
			instance.context,
			narInfoObjects,
			retryPolicy,
			clock.now,
			new BackfillPurgePace(instance.context, intervalMs)
		);
		const alarm = fakeAlarm(state.storage);

		try {
			await signingKeys.rotateKey();
			await asOneInvocation(() => signingKeys.runBackfillOnce());
			alarm.clear();
			const purge = vi.spyOn(instance.context, 'purgeCacheTags');
			const publish = vi.spyOn(narInfoObjects, 'publishNarInfoObject');

			try {
				return await body({
					instance,
					storage: state.storage,
					context: instance.context,
					signingKeys,
					alarm,
					clock,
					purge,
					publish
				});
			} finally {
				purge.mockRestore();
				publish.mockRestore();
			}
		} finally {
			alarm.restore();
		}
	});
}

function tagsOf(count: number): string[] {
	return Array.from(
		{ length: count },
		(_, index) => `narinfo-${String(index)}`
	);
}

// The tags of the page that `pagedBackfill` queues by default.
const pagedTags = tagsOf(150);

// The entries of a backfill continuation row. They have no narinfo rows, so a
// pass publishes nothing and purges every tag.
function pagedEntries(cacheId: number, count = pagedTags.length) {
	return tagsOf(count).map((tag, index) => ({
		cacheId,
		storePathHash: nixBase32Hash(index),
		narInfoGeneration: 1,
		targetGeneration: 2,
		tag
	}));
}

// A tenant context on the Paid plan's allowance, so one pass can afford a page
// of more than 100 entries.
function paidContext(
	instance: CupboardServer,
	state: DurableObjectState
): ServerContext {
	return new ServerContext(state, {
		...instance.context.env,
		CUPBOARD_SUBREQUESTS_PER_INVOCATION: String(
			workersInvocationAllowances.paid.subrequests
		)
	});
}

function insertBackfillRow(
	context: ServerContext,
	clock: TestClock,
	id: string,
	entries: readonly object[],
	createdAfterMs = 0,
	failedAttempts = 0
): void {
	const createdAt = new Date(clock.now() + createdAfterMs);
	const expiresAt = new Date(clock.now() + 3_600_000);

	context.db
		.insert(schema.cachePurgeContinuations)
		.values({
			id,
			kind: 'backfill',
			entriesJson: JSON.stringify(entries),
			createdAt: isoTimestamp(createdAt),
			expiresAt: isoTimestamp(expiresAt),
			failedAttempts
		})
		.run();
}

// Queues one backfill continuation row of `count` entries, 150 by default, more
// than one purge request can list, and returns a backfill service with the
// test clock and the injected interval.
function pagedBackfill(
	instance: CupboardServer,
	state: DurableObjectState,
	clock: TestClock,
	count = pagedTags.length
): { readonly context: ServerContext; readonly service: SigningKeysService } {
	const context = paidContext(instance, state);
	insertBackfillRow(
		context,
		clock,
		'paged',
		pagedEntries(resolvedCache(context).id, count)
	);

	return { context, service: pacedService(context, clock) };
}

function continuationIds(context: ServerContext): { id: string }[] {
	return context.db
		.select({ id: schema.cachePurgeContinuations.id })
		.from(schema.cachePurgeContinuations)
		.all();
}

// A backfill pass that cannot stage reports a stall, and the scheduler records
// a retry deadline for it. Runs the alarm after that deadline.
async function alarmAfterBackfillRetry(): Promise<void> {
	vi.setSystemTime(Date.now() + noProgressRetryMs);
	await runInDurableObject(currentServer(), (instance) => instance.alarm());
}

async function drainKeyBackfill(): Promise<void> {
	for (let pass = 0; pass < 3; pass += 1) {
		await runInDurableObject(currentServer(), (instance) => instance.alarm());
	}
}

async function rotate(
	token: string
): Promise<{ readonly status: number; readonly body: KeyRotateResponseInput }> {
	const response = await authorisedFetch('/keys/rotate', token, {
		method: 'POST'
	});

	return {
		status: response.status,
		body: keyRotateResponseSchema.parse(await response.json())
	};
}

async function retire(
	token: string
): Promise<{ readonly status: number; readonly body: KeyRetireResponseInput }> {
	const response = await authorisedFetch(`/keys/retire/active`, token, {
		method: 'POST'
	});

	return {
		status: response.status,
		body: keyRetireResponseSchema.parse(await response.json())
	};
}

async function abort(
	token: string,
	id: string
): Promise<{ readonly status: number; readonly body: KeyAbortResponseInput }> {
	const response = await authorisedFetch(`/keys/abort/${id}`, token, {
		method: 'POST'
	});

	return {
		status: response.status,
		body: keyAbortResponseSchema.parse(await response.json())
	};
}

async function publishedKeys(): Promise<string[]> {
	const response = await fetchPath('/pubkey');
	const body = await response.text();

	return body.trim().split('\n');
}

describe('signing key rotation', () => {
	beforeEach(resetTestServer);

	it('dual-signs new narinfos and backfills existing narinfos', async () => {
		const init = await bootstrap();
		const before = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: 'a'.repeat(32),
			name: 'before'
		});
		await pushPath(init.token, before);

		const rotation = await rotate(init.token);
		const { rotated } = rotation.body;
		await drainKeyBackfill();

		const after = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: 'b'.repeat(32),
			name: 'after'
		});
		await pushPath(init.token, after);

		const oldKey = init.publicKey;
		const newKey = rotated.key.publicKey;
		const beforeNarInfo = await fetchNarInfo(before.storePathHash);
		const afterNarInfo = await fetchNarInfo(after.storePathHash);
		const published = await publishedKeys();
		const listedResponse = await authorisedFetch('/keys', init.token);
		const listed = keyListResponseSchema.parse(await listedResponse.json());
		const signatureGenerations = await runInDurableObject(
			currentServer(),
			(instance) =>
				instance.context.db
					.select({
						storePathHash: schema.narInfos.storePathHash,
						signatureGeneration: schema.narInfos.signatureGeneration
					})
					.from(schema.narInfos)
					.all()
		);
		const rotatedStatus = listed.keys.find(
			(entry) => entry.key.id === rotated.key.id
		);
		if (
			rotatedStatus?.state !== 'signing' ||
			rotatedStatus.backfill?.state !== 'complete'
		) {
			throw new Error('Expected the rotated key backfill to be complete');
		}
		const backfill = rotatedStatus.backfill;

		expect({
			rotationStatus: rotation.status,
			rotatedStage: rotated.state,
			backfill,
			signatureGenerations,
			publishedKeys: published.toSorted(byCodeUnit),
			before: {
				sigs: beforeNarInfo.sigs.length,
				verifiesUnderOld: await isNarInfoSignatureValid(beforeNarInfo, oldKey),
				verifiesUnderNew: await isNarInfoSignatureValid(beforeNarInfo, newKey)
			},
			after: {
				sigs: afterNarInfo.sigs.length,
				verifiesUnderOld: await isNarInfoSignatureValid(afterNarInfo, oldKey),
				verifiesUnderNew: await isNarInfoSignatureValid(afterNarInfo, newKey)
			}
		}).toStrictEqual({
			rotationStatus: StatusCodes.OK,
			rotatedStage: 'signing',
			backfill: {
				state: 'complete',
				startedAt: backfill.startedAt,
				completedAt: backfill.completedAt,
				resigned: 1
			},
			signatureGenerations: [
				{
					storePathHash: before.storePathHash,
					signatureGeneration: 2
				},
				{
					storePathHash: after.storePathHash,
					signatureGeneration: 2
				}
			],
			publishedKeys: [oldKey, newKey].toSorted(byCodeUnit),
			before: { sigs: 2, verifiesUnderOld: true, verifiesUnderNew: true },
			after: { sigs: 2, verifiesUnderOld: true, verifiesUnderNew: true }
		});
	});

	it('retires a key through publication then absent, idempotently', async () => {
		const init = await bootstrap();
		const rotation = await rotate(init.token);
		const { rotated } = rotation.body;
		await drainKeyBackfill();

		const first = await retire(init.token);
		const second = await retire(init.token);
		const third = await retire(init.token);

		const path = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: 'c'.repeat(32),
			name: 'after-retire'
		});
		await pushPath(init.token, path);
		const narInfo = await fetchNarInfo(path.storePathHash);
		const published = await publishedKeys();

		expect({
			rotationStatus: rotation.status,
			retireStatuses: [first.status, second.status, third.status],
			states: [first.body.state, second.body.state, third.body.state],
			publishedKeys: published,
			sigs: narInfo.sigs.length,
			verifiesUnderRetired: await isNarInfoSignatureValid(
				narInfo,
				init.publicKey
			),
			verifiesUnderSurvivor: await isNarInfoSignatureValid(
				narInfo,
				rotated.key.publicKey
			)
		}).toStrictEqual({
			rotationStatus: StatusCodes.OK,
			retireStatuses: [StatusCodes.OK, StatusCodes.OK, StatusCodes.OK],
			states: ['published-only', 'absent', 'absent'],
			publishedKeys: [rotated.key.publicKey],
			sigs: 1,
			verifiesUnderRetired: false,
			verifiesUnderSurvivor: true
		});
	});

	it('reconciles signature coverage for a legacy rotated key set', async () => {
		const init = await bootstrap();
		const before = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: 'd'.repeat(32),
			name: 'legacy-before'
		});
		await pushPath(init.token, before);
		const oldNarInfo = await fetchNarInfo(before.storePathHash);
		const rotation = await rotate(init.token);
		await drainKeyBackfill();
		await retire(init.token);

		await runInDurableObject(currentServer(), async (instance) => {
			const row = instance.context.db
				.select()
				.from(schema.narInfos)
				.where(eq(schema.narInfos.storePathHash, before.storePathHash))
				.get();

			expect(row).toBeDefined();

			if (row === undefined) {
				return;
			}

			instance.context.db.transaction((tx) => {
				tx.update(schema.signingKeys)
					.set({ generation: signingKeyGenerationSchema.parse(0) })
					.run();
				tx.delete(schema.signingKeyBackfills).run();
				tx.delete(schema.cachePurgeContinuations).run();
				tx.update(schema.narInfos)
					.set({
						sigsJson: JSON.stringify(oldNarInfo.sigs),
						signatureGeneration: signingKeyGenerationSchema.parse(0),
						pendingSignatureGeneration: sql`null`
					})
					.where(eq(schema.narInfos.storePathHash, before.storePathHash))
					.run();
			});
			await env.BLOBS.put(
				narInfoObjectKey(fixtureTenant, before.storePathHash, {
					kind: 'default'
				}),
				oldNarInfo.render(),
				{
					customMetadata: {
						generation: String(row.generation),
						narHash: row.narHash,
						signatureGeneration: '0'
					}
				}
			);

			// The first backfill claimed a purge request, so the next claim is one
			// interval later.
			const service = new SigningKeysService(
				instance.context,
				new NarInfoObjectsService(instance.context),
				undefined,
				() => Date.now() + defaultBackfillPurgeIntervalMs
			);
			await service.keyList();
			await asOneInvocation(() => service.runBackfillOnce());
			await asOneInvocation(() => service.runBackfillOnce());
			await asOneInvocation(() => service.runBackfillOnce());
		});

		const repaired = await fetchNarInfo(before.storePathHash);

		expect({
			old: await isNarInfoSignatureValid(repaired, init.publicKey),
			incoming: await isNarInfoSignatureValid(
				repaired,
				rotation.body.rotated.key.publicKey
			)
		}).toStrictEqual({ old: true, incoming: true });
	});

	it('aborts an incoming key whose backfill cannot complete', async () => {
		const init = await bootstrap();
		const before = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: 'g'.repeat(32),
			name: 'abort-before'
		});
		await pushPath(init.token, before);
		await runInDurableObject(currentServer(), (instance) => {
			instance.context.db
				.update(schema.narInfos)
				.set({ referencesJson: '{' })
				.where(eq(schema.narInfos.storePathHash, before.storePathHash))
				.run();
		});

		const rotation = await rotate(init.token);
		await runInDurableObject(currentServer(), (instance) => instance.alarm());
		const aborted = await abort(init.token, rotation.body.rotated.key.id);
		const listedResponse = await authorisedFetch('/keys', init.token);
		const listed = keyListResponseSchema.parse(await listedResponse.json());
		// The abort removed the backfill, so the alarm after the stalled pass's
		// retry deadline finds no backfill to run.
		await alarmAfterBackfillRetry();

		expect({
			status: aborted.status,
			body: aborted.body,
			keys: listed.keys.map((entry) => entry.key.id)
		}).toStrictEqual({
			status: StatusCodes.OK,
			body: { id: rotation.body.rotated.key.id, state: 'absent' },
			keys: ['active']
		});
	});

	it('reports a stall when the backfill cannot be staged', async () => {
		const init = await bootstrap();
		const before = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: 'h'.repeat(32),
			name: 'stage-failure'
		});
		await withoutAlarmArming(() => pushPath(init.token, before));
		const failedAt = Date.now();

		const result = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				instance.context.db
					.update(schema.narInfos)
					.set({ referencesJson: '{' })
					.where(eq(schema.narInfos.storePathHash, before.storePathHash))
					.run();
				const signingKeys = new SigningKeysService(
					instance.context,
					new NarInfoObjectsService(instance.context),
					retryPolicy
				);
				const alarm = fakeAlarm(state.storage);

				try {
					await signingKeys.rotateKey();
					alarm.clear();
					const outcome = await asOneInvocation(() =>
						signingKeys.runBackfillOnce()
					);

					return { outcome, alarm: alarm.scheduled() };
				} finally {
					alarm.restore();
				}
			}
		);

		expect(result).toStrictEqual({
			outcome: 'stalled',
			alarm: failedAt + noProgressRetryMs
		});
	});

	it('re-arms unfinished work when status is queried', async () => {
		const init = await bootstrap();
		const before = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: 'f'.repeat(32),
			name: 'alarm-before'
		});
		await pushPath(init.token, before);
		const setReferences = (referencesJson: string) =>
			runInDurableObject(currentServer(), (instance) => {
				instance.context.db
					.update(schema.narInfos)
					.set({ referencesJson })
					.where(eq(schema.narInfos.storePathHash, before.storePathHash))
					.run();
			});
		await setReferences('{');
		const rotation = await rotate(init.token);

		const alarm = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				await state.storage.deleteAlarm();
				const service = new SigningKeysService(
					instance.context,
					new NarInfoObjectsService(instance.context)
				);
				await service.keyList();

				return state.storage.getAlarm();
			}
		);

		expect({
			rotation: rotation.status,
			alarmArmed: alarm !== null
		}).toStrictEqual({
			rotation: StatusCodes.OK,
			alarmArmed: true
		});

		// The alarm's backfill pass stalled on the corrupt references. Repair
		// them and run the alarm after the pass's retry deadline, so the pass can
		// stage the backfill.
		await setReferences('[]');
		await alarmAfterBackfillRetry();
	});

	it('keeps an expired batch pending until its cache purge succeeds', async () => {
		const init = await bootstrap();
		const before = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: 'j'.repeat(32),
			name: 'expired-purge'
		});
		// The commit arms an alarm for attestation inheritance. The test spies on
		// the alarm, so an alarm handler running beside it would arm its own.
		await withoutAlarmArming(() => pushPath(init.token, before));

		const result = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				await state.storage.deleteAlarm();
				let scheduledAlarmAt = Infinity;
				const getAlarm = vi
					.spyOn(state.storage, 'getAlarm')
					.mockImplementation(() => Promise.resolve(scheduledAlarmAt));
				const setAlarm = vi
					.spyOn(state.storage, 'setAlarm')
					.mockImplementation((scheduledTime) => {
						scheduledAlarmAt =
							typeof scheduledTime === 'number'
								? scheduledTime
								: scheduledTime.getTime();

						return Promise.resolve();
					});
				const service = new SigningKeysService(
					instance.context,
					new NarInfoObjectsService(instance.context),
					retryPolicy
				);

				try {
					const rotation = await service.rotateKey();
					await service.runBackfillOnce();
					scheduledAlarmAt = Infinity;
					instance.context.db
						.update(schema.cachePurgeContinuations)
						.set({ expiresAt: isoTimestamp(new Date(0)) })
						.run();
					const purge = vi
						.spyOn(instance.context, 'purgeCacheTags')
						.mockRejectedValueOnce(new Error('purge unavailable'));

					try {
						await asOneInvocation(() => service.runBackfillOnce());

						const continuations = instance.context.db
							.select()
							.from(schema.cachePurgeContinuations)
							.all();
						const retryAlarmAt = scheduledAlarmAt;
						const keys = await service.keyList();

						return {
							rotation,
							continuations,
							keys,
							purgeCalls: purge.mock.calls,
							retryAlarmAt
						};
					} finally {
						purge.mockRestore();
					}
				} finally {
					getAlarm.mockRestore();
					setAlarm.mockRestore();
				}
			}
		);
		const incoming = result.keys.keys.find(
			(entry) => entry.key.id === result.rotation.rotated.key.id
		);

		if (
			incoming?.state !== 'signing' ||
			incoming.backfill?.state !== 'retrying'
		) {
			throw new Error('Expected the incoming key backfill to be retrying');
		}

		expect({
			continuations: result.continuations.map((continuation) => ({
				kind: continuation.kind,
				lastError: continuation.lastError
			})),
			backfill: incoming.backfill,
			purgeCalls: result.purgeCalls,
			retryAlarmAt: result.retryAlarmAt
		}).toStrictEqual({
			continuations: [{ kind: 'backfill', lastError: 'purge unavailable' }],
			backfill: {
				state: 'retrying',
				startedAt: incoming.backfill.startedAt,
				updatedAt: incoming.backfill.updatedAt,
				resigned: 0,
				remaining: 1,
				failure: {
					operation: 'cache-purge',
					failedAt: incoming.backfill.failure.failedAt,
					message: 'purge unavailable'
				}
			},
			purgeCalls: [[[`narinfo:v1:default:${before.storePathHash}`]]],
			retryAlarmAt: Date.now() + 9000
		});
	});

	// The second pass simulates an alarm caused by other work. It must neither
	// publish the page nor purge its tags again before the retry time.
	it.each([
		{
			failure: 'a rate-limit refusal',
			error: rateLimitedPurge(),
			row: { nextAttemptAt: undefined, failedAttempts: 0 },
			delayMs: 45_000
		},
		{
			failure: 'a timeout',
			error: new SubrequestTimeoutError('cache.purge'),
			row: { nextAttemptAt: 9000, failedAttempts: 1 },
			delayMs: 9000
		}
	])(
		'waits for the retry time after a backfill purge fails with $failure',
		async ({ error, row, delayMs }) => {
			const failedAt = Date.now();

			const result = await withStagedBackfill(
				'm',
				async ({ context, signingKeys, alarm, purge, publish }) => {
					purge.mockRejectedValue(error);
					const outcomes = [
						await asOneInvocation(() => signingKeys.runBackfillOnce()),
						await asOneInvocation(() => signingKeys.runBackfillOnce())
					];

					return {
						outcomes,
						purgeCalls: purge.mock.calls.length,
						publications: publish.mock.calls.length,
						continuations: context.db
							.select()
							.from(schema.cachePurgeContinuations)
							.all()
							.map((continuation) => ({
								kind: continuation.kind,
								lastAttemptAt: continuation.lastAttemptAt,
								nextAttemptAt: continuation.nextAttemptAt ?? undefined,
								failedAttempts: continuation.failedAttempts
							})),
						workAt: await signingKeys.backfillWorkAt(Date.now()),
						alarm: alarm.scheduled()
					};
				}
			);

			expect(result).toStrictEqual({
				outcomes: ['stalled', 'stalled'],
				purgeCalls: 1,
				publications: 1,
				continuations: [
					{
						kind: 'backfill',
						lastAttemptAt: isoTimestamp(new Date(failedAt)),
						nextAttemptAt:
							row.nextAttemptAt === undefined
								? undefined
								: isoTimestamp(new Date(failedAt + row.nextAttemptAt)),
						failedAttempts: row.failedAttempts
					}
				],
				workAt: failedAt + delayMs,
				alarm: failedAt + delayMs
			});
		}
	);

	// The scheduler asks the pass when it next has work. While the purge waits,
	// the alarm runs no backfill and arms no alarm for it before the retry time.
	it('leaves a waiting backfill out of the alarm', async () => {
		const retryAt = Date.now() + 45_000;

		const result = await withStagedBackfill(
			's',
			async ({ instance, storage, signingKeys, alarm, purge, publish }) => {
				purge.mockRejectedValueOnce(rateLimitedPurge());
				await asOneInvocation(() => signingKeys.runBackfillOnce());
				const beforeAlarm = {
					purgeCalls: purge.mock.calls.length,
					publications: publish.mock.calls.length
				};
				alarm.clear();
				await instance.alarm();

				return {
					beforeAlarm,
					afterAlarm: {
						purgeCalls: purge.mock.calls.length,
						publications: publish.mock.calls.length,
						backfillRetry: await storage.get(
							maintenanceRetryKey('signing-key-backfill')
						),
						alarm: alarm.scheduled()
					}
				};
			}
		);

		expect(result).toStrictEqual({
			beforeAlarm: { purgeCalls: 1, publications: 1 },
			afterAlarm: {
				purgeCalls: 1,
				publications: 1,
				backfillRetry: undefined,
				alarm: retryAt
			}
		});
	});

	// Cloudflare's purge rate limit applies to the whole account, so a refusal
	// on one path must also delay the other.
	it('delays the backfill purge after the queue is rate limited', async () => {
		const retryAt = Date.now() + 45_000;

		const result = await withStagedBackfill(
			'n',
			async ({ context, signingKeys, alarm, clock, purge, publish }) => {
				const queue = new CachePurgeQueueService(context, retryPolicy);
				await queue.enqueueNarInfos(resolvedCache(context), [
					syntheticStorePathHash(1)
				]);
				purge.mockRejectedValueOnce(rateLimitedPurge());
				await queue.runOnce();
				alarm.clear();
				const waiting = await asOneInvocation(() =>
					signingKeys.runBackfillOnce()
				);
				const whileWaiting = {
					outcome: waiting,
					purgeCalls: purge.mock.calls.length,
					publications: publish.mock.calls.length,
					workAt: await signingKeys.backfillWorkAt(Date.now()),
					alarm: alarm.scheduled()
				};
				clock.set(retryAt);
				purge.mockResolvedValue(undefined);
				const due = await asOneInvocation(() => signingKeys.runBackfillOnce());

				return {
					whileWaiting,
					afterWaiting: {
						outcome: due,
						purgeCalls: purge.mock.calls.length,
						publications: publish.mock.calls.length
					}
				};
			}
		);

		expect(result).toStrictEqual({
			whileWaiting: {
				outcome: 'stalled',
				purgeCalls: 1,
				publications: 0,
				workAt: retryAt,
				alarm: retryAt
			},
			afterWaiting: { outcome: 'progressed', purgeCalls: 2, publications: 1 }
		});
	});

	it('delays the queued purge after the backfill is rate limited', async () => {
		const retryAt = Date.now() + 45_000;

		const result = await withStagedBackfill(
			'q',
			async ({ context, signingKeys, alarm, purge }) => {
				const queue = new CachePurgeQueueService(context, retryPolicy);
				purge.mockRejectedValueOnce(rateLimitedPurge());
				await asOneInvocation(() => signingKeys.runBackfillOnce());
				await queue.enqueueNarInfos(resolvedCache(context), [
					syntheticStorePathHash(2)
				]);
				alarm.clear();
				await queue.runOnce();
				const whileWaiting = {
					purgeCalls: purge.mock.calls.length,
					alarm: alarm.scheduled()
				};
				vi.setSystemTime(retryAt);
				purge.mockResolvedValue(undefined);
				await queue.runOnce();

				return {
					whileWaiting,
					afterWaiting: { purgeCalls: purge.mock.calls.length }
				};
			}
		);

		expect(result).toStrictEqual({
			whileWaiting: { purgeCalls: 1, alarm: retryAt },
			afterWaiting: { purgeCalls: 2 }
		});
	});

	it('retries a backfill when publishing its R2 object stalls', async () => {
		const init = await bootstrap();
		const before = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: 'k'.repeat(32),
			name: 'stalled-publish'
		});
		// The commit arms an alarm for attestation inheritance. The test spies on
		// the alarm, so an alarm handler running beside it would arm its own.
		await withoutAlarmArming(() => pushPath(init.token, before));

		const result = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				await state.storage.deleteAlarm();
				let scheduledAlarmAt = Infinity;
				const getAlarm = vi
					.spyOn(state.storage, 'getAlarm')
					.mockImplementation(() => Promise.resolve(scheduledAlarmAt));
				const setAlarm = vi
					.spyOn(state.storage, 'setAlarm')
					.mockImplementation((scheduledTime) => {
						scheduledAlarmAt =
							typeof scheduledTime === 'number'
								? scheduledTime
								: scheduledTime.getTime();

						return Promise.resolve();
					});
				const service = new SigningKeysService(
					instance.context,
					new NarInfoObjectsService(instance.context),
					retryPolicy
				);

				try {
					const rotation = await service.rotateKey();
					await service.runBackfillOnce();
					const existingAlarmAt = Date.now() + 10_000;
					scheduledAlarmAt = existingAlarmAt;
					const publicationStarted = Promise.withResolvers<undefined>();
					const put = vi.spyOn(env.BLOBS, 'put').mockImplementation(() => {
						publicationStarted.resolve(undefined);

						return Promise.race([]);
					});

					try {
						const pending = asOneInvocation(() =>
							withDeadlineBudget(1000, () => service.runBackfillOnce())
						);
						await publicationStarted.promise;
						let didTimeout = false;

						try {
							await pending;
						} catch (error) {
							didTimeout = error instanceof SubrequestTimeoutError;
						}

						const continuations = instance.context.db
							.select()
							.from(schema.cachePurgeContinuations)
							.all();
						const retryAlarmAt = scheduledAlarmAt;
						const keys = await service.keyList();

						return {
							rotation,
							continuations,
							keys,
							didTimeout,
							existingAlarmAt,
							failedAt: Date.now(),
							publicationStarted: put.mock.calls.length > 0,
							retryAlarmAt
						};
					} finally {
						put.mockRestore();
					}
				} finally {
					getAlarm.mockRestore();
					setAlarm.mockRestore();
				}
			}
		);
		const incoming = result.keys.keys.find(
			(entry) => entry.key.id === result.rotation.rotated.key.id
		);

		if (
			incoming?.state !== 'signing' ||
			incoming.backfill?.state !== 'retrying'
		) {
			throw new Error('Expected the incoming key backfill to be retrying');
		}

		expect({
			continuations: result.continuations.map((continuation) => ({
				kind: continuation.kind,
				lastError: continuation.lastError
			})),
			backfill: incoming.backfill,
			didTimeout: result.didTimeout,
			publicationStarted: result.publicationStarted,
			retryAlarmAt: result.retryAlarmAt
		}).toStrictEqual({
			continuations: [
				{ kind: 'backfill', lastError: 'A storage subrequest timed out' }
			],
			backfill: {
				state: 'retrying',
				startedAt: incoming.backfill.startedAt,
				updatedAt: incoming.backfill.updatedAt,
				resigned: 0,
				remaining: 1,
				failure: {
					operation: 'resigning',
					failedAt: incoming.backfill.failure.failedAt,
					message: 'A storage subrequest timed out'
				}
			},
			didTimeout: true,
			publicationStarted: true,
			// The failed publication arms the alarm for the row's retry time, which is
			// earlier than the alarm that was already armed.
			retryAlarmAt: result.failedAt + 9000
		});
	});

	it('uses covering indexes for backfill and purge continuation scans', async () => {
		await bootstrap();
		const planRowSchema = z.object({ detail: z.string() });
		const plans = await runInDurableObject(currentServer(), (instance) => ({
			backfill: instance.context.db.all(
				sql`EXPLAIN QUERY PLAN SELECT * FROM narinfo WHERE signature_generation < ${2} AND pending_signature_generation IS NULL ORDER BY signature_generation, cache_id, store_path_hash LIMIT ${32}`
			),
			continuation: instance.context.db.all(
				sql`EXPLAIN QUERY PLAN SELECT * FROM cache_purge_continuation WHERE kind = ${'backfill'} ORDER BY priority, created_at LIMIT ${1}`
			)
		}));
		const parsed = z
			.strictObject({
				backfill: z.array(planRowSchema),
				continuation: z.array(planRowSchema)
			})
			.parse(plans);

		expect({
			backfillUsesIndex: parsed.backfill.some((row) =>
				row.detail.includes('narinfo_pending_signature_generation_idx')
			),
			backfillSorts: parsed.backfill.some((row) =>
				row.detail.includes('USE TEMP B-TREE')
			),
			continuationUsesIndex: parsed.continuation.some((row) =>
				row.detail.includes('cache_purge_kind_priority_created_at_idx')
			),
			continuationSorts: parsed.continuation.some((row) =>
				row.detail.includes('USE TEMP B-TREE')
			)
		}).toStrictEqual({
			backfillUsesIndex: true,
			backfillSorts: false,
			continuationUsesIndex: true,
			continuationSorts: false
		});
	});

	// A continuation row is written once and only shrinks, so a pass has to
	// accept whatever length the staging wrote. This row is larger than any page
	// a pass can afford.
	it('publishes a continuation longer than one pass can settle', async () => {
		await bootstrap();
		const queued =
			backfillEntriesPerPass(await deployedSubrequestAllowance()) + 1;
		const now = isoTimestamp(new Date());
		const expiresAt = isoTimestamp(new Date(Date.now() + 3_600_000));
		const remaining = await runInDurableObject(
			currentServer(),
			async (instance) => {
				const cacheId = resolvedCache(instance.context).id;
				const entries = Array.from({ length: queued }, (_, index) => ({
					cacheId,
					storePathHash: nixBase32Hash(index),
					narInfoGeneration: 1,
					targetGeneration: 2,
					tag: `narinfo-${String(index)}`
				}));

				instance.context.db
					.insert(schema.cachePurgeContinuations)
					.values({
						id: 'oversized',
						kind: 'backfill',
						entriesJson: JSON.stringify(entries),
						createdAt: now,
						expiresAt
					})
					.run();
				const service = new SigningKeysService(
					instance.context,
					new NarInfoObjectsService(instance.context)
				);
				await asOneInvocation(() => service.runBackfillOnce());

				const row = instance.context.db
					.select({ entriesJson: schema.cachePurgeContinuations.entriesJson })
					.from(schema.cachePurgeContinuations)
					.where(eq(schema.cachePurgeContinuations.id, 'oversized'))
					.get();

				return row === undefined
					? undefined
					: z.array(z.unknown()).parse(JSON.parse(row.entriesJson)).length;
			}
		);

		expect({ remaining }).toStrictEqual({
			remaining: queued - tagsPerPurgeRequest
		});
	});

	// A row of 150 entries needs two purge requests, one in each of two passes.
	// The first request succeeds. The second is refused, and the retry sends
	// only the second request's tags again.
	it('resends only the refused purge request of a backfill page', async () => {
		await bootstrap();
		const clock = testClock();
		const start = clock.now();

		const result = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				const { service } = pagedBackfill(instance, state, clock);
				const alarm = fakeAlarm(state.storage);
				const purge = vi
					.spyOn(CachedTenantReads.prototype, 'purgeTags')
					.mockResolvedValueOnce({ success: true, errors: [] })
					.mockResolvedValueOnce({
						success: false,
						errors: [
							{ code: 1134, message: 'Unable to purge, rate limit reached.' }
						]
					})
					.mockResolvedValue({ success: true, errors: [] });

				try {
					await service.runBackfillOnce();
					clock.set(start + paceIntervalMs);
					await service.runBackfillOnce();
					clock.set(start + paceIntervalMs + 45_000);
					await service.runBackfillOnce();

					return {
						purgeCalls: purge.mock.calls.map(([tags]) => tags),
						continuations: continuationIds(instance.context)
					};
				} finally {
					purge.mockRestore();
					alarm.restore();
				}
			}
		);

		expect(result).toStrictEqual({
			purgeCalls: [
				pagedTags.slice(0, 100),
				pagedTags.slice(100),
				pagedTags.slice(100)
			],
			continuations: []
		});
	});

	// With the Paid plan's allowance, a pass can afford 1,979 entries, which is
	// 20 purge requests and nearly the account's whole burst of 25. A pass
	// sends one request of 100 tags, and the next request waits for the
	// interval, in this tenant and in every other tenant.
	it('sends one purge request of at most 100 tags in a backfill pass', async () => {
		await bootstrap();
		const clock = testClock();
		const start = clock.now();

		const result = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				const { context, service } = pagedBackfill(
					instance,
					state,
					clock,
					2000
				);
				const alarm = fakeAlarm(state.storage);
				const purge = vi
					.spyOn(CachedTenantReads.prototype, 'purgeTags')
					.mockResolvedValue({ success: true, errors: [] });

				try {
					const first = await service.runBackfillOnce();
					const second = await service.runBackfillOnce();
					const whileWaiting = {
						purgeCalls: purge.mock.calls.length,
						workAt: await service.backfillWorkAt(start),
						alarm: alarm.scheduled()
					};
					clock.set(start + paceIntervalMs);
					const third = await service.runBackfillOnce();
					const row = context.db
						.select({ entriesJson: schema.cachePurgeContinuations.entriesJson })
						.from(schema.cachePurgeContinuations)
						.get();

					return {
						outcomes: [first, second, third],
						whileWaiting,
						purgeCalls: purge.mock.calls.map(([tags]) => tags),
						remaining: z
							.array(z.object({ tag: z.string() }))
							.parse(JSON.parse(row?.entriesJson ?? '[]'))
							.map((entry) => entry.tag)
					};
				} finally {
					purge.mockRestore();
					alarm.restore();
				}
			}
		);

		expect(result).toStrictEqual({
			outcomes: ['progressed', 'progressed', 'progressed'],
			whileWaiting: {
				purgeCalls: 1,
				workAt: start + paceIntervalMs,
				alarm: start + paceIntervalMs
			},
			purgeCalls: [tagsOf(2000).slice(0, 100), tagsOf(2000).slice(100, 200)],
			remaining: tagsOf(2000).slice(200)
		});
	});

	// The purge request is a subrequest too. The page leaves one subrequest of the
	// invocation's slice for it, so the request does not depend on the slice's
	// safety reserve. The slice below has 21 subrequests: one for the claim, one
	// for the request and 19 for publication, which is three entries at five
	// subrequests each.
	it('leaves a subrequest for the purge request when it sizes the page', async () => {
		await bootstrap();
		const clock = testClock();

		const purgeCalls = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				const { service } = pagedBackfill(instance, state, clock);
				const alarm = fakeAlarm(state.storage);
				const purge = vi
					.spyOn(CachedTenantReads.prototype, 'purgeTags')
					.mockResolvedValue({ success: true, errors: [] });

				try {
					await withSubrequestSlice(() => service.runBackfillOnce(), {
						subrequests: 21,
						reserve: 0
					});

					return purge.mock.calls.map(([tags]) => tags);
				} finally {
					purge.mockRestore();
					alarm.restore();
				}
			}
		);

		expect(purgeCalls).toStrictEqual([pagedTags.slice(0, 3)]);
	});

	// Staging writes rows of at most 32 entries. A request takes the entries of
	// several rows up to its limit of 100 tags, and the pass records each row's
	// entries separately.
	it('fills a purge request with the entries of several backfill rows', async () => {
		await bootstrap();
		const clock = testClock();

		const result = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				const context = paidContext(instance, state);
				const cacheId = resolvedCache(context).id;
				const entries = pagedEntries(cacheId, 114);
				insertBackfillRow(context, clock, 'a', entries.slice(0, 32));
				insertBackfillRow(context, clock, 'b', entries.slice(32, 64), 1);
				insertBackfillRow(context, clock, 'c', entries.slice(64), 2);
				const alarm = fakeAlarm(state.storage);
				const purge = vi
					.spyOn(CachedTenantReads.prototype, 'purgeTags')
					.mockResolvedValue({ success: true, errors: [] });

				try {
					const outcome = await pacedService(context, clock).runBackfillOnce();

					return {
						outcome,
						purgeCalls: purge.mock.calls.map(([tags]) => tags),
						rows: context.db
							.select({
								id: schema.cachePurgeContinuations.id,
								entriesJson: schema.cachePurgeContinuations.entriesJson
							})
							.from(schema.cachePurgeContinuations)
							.all()
							.map((row) => ({
								id: row.id,
								tags: z
									.array(z.object({ tag: z.string() }))
									.parse(JSON.parse(row.entriesJson))
									.map((entry) => entry.tag)
							}))
					};
				} finally {
					purge.mockRestore();
					alarm.restore();
				}
			}
		);

		expect(result).toStrictEqual({
			outcome: 'progressed',
			purgeCalls: [tagsOf(114).slice(0, 100)],
			rows: [{ id: 'c', tags: tagsOf(114).slice(100) }]
		});
	});

	// The purge bucket belongs to the whole account, so the pace belongs to the
	// deployment. Two tenants run their passes at the same instants. At each
	// instant, one claim succeeds and the other tenant waits, so the two
	// together send one request for each interval.
	it('lets one backfill purge request through in each interval across tenants', async () => {
		await bootstrap();
		await provisionNamedTenant('pace-second');
		const clock = testClock();
		const start = clock.now();
		const tenants = [currentServer(), testServerFor('pace-second')];

		for (const tenant of tenants) {
			await runInDurableObject(tenant, (instance, state) => {
				const context = paidContext(instance, state);
				insertBackfillRow(
					context,
					clock,
					'paged',
					pagedEntries(resolvedCache(context).id, 250)
				);
			});
		}

		const purge = vi
			.spyOn(CachedTenantReads.prototype, 'purgeTags')
			.mockResolvedValue({ success: true, errors: [] });

		try {
			const perInterval: number[] = [];

			for (const interval of [0, 1, 2]) {
				clock.set(start + interval * paceIntervalMs);
				const before = purge.mock.calls.length;

				for (const tenant of tenants) {
					await runInDurableObject(tenant, async (instance, state) => {
						const alarm = fakeAlarm(state.storage);

						try {
							await pacedService(
								paidContext(instance, state),
								clock
							).runBackfillOnce();
						} finally {
							alarm.restore();
						}
					});
				}

				perInterval.push(purge.mock.calls.length - before);
			}

			expect(perInterval).toStrictEqual([1, 1, 1]);
		} finally {
			purge.mockRestore();
		}
	});

	// The pace belongs to the backfill only. An explicit deletion queues urgent
	// purges, and the queue sends them while the backfill waits.
	it('sends an urgent purge while the backfill waits', async () => {
		await bootstrap();
		const clock = testClock();
		const start = clock.now();

		const result = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				const { context, service } = pagedBackfill(instance, state, clock, 250);
				const alarm = fakeAlarm(state.storage);
				const purge = vi
					.spyOn(CachedTenantReads.prototype, 'purgeTags')
					.mockResolvedValue({ success: true, errors: [] });

				try {
					await service.runBackfillOnce();
					const queue = new CachePurgeQueueService(context, retryPolicy);
					await queue.enqueueNarInfos(
						resolvedCache(context),
						[syntheticStorePathHash(3)],
						'urgent'
					);
					await queue.runOnce();

					return {
						purgeCalls: purge.mock.calls.length,
						backfillWorkAt: await service.backfillWorkAt(start)
					};
				} finally {
					purge.mockRestore();
					alarm.restore();
				}
			}
		);

		expect(result).toStrictEqual({
			purgeCalls: 2,
			backfillWorkAt: start + paceIntervalMs
		});
	});

	// The claim is the first D1 call of a pass. A D1 failure there is a failed
	// attempt of the backfill, like a failed publication: the row records the
	// error, the key's backfill reports a retry, and the alarm is armed.
	it('records a failed claim as a retry of the backfill', async () => {
		const start = Date.now();

		const result = await withStagedBackfill(
			'p',
			async ({ context, signingKeys, alarm, purge, publish }) => {
				const claim = vi
					.spyOn(BackfillPurgePace.prototype, 'claim')
					.mockRejectedValue(new Error('D1 overloaded'));

				try {
					const outcome = await asOneInvocation(() =>
						signingKeys.runBackfillOnce()
					);

					return {
						outcome,
						purgeCalls: purge.mock.calls.length,
						publications: publish.mock.calls.length,
						continuations: context.db
							.select()
							.from(schema.cachePurgeContinuations)
							.all()
							.map((row) => ({
								kind: row.kind,
								lastError: row.lastError,
								failedAttempts: row.failedAttempts
							})),
						backfills: context.db
							.select()
							.from(schema.signingKeyBackfills)
							.all()
							.map((row) => ({
								state: row.state,
								failureOperation: row.failureOperation,
								failureMessage: row.failureMessage
							})),
						alarm: alarm.scheduled()
					};
				} finally {
					claim.mockRestore();
				}
			}
		);

		expect(result).toStrictEqual({
			outcome: 'stalled',
			purgeCalls: 0,
			publications: 0,
			continuations: [
				{ kind: 'backfill', lastError: 'D1 overloaded', failedAttempts: 0 }
			],
			backfills: [
				{
					state: 'retrying',
					failureOperation: 'cache-purge',
					failureMessage: 'D1 overloaded'
				}
			],
			alarm: start + noProgressRetryMs
		});
	});

	// A pass claims its slot before it publishes, so a publication that fails on
	// every attempt would use a slot of the whole deployment each time. After a
	// failed publication, the row waits for its own retry time, which grows with
	// each failure, and the tenant claims nothing until then.
	it('backs off a backfill whose publication keeps failing', async () => {
		const start = Date.now();

		const result = await withStagedBackfill(
			'r',
			async ({ context, signingKeys, publish, clock }) => {
				publish.mockRejectedValue(new Error('R2 unavailable'));
				const steps: unknown[] = [];

				for (const offset of [0, 8000, 9000]) {
					clock.set(start + offset);
					const outcome = await asOneInvocation(() =>
						signingKeys.runBackfillOnce()
					);
					const paceRows = await context.d1
						.select({ nextAt: d1Schema.backfillPurgePace.nextAt })
						.from(d1Schema.backfillPurgePace);
					steps.push({
						offset,
						outcome,
						publications: publish.mock.calls.length,
						rows: context.db
							.select()
							.from(schema.cachePurgeContinuations)
							.all()
							.map((row) => ({
								failedAttempts: row.failedAttempts,
								nextAttemptAt: row.nextAttemptAt
							})),
						claimedUntil: paceRows.map((row) => row.nextAt)
					});
				}

				return steps;
			}
		);

		expect(result).toStrictEqual([
			{
				offset: 0,
				outcome: 'stalled',
				publications: 1,
				rows: [
					{
						failedAttempts: 1,
						nextAttemptAt: isoTimestamp(new Date(start + 9000))
					}
				],
				claimedUntil: [start + paceIntervalMs]
			},
			{
				offset: 8000,
				outcome: 'stalled',
				publications: 1,
				rows: [
					{
						failedAttempts: 1,
						nextAttemptAt: isoTimestamp(new Date(start + 9000))
					}
				],
				claimedUntil: [start + paceIntervalMs]
			},
			{
				offset: 9000,
				outcome: 'stalled',
				publications: 2,
				rows: [
					{
						failedAttempts: 2,
						nextAttemptAt: isoTimestamp(new Date(start + 9000 + 18_000))
					}
				],
				claimedUntil: [start + 9000 + paceIntervalMs]
			}
		]);
	});

	// After a failed purge, the backfill waits for the later of its retry time
	// and the end of the pace interval. A timeout retries after 9 seconds.
	it.each([
		{ intervalMs: 3000, waitMs: 9000 },
		{ intervalMs: 20_000, waitMs: 20_000 }
	])(
		'waits for the later of the retry time and a $intervalMs ms interval',
		async ({ intervalMs, waitMs }) => {
			const start = Date.now();

			const workAt = await withStagedBackfill(
				'v',
				async ({ signingKeys, purge }) => {
					purge.mockRejectedValue(new SubrequestTimeoutError('cache.purge'));
					await asOneInvocation(() => signingKeys.runBackfillOnce());

					return signingKeys.backfillWorkAt(start);
				},
				intervalMs
			);

			expect(workAt).toBe(start + waitMs);
		}
	);

	// A row with a recorded failure count joins no other row's request. A head
	// with a failure count is purged alone, and a failed row behind a healthy
	// head stays out of the head's request.
	it.each([
		{
			failed: 'the head row',
			purged: [0, 1, 2],
			remaining: ['b', 'c']
		},
		{
			failed: 'the second row',
			purged: [0, 1, 2, 6, 7, 8],
			remaining: ['b']
		}
	])(
		'keeps $failed out of a merged purge request',
		async ({ failed, purged, remaining }) => {
			await bootstrap();
			const clock = testClock();

			const result = await runInDurableObject(
				currentServer(),
				async (instance, state) => {
					const context = paidContext(instance, state);
					const entries = pagedEntries(resolvedCache(context).id, 9);
					const failures = failed === 'the head row' ? [1, 0, 0] : [0, 1, 0];

					for (const [index, id] of ['a', 'b', 'c'].entries()) {
						insertBackfillRow(
							context,
							clock,
							id,
							entries.slice(index * 3, index * 3 + 3),
							index,
							failures.at(index)
						);
					}

					const alarm = fakeAlarm(state.storage);
					const purge = vi
						.spyOn(CachedTenantReads.prototype, 'purgeTags')
						.mockResolvedValue({ success: true, errors: [] });

					try {
						await pacedService(context, clock).runBackfillOnce();

						return {
							purgeCalls: purge.mock.calls.map(([tags]) => tags),
							remaining: continuationIds(context).map((row) => row.id)
						};
					} finally {
						purge.mockRestore();
						alarm.restore();
					}
				}
			);

			expect(result).toStrictEqual({
				purgeCalls: [purged.map((index) => `narinfo-${String(index)}`)],
				remaining
			});
		}
	);

	// Staging adds rows until four are queued, which is enough to fill the next
	// request of 100 tags, and no more. It stamps the rows with the injected
	// clock.
	it('stages four rows of 32 entries for the next request and no more', async () => {
		const init = await bootstrap();
		const path = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: 'a'.repeat(32),
			name: 'staging-limit'
		});
		await withoutAlarmArming(() => pushPath(init.token, path));
		const clock = testClock();
		const stagedAt = clock.now() + 5000;

		const result = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				const alarm = fakeAlarm(state.storage);
				const service = pacedService(instance.context, clock);
				await service.rotateKey();
				const base = instance.context.db.select().from(schema.narInfos).get();

				if (base === undefined) {
					throw new Error('The pushed narinfo row is missing');
				}

				for (let index = 1; index < 200; index += 1) {
					const storePathHash = storePathHashSchema.parse(nixBase32Hash(index));
					instance.context.db
						.insert(schema.narInfos)
						.values({
							...base,
							storePathHash,
							storePath: storePathSchema.parse(
								`/nix/store/${storePathHash}-staging-limit`
							)
						})
						.run();
				}

				clock.set(stagedAt);

				try {
					const outcome = await service.runBackfillOnce();

					return {
						outcome,
						rows: instance.context.db
							.select()
							.from(schema.cachePurgeContinuations)
							.all()
							.map((row) => ({
								kind: row.kind,
								entries: z.array(z.unknown()).parse(JSON.parse(row.entriesJson))
									.length,
								createdAt: row.createdAt
							})),
						pending: instance.context.db
							.select({ hash: schema.narInfos.storePathHash })
							.from(schema.narInfos)
							.where(sql`pending_signature_generation IS NOT NULL`)
							.all().length
					};
				} finally {
					alarm.restore();
				}
			}
		);

		expect(result).toStrictEqual({
			outcome: 'progressed',
			rows: Array.from({ length: 4 }, () => ({
				kind: 'backfill',
				entries: 32,
				createdAt: isoTimestamp(new Date(stagedAt))
			})),
			pending: 128
		});
	});

	// `abortKeyRotation` runs during the purge request of the first 100 entries
	// of a row of 150. It deletes the rotation's continuation rows, clears the
	// narinfo's pending generation and deletes the backfill row, so recording the
	// request changes neither row. A later pass, after the pace interval, must
	// send no request for the other 50 entries.
	it('purges nothing more for a rotation that is aborted', async () => {
		const init = await bootstrap();
		const path = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: 'k'.repeat(32),
			name: 'aborted-backfill'
		});
		await withoutAlarmArming(() => pushPath(init.token, path));
		const clock = testClock();

		const result = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				const alarm = fakeAlarm(state.storage);
				const { context, service } = pagedBackfill(instance, state, clock);
				const rotation = await service.rotateKey();
				const keyId = signingKeyIdSchema.parse(rotation.rotated.key.id);
				const { generation } = z
					.object({ generation: signingKeyGenerationSchema })
					.parse(
						context.db
							.select({ generation: schema.signingKeyBackfills.generation })
							.from(schema.signingKeyBackfills)
							.where(eq(schema.signingKeyBackfills.keyId, keyId))
							.get()
					);
				const narInfo = context.db
					.update(schema.narInfos)
					.set({ pendingSignatureGeneration: generation })
					.where(eq(schema.narInfos.storePathHash, path.storePathHash))
					.returning({
						cacheId: schema.narInfos.cacheId,
						generation: schema.narInfos.generation
					})
					.get();
				context.db
					.update(schema.cachePurgeContinuations)
					.set({
						signingKeyId: keyId,
						entriesJson: JSON.stringify([
							{
								cacheId: narInfo.cacheId,
								storePathHash: path.storePathHash,
								narInfoGeneration: narInfo.generation,
								targetGeneration: generation,
								tag: pagedTags[0]
							},
							...pagedEntries(narInfo.cacheId).slice(1)
						])
					})
					.where(eq(schema.cachePurgeContinuations.id, 'paged'))
					.run();
				const purge = vi
					.spyOn(context, 'purgeCacheTags')
					.mockImplementationOnce(async () => {
						await service.abortKeyRotation(keyId);
					})
					.mockResolvedValue(undefined);

				try {
					const outcome = await service.runBackfillOnce();
					clock.set(clock.now() + paceIntervalMs);
					const later = await service.runBackfillOnce();

					return {
						outcome,
						later,
						purgeCalls: purge.mock.calls.map(([tags]) => tags),
						continuations: continuationIds(instance.context),
						narInfo: context.db
							.select({
								signatureGeneration: schema.narInfos.signatureGeneration,
								pendingSignatureGeneration:
									schema.narInfos.pendingSignatureGeneration
							})
							.from(schema.narInfos)
							.where(eq(schema.narInfos.storePathHash, path.storePathHash))
							.all()
							.map((row) => ({
								signatureGeneration: row.signatureGeneration,
								pendingSignatureGeneration:
									row.pendingSignatureGeneration ?? undefined
							})),
						backfills: context.db
							.select({ keyId: schema.signingKeyBackfills.keyId })
							.from(schema.signingKeyBackfills)
							.all()
					};
				} finally {
					purge.mockRestore();
					alarm.restore();
				}
			}
		);

		expect(result).toStrictEqual({
			outcome: 'progressed',
			later: 'progressed',
			purgeCalls: [pagedTags.slice(0, 100)],
			continuations: [],
			narInfo: [
				{ signatureGeneration: 1, pendingSignatureGeneration: undefined }
			],
			backfills: []
		});
	});

	it('refuses to retire the only signing key', async () => {
		const init = await bootstrap();

		const response = await authorisedFetch('/keys/retire/active', init.token, {
			method: 'POST'
		});

		expect(response.status).toBe(StatusCodes.CONFLICT);
	});

	it('reports a missing signing key sequence as stored-state corruption', async () => {
		const init = await bootstrap();
		await runInDurableObject(currentServer(), (instance) => {
			instance.context.db.delete(schema.signingKeySequence).run();
		});

		const response = await authorisedFetch('/keys/rotate', init.token, {
			method: 'POST'
		});
		const body = z
			.strictObject({
				defined: z.boolean(),
				code: z.string(),
				status: z.number(),
				message: z.string()
			})
			.parse(await response.json());

		expect({
			status: response.status,
			body
		}).toStrictEqual({
			status: StatusCodes.INTERNAL_SERVER_ERROR,
			body: {
				defined: false,
				code: 'INTERNAL_SERVER_ERROR',
				status: StatusCodes.INTERNAL_SERVER_ERROR,
				message: 'Stored signing key sequence is missing'
			}
		});
	});

	it('rejects rotation, retirement and abort without admin scope', async () => {
		await bootstrap();
		const writeToken = await issueServerSignedToken(cacheWriteGrants());

		const rotateResponse = await authorisedFetch('/keys/rotate', writeToken, {
			method: 'POST'
		});
		const retireResponse = await authorisedFetch(
			'/keys/retire/active',
			writeToken,
			{ method: 'POST' }
		);
		const abortResponse = await authorisedFetch(
			'/keys/abort/active',
			writeToken,
			{
				method: 'POST'
			}
		);

		expect({
			rotate: rotateResponse.status,
			retire: retireResponse.status,
			abort: abortResponse.status
		}).toStrictEqual({
			rotate: StatusCodes.FORBIDDEN,
			retire: StatusCodes.FORBIDDEN,
			abort: StatusCodes.FORBIDDEN
		});
	});
});

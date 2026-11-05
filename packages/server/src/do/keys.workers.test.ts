import { signingKeyGenerationSchema } from '@cupboard/nix-store/scalars';
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
	pushPath,
	resetTestServer,
	resolvedCache,
	syntheticStorePathHash,
	uploadMetadata,
	withoutAlarmArming
} from '../test-support.ts';

import { maintenanceRetryKey, noProgressRetryMs } from './alarm.ts';
import { CachePurgeQueueService } from './cache-purge-queue-service.ts';
import { CachePurgeRetryPolicy } from './cache-purge-retry.ts';
import type { ServerContext } from './context.ts';
import { withDeadlineBudget } from './deadline.ts';
import { NarInfoObjectsService } from './narinfo-objects-service.ts';
import type { CupboardServer } from './server.ts';
import {
	backfillEntriesPerPass,
	SigningKeysService
} from './signing-keys-service.ts';

// The jitter source returns the midpoint, so each purge retry waits three
// quarters of its exponential delay.
const retryPolicy = new CachePurgeRetryPolicy(() => 0.5);

// Store-path hashes are nix-base32, which omits `e`, `o`, `t` and `u`.
function nixBase32Pair(index: number): string {
	const alphabet = '0123456789abcdfghijklmnpqrsvwxyz';

	return (
		alphabet.charAt(Math.floor(index / alphabet.length)) +
		alphabet.charAt(index % alphabet.length)
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
	readonly purge: MockInstance<ServerContext['purgeCacheTags']>;
	readonly publish: MockInstance<NarInfoObjectsService['publishNarInfoObject']>;
}

// Pushes one path, rotates the signing key and stages the backfill, so the
// next backfill pass publishes the page and purges its tags. `body` runs in
// the tenant object with the purge and publication spied on and the alarm
// faked.
async function withStagedBackfill<T>(
	hashCharacter: string,
	body: (staged: StagedBackfill) => Promise<T>
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
		const signingKeys = new SigningKeysService(
			instance.context,
			narInfoObjects,
			retryPolicy
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

			const service = new SigningKeysService(
				instance.context,
				new NarInfoObjectsService(instance.context)
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
			async ({ context, signingKeys, alarm, purge, publish }) => {
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
				vi.setSystemTime(retryAt);
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
					new NarInfoObjectsService(instance.context)
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
			retryAlarmAt: result.existingAlarmAt
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
				sql`EXPLAIN QUERY PLAN SELECT * FROM cache_purge_continuation WHERE kind = ${'backfill'} ORDER BY created_at LIMIT ${1}`
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
				row.detail.includes('cache_purge_kind_created_at_idx')
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
					storePathHash: `${'0'.repeat(30)}${nixBase32Pair(index)}`,
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
			remaining:
				queued - backfillEntriesPerPass(await deployedSubrequestAllowance())
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

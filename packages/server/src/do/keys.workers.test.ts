import { signingKeyGenerationSchema } from '@cupboard/nix-store/scalars';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import type {
	KeyAbortResponse,
	KeyRetireResponse,
	KeyRotateResponse
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
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import * as schema from '../db/schema.ts';
import { narInfoObjectKey } from '../http/http.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	authorisedFetch,
	bootstrap,
	cacheWriteGrants,
	currentServer,
	fetchNarInfo,
	fetchPath,
	isNarInfoSignatureValid,
	issueServerSignedToken,
	narBytes,
	pushPath,
	resetTestServer,
	uploadMetadata
} from '../test-support.ts';

import { withDeadlineBudget } from './deadline.ts';
import { NarInfoObjectsService } from './narinfo-objects-service.ts';
import { SigningKeysService } from './signing-keys-service.ts';

async function drainKeyBackfill(): Promise<void> {
	for (let pass = 0; pass < 3; pass += 1) {
		await runInDurableObject(currentServer(), (instance) => instance.alarm());
	}
}

async function rotate(
	token: string
): Promise<{ readonly status: number; readonly body: KeyRotateResponse }> {
	const response = await authorisedFetch('/keys/rotate', token, {
		method: 'POST'
	});

	return {
		status: response.status,
		body: keyRotateResponseSchema.parse(await response.json())
	};
}

async function retire(
	token: string,
	id: string
): Promise<{ readonly status: number; readonly body: KeyRetireResponse }> {
	const response = await authorisedFetch(`/keys/retire/${id}`, token, {
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
): Promise<{ readonly status: number; readonly body: KeyAbortResponse }> {
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

		const first = await retire(init.token, 'active');
		const second = await retire(init.token, 'active');
		const third = await retire(init.token, 'active');

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
		await retire(init.token, 'active');

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
				narInfoObjectKey(fixtureTenant, before.storePathHash),
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
			await service.runBackfillOnce();
			await service.runBackfillOnce();
			await service.runBackfillOnce();
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

	it('re-arms unfinished work when status is queried', async () => {
		const init = await bootstrap();
		const before = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: 'f'.repeat(32),
			name: 'alarm-before'
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
	});

	it('keeps an expired batch pending until its cache purge succeeds', async () => {
		const init = await bootstrap();
		const before = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: 'j'.repeat(32),
			name: 'expired-purge'
		});
		await pushPath(init.token, before);

		const result = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				await state.storage.deleteAlarm();
				const setAlarm = vi
					.spyOn(state.storage, 'setAlarm')
					.mockResolvedValue(undefined);
				const service = new SigningKeysService(
					instance.context,
					new NarInfoObjectsService(instance.context)
				);

				try {
					const rotation = await service.rotateKey();
					await service.runBackfillOnce();
					setAlarm.mockClear();
					instance.context.db
						.update(schema.cachePurgeContinuations)
						.set({ expiresAt: isoTimestamp(new Date(0)) })
						.run();
					const purge = vi
						.spyOn(instance.context, 'purgeCacheTags')
						.mockRejectedValueOnce(new Error('purge unavailable'));

					try {
						await service.runBackfillOnce();

						const continuations = instance.context.db
							.select()
							.from(schema.cachePurgeContinuations)
							.all();
						const retryAlarmCalls = setAlarm.mock.calls.length;
						const keys = await service.keyList();

						return {
							rotation,
							continuations,
							keys,
							purgeCalls: purge.mock.calls,
							alarmRearmed: retryAlarmCalls === 1
						};
					} finally {
						purge.mockRestore();
					}
				} finally {
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
			alarmRearmed: result.alarmRearmed
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
			purgeCalls: [[[`narinfo:v1:_default:${before.storePathHash}`]]],
			alarmRearmed: true
		});
	});

	it('retries a backfill when publishing its R2 object stalls', async () => {
		const init = await bootstrap();
		const before = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: 'k'.repeat(32),
			name: 'stalled-publish'
		});
		await pushPath(init.token, before);

		const result = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				await state.storage.deleteAlarm();
				const setAlarm = vi
					.spyOn(state.storage, 'setAlarm')
					.mockResolvedValue(undefined);
				const service = new SigningKeysService(
					instance.context,
					new NarInfoObjectsService(instance.context)
				);

				try {
					const rotation = await service.rotateKey();
					await service.runBackfillOnce();
					setAlarm.mockClear();

					const publicationStarted = Promise.withResolvers<undefined>();
					const put = vi.spyOn(env.BLOBS, 'put').mockImplementation(() => {
						publicationStarted.resolve(undefined);

						return Promise.race([]);
					});

					try {
						const pending = withDeadlineBudget(1000, () =>
							service.runBackfillOnce()
						);
						await publicationStarted.promise;
						await pending;

						const continuations = instance.context.db
							.select()
							.from(schema.cachePurgeContinuations)
							.all();
						const retryAlarmCalls = setAlarm.mock.calls.length;
						const keys = await service.keyList();

						return {
							rotation,
							continuations,
							keys,
							publicationStarted: put.mock.calls.length > 0,
							alarmRearmed: retryAlarmCalls === 1
						};
					} finally {
						put.mockRestore();
					}
				} finally {
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
			publicationStarted: result.publicationStarted,
			alarmRearmed: result.alarmRearmed
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
			publicationStarted: true,
			alarmRearmed: true
		});
	});

	it('uses covering indexes for backfill and purge continuation scans', async () => {
		await bootstrap();
		const planRowSchema = z.object({ detail: z.string() });
		const plans = await runInDurableObject(currentServer(), (instance) => ({
			backfill: instance.context.db.all(
				sql`EXPLAIN QUERY PLAN SELECT * FROM narinfo WHERE signature_generation < ${2} AND pending_signature_generation IS NULL ORDER BY signature_generation, cache, store_path_hash LIMIT ${32}`
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

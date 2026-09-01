import { rootLogger } from '@cupboard/logger';
import {
	narInfoGenerationSchema,
	type NixSha256HashString,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { beforeEach, describe, expect, it } from 'vitest';

import { cacheIdentityColumns } from '../db/cache.ts';
import { currentCacheGeneration } from '../db/cache-generation.ts';
import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import {
	commitPath,
	currentNarObjectKey,
	currentServer,
	drivenDirectly,
	expectSingleCommitDecision,
	flakyD1,
	initialise,
	negotiateUploads,
	resetTestServer,
	resolvedCache,
	seedReservedNarInfo,
	uploadMetadata,
	verifiableNar
} from '../test-support.ts';

import { CommitPipelineService } from './commit-pipeline-service.ts';
import { ServerContext } from './context.ts';
import { NarInfoObjectsService } from './narinfo-objects-service.ts';
import { RetentionService } from './retention-service.ts';
import { SigningKeysService } from './signing-keys-service.ts';
import { UploadStateService } from './upload-state-service.ts';

describe('while checking whether a narinfo is committed', () => {
	beforeEach(resetTestServer);

	it('returns no committed row when its generation changes during the edge lookup', async () => {
		const token = await initialise();
		const nar = await verifiableNar('committed-row-moved');
		const metadata = uploadMetadata({
			name: 'moved',
			storePathHash: 'm'.repeat(32),
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength,
			narSize: nar.narSize
		});

		await commitPath(token, metadata, nar);

		const result = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				let hasMoved = false;
				const context = new ServerContext(state, {
					...instance.context.env,
					CUPBOARD_DB: flakyD1(instance.context.env.CUPBOARD_DB, {
						failures: 0,
						matches: (query) => query.includes('blob_ref'),
						onMatch: () => {
							if (hasMoved) {
								return;
							}

							hasMoved = true;
							const row = instance.context.db
								.select({ generation: schema.narInfos.generation })
								.from(schema.narInfos)
								.where(
									eq(schema.narInfos.storePathHash, metadata.storePathHash)
								)
								.get();

							if (row === undefined) {
								throw new Error('committed narinfo row is missing');
							}

							instance.context.db
								.update(schema.narInfos)
								.set({
									generation: narInfoGenerationSchema.parse(row.generation + 1)
								})
								.where(
									eq(schema.narInfos.storePathHash, metadata.storePathHash)
								)
								.run();
						}
					})
				});
				const row = await new NarInfoObjectsService(
					context
				).committedNarInfoRow(
					resolvedCache(context),
					storePathHashSchema.parse(metadata.storePathHash)
				);

				return { hasMoved, row };
			}
		);

		expect(result).toStrictEqual({ hasMoved: true, row: undefined });
	});
});

function pipelineFor(context: ServerContext): CommitPipelineService {
	const narInfoObjects = new NarInfoObjectsService(context);

	return drivenDirectly(
		new CommitPipelineService(
			context,
			new SigningKeysService(context, narInfoObjects),
			new UploadStateService(context),
			narInfoObjects,
			new RetentionService(context)
		)
	);
}

describe('when a commit retry finds an abandoned reservation', () => {
	beforeEach(resetTestServer);

	it('reclaims the reservation and commits without deferring', async () => {
		const token = await initialise();
		const nar = await verifiableNar('reservation-reclaim');
		const first = uploadMetadata({
			name: 'first',
			storePathHash: 'a'.repeat(32),
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength,
			narSize: nar.narSize
		});

		await commitPath(token, first, nar);

		const retried = uploadMetadata({
			name: 'retried',
			storePathHash: 'b'.repeat(32),
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength,
			narSize: nar.narSize
		});
		const doomed = expectSingleCommitDecision(
			await negotiateUploads(token, [retried]),
			retried
		);

		await runInDurableObject(currentServer(), async (instance) => {
			const pipeline = pipelineFor(instance.context);
			const cache = resolvedCache(instance.context);
			const realD1 = instance.context.d1;

			Object.defineProperty(instance.context, 'd1', {
				configurable: true,
				value: {
					select: realD1.select.bind(realD1),
					update: realD1.update.bind(realD1),
					delete: realD1.delete.bind(realD1),
					insert: realD1.insert.bind(realD1),
					batch: () => Promise.reject(new Error('simulated charge outage'))
				}
			});

			let didFail = false;

			try {
				await pipeline.commit(rootLogger(), cache, doomed.uploadId);
			} catch {
				didFail = true;
			}

			Object.defineProperty(instance.context, 'd1', {
				configurable: true,
				value: realD1
			});

			expect(didFail).toBe(true);

			instance.context.db
				.delete(schema.pendingUploads)
				.where(eq(schema.pendingUploads.id, doomed.uploadId))
				.run();
		});

		const fresh = expectSingleCommitDecision(
			await negotiateUploads(token, [retried]),
			retried
		);
		const outcome = await runInDurableObject(
			currentServer(),
			async (instance) =>
				pipelineFor(instance.context).commit(
					rootLogger(),
					resolvedCache(instance.context),
					fresh.uploadId
				)
		);

		expect(outcome).toStrictEqual({
			kind: 'settled',
			response: {
				storePathHash: retried.storePathHash,
				narHash: retried.narHash,
				status: 'committed'
			}
		});
	});
});

describe('when a commit resumes its existing reservation', () => {
	beforeEach(resetTestServer);

	it('materialises the generation already reserved by the same commit', async () => {
		const token = await initialise();
		const nar = await verifiableNar('mine-outcome');

		const first = uploadMetadata({
			name: 'first',
			storePathHash: 'a'.repeat(32),
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength,
			narSize: nar.narSize
		});

		await commitPath(token, first, nar);

		const second = uploadMetadata({
			name: 'second',
			storePathHash: 'b'.repeat(32),
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength,
			narSize: nar.narSize
		});
		const reuse = expectSingleCommitDecision(
			await negotiateUploads(token, [second]),
			second
		);

		await seedReservedNarInfo(second);

		const outcome = await runInDurableObject(
			currentServer(),
			async (instance) =>
				pipelineFor(instance.context).commit(
					rootLogger(),
					resolvedCache(instance.context),
					reuse.uploadId
				)
		);

		expect(outcome).toStrictEqual({
			kind: 'settled',
			response: {
				storePathHash: second.storePathHash,
				narHash: second.narHash,
				status: 'committed'
			}
		});
	});
});

describe('when another commit holds the reservation', () => {
	beforeEach(resetTestServer);

	it('defers while the winning reservation has no committed edge', async () => {
		const token = await initialise();
		const nar = await verifiableNar('concede-no-winner');

		const first = uploadMetadata({
			name: 'first',
			storePathHash: 'a'.repeat(32),
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength,
			narSize: nar.narSize
		});

		await commitPath(token, first, nar);

		const second = uploadMetadata({
			name: 'second',
			storePathHash: 'b'.repeat(32),
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength,
			narSize: nar.narSize
		});
		const reuse = expectSingleCommitDecision(
			await negotiateUploads(token, [second]),
			second
		);

		// Call `concedeToWinner` directly with the reuse upload's metadata and the
		// current physical object key. No D1 `blobReference` edge exists for the
		// second path yet, so `committedNarInfoRow` returns undefined and the call
		// must return `deferred`, not `already-present`.
		const outcome = await runInDurableObject(
			currentServer(),
			async (instance) =>
				pipelineFor(instance.context).concedeToWinner(
					rootLogger(),
					resolvedCache(instance.context),
					reuse.uploadId,
					second,
					await currentNarObjectKey(second.narHash)
				)
		);

		expect(outcome).toStrictEqual({
			kind: 'deferred',
			storePathHash: second.storePathHash,
			narHash: second.narHash
		});
	});
});

async function seedEdge(
	generation: number,
	narHash: NixSha256HashString
): Promise<void> {
	await runInDurableObject(currentServer(), async (instance) => {
		const database = drizzleD1(instance.context.env.CUPBOARD_DB, {
			schema: d1Schema
		});
		const tenant = instance.context.requireTenant();
		const cache = { kind: 'default' } as const;

		await database.insert(d1Schema.blobReference).values({
			tenant,
			...cacheIdentityColumns(cache),
			storePathHash: storePathHashSchema.parse('r4'.repeat(16)),
			generation: narInfoGenerationSchema.parse(generation),
			narHash,
			cacheGeneration: currentCacheGeneration(tenant, cache)
		});
	});
}

describe('when reclaiming a row after failed verification', () => {
	beforeEach(resetTestServer);

	it.each([
		{
			name: 'preserves a current row with a matching committed edge',
			liveGeneration: 7,
			edgeGeneration: 7,
			outcome: 'committed-current',
			survivingGeneration: 7,
			graceSurvives: true
		},
		{
			name: 'deletes a current row with no committed edge',
			liveGeneration: 7,
			edgeGeneration: undefined,
			outcome: 'reclaimed',
			survivingGeneration: undefined,
			graceSurvives: false
		},
		{
			name: 'preserves a replacement row despite an edge for the old generation',
			liveGeneration: 8,
			edgeGeneration: 7,
			outcome: 'superseded',
			survivingGeneration: 8,
			graceSurvives: true
		}
	] as const)(
		'$name',
		async ({
			liveGeneration,
			edgeGeneration,
			outcome,
			survivingGeneration,
			graceSurvives
		}) => {
			await initialise();

			const metadata = uploadMetadata({
				fileSize: 128,
				storePathHash: 'r4'.repeat(16),
				name: 'reclaimed'
			});

			await seedReservedNarInfo(metadata, liveGeneration);
			await runInDurableObject(currentServer(), (instance) => {
				const cache = resolvedCache(instance.context);

				instance.context.db
					.insert(schema.retentionGrace)
					.values({
						cacheId: cache.id,
						storePathHash: metadata.storePathHash,
						retainUntil: isoTimestampSchema.parse('2026-06-01T00:00:00.000Z')
					})
					.run();
			});

			if (edgeGeneration !== undefined) {
				await seedEdge(edgeGeneration, metadata.narHash);
			}

			const result = await runInDurableObject(currentServer(), (instance) =>
				instance.context.criticalSection(() =>
					pipelineFor(instance.context).reclaimReservedRow(
						resolvedCache(instance.context),
						metadata.storePathHash,
						narInfoGenerationSchema.parse(7),
						metadata.narHash
					)
				)
			);
			const after = await runInDurableObject(currentServer(), (instance) => ({
				surviving: instance.context.db
					.select({ generation: schema.narInfos.generation })
					.from(schema.narInfos)
					.where(eq(schema.narInfos.storePathHash, metadata.storePathHash))
					.get(),
				grace: instance.context.db
					.select({ storePathHash: schema.retentionGrace.storePathHash })
					.from(schema.retentionGrace)
					.where(
						eq(schema.retentionGrace.storePathHash, metadata.storePathHash)
					)
					.get()
			}));

			expect({
				result,
				surviving: after.surviving?.generation,
				graceSurvives: after.grace !== undefined
			}).toStrictEqual({
				result: outcome,
				surviving: survivingGeneration,
				graceSurvives
			});
		}
	);

	it('treats a missing row as already reclaimed', async () => {
		await initialise();

		const metadata = uploadMetadata({
			fileSize: 128,
			storePathHash: 'r4'.repeat(16),
			name: 'vanished'
		});

		const result = await runInDurableObject(currentServer(), (instance) =>
			instance.context.criticalSection(() =>
				pipelineFor(instance.context).reclaimReservedRow(
					resolvedCache(instance.context),
					metadata.storePathHash,
					narInfoGenerationSchema.parse(7),
					metadata.narHash
				)
			)
		);

		expect(result).toBe('reclaimed');
	});
});

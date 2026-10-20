import {
	type CacheScope,
	rootNameSchema,
	type StorePathHash,
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../db/schema.ts';
import {
	currentServer,
	defaultCache,
	driveToCompletion,
	initialise,
	namedCache,
	putTestCache,
	resetTestServer,
	resolvedCache,
	syntheticNarHash,
	syntheticStorePathHash,
	underOneUnitOfWork,
	withoutAlarmArming
} from '../test-support.ts';

import { type ServerContext } from './context.ts';
import {
	type CollectionInputState,
	GarbageCollectionInputs
} from './garbage-collection-inputs.ts';
import { gcContinuationKey } from './server.ts';

const kept = syntheticStorePathHash(1);
const released = syntheticStorePathHash(2);
const graced = syntheticStorePathHash(3);
const added = syntheticStorePathHash(4);
const past = '2020-01-01T00:00:00.000Z';
const future = '2099-01-01T00:00:00.000Z';

// Enough unit-budget passes for the fixtures below to finish a scan.
const maxDrivenPasses = 32;

function storePathString(storePathHash: StorePathHash): StorePathString {
	return storePathSchema.parse(`/nix/store/${storePathHash}-app`);
}

function inputState(context: ServerContext): CollectionInputState | undefined {
	return new GarbageCollectionInputs(context).state(resolvedCache(context));
}

function insertNarInfo(
	context: ServerContext,
	storePathHash: StorePathHash,
	index: number
): void {
	context.db
		.insert(schema.narInfos)
		.values({
			cacheId: resolvedCache(context).id,
			storePathHash,
			storePath: storePathString(storePathHash),
			narHash: syntheticNarHash(index),
			narSize: 1,
			referencesJson: '[]',
			createdAt: isoTimestamp(new Date(past))
		})
		.run();
}

function insertRoot(
	context: ServerContext,
	name: string,
	expiresAt: string | undefined,
	target: StorePathHash
): void {
	const cacheId = resolvedCache(context).id;
	const rootName = rootNameSchema.parse(name);
	const createdAt = isoTimestamp(new Date(past));

	context.db
		.insert(schema.retentionRoots)
		.values({
			cacheId,
			name: rootName,
			...(expiresAt !== undefined && {
				expiresAt: isoTimestamp(new Date(expiresAt))
			}),
			createdAt,
			updatedAt: createdAt
		})
		.run();
	context.db
		.insert(schema.retentionRootTargets)
		.values({
			cacheId,
			rootName,
			storePathHash: target,
			storePath: storePathString(target)
		})
		.run();
}

function cacheCreatedAt(
	context: ServerContext,
	scope: CacheScope = defaultCache()
): IsoTimestamp | undefined {
	return context.db
		.select({ createdAt: schema.cacheIdentities.createdAt })
		.from(schema.cacheIdentities)
		.where(eq(schema.cacheIdentities.id, resolvedCache(context, scope).id))
		.get()?.createdAt;
}

function clearInputs(context: ServerContext): void {
	context.db
		.update(schema.garbageCollectionInputs)
		.set({ inputsChanged: false })
		.where(
			eq(schema.garbageCollectionInputs.cacheId, resolvedCache(context).id)
		)
		.run();
}

// One cache whose path is kept in every way that a scan reads: a root target,
// a grace deadline and an upload in flight. Four upload states are present:
// none, `pending`, `committing` and `servable`.
function seedRetainedCache(context: ServerContext, sql: SqlStorage): void {
	const cacheId = resolvedCache(context).id;
	const insertUpload =
		'INSERT INTO pending_upload (id, cache_id, nar_hash, r2_key, metadata_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)';
	const verdictUpdate = 'UPDATE pending_upload SET verdict = ? WHERE id = ?';

	insertNarInfo(context, kept, 1);
	insertRoot(context, 'channel', future, kept);
	context.db
		.insert(schema.retentionGrace)
		.values({
			cacheId,
			storePathHash: kept,
			retainUntil: isoTimestamp(new Date(future))
		})
		.run();

	for (const [id, verdict] of [
		['negotiated', undefined],
		['live', 'pending'],
		['committing', 'committing'],
		['terminal', 'servable']
	] as const) {
		sql.exec(
			insertUpload,
			id,
			cacheId,
			syntheticNarHash(1),
			`staging/fixture/${id}`,
			JSON.stringify({ storePathHash: kept }),
			past,
			future
		);

		if (verdict !== undefined) {
			sql.exec(verdictUpdate, verdict, id);
		}
	}
}

interface InputWrite {
	readonly name: string;
	readonly statement: string;
	readonly parameters: (
		cacheId: number,
		otherCacheId: number
	) => SqlStorageValue[];
	readonly inputsChanged: boolean;
	// Whether the write also marks the other cache, which a move targets.
	readonly otherInputsChanged?: boolean;
}

const otherCache = namedCache('other');
const markDeleted = 'UPDATE cache_identity SET deleted_at = ? WHERE id = ?';
const markLive = 'UPDATE cache_identity SET deleted_at = NULL WHERE id = ?';
const insertDeletedCacheNarInfo =
	"INSERT INTO narinfo (cache_id, store_path_hash, store_path, nar_hash, nar_size, references_json, created_at) VALUES (?, ?, ?, ?, 1, '[]', ?)";
const inputRowDeletion =
	'DELETE FROM garbage_collection_input WHERE cache_id = ?';
const selectInputRow =
	'SELECT inputs_changed, scan_completed_at FROM garbage_collection_input WHERE cache_id = ?';

const writes: readonly InputWrite[] = [
	{
		name: 'a cache becoming grace-managed',
		statement: 'UPDATE cache_identity SET grace_managed = 1 WHERE id = ?',
		parameters: (cacheId) => [cacheId],
		inputsChanged: true
	},
	{
		name: 'a cache close',
		statement:
			'INSERT INTO cache_close_event (cache_id, epoch, closed_at, grace_until) VALUES (?, 1, ?, ?)',
		parameters: (cacheId) => [cacheId, past, past],
		inputsChanged: true
	},
	{
		name: 'a narinfo insert',
		statement:
			"INSERT INTO narinfo (cache_id, store_path_hash, store_path, nar_hash, nar_size, references_json, created_at) VALUES (?, ?, ?, ?, 1, '[]', ?)",
		parameters: (cacheId) => [
			cacheId,
			added,
			storePathString(added),
			syntheticNarHash(4),
			past
		],
		inputsChanged: true
	},
	{
		name: 'a change to narinfo references',
		statement:
			'UPDATE narinfo SET references_json = ? WHERE cache_id = ? AND store_path_hash = ?',
		parameters: (cacheId) => [JSON.stringify([`${added}-app`]), cacheId, kept],
		inputsChanged: true
	},
	{
		name: 'a narinfo moved to another cache',
		statement: 'UPDATE narinfo SET cache_id = ? WHERE cache_id = ?',
		parameters: (cacheId, otherCacheId) => [otherCacheId, cacheId],
		inputsChanged: true,
		otherInputsChanged: true
	},
	{
		name: 'a narinfo moved to another store path',
		statement: 'UPDATE narinfo SET store_path_hash = ? WHERE cache_id = ?',
		parameters: (cacheId) => [added, cacheId],
		inputsChanged: true
	},
	{
		name: 'a narinfo delete',
		statement: 'DELETE FROM narinfo WHERE cache_id = ?',
		parameters: (cacheId) => [cacheId],
		inputsChanged: true
	},
	{
		name: 'a root target insert',
		statement:
			"INSERT INTO retention_root_target (cache_id, root_name, store_path_hash, store_path) VALUES (?, 'channel', ?, ?)",
		parameters: (cacheId) => [cacheId, added, storePathString(added)],
		inputsChanged: true
	},
	{
		name: 'a root target moved to another path',
		statement:
			'UPDATE retention_root_target SET store_path_hash = ? WHERE cache_id = ?',
		parameters: (cacheId) => [added, cacheId],
		inputsChanged: true
	},
	{
		name: 'a root target delete',
		statement: 'DELETE FROM retention_root_target WHERE cache_id = ?',
		parameters: (cacheId) => [cacheId],
		inputsChanged: true
	},
	{
		name: 'a grace insert',
		statement:
			'INSERT INTO retention_grace (cache_id, store_path_hash, retain_until) VALUES (?, ?, ?)',
		parameters: (cacheId) => [cacheId, added, future],
		inputsChanged: true
	},
	{
		name: 'a grace deadline moved to another path',
		statement:
			'UPDATE retention_grace SET store_path_hash = ? WHERE cache_id = ?',
		parameters: (cacheId) => [added, cacheId],
		inputsChanged: true
	},
	{
		name: 'a grace delete',
		statement: 'DELETE FROM retention_grace WHERE cache_id = ?',
		parameters: (cacheId) => [cacheId],
		inputsChanged: true
	},
	{
		name: 'an upload in flight receiving a mismatch verdict',
		statement:
			"UPDATE pending_upload SET verdict = 'mismatch' WHERE id = 'live' AND cache_id = ?",
		parameters: (cacheId) => [cacheId],
		inputsChanged: true
	},
	{
		name: 'an upload in flight being deleted',
		statement: "DELETE FROM pending_upload WHERE id = 'live' AND cache_id = ?",
		parameters: (cacheId) => [cacheId],
		inputsChanged: true
	},
	{
		name: 'a committing upload being deleted',
		statement:
			"DELETE FROM pending_upload WHERE id = 'committing' AND cache_id = ?",
		parameters: (cacheId) => [cacheId],
		inputsChanged: true
	},
	{
		name: 'an upload in flight moving to another cache',
		statement:
			"UPDATE pending_upload SET cache_id = ? WHERE id = 'live' AND cache_id = ?",
		parameters: (cacheId, otherCacheId) => [otherCacheId, cacheId],
		inputsChanged: true,
		otherInputsChanged: false
	},
	{
		name: 'an upload in flight moving to another store path',
		statement:
			"UPDATE pending_upload SET metadata_json = ? WHERE id = 'live' AND cache_id = ?",
		parameters: (cacheId) => [
			JSON.stringify({ storePathHash: added }),
			cacheId
		],
		inputsChanged: true
	},
	{
		name: 'a narinfo re-signed',
		statement:
			'UPDATE narinfo SET sigs_json = \'["cache-1:sig"]\' WHERE cache_id = ?',
		parameters: (cacheId) => [cacheId],
		inputsChanged: false
	},
	{
		name: 'narinfo references rewritten unchanged',
		statement:
			'UPDATE narinfo SET references_json = references_json WHERE cache_id = ?',
		parameters: (cacheId) => [cacheId],
		inputsChanged: false
	},
	{
		name: 'a grace deadline extended',
		statement: 'UPDATE retention_grace SET retain_until = ? WHERE cache_id = ?',
		parameters: (cacheId) => ['2100-01-01T00:00:00.000Z', cacheId],
		inputsChanged: false
	},
	{
		name: 'the grace-managed mark rewritten unchanged',
		statement:
			'UPDATE cache_identity SET grace_managed = grace_managed WHERE id = ?',
		parameters: (cacheId) => [cacheId],
		inputsChanged: false
	},
	{
		name: 'a retention epoch change without a close',
		statement:
			'UPDATE cache_identity SET retention_epoch = retention_epoch + 1 WHERE id = ?',
		parameters: (cacheId) => [cacheId],
		inputsChanged: false
	},
	{
		name: 'a root expiry change',
		statement: 'UPDATE retention_root SET expires_at = ? WHERE cache_id = ?',
		parameters: (cacheId) => [past, cacheId],
		inputsChanged: false
	},
	{
		name: 'an upload in flight moving to committing',
		statement:
			"UPDATE pending_upload SET verdict = 'committing' WHERE id = 'live' AND cache_id = ?",
		parameters: (cacheId) => [cacheId],
		inputsChanged: false
	},
	{
		name: 'a negotiated upload becoming pending',
		statement:
			"UPDATE pending_upload SET verdict = 'pending' WHERE id = 'negotiated' AND cache_id = ?",
		parameters: (cacheId) => [cacheId],
		inputsChanged: false
	},
	{
		name: 'a servable upload being deleted',
		statement:
			"DELETE FROM pending_upload WHERE id = 'terminal' AND cache_id = ?",
		parameters: (cacheId) => [cacheId],
		inputsChanged: false
	}
];

// Runs one unit of collection work and drops the continuation that it arms,
// so a stray alarm delivery cannot advance the scan under another budget.
async function collectOneUnitOfWork(): Promise<void> {
	await runInDurableObject(currentServer(), async (instance, state) => {
		await underOneUnitOfWork(() => instance.runGarbageCollection());
		await state.storage.delete(gcContinuationKey);
		await state.storage.deleteAlarm();
	});
}

async function collectPass(): Promise<void> {
	await currentServer().runGarbageCollection();
}

async function scanPhase(): Promise<string | undefined> {
	return runInDurableObject(
		currentServer(),
		(instance) =>
			instance.context.db
				.select({ phase: schema.garbageCollectionScans.phase })
				.from(schema.garbageCollectionScans)
				.where(
					eq(
						schema.garbageCollectionScans.cacheId,
						resolvedCache(instance.context).id
					)
				)
				.get()?.phase
	);
}

async function driveScan(
	pass: () => Promise<void>,
	isDone: (phase: string | undefined) => boolean
): Promise<void> {
	await driveToCompletion(
		pass,
		async () => isDone(await scanPhase()),
		maxDrivenPasses
	);
}

// A cache whose next scan writes to every kind of input table: it expires a
// root, marks the cache grace-managed, expires a grace deadline and collects
// two paths. A permanent root keeps one path.
async function seedScanWithOwnWrites(): Promise<void> {
	await runInDurableObject(currentServer(), (instance, state) => {
		const cacheId = resolvedCache(instance.context).id;

		state.storage.sql.exec(
			'UPDATE cache_identity SET grace_seconds = 0 WHERE id = ?',
			cacheId
		);
		insertNarInfo(instance.context, kept, 1);
		insertNarInfo(instance.context, released, 2);
		insertNarInfo(instance.context, graced, 3);
		insertRoot(instance.context, 'live', undefined, kept);
		insertRoot(instance.context, 'expired', past, released);
		instance.context.db
			.insert(schema.retentionGrace)
			.values({
				cacheId,
				storePathHash: graced,
				retainUntil: isoTimestamp(new Date(past))
			})
			.run();
	});
}

async function collectionState(): Promise<unknown> {
	return runInDurableObject(currentServer(), (instance) => ({
		narInfos: instance.context.db
			.select({ storePathHash: schema.narInfos.storePathHash })
			.from(schema.narInfos)
			.orderBy(schema.narInfos.storePathHash)
			.all()
			.map((row) => row.storePathHash),
		roots: instance.context.db
			.select({ name: schema.retentionRoots.name })
			.from(schema.retentionRoots)
			.all()
			.map((row) => row.name),
		inputs: inputState(instance.context)
	}));
}

describe('garbage collection inputs', () => {
	beforeEach(resetTestServer);

	it.each(writes)(
		'records $name as inputsChanged: $inputsChanged',
		async ({
			statement,
			parameters,
			inputsChanged,
			otherInputsChanged = false
		}) => {
			const token = await initialise();

			await putTestCache(token, otherCache);

			const recorded = await runInDurableObject(
				currentServer(),
				(instance, state) => {
					seedRetainedCache(instance.context, state.storage.sql);
					clearInputs(instance.context);
					state.storage.sql.exec(
						statement,
						...parameters(
							resolvedCache(instance.context).id,
							resolvedCache(instance.context, otherCache).id
						)
					);

					return {
						inputs: inputState(instance.context),
						other: new GarbageCollectionInputs(instance.context).state(
							resolvedCache(instance.context, otherCache)
						),
						createdAt: cacheCreatedAt(instance.context),
						otherCreatedAt: cacheCreatedAt(instance.context, otherCache)
					};
				}
			);

			expect({
				inputs: recorded.inputs,
				other: recorded.other
			}).toStrictEqual({
				inputs: { inputsChanged, scanCompletedAt: recorded.createdAt },
				other: {
					inputsChanged: otherInputsChanged,
					scanCompletedAt: recorded.otherCreatedAt
				}
			});
		}
	);

	it('records a new cache as unchanged and scanned when it was created', async () => {
		const token = await initialise();

		await putTestCache(token, namedCache('builds'));

		const recorded = await runInDurableObject(currentServer(), (instance) => ({
			inputs: new GarbageCollectionInputs(instance.context).state(
				resolvedCache(instance.context, namedCache('builds'))
			),
			createdAt: cacheCreatedAt(instance.context, namedCache('builds'))
		}));

		expect(recorded.inputs).toStrictEqual({
			inputsChanged: false,
			scanCompletedAt: recorded.createdAt
		});
	});

	it.each([
		{
			name: 'becomes live again',
			statement: markLive,
			parameters: (cacheId: number): SqlStorageValue[] => [cacheId]
		},
		{
			name: 'receives a narinfo',
			statement: insertDeletedCacheNarInfo,
			parameters: (cacheId: number): SqlStorageValue[] => [
				cacheId,
				added,
				storePathString(added),
				syntheticNarHash(4),
				past
			]
		}
	])(
		'records a deleted cache without a row that $name as changed',
		async ({ statement, parameters }) => {
			const token = await initialise();

			await putTestCache(token, namedCache('builds'));

			const recorded = await runInDurableObject(
				currentServer(),
				(instance, state) => {
					const cacheId = resolvedCache(
						instance.context,
						namedCache('builds')
					).id;

					state.storage.sql.exec(markDeleted, past, cacheId);
					state.storage.sql.exec(inputRowDeletion, cacheId);
					state.storage.sql.exec(statement, ...parameters(cacheId));

					return Array.from(
						state.storage.sql.exec<{
							inputs_changed: number;
							scan_completed_at: string | null;
						}>(selectInputRow, cacheId),
						(row) => ({
							inputsChanged: row.inputs_changed,
							scanCompletedAt: row.scan_completed_at ?? undefined
						})
					);
				}
			);

			expect(recorded).toStrictEqual([
				{ inputsChanged: 1, scanCompletedAt: undefined }
			]);
		}
	);

	it("leaves the inputs clear after a scan's own writes", async () =>
		withoutAlarmArming(async () => {
			await initialise();
			await seedScanWithOwnWrites();

			await collectPass();
			await driveScan(collectPass, (phase) => phase === undefined);

			expect(await collectionState()).toStrictEqual({
				narInfos: [kept],
				roots: ['live'],
				inputs: {
					inputsChanged: false,
					scanCompletedAt: isoTimestamp(new Date())
				}
			});
		}));

	it('keeps the inputs changed after a write between two invocations of a scan', async () =>
		withoutAlarmArming(async () => {
			await initialise();
			await seedScanWithOwnWrites();

			await driveScan(collectOneUnitOfWork, (phase) => phase === 'mark');
			await runInDurableObject(currentServer(), (instance, state) => {
				state.storage.sql.exec(
					"DELETE FROM retention_root_target WHERE cache_id = ? AND root_name = 'live'",
					resolvedCache(instance.context).id
				);
			});
			await driveScan(collectOneUnitOfWork, (phase) => phase === undefined);

			expect(await collectionState()).toStrictEqual({
				narInfos: [kept],
				roots: ['live'],
				inputs: {
					inputsChanged: true,
					scanCompletedAt: isoTimestamp(new Date())
				}
			});
		}));
});

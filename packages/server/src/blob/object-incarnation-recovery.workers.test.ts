import { rootLogger } from '@cupboard/logger';
import { startCapture } from '@cupboard/logger/testing';
import { NixSha256Hash } from '@cupboard/nix-store/hash';
import {
	type Sha256HexDigest,
	sha256HexDigestSchema
} from '@cupboard/nix-store/scalars';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { env } from 'cloudflare:workers';
import { and, eq } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as d1Schema from '../db/d1-schema.ts';
import type { ObjectReaperPhase } from '../do/blob-reaper-service.ts';
import {
	blobReaperGraceMs,
	casObjectKey,
	d1StatementsPerReaperInvocation,
	narObjectKey,
	objectDeletionBatchSize,
	objectRecoveryBatchSize
} from '../http/http.ts';
import { runBlobReaper as runBlobReaperPhase } from '../routing/scheduled.ts';
import {
	clearBlobStorage,
	resetTestServer,
	runBlobReaperToCompletion as runBlobReaper,
	runCasReaperToCompletion as runCasReaper,
	syntheticNarHash,
	testBase,
	verifiableNar
} from '../test-support.ts';

import {
	activateObjectIncarnation,
	firstVersionedObjectIncarnation,
	lateWriteTombstoneHorizonMs,
	queueObjectDeletion,
	reserveObjectIncarnation,
	type SharedObjectKind
} from './object-incarnation.ts';
import {
	drainObjectDeletions,
	recoverAbandonedIncarnations
} from './object-incarnation-recovery.ts';

async function casFixture(seed: string): Promise<{
	readonly bytes: Uint8Array;
	readonly digest: Sha256HexDigest;
}> {
	const bytes = new TextEncoder().encode(seed);
	const checksum = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
	const digest = sha256HexDigestSchema.parse(
		[...checksum].map((byte) => byte.toString(16).padStart(2, '0')).join('')
	);

	return { bytes, digest };
}

async function registryState(
	kind: SharedObjectKind,
	objectId: string
): Promise<string | undefined> {
	const row = await drizzleD1(env.CUPBOARD_DB, { schema: d1Schema })
		.select({ state: d1Schema.objectIncarnation.state })
		.from(d1Schema.objectIncarnation)
		.where(
			and(
				eq(d1Schema.objectIncarnation.kind, kind),
				eq(d1Schema.objectIncarnation.objectId, objectId)
			)
		)
		.get();

	return row?.state;
}

async function deletionMarkers(
	kind: SharedObjectKind,
	objectId: string
): Promise<number[]> {
	const rows = await drizzleD1(env.CUPBOARD_DB, { schema: d1Schema })
		.select({ incarnation: d1Schema.objectDeletion.incarnation })
		.from(d1Schema.objectDeletion)
		.where(
			and(
				eq(d1Schema.objectDeletion.kind, kind),
				eq(d1Schema.objectDeletion.objectId, objectId)
			)
		)
		.all();

	return rows.map((row) => row.incarnation);
}

describe('abandoned object version recovery', () => {
	beforeEach(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(testBase);
		await resetTestServer();
		await clearBlobStorage();
	});

	it('uses maintenance indexes for recovery and deletion scans', async () => {
		const recovery = await env.CUPBOARD_DB.prepare(
			`EXPLAIN QUERY PLAN
			 SELECT object_id FROM object_incarnation
			 WHERE kind = 'nar' AND state IN ('pending', 'live')
			   AND updated_at <= '2026-01-01T00:00:00.000Z'
			 ORDER BY state, updated_at, object_id LIMIT 500`
		).all<{ detail: string }>();
		const deletion = await env.CUPBOARD_DB.prepare(
			`EXPLAIN QUERY PLAN
			 SELECT object_id FROM object_deletion
			 WHERE kind = 'nar'
			 ORDER BY remove_after, object_id, incarnation LIMIT 500`
		).all<{ detail: string }>();

		expect({
			recovery: recovery.results.map((row) => row.detail),
			deletion: deletion.results.map((row) => row.detail)
		}).toStrictEqual({
			recovery: [expect.stringContaining('object_incarnation_recovery_idx')],
			deletion: [expect.stringContaining('object_deletion_due_idx')]
		});
	});

	it.each(['nar', 'cas'] as const)(
		'collects a %s row written by the old Worker after the registry migration',
		async (kind) => {
			const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
			const nar = await verifiableNar(`deployment-skew-${kind}`);
			const bundle = await casFixture(`deployment-skew-${kind}`);
			const objectId = kind === 'nar' ? nar.narHash : bundle.digest;
			const key =
				kind === 'nar'
					? narObjectKey(nar.narHash)
					: casObjectKey(bundle.digest);

			if (kind === 'nar') {
				await env.BLOBS.put(key, nar.narBytes, {
					sha256: NixSha256Hash.parse(nar.fileHash).digestBytes(),
					customMetadata: { narSize: String(nar.narSize) }
				});
				await database.insert(d1Schema.blobState).values({
					narHash: nar.narHash,
					fileHash: nar.fileHash,
					fileSize: nar.narBytes.byteLength,
					compression: 'zstd',
					narSize: nar.narSize,
					verifiedAt: isoTimestamp(testBase)
				});
			} else {
				await env.BLOBS.put(key, bundle.bytes, { sha256: bundle.digest });
				await database.insert(d1Schema.casObject).values({
					digest: bundle.digest,
					size: bundle.bytes.byteLength,
					storedAt: isoTimestamp(testBase)
				});
			}

			if (kind === 'nar') {
				await runBlobReaper(rootLogger(), env);
			} else {
				await runCasReaper(rootLogger(), env);
			}

			vi.setSystemTime(new Date(testBase.getTime() + blobReaperGraceMs));

			if (kind === 'nar') {
				await runBlobReaper(rootLogger(), env);
			} else {
				await runCasReaper(rootLogger(), env);
			}

			const row =
				kind === 'nar'
					? await database
							.select({ objectId: d1Schema.blobState.narHash })
							.from(d1Schema.blobState)
							.where(eq(d1Schema.blobState.narHash, nar.narHash))
							.get()
					: await database
							.select({ objectId: d1Schema.casObject.digest })
							.from(d1Schema.casObject)
							.where(eq(d1Schema.casObject.digest, bundle.digest))
							.get();

			expect({
				row,
				objectPresent: (await env.BLOBS.head(key)) !== null,
				registry: await registryState(kind, objectId)
			}).toStrictEqual({
				row: undefined,
				objectPresent: false,
				registry: 'absent'
			});
		}
	);

	it.each(['nar', 'cas'] as const)(
		'starts a newly registered %s identity above the legacy key',
		async (kind) => {
			const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
			const nar = await verifiableNar(`post-upgrade-${kind}`);
			const bundle = await casFixture(`post-upgrade-${kind}`);
			const objectId = kind === 'nar' ? nar.narHash : bundle.digest;
			const legacyKey =
				kind === 'nar'
					? narObjectKey(nar.narHash)
					: casObjectKey(bundle.digest);
			const legacyBytes =
				kind === 'nar'
					? new TextEncoder().encode('retired encoding')
					: bundle.bytes;

			await env.BLOBS.put(legacyKey, legacyBytes);
			const reserved = await reserveObjectIncarnation(database, kind, objectId);
			const versionedKey =
				kind === 'nar'
					? narObjectKey(nar.narHash, reserved.incarnation)
					: casObjectKey(bundle.digest, reserved.incarnation);
			await env.BLOBS.put(versionedKey, 'versioned');
			const legacyObject = await env.BLOBS.get(legacyKey);

			if (legacyObject === null) {
				throw new Error('The legacy object vanished before it was inspected.');
			}

			expect({
				reserved,
				markers: await deletionMarkers(kind, objectId),
				legacyBytes: new Uint8Array(await legacyObject.arrayBuffer())
			}).toStrictEqual({
				reserved: {
					incarnation: firstVersionedObjectIncarnation,
					state: 'pending'
				},
				markers: [1],
				legacyBytes
			});

			const failingBucket: R2Bucket = {
				head: env.BLOBS.head.bind(env.BLOBS),
				get: env.BLOBS.get.bind(env.BLOBS),
				put: env.BLOBS.put.bind(env.BLOBS),
				delete: vi.fn().mockRejectedValue(new Error('R2 delete unavailable')),
				list: env.BLOBS.list.bind(env.BLOBS),
				createMultipartUpload: env.BLOBS.createMultipartUpload.bind(env.BLOBS),
				resumeMultipartUpload: env.BLOBS.resumeMultipartUpload.bind(env.BLOBS)
			};

			await drainObjectDeletions(database, env.BLOBS, kind, 1);

			expect({
				markers: await deletionMarkers(kind, objectId),
				legacyPresent: (await env.BLOBS.head(legacyKey)) !== null,
				versionedPresent: (await env.BLOBS.head(versionedKey)) !== null
			}).toStrictEqual({
				markers: [1],
				legacyPresent: true,
				versionedPresent: true
			});

			vi.setSystemTime(
				new Date(testBase.getTime() + lateWriteTombstoneHorizonMs)
			);
			await expect(
				drainObjectDeletions(database, failingBucket, kind, 1)
			).rejects.toThrow('R2 delete unavailable');
			expect(await deletionMarkers(kind, objectId)).toStrictEqual([1]);

			await drainObjectDeletions(database, env.BLOBS, kind, 1);

			expect({
				markers: await deletionMarkers(kind, objectId),
				legacyPresent: (await env.BLOBS.head(legacyKey)) !== null,
				versionedPresent: (await env.BLOBS.head(versionedKey)) !== null
			}).toStrictEqual({
				markers: [],
				legacyPresent: false,
				versionedPresent: true
			});
		}
	);

	it.each(['nar', 'cas'] as const)(
		'reserves a new %s object version when the promotion owner changes',
		async (kind) => {
			const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
			const nar = await verifiableNar(`replacement-owner-${kind}`);
			const bundle = await casFixture(`replacement-owner-${kind}`);
			const objectId = kind === 'nar' ? nar.narHash : bundle.digest;
			const first = await reserveObjectIncarnation(
				database,
				kind,
				objectId,
				'owner-a'
			);
			const second = await reserveObjectIncarnation(
				database,
				kind,
				objectId,
				'owner-b'
			);

			expect({
				first,
				second,
				markers: await deletionMarkers(kind, objectId),
				firstActivation: await activateObjectIncarnation(
					database,
					kind,
					objectId,
					first.incarnation,
					'owner-a'
				),
				secondActivation: await activateObjectIncarnation(
					database,
					kind,
					objectId,
					second.incarnation,
					'owner-b'
				)
			}).toStrictEqual({
				first: { incarnation: 2, state: 'pending' },
				second: { incarnation: 3, state: 'pending' },
				markers: [1, 2],
				firstActivation: 'retired',
				secondActivation: 'live'
			});
		}
	);

	it('extends an existing marker when the promotion owner changes', async () => {
		const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
		const nar = await verifiableNar('replacement-marker-deadline');
		const first = await reserveObjectIncarnation(
			database,
			'nar',
			nar.narHash,
			'owner-a'
		);
		await queueObjectDeletion(database, 'nar', nar.narHash, first.incarnation);

		await reserveObjectIncarnation(database, 'nar', nar.narHash, 'owner-b');
		const marker = await database
			.select({ removeAfter: d1Schema.objectDeletion.removeAfter })
			.from(d1Schema.objectDeletion)
			.where(
				and(
					eq(d1Schema.objectDeletion.kind, 'nar'),
					eq(d1Schema.objectDeletion.objectId, nar.narHash),
					eq(d1Schema.objectDeletion.incarnation, first.incarnation)
				)
			)
			.get();

		expect(marker).toStrictEqual({
			removeAfter: new Date(
				testBase.getTime() + lateWriteTombstoneHorizonMs
			).toISOString()
		});
	});

	it.each(['nar', 'cas'] as const)(
		'keeps an extended %s marker after an earlier drain resumes',
		async (kind) => {
			const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
			const nar = await verifiableNar(`extended-drain-${kind}`);
			const bundle = await casFixture(`extended-drain-${kind}`);
			const objectId = kind === 'nar' ? nar.narHash : bundle.digest;
			const first = await reserveObjectIncarnation(
				database,
				kind,
				objectId,
				'owner-a'
			);
			const firstKey =
				kind === 'nar'
					? narObjectKey(nar.narHash, first.incarnation)
					: casObjectKey(bundle.digest, first.incarnation);
			await env.BLOBS.put(firstKey, 'first');
			await queueObjectDeletion(database, kind, objectId, first.incarnation);

			const originalDelete = env.BLOBS.delete.bind(env.BLOBS);
			const { promise: held, resolve: release } =
				Promise.withResolvers<undefined>();
			const { promise: reached, resolve: didReach } =
				Promise.withResolvers<undefined>();
			const bucket: R2Bucket = {
				head: env.BLOBS.head.bind(env.BLOBS),
				get: env.BLOBS.get.bind(env.BLOBS),
				put: env.BLOBS.put.bind(env.BLOBS),
				async delete(keys) {
					if ((Array.isArray(keys) ? keys : [keys]).includes(firstKey)) {
						didReach(undefined);
						await held;
					}

					return originalDelete(keys);
				},
				list: env.BLOBS.list.bind(env.BLOBS),
				createMultipartUpload: env.BLOBS.createMultipartUpload.bind(env.BLOBS),
				resumeMultipartUpload: env.BLOBS.resumeMultipartUpload.bind(env.BLOBS)
			};
			const earlyDrain = drainObjectDeletions(database, bucket, kind, 500);

			await reached;
			const replacement = await reserveObjectIncarnation(
				database,
				kind,
				objectId,
				'owner-b'
			);
			const replacementKey =
				kind === 'nar'
					? narObjectKey(nar.narHash, replacement.incarnation)
					: casObjectKey(bundle.digest, replacement.incarnation);
			await env.BLOBS.put(replacementKey, 'replacement');
			await activateObjectIncarnation(
				database,
				kind,
				objectId,
				replacement.incarnation,
				'owner-b'
			);
			release(undefined);
			await earlyDrain;
			await env.BLOBS.put(firstKey, 'late first');

			const extendedDeadline = new Date(
				testBase.getTime() + lateWriteTombstoneHorizonMs
			).toISOString();
			const marker = await database
				.select({ removeAfter: d1Schema.objectDeletion.removeAfter })
				.from(d1Schema.objectDeletion)
				.where(
					and(
						eq(d1Schema.objectDeletion.kind, kind),
						eq(d1Schema.objectDeletion.objectId, objectId),
						eq(d1Schema.objectDeletion.incarnation, first.incarnation)
					)
				)
				.get();

			expect({
				marker,
				firstPresent: (await env.BLOBS.head(firstKey)) !== null,
				replacementPresent: (await env.BLOBS.head(replacementKey)) !== null
			}).toStrictEqual({
				marker: { removeAfter: extendedDeadline },
				firstPresent: true,
				replacementPresent: true
			});

			vi.setSystemTime(new Date(extendedDeadline));
			await drainObjectDeletions(database, env.BLOBS, kind, 500);

			expect({
				markers: await deletionMarkers(kind, objectId),
				firstPresent: (await env.BLOBS.head(firstKey)) !== null,
				replacementPresent: (await env.BLOBS.head(replacementKey)) !== null
			}).toStrictEqual({
				markers: [],
				firstPresent: false,
				replacementPresent: true
			});
		}
	);

	it.each(['pending', 'live'] as const)(
		'restores a blob_state row from an abandoned %s object version',
		async (state) => {
			const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
			const nar = await verifiableNar(`recover-nar-${state}`);
			const reserved = await reserveObjectIncarnation(
				database,
				'nar',
				nar.narHash
			);
			const key = narObjectKey(nar.narHash, reserved.incarnation);

			await env.BLOBS.put(key, nar.narBytes, {
				sha256: NixSha256Hash.parse(nar.fileHash).digestBytes(),
				customMetadata: { narSize: String(nar.narSize) }
			});

			if (state === 'live') {
				await activateObjectIncarnation(
					database,
					'nar',
					nar.narHash,
					reserved.incarnation
				);
			}

			vi.setSystemTime(new Date(testBase.getTime() + blobReaperGraceMs + 1));
			await runBlobReaper(rootLogger(), env);

			const blobState = await database
				.select({
					fileHash: d1Schema.blobState.fileHash,
					fileSize: d1Schema.blobState.fileSize,
					narSize: d1Schema.blobState.narSize,
					incarnation: d1Schema.blobState.incarnation
				})
				.from(d1Schema.blobState)
				.where(eq(d1Schema.blobState.narHash, nar.narHash))
				.get();

			expect({
				blobState,
				objectPresent: (await env.BLOBS.head(key)) !== null,
				state: await registryState('nar', nar.narHash)
			}).toStrictEqual({
				blobState: {
					fileHash: nar.fileHash,
					fileSize: nar.narBytes.byteLength,
					narSize: nar.narSize,
					incarnation: reserved.incarnation
				},
				objectPresent: true,
				state: 'live'
			});
		}
	);

	it.each(['pending', 'live'] as const)(
		'restores a cas_object row from an abandoned %s object version',
		async (state) => {
			const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
			const bundle = await casFixture(`recover-cas-${state}`);
			const reserved = await reserveObjectIncarnation(
				database,
				'cas',
				bundle.digest
			);
			const key = casObjectKey(bundle.digest, reserved.incarnation);

			await env.BLOBS.put(key, bundle.bytes, { sha256: bundle.digest });

			if (state === 'live') {
				await activateObjectIncarnation(
					database,
					'cas',
					bundle.digest,
					reserved.incarnation
				);
			}

			vi.setSystemTime(new Date(testBase.getTime() + blobReaperGraceMs));
			await runCasReaper(rootLogger(), env);

			const casObject = await database
				.select({
					size: d1Schema.casObject.size,
					incarnation: d1Schema.casObject.incarnation
				})
				.from(d1Schema.casObject)
				.where(eq(d1Schema.casObject.digest, bundle.digest))
				.get();

			expect({
				casObject,
				objectPresent: (await env.BLOBS.head(key)) !== null,
				state: await registryState('cas', bundle.digest)
			}).toStrictEqual({
				casObject: {
					size: bundle.bytes.byteLength,
					incarnation: reserved.incarnation
				},
				objectPresent: true,
				state: 'live'
			});
		}
	);

	it.each(['nar', 'cas'] as const)(
		'replaces a stale %s state row with the live registry incarnation',
		async (kind) => {
			const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
			const nar = await verifiableNar(`recover-mismatched-${kind}`);
			const bundle = await casFixture(`recover-mismatched-${kind}`);
			const objectId = kind === 'nar' ? nar.narHash : bundle.digest;
			const reserved = await reserveObjectIncarnation(database, kind, objectId);
			const key =
				kind === 'nar'
					? narObjectKey(nar.narHash, reserved.incarnation)
					: casObjectKey(bundle.digest, reserved.incarnation);

			if (kind === 'nar') {
				await env.BLOBS.put(key, nar.narBytes, {
					sha256: NixSha256Hash.parse(nar.fileHash).digestBytes(),
					customMetadata: { narSize: String(nar.narSize) }
				});
				await database.insert(d1Schema.blobState).values({
					narHash: nar.narHash,
					fileHash: nar.fileHash,
					fileSize: nar.narBytes.byteLength,
					compression: 'zstd',
					narSize: nar.narSize,
					verifiedAt: isoTimestamp(testBase)
				});
			} else {
				await env.BLOBS.put(key, bundle.bytes, { sha256: bundle.digest });
				await database.insert(d1Schema.casObject).values({
					digest: bundle.digest,
					size: bundle.bytes.byteLength,
					storedAt: isoTimestamp(testBase)
				});
			}

			await activateObjectIncarnation(
				database,
				kind,
				objectId,
				reserved.incarnation
			);
			vi.setSystemTime(new Date(testBase.getTime() + blobReaperGraceMs + 1));

			if (kind === 'nar') {
				await runBlobReaper(rootLogger(), env);
			} else {
				await runCasReaper(rootLogger(), env);
			}

			const state =
				kind === 'nar'
					? await database
							.select({ incarnation: d1Schema.blobState.incarnation })
							.from(d1Schema.blobState)
							.where(eq(d1Schema.blobState.narHash, nar.narHash))
							.get()
					: await database
							.select({ incarnation: d1Schema.casObject.incarnation })
							.from(d1Schema.casObject)
							.where(eq(d1Schema.casObject.digest, bundle.digest))
							.get();

			expect({
				state,
				registry: await registryState(kind, objectId)
			}).toStrictEqual({
				state: { incarnation: reserved.incarnation },
				registry: 'live'
			});
		}
	);

	it.each(['nar', 'cas'] as const)(
		'retires an abandoned %s reservation whose object is absent',
		async (kind) => {
			const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
			const nar = await verifiableNar('recover-absent');
			const bundle = await casFixture('recover-absent');
			const objectId = kind === 'nar' ? nar.narHash : bundle.digest;

			await reserveObjectIncarnation(database, kind, objectId);
			vi.setSystemTime(new Date(testBase.getTime() + blobReaperGraceMs));

			if (kind === 'nar') {
				await runBlobReaper(rootLogger(), env);
			} else {
				await runCasReaper(rootLogger(), env);
			}

			expect(await registryState(kind, objectId)).toBe('absent');
		}
	);

	it('does not retire a reservation resumed during its R2 probe', async () => {
		const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
		const nar = await verifiableNar('recover-resumed-race');
		const reserved = await reserveObjectIncarnation(
			database,
			'nar',
			nar.narHash
		);
		const key = narObjectKey(nar.narHash, reserved.incarnation);
		const originalHead = env.BLOBS.head.bind(env.BLOBS);
		let didResume = false;

		vi.setSystemTime(new Date(testBase.getTime() + blobReaperGraceMs));
		const head = vi
			.spyOn(env.BLOBS, 'head')
			.mockImplementation(async (name) => {
				if (name === key && !didResume) {
					didResume = true;
					await reserveObjectIncarnation(database, 'nar', nar.narHash);
				}

				return originalHead(name);
			});

		try {
			await runBlobReaper(rootLogger(), env);
		} finally {
			head.mockRestore();
		}

		expect({
			didResume,
			state: await registryState('nar', nar.narHash)
		}).toStrictEqual({ didResume: true, state: 'pending' });
	});

	it('moves failed probes behind later recovery pages and logs no object identity', async () => {
		const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
		const rows = await Promise.all(
			Array.from({ length: 3 }, async (_, index) => {
				const nar = await verifiableNar(`recover-page-${String(index)}`);
				const reservation = await reserveObjectIncarnation(
					database,
					'nar',
					nar.narHash
				);

				return { narHash: nar.narHash, incarnation: reservation.incarnation };
			})
		);
		const ordered = rows.toSorted((left, right) =>
			left.narHash.localeCompare(right.narHash)
		);
		const failedKeys = new Set<string>(
			ordered
				.slice(0, 2)
				.map((row) => narObjectKey(row.narHash, row.incarnation))
		);
		const originalHead = env.BLOBS.head.bind(env.BLOBS);
		const head = vi
			.spyOn(env.BLOBS, 'head')
			.mockImplementation((key) =>
				failedKeys.has(key)
					? Promise.reject(new Error('simulated recovery probe outage'))
					: originalHead(key)
			);
		const now = new Date(testBase.getTime() + blobReaperGraceMs + 1);
		vi.setSystemTime(now);
		const capture = startCapture();
		let recovered: readonly {
			readonly hasMoreWork: boolean;
			readonly recovered: number;
		}[];

		try {
			recovered = [
				await recoverAbandonedIncarnations(
					database,
					env.BLOBS,
					'nar',
					now,
					2,
					rootLogger()
				),
				await recoverAbandonedIncarnations(
					database,
					env.BLOBS,
					'nar',
					now,
					2,
					rootLogger()
				)
			];
		} finally {
			head.mockRestore();
			capture.stop();
		}

		const states = await Promise.all(
			ordered.map((row) => registryState('nar', row.narHash))
		);
		const warnings = capture.logs
			.filter(
				(record) =>
					record.message === 'object incarnation recovery probe failed'
			)
			.map((record) => ({
				level: record.level,
				propertyNames: Object.keys(record.properties).toSorted((left, right) =>
					left.localeCompare(right)
				),
				kind: record.properties.kind,
				incarnation: record.properties.incarnation,
				reason: record.properties.reason
			}));

		expect({ recovered, states, warnings }).toStrictEqual({
			recovered: [
				{ hasMoreWork: true, recovered: 0 },
				{ hasMoreWork: false, recovered: 1 }
			],
			states: ['pending', 'pending', 'absent'],
			warnings: [
				{
					level: 'warning',
					propertyNames: ['incarnation', 'kind', 'reason'],
					kind: 'nar',
					incarnation: firstVersionedObjectIncarnation,
					reason: 'r2-head-failed'
				},
				{
					level: 'warning',
					propertyNames: ['incarnation', 'kind', 'reason'],
					kind: 'nar',
					incarnation: firstVersionedObjectIncarnation,
					reason: 'r2-head-failed'
				}
			]
		});
	});

	it('continues a recovery backlog in query-budgeted pages', async () => {
		const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
		const rowCount = objectRecoveryBatchSize + 1;
		const rows = Array.from({ length: rowCount }, (_, index) => ({
			kind: 'nar' as const,
			objectId: syntheticNarHash(index + 10_000),
			incarnation: firstVersionedObjectIncarnation,
			state: 'pending' as const,
			updatedAt: isoTimestamp(testBase)
		}));

		await env.CUPBOARD_DB.batch(
			rows.map((row) =>
				env.CUPBOARD_DB.prepare(
					`INSERT INTO object_incarnation
					 (kind, object_id, incarnation, state, updated_at)
					 VALUES (?, ?, ?, ?, ?)`
				).bind(
					row.kind,
					row.objectId,
					row.incarnation,
					row.state,
					row.updatedAt
				)
			)
		);
		vi.setSystemTime(new Date(testBase.getTime() + blobReaperGraceMs + 1));
		const continueReaper = vi.fn((_phase: ObjectReaperPhase) =>
			Promise.resolve()
		);

		await runBlobReaperPhase(rootLogger(), env, 500, continueReaper, 'recover');
		const afterFirst = await database
			.select({ state: d1Schema.objectIncarnation.state })
			.from(d1Schema.objectIncarnation)
			.all();
		await runBlobReaperPhase(rootLogger(), env, 500, continueReaper, 'recover');
		const afterSecond = await database
			.select({ state: d1Schema.objectIncarnation.state })
			.from(d1Schema.objectIncarnation)
			.all();

		expect({
			afterFirst: Object.fromEntries(
				[...Map.groupBy(afterFirst, ({ state }) => state)].map(
					([state, matching]) => [state, matching.length]
				)
			),
			afterSecond: Object.fromEntries(
				[...Map.groupBy(afterSecond, ({ state }) => state)].map(
					([state, matching]) => [state, matching.length]
				)
			),
			continuations: continueReaper.mock.calls.map(([phase]) => phase)
		}).toStrictEqual({
			afterFirst: { absent: objectRecoveryBatchSize, pending: 1 },
			afterSecond: { absent: rowCount },
			continuations: ['recover', 'arm']
		});
	});

	it('continues deletion markers within the Workers Free D1 allowance', async () => {
		const rowCount = objectDeletionBatchSize + 1;
		await env.CUPBOARD_DB.batch(
			Array.from({ length: rowCount }, (_, index) =>
				env.CUPBOARD_DB.prepare(
					`INSERT INTO object_deletion
					 (kind, object_id, incarnation, remove_after)
					 VALUES ('nar', ?, 1, ?)`
				).bind(syntheticNarHash(index + 20_000), isoTimestamp(testBase))
			)
		);
		const continuations: ObjectReaperPhase[] = [];
		const continueReaper = (phase: ObjectReaperPhase): Promise<void> => {
			continuations.push(phase);

			return Promise.resolve();
		};
		const markerCount = async (): Promise<number> => {
			const row = await env.CUPBOARD_DB.prepare(
				"SELECT count(*) AS count FROM object_deletion WHERE kind = 'nar'"
			).first<{ count: number }>();

			return row?.count ?? 0;
		};

		await runBlobReaperPhase(
			rootLogger(),
			env,
			500,
			continueReaper,
			'delete-existing'
		);
		const afterFirst = await markerCount();
		await runBlobReaperPhase(
			rootLogger(),
			env,
			500,
			continueReaper,
			'delete-existing'
		);

		expect({
			statementLimit: d1StatementsPerReaperInvocation,
			pageSize: objectDeletionBatchSize,
			afterFirst,
			afterSecond: await markerCount(),
			continuations
		}).toStrictEqual({
			statementLimit: 50,
			pageSize: 49,
			afterFirst: 1,
			afterSecond: 0,
			continuations: ['delete-existing', 'recover']
		});
	});

	it.each(['nar', 'cas'] as const)(
		'retries an interrupted retirement of an incomplete %s object',
		async (kind) => {
			const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
			const nar = await verifiableNar(`recover-incomplete-${kind}`);
			const bundle = await casFixture(`recover-incomplete-${kind}`);
			const objectId = kind === 'nar' ? nar.narHash : bundle.digest;
			const reserved = await reserveObjectIncarnation(database, kind, objectId);
			const key =
				kind === 'nar'
					? narObjectKey(nar.narHash, reserved.incarnation)
					: casObjectKey(bundle.digest, reserved.incarnation);

			await env.BLOBS.put(key, 'incomplete');
			await drainObjectDeletions(database, env.BLOBS, kind, 500);
			vi.setSystemTime(
				new Date(testBase.getTime() + lateWriteTombstoneHorizonMs)
			);
			await drainObjectDeletions(database, env.BLOBS, kind, 500);
			vi.setSystemTime(new Date(testBase.getTime() + blobReaperGraceMs + 1));
			const bucket: R2Bucket = {
				head: env.BLOBS.head.bind(env.BLOBS),
				get: env.BLOBS.get.bind(env.BLOBS),
				put: env.BLOBS.put.bind(env.BLOBS),
				delete: vi.fn(async (keys: string | string[]) => {
					if ((Array.isArray(keys) ? keys : [keys]).includes(key)) {
						throw new Error('R2 delete unavailable');
					}

					return env.BLOBS.delete(keys);
				}),
				list: env.BLOBS.list.bind(env.BLOBS),
				createMultipartUpload: env.BLOBS.createMultipartUpload.bind(env.BLOBS),
				resumeMultipartUpload: env.BLOBS.resumeMultipartUpload.bind(env.BLOBS)
			};
			await expect(
				kind === 'nar'
					? runBlobReaper(rootLogger(), { ...env, BLOBS: bucket })
					: runCasReaper(rootLogger(), { ...env, BLOBS: bucket })
			).rejects.toThrow('R2 delete unavailable');
			expect({
				state: await registryState(kind, objectId),
				markers: await deletionMarkers(kind, objectId),
				objectPresent: (await env.BLOBS.head(key)) !== null
			}).toStrictEqual({
				state: 'absent',
				markers: [reserved.incarnation],
				objectPresent: true
			});

			if (kind === 'nar') {
				await runBlobReaper(rootLogger(), env);
			} else {
				await runCasReaper(rootLogger(), env);
			}

			expect({
				markers: await deletionMarkers(kind, objectId),
				objectPresent: (await env.BLOBS.head(key)) !== null
			}).toStrictEqual({ markers: [], objectPresent: false });
		}
	);
});

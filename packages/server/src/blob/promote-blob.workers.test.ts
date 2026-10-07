import { NixSha256Hash } from '@cupboard/nix-store/hash';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { env } from 'cloudflare:workers';
import { eq, sql } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as d1Schema from '../db/d1-schema.ts';
import { boundedBlobs, boundedD1 } from '../do/bounded-io.ts';
import {
	subrequestsAvailable,
	withSubrequestSlice
} from '../do/subrequest-slice.ts';
import {
	StagedObjectDigestMismatchError,
	UploadedObjectNotFoundError
} from '../errors.ts';
import { narObjectKey, r2ObjectKeySchema } from '../http/http.ts';
import {
	clearBlobStorage,
	resetTestServer,
	verifiableNar,
	verifiableNarStored
} from '../test-support.ts';

import { reserveObjectIncarnation } from './object-incarnation.ts';
import {
	commitStagedBlobPromotion,
	promoteVerifiedBlob,
	stagePromotedBlob
} from './promote-blob.ts';

describe('promoteVerifiedBlob', () => {
	beforeEach(async () => {
		await resetTestServer();
		await clearBlobStorage();
	});

	it.each([
		{
			contended: false,
			loser: false,
			incoherent: false,
			calls: 14,
			activation: 'live'
		},
		{
			contended: false,
			loser: true,
			incoherent: false,
			calls: 15,
			activation: 'live'
		},
		{
			contended: false,
			loser: true,
			incoherent: true,
			calls: 17,
			activation: 'retired'
		},
		{
			contended: true,
			loser: true,
			incoherent: true,
			calls: 7,
			activation: 'deferred'
		}
	])(
		'meters $calls calls when replacing a missing NAR (loser=$loser, incoherent=$incoherent)',
		async ({ contended, loser, incoherent, calls, activation }) => {
			const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
			const nar = await verifiableNar('metered-promotion');
			const target = { narHash: nar.narHash, narSize: nar.narSize };
			const blob = {
				fileHash: nar.fileHash,
				fileSize: nar.narBytes.byteLength
			};
			const stagingKey = r2ObjectKeySchema.parse(
				'staging/metered-promotion/upload'
			);
			await env.BLOBS.put(stagingKey, nar.narBytes);
			await database.insert(d1Schema.blobState).values({
				...target,
				...blob,
				compression: 'zstd',
				incarnation: 2,
				verifiedAt: isoTimestamp(new Date())
			});
			await database.insert(d1Schema.objectIncarnation).values({
				kind: 'nar',
				objectId: nar.narHash,
				incarnation: 2,
				state: 'live',
				updatedAt: isoTimestamp(new Date())
			});
			const originalBatch = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
			let reservationBatches = 0;
			const batch = vi
				.spyOn(env.CUPBOARD_DB, 'batch')
				.mockImplementation(async (statements) => {
					reservationBatches += 1;
					if (contended && reservationBatches === 2) {
						await database
							.update(d1Schema.objectIncarnation)
							.set({ incarnation: 4, reservationOwner: 'competing-owner' })
							.where(eq(d1Schema.objectIncarnation.objectId, nar.narHash))
							.run();
					}
					return originalBatch(statements);
				});

			const originalHead = env.BLOBS.head.bind(env.BLOBS);
			const originalPut = env.BLOBS.put.bind(env.BLOBS);
			const head = vi
				.spyOn(env.BLOBS, 'head')
				.mockImplementation(async (key) => {
					if (key === narObjectKey(nar.narHash, 2)) {
						await database
							.update(d1Schema.objectIncarnation)
							.set({
								incarnation: 3,
								state: 'pending',
								reservationOwner: contended ? 'other-owner' : 'metered-owner'
							})
							.where(eq(d1Schema.objectIncarnation.objectId, nar.narHash));
					}
					return originalHead(key);
				});
			const put = vi
				.spyOn(env.BLOBS, 'put')
				.mockImplementation(async (...arguments_) => {
					if (loser && arguments_[0] === narObjectKey(nar.narHash, 3)) {
						await originalPut(arguments_[0], nar.narBytes, {
							sha256: NixSha256Hash.parse(nar.fileHash).digestBytes()
						});
						if (incoherent) {
							await database
								.update(d1Schema.objectIncarnation)
								.set({ state: 'live', reservationOwner: sql`null` })
								.where(eq(d1Schema.objectIncarnation.objectId, nar.narHash));
							await database
								.update(d1Schema.blobState)
								.set({ incarnation: 4 })
								.where(eq(d1Schema.blobState.narHash, nar.narHash));
						}
					}
					return originalPut(...arguments_);
				});
			try {
				const result = await withSubrequestSlice(
					async () => {
						const before = subrequestsAvailable();
						try {
							const staged = await stagePromotedBlob(
								drizzleD1(boundedD1(env.CUPBOARD_DB), { schema: d1Schema }),
								boundedBlobs(env.BLOBS),
								stagingKey,
								target,
								blob,
								'metered-owner',
								() => true
							);
							if (staged === undefined) {
								throw new Error(
									'The owned promotion did not produce a staging result.'
								);
							}
							const activation = await commitStagedBlobPromotion(
								drizzleD1(boundedD1(env.CUPBOARD_DB), { schema: d1Schema }),
								staged,
								() => true
							);
							return { activation, calls: before - subrequestsAvailable() };
						} catch (error) {
							if (!contended || !(error instanceof Error)) {
								throw error;
							}
							return {
								activation: 'deferred',
								error: error.name,
								calls: before - subrequestsAvailable()
							};
						}
					},
					{ subrequests: 17, reserve: 0 }
				);
				expect(result).toStrictEqual({
					activation,
					calls,
					...(contended && {
						error: 'ObjectIncarnationReservationContendedError'
					})
				});
			} finally {
				head.mockRestore();
				put.mockRestore();
				batch.mockRestore();
			}
		}
	);

	it('uses the canonical object metadata after a concurrent promotion', async () => {
		const staged = await verifiableNar('promote-loser');
		const winner = await verifiableNarStored('promote-loser');
		const canonicalKey = narObjectKey(staged.narHash, 2);
		const stagingKey = r2ObjectKeySchema.parse('staging/promote-loser/upload');

		await env.BLOBS.put(stagingKey, staged.narBytes);

		// Hide the canonical object from the first head so the conditional put
		// discovers the competing promotion.
		await env.BLOBS.put(canonicalKey, winner.narBytes, {
			sha256: NixSha256Hash.parse(winner.fileHash).digestBytes()
		});

		const originalHead = env.BLOBS.head.bind(env.BLOBS);
		let isBlinded = true;
		const head = vi
			.spyOn(env.BLOBS, 'head')
			.mockImplementation((key: string) => {
				if (key === canonicalKey && isBlinded) {
					isBlinded = false;

					return originalHead('test/absent');
				}

				return originalHead(key);
			});

		try {
			const blob = await promoteVerifiedBlob(
				drizzleD1(env.CUPBOARD_DB, { schema: d1Schema }),
				env.BLOBS,
				stagingKey,
				{ narHash: staged.narHash, narSize: staged.narSize },
				{ fileHash: staged.fileHash, fileSize: staged.narBytes.byteLength }
			);

			expect(blob).toStrictEqual({
				fileHash: winner.fileHash,
				fileSize: winner.narBytes.byteLength
			});
		} finally {
			head.mockRestore();
		}
	});

	it('does not queue the winner for deletion when ownership expires after a losing put', async () => {
		const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
		const staged = await verifiableNar('promote-lost-ownership');
		const canonicalKey = narObjectKey(staged.narHash, 2);
		const stagingKey = r2ObjectKeySchema.parse(
			'staging/promote-lost-ownership/upload'
		);

		await env.BLOBS.put(stagingKey, staged.narBytes);
		await env.BLOBS.put(canonicalKey, staged.narBytes);

		const originalHead = env.BLOBS.head.bind(env.BLOBS);
		const originalPut = env.BLOBS.put.bind(env.BLOBS);
		let isBlinded = true;
		let isOwned = true;
		const head = vi
			.spyOn(env.BLOBS, 'head')
			.mockImplementation((key: string) => {
				if (key === canonicalKey && isBlinded) {
					isBlinded = false;

					return originalHead('test/absent');
				}

				return originalHead(key);
			});
		const put = vi
			.spyOn(env.BLOBS, 'put')
			.mockImplementation(async (...arguments_) => {
				const written = await originalPut(...arguments_);
				if (arguments_[0] === canonicalKey) {
					isOwned = false;
				}

				return written;
			});

		try {
			const promotion = await stagePromotedBlob(
				database,
				env.BLOBS,
				stagingKey,
				{ narHash: staged.narHash, narSize: staged.narSize },
				{ fileHash: staged.fileHash, fileSize: staged.narBytes.byteLength },
				'promote-lost-ownership',
				() => isOwned
			);
			const markers = await database
				.select({ incarnation: d1Schema.objectDeletion.incarnation })
				.from(d1Schema.objectDeletion)
				.where(eq(d1Schema.objectDeletion.objectId, staged.narHash));

			expect({ promotion, markers }).toStrictEqual({
				promotion: undefined,
				markers: [{ incarnation: 1 }]
			});
		} finally {
			head.mockRestore();
			put.mockRestore();
		}
	});

	it('replaces a legacy state row written after the versioned reservation', async () => {
		const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
		const staged = await verifiableNar('promote-deployment-overlap');
		const stagingKey = r2ObjectKeySchema.parse(
			'staging/promote-deployment-overlap/upload'
		);
		const reserved = await reserveObjectIncarnation(
			database,
			'nar',
			staged.narHash
		);

		await env.BLOBS.put(stagingKey, staged.narBytes);
		await env.BLOBS.put(narObjectKey(staged.narHash), staged.narBytes);
		await database.insert(d1Schema.blobState).values({
			narHash: staged.narHash,
			fileHash: staged.fileHash,
			fileSize: staged.narBytes.byteLength,
			compression: 'zstd',
			narSize: staged.narSize,
			verifiedAt: isoTimestamp(new Date())
		});

		await promoteVerifiedBlob(
			database,
			env.BLOBS,
			stagingKey,
			{ narHash: staged.narHash, narSize: staged.narSize },
			{ fileHash: staged.fileHash, fileSize: staged.narBytes.byteLength }
		);

		const state = await database
			.select({ incarnation: d1Schema.blobState.incarnation })
			.from(d1Schema.blobState)
			.where(eq(d1Schema.blobState.narHash, staged.narHash))
			.get();

		expect({ reserved, state }).toStrictEqual({
			reserved: { incarnation: 2, state: 'pending' },
			state: { incarnation: 2 }
		});
	});

	it('does not report success when the live registry and state versions disagree', async () => {
		const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
		const staged = await verifiableNar('promote-incoherent-state');
		const stagingKey = r2ObjectKeySchema.parse(
			'staging/promote-incoherent-state/upload'
		);

		await reserveObjectIncarnation(database, 'nar', staged.narHash);
		await env.BLOBS.put(stagingKey, staged.narBytes);
		await database.insert(d1Schema.blobState).values({
			narHash: staged.narHash,
			fileHash: staged.fileHash,
			fileSize: staged.narBytes.byteLength,
			compression: 'zstd',
			narSize: staged.narSize,
			incarnation: 3,
			verifiedAt: isoTimestamp(new Date())
		});

		await expect(
			promoteVerifiedBlob(
				database,
				env.BLOBS,
				stagingKey,
				{ narHash: staged.narHash, narSize: staged.narSize },
				{ fileHash: staged.fileHash, fileSize: staged.narBytes.byteLength }
			)
		).rejects.toBeInstanceOf(UploadedObjectNotFoundError);

		const markers = await database
			.select({ incarnation: d1Schema.objectDeletion.incarnation })
			.from(d1Schema.objectDeletion)
			.where(eq(d1Schema.objectDeletion.objectId, staged.narHash));

		expect(markers).toStrictEqual([{ incarnation: 1 }, { incarnation: 2 }]);
	});

	it.each([
		{ promoters: 1, name: 'one promoter' },
		{ promoters: 2, name: 'two concurrent promoters' }
	])(
		'replaces a live incarnation whose NAR object has disappeared with $name',
		async ({ promoters }) => {
			const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
			const staged = await verifiableNar('promote-missing-live-nar');
			const target = { narHash: staged.narHash, narSize: staged.narSize };
			const blob = {
				fileHash: staged.fileHash,
				fileSize: staged.narBytes.byteLength
			};
			const stagingKeys = Array.from({ length: promoters + 1 }, (_, index) =>
				r2ObjectKeySchema.parse(
					`staging/promote-missing-live-nar/upload-${String(index)}`
				)
			);

			for (const stagingKey of stagingKeys) {
				await env.BLOBS.put(stagingKey, staged.narBytes);
			}

			const [firstKey, ...recoveryKeys] = stagingKeys;

			if (firstKey === undefined) {
				throw new Error('the test needs a staging key');
			}

			await promoteVerifiedBlob(database, env.BLOBS, firstKey, target, blob);
			await env.BLOBS.delete(narObjectKey(staged.narHash, 2));
			await Promise.all(
				recoveryKeys.map((stagingKey) =>
					promoteVerifiedBlob(database, env.BLOBS, stagingKey, target, blob)
				)
			);

			const state = await database
				.select({ incarnation: d1Schema.blobState.incarnation })
				.from(d1Schema.blobState)
				.where(eq(d1Schema.blobState.narHash, staged.narHash))
				.all();
			const registry = await database
				.select({
					incarnation: d1Schema.objectIncarnation.incarnation,
					state: d1Schema.objectIncarnation.state
				})
				.from(d1Schema.objectIncarnation)
				.where(eq(d1Schema.objectIncarnation.objectId, staged.narHash))
				.all();
			const markers = await database
				.select({ incarnation: d1Schema.objectDeletion.incarnation })
				.from(d1Schema.objectDeletion)
				.where(eq(d1Schema.objectDeletion.objectId, staged.narHash))
				.orderBy(d1Schema.objectDeletion.incarnation)
				.all();

			expect({
				state,
				registry,
				markers,
				isReplacementPresent:
					(await env.BLOBS.head(narObjectKey(staged.narHash, 3))) !== null
			}).toStrictEqual({
				state: [{ incarnation: 3 }],
				registry: [{ incarnation: 3, state: 'live' }],
				markers: [{ incarnation: 1 }],
				isReplacementPresent: true
			});
		}
	);

	it('rejects when the post-conflict head cannot find the canonical object', async () => {
		const staged = await verifiableNar('promote-vanished');
		const canonicalKey = narObjectKey(staged.narHash, 2);
		const stagingKey = r2ObjectKeySchema.parse(
			'staging/promote-vanished/upload'
		);

		await env.BLOBS.put(stagingKey, staged.narBytes);

		// Keep a real canonical object so the conditional put conflicts, but hide it
		// from both heads so the metadata cannot be adopted after the conflict.
		await env.BLOBS.put(canonicalKey, staged.narBytes);

		const originalHead = env.BLOBS.head.bind(env.BLOBS);
		const head = vi
			.spyOn(env.BLOBS, 'head')
			.mockImplementation((key: string) =>
				originalHead(key === canonicalKey ? 'test/absent' : key)
			);

		try {
			await expect(
				promoteVerifiedBlob(
					drizzleD1(env.CUPBOARD_DB, { schema: d1Schema }),
					env.BLOBS,
					stagingKey,
					{ narHash: staged.narHash, narSize: staged.narSize },
					{ fileHash: staged.fileHash, fileSize: staged.narBytes.byteLength }
				)
			).rejects.toBeInstanceOf(UploadedObjectNotFoundError);
		} finally {
			head.mockRestore();
		}
	});

	it('reports a digest mismatch when the staged bytes changed after verification', async () => {
		const verified = await verifiableNar('promote-verified');
		const replaced = await verifiableNar('promote-replaced');
		const stagingKey = r2ObjectKeySchema.parse(
			'staging/promote-replaced/upload'
		);

		await env.BLOBS.put(stagingKey, replaced.narBytes);

		let failure: unknown;

		try {
			await promoteVerifiedBlob(
				drizzleD1(env.CUPBOARD_DB, { schema: d1Schema }),
				env.BLOBS,
				stagingKey,
				{ narHash: verified.narHash, narSize: verified.narSize },
				{
					fileHash: verified.fileHash,
					fileSize: verified.narBytes.byteLength
				}
			);
		} catch (error) {
			failure = error;
		}

		const stored = await env.BLOBS.list();

		expect({
			isDigestMismatch: failure instanceof StagedObjectDigestMismatchError,
			stagingKey:
				failure instanceof StagedObjectDigestMismatchError
					? failure.stagingKey
					: undefined,
			storedKeys: stored.objects.map((object) => object.key)
		}).toStrictEqual({
			isDigestMismatch: true,
			stagingKey,
			storedKeys: [stagingKey]
		});
	});
});

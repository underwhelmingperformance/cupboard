import { NixSha256Hash } from '@cupboard/nix-store/hash';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as d1Schema from '../db/d1-schema.ts';
import { UploadedObjectNotFoundError } from '../errors.ts';
import { narObjectKey, r2ObjectKeySchema } from '../http/http.ts';
import {
	clearBlobStorage,
	resetTestServer,
	verifiableNar,
	verifiableNarStored
} from '../test-support.ts';

import { reserveObjectIncarnation } from './object-incarnation.ts';
import { promoteVerifiedBlob, stagePromotedBlob } from './promote-blob.ts';

describe('promoteVerifiedBlob', () => {
	beforeEach(async () => {
		await resetTestServer();
		await clearBlobStorage();
	});

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
});

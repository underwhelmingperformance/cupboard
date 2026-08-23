import {
	DEFAULT_CACHE,
	rootNameSchema,
	storePathHashSchema,
	storePathSchema
} from '@cupboard/nix-store/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../db/schema.ts';
import {
	currentServer,
	initialise,
	listRoots,
	listRootTargets,
	narBytes,
	pushPath,
	resetTestServer,
	setRoot,
	uploadMetadata
} from '../test-support.ts';

// The base32 store-path-hash alphabet, so synthetic hashes sort the way the
// keyset pagination does.
const alphabet = '0123456789abcdfghijklmnpqrsvwxyz';

function syntheticHash(index: number): string {
	const suffix =
		alphabet.charAt(Math.floor(index / 32)) + alphabet.charAt(index % 32);

	return `${'0'.repeat(30)}${suffix}`;
}

async function seedTargets(
	name: string,
	indexes: readonly number[]
): Promise<void> {
	await runInDurableObject(currentServer(), (instance) => {
		const rootName = rootNameSchema.parse(name);

		for (const index of indexes) {
			const storePathHash = syntheticHash(index);

			instance.context.db
				.insert(schema.retentionRootTargets)
				.values({
					cache: DEFAULT_CACHE,
					rootName,
					storePathHash: storePathHashSchema.parse(storePathHash),
					storePath: storePathSchema.parse(
						`/nix/store/${storePathHash}-seeded-${String(index)}`
					)
				})
				.onConflictDoNothing()
				.run();
		}
	});
}

function listedRoot(name: string, targetCount: number) {
	return {
		name,
		expiresAt: '2026-01-01T01:00:00.000Z',
		expired: false,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		targetCount
	};
}

describe('root listing bounds', () => {
	beforeEach(resetTestServer);

	it('pages the targets and keeps the cursor stable under a concurrent attach', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		await pushPath(token, metadata);
		await setRoot(token, { name: 'main', targets: [metadata.storePath] });
		await seedTargets('main', [1, 2, 3, 4, 5]);

		const first = await listRootTargets(token, 'main', { limit: 3 });

		// A concurrent attach lands between the pages, at a hash sorting before
		// everything the first page returned: the cursor resumes exactly where
		// that page stopped, so the second page neither repeats nor skips a
		// row, and the new row surfaces on the next full listing.
		await seedTargets('main', [0]);

		const second = await listRootTargets(token, 'main', {
			limit: 3,
			...(first.cursor !== undefined && { cursor: first.cursor })
		});
		const fresh = await listRootTargets(token, 'main', { limit: 3 });

		expect({
			firstHashes: first.targets.map((target) => target.storePathHash),
			firstCursor: first.cursor,
			secondHashes: second.targets.map((target) => target.storePathHash),
			secondCursor: second.cursor,
			freshHashes: fresh.targets.map((target) => target.storePathHash)
		}).toStrictEqual({
			firstHashes: [syntheticHash(1), syntheticHash(2), syntheticHash(3)],
			firstCursor: syntheticHash(3),
			secondHashes: [
				syntheticHash(4),
				syntheticHash(5),
				metadata.storePathHash
			],
			secondCursor: undefined,
			freshHashes: [syntheticHash(0), syntheticHash(1), syntheticHash(2)]
		});
	});

	it('reports the seeded rows absent and the pushed target present, page by page', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		await pushPath(token, metadata);
		await setRoot(token, { name: 'main', targets: [metadata.storePath] });
		await seedTargets('main', [0, 1]);

		const page = await listRootTargets(token, 'main');

		expect(page).toStrictEqual({
			targets: [
				{
					storePathHash: syntheticHash(0),
					storePath: `/nix/store/${syntheticHash(0)}-seeded-0`,
					present: false
				},
				{
					storePathHash: syntheticHash(1),
					storePath: `/nix/store/${syntheticHash(1)}-seeded-1`,
					present: false
				},
				{
					storePathHash: metadata.storePathHash,
					storePath: metadata.storePath,
					present: true
				}
			]
		});
	});

	it('pages the roots listing by name with per-root counts', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		await pushPath(token, metadata);

		for (const name of ['run-a', 'run-b', 'run-c']) {
			await setRoot(token, {
				name,
				targets: [metadata.storePath],
				ttlSeconds: 3600
			});
		}
		await seedTargets('run-b', [0, 1, 2, 3]);

		const first = await listRoots(token, { limit: 2 });
		const second = await listRoots(token, {
			limit: 2,
			...(first.cursor !== undefined && { cursor: first.cursor })
		});

		expect({ first, second }).toStrictEqual({
			first: {
				roots: [listedRoot('run-a', 1), listedRoot('run-b', 5)],
				cursor: 'run-b'
			},
			second: { roots: [listedRoot('run-c', 1)] }
		});
	});
});

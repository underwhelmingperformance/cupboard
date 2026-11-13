import { startCapture } from '@cupboard/logger/testing';
import { runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
	currentServer,
	initialise,
	listRoots,
	listRootTargets,
	narBytes,
	pushPath,
	resetTestServer,
	resolvedCache,
	setRoot,
	uploadMetadata
} from '../test-support.ts';

const liveIncarnation = 7;
const releasedIncarnation = 3;

const requestCostSchema = z.object({
	route: z.string(),
	rowsRead: z.number(),
	rowsWritten: z.number()
});

// Hashes that sort before the pushed path's, so a read that does not skip
// the released rows meets them first.
const insertReleasedTargets = `WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < ?2)
	INSERT INTO retention_root_target (cache_id, root_name, store_path_hash, store_path, incarnation)
	SELECT ?1, 'main', printf('0%031d', n), printf('/nix/store/0%031d-released', n), ?3 FROM sequence`;

const insertLegacyTargets = `WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < 3)
	INSERT INTO retention_root_target (cache_id, root_name, store_path_hash, store_path)
	SELECT ?1, 'legacy', printf('1%031d', n), printf('/nix/store/1%031d-legacy', n) FROM sequence`;

const insertLegacyRoot =
	"INSERT INTO retention_root (cache_id, name, created_at, updated_at) VALUES (?1, 'legacy', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')";

const stampMain =
	"UPDATE retention_root SET incarnation = ?2 WHERE cache_id = ?1 AND name = 'main'";

const stampMainTargets =
	"UPDATE retention_root_target SET incarnation = ?2 WHERE cache_id = ?1 AND root_name = 'main'";

const countMainTargets =
	"SELECT incarnation, count(*) AS targets FROM retention_root_target WHERE root_name = 'main' GROUP BY incarnation ORDER BY incarnation";

const metadata = uploadMetadata({
	fileSize: narBytes.byteLength,
	name: 'live',
	storePathHash: 'z'.repeat(32)
});

function listedRoot(name: string, targetCount: number) {
	return {
		name,
		expired: false,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		targetCount
	};
}

// Replaces every root with `main`, which keeps the pushed path under a
// positive incarnation, `released` rows of an earlier incarnation of
// `main`, and a legacy root.
async function seedRoots(token: string, released: number): Promise<void> {
	await runInDurableObject(currentServer(), (_instance, state) => {
		state.storage.sql.exec('DELETE FROM retention_root_target');
		state.storage.sql.exec('DELETE FROM retention_root');
	});
	await setRoot(token, { name: 'main', targets: [metadata.storePath] });
	await runInDurableObject(currentServer(), (instance, state) => {
		const cacheId = resolvedCache(instance.context).id;

		state.storage.sql.exec(stampMain, cacheId, liveIncarnation);
		state.storage.sql.exec(stampMainTargets, cacheId, liveIncarnation);
		state.storage.sql.exec(
			insertReleasedTargets,
			cacheId,
			released,
			releasedIncarnation
		);
		state.storage.sql.exec(insertLegacyRoot, cacheId);
		state.storage.sql.exec(insertLegacyTargets, cacheId);
	});
}

// Runs `request` and returns its result and the cost that the object logged
// for it.
async function measured<T>(request: () => Promise<T>) {
	const capture = startCapture();

	try {
		const result = await request();
		const costs = capture.logs
			.filter((entry) => entry.message === 'request finished')
			.map((entry) => requestCostSchema.parse(entry.properties));

		return { result, costs };
	} finally {
		capture.stop();
	}
}

async function readRoots(token: string, released: number) {
	await seedRoots(token, released);

	return {
		list: await measured(() => listRoots(token)),
		targets: await measured(() => listRootTargets(token, 'main')),
		legacy: await listRootTargets(token, 'legacy')
	};
}

describe('reading a root through its incarnation', () => {
	beforeEach(resetTestServer);

	it('lists and pages only the live incarnation, at a cost that released rows do not change', async () => {
		const token = await initialise();
		await pushPath(token, metadata);
		const few = await readRoots(token, 10);
		const many = await readRoots(token, 2000);
		const expected = {
			list: {
				result: { roots: [listedRoot('legacy', 3), listedRoot('main', 1)] },
				costs: [{ route: '/roots', rowsRead: 11, rowsWritten: 0 }]
			},
			targets: {
				result: {
					targets: [
						{
							storePathHash: metadata.storePathHash,
							storePath: metadata.storePath,
							present: true
						}
					]
				},
				costs: [
					{ route: '/roots/{name}/targets', rowsRead: 11, rowsWritten: 0 }
				]
			},
			legacy: {
				targets: [1, 2, 3].map((n) => ({
					storePathHash: `1${String(n).padStart(31, '0')}`,
					storePath: `/nix/store/1${String(n).padStart(31, '0')}-legacy`,
					present: false
				}))
			}
		};

		expect({ few, many }).toStrictEqual({ few: expected, many: expected });
	});

	it('keeps a set that names the live targets unchanged, leaving released rows to their release', async () => {
		const token = await initialise();
		await pushPath(token, metadata);
		await seedRoots(token, 10);

		await setRoot(token, { name: 'main', targets: [metadata.storePath] });

		const rows = await runInDurableObject(currentServer(), (_instance, state) =>
			state.storage.sql.exec(countMainTargets).toArray()
		);

		expect(rows).toStrictEqual([
			{ incarnation: releasedIncarnation, targets: 10 },
			{ incarnation: liveIncarnation, targets: 1 }
		]);
	});
});

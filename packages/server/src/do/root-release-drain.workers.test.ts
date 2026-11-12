import { startCapture } from '@cupboard/logger/testing';
import {
	rootNameSchema,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { rootIncarnationSchema } from '../db/root-incarnation.ts';
import {
	authorisedFetch,
	currentServer,
	initialise,
	listRoots,
	listRootTargets,
	narBytes,
	pushPath,
	resetTestServer,
	resolvedCache,
	setRoot,
	testPushId,
	underOneUnitOfWork,
	uploadMetadata,
	withoutAlarmArming
} from '../test-support.ts';

import { collectOneUnitOfWork } from './garbage-collection.test-support.ts';
import { jsonValueList } from './json-list.ts';
import { takenTargetReleasesSelect } from './live-root-targets.ts';

const releasedAt = '2026-01-01T00:00:00.000Z';
const retainUntil = '2026-01-02T00:00:00.000Z';
const before = '2025-12-31T00:00:00.000Z';
const after = '2026-01-01T00:00:01.000Z';

const insertNarInfo =
	"INSERT INTO narinfo (cache_id, store_path_hash, store_path, nar_hash, nar_size, references_json, created_at, retention_epoch) VALUES (?1, ?2, '/nix/store/' || ?2 || '-p', 'sha256:nar', 1, '[]', ?3, ?4)";

const insertTarget =
	"INSERT INTO retention_root_target (cache_id, root_name, store_path_hash, store_path, incarnation) VALUES (?1, ?2, ?3, '/nix/store/' || ?3 || '-p', ?4)";

const insertLegacyTarget =
	"INSERT INTO retention_root_target (cache_id, root_name, store_path_hash, store_path) VALUES (?1, ?2, ?3, '/nix/store/' || ?3 || '-p')";

const insertRoot =
	"INSERT INTO retention_root (cache_id, name, created_at, updated_at, incarnation) VALUES (?1, ?2, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', ?3)";

// An empty deadline and a negative epoch store no value.
const insertRelease =
	"INSERT INTO retention_root_release (cache_id, root_name, incarnation, released_at, retain_until, close_retention_epoch) VALUES (?1, ?2, ?3, ?4, nullif(?5, ''), nullif(?6, -1))";

const insertLegacyRelease =
	'INSERT INTO retention_root_release (cache_id, root_name, released_at) VALUES (?1, ?2, ?3)';

const selectState = {
	releases:
		'SELECT root_name, incarnation IS NULL AS is_legacy FROM retention_root_release ORDER BY id',
	targets:
		'SELECT root_name, incarnation, count(*) AS targets FROM retention_root_target WHERE incarnation IS NOT NULL GROUP BY root_name, incarnation ORDER BY root_name',
	legacyTargets:
		'SELECT count(*) AS targets FROM retention_root_target WHERE incarnation IS NULL',
	grace:
		'SELECT store_path_hash, retain_until FROM retention_grace ORDER BY store_path_hash'
};

function hash(prefix: string): string {
	return `${prefix}${'1'.padStart(31, '0')}`;
}

type SeedStatement = readonly [string, ...unknown[]];

async function seed(
	statements: (cacheId: number) => readonly SeedStatement[]
): Promise<void> {
	await runInDurableObject(currentServer(), (instance, state) => {
		const cacheId = resolvedCache(instance.context).id;

		for (const [query, ...bindings] of statements(cacheId)) {
			state.storage.sql.exec(query, ...bindings);
		}
	});
}

async function storedState() {
	return runInDurableObject(currentServer(), (_instance, state) =>
		Object.fromEntries(
			Object.entries(selectState).map(([name, query]) => [
				name,
				state.storage.sql.exec(query).toArray()
			])
		)
	);
}

describe('root release drain', () => {
	beforeEach(resetTestServer);

	it.each([
		{
			name: 'a release with a deadline',
			deadline: retainUntil,
			closeRetentionEpoch: -1,
			grace: [hash('a'), hash('e')]
		},
		{
			name: 'a closed-root release',
			deadline: retainUntil,
			closeRetentionEpoch: 1,
			grace: [hash('a')]
		},
		{
			name: 'a release without a deadline',
			deadline: '',
			closeRetentionEpoch: -1,
			grace: []
		}
	])(
		'grants $name only to the paths it covers when an alarm drains it',
		async ({ deadline, closeRetentionEpoch, grace }) => {
			await initialise();
			// The release is of incarnation 9 of `run`. `a` was committed before
			// the release and `b` after it; `c` has no narinfo row, and `e` has a
			// later retention epoch than the closed root. `main` keeps `d`.
			await seed((cacheId) => [
				[insertNarInfo, cacheId, hash('a'), before, 0],
				[insertNarInfo, cacheId, hash('b'), after, 0],
				[insertNarInfo, cacheId, hash('e'), before, 2],
				[insertRoot, cacheId, 'main', 5],
				[insertTarget, cacheId, 'main', hash('d'), 5],
				...['a', 'b', 'c', 'e'].map(
					(prefix) => [insertTarget, cacheId, 'run', hash(prefix), 9] as const
				),
				[
					insertRelease,
					cacheId,
					'run',
					9,
					releasedAt,
					deadline,
					closeRetentionEpoch
				]
			]);

			await withoutAlarmArming(() =>
				runInDurableObject(currentServer(), (instance) => instance.alarm())
			);

			expect(await storedState()).toStrictEqual({
				releases: [],
				targets: [{ root_name: 'main', incarnation: 5, targets: 1 }],
				legacyTargets: [{ targets: 0 }],
				grace: grace.map((storePathHash) => ({
					store_path_hash: storePathHash,
					retain_until: retainUntil
				}))
			});
		}
	);

	it('drains a release without an incarnation in pages of its own rows, between the rows of a later incarnation', async () => {
		await initialise();
		// 200 rows of a released legacy incarnation of `run` sort between 100
		// rows of the recreated root's incarnation 12.
		await seed((cacheId) => [
			[insertRoot, cacheId, 'run', 12],
			...Array.from({ length: 300 }, (_, index) => {
				const storePathHash = String(index).padStart(32, '0');

				return index % 3 === 2
					? ([insertTarget, cacheId, 'run', storePathHash, 12] as const)
					: ([insertLegacyTarget, cacheId, 'run', storePathHash] as const);
			}),
			[insertLegacyRelease, cacheId, 'run', releasedAt]
		]);

		await runInDurableObject(currentServer(), (instance) =>
			underOneUnitOfWork(() => instance.resumeRootReleases())
		);
		const afterOneStep = await storedState();
		await runInDurableObject(currentServer(), (instance) =>
			instance.resumeRootReleases()
		);

		expect({ afterOneStep, drained: await storedState() }).toStrictEqual({
			// One step reads and deletes 128 of the rows without an incarnation.
			afterOneStep: {
				releases: [{ root_name: 'run', is_legacy: 1 }],
				targets: [{ root_name: 'run', incarnation: 12, targets: 100 }],
				legacyTargets: [{ targets: 72 }],
				grace: []
			},
			drained: {
				releases: [],
				targets: [{ root_name: 'run', incarnation: 12, targets: 100 }],
				legacyTargets: [{ targets: 0 }],
				grace: []
			}
		});
	});

	it.each([
		{
			name: 'a release with a deadline',
			deadline: retainUntil,
			closeRetentionEpoch: -1,
			grace: [hash('a'), hash('f')]
		},
		{
			name: 'a closed-root release',
			deadline: retainUntil,
			closeRetentionEpoch: 1,
			grace: [hash('a')]
		},
		{
			name: 'a release without a deadline',
			deadline: '',
			closeRetentionEpoch: -1,
			grace: []
		}
	])(
		'grants $name only to the paths it covers when a write takes them back from it',
		async ({ deadline, closeRetentionEpoch, grace }) => {
			const token = await initialise();
			// `run` is at incarnation 12, and the release of incarnation 9 still
			// has the rows of `a`, `b`, `c` and `f`. `a` was committed before the
			// release and `b` after it; `c` has no narinfo row, and `f` has a
			// later retention epoch than the closed root.
			await seed((cacheId) => [
				[insertNarInfo, cacheId, hash('a'), before, 0],
				[insertNarInfo, cacheId, hash('b'), after, 0],
				[insertNarInfo, cacheId, hash('f'), before, 2],
				[insertRoot, cacheId, 'run', 12],
				...['a', 'b', 'c', 'f'].map(
					(prefix) => [insertTarget, cacheId, 'run', hash(prefix), 9] as const
				),
				[
					insertRelease,
					cacheId,
					'run',
					9,
					releasedAt,
					deadline,
					closeRetentionEpoch
				]
			]);

			await withoutAlarmArming(() =>
				setRoot(token, {
					name: 'run',
					targets: ['a', 'b', 'f'].map(
						(prefix) => `/nix/store/${hash(prefix)}-p`
					)
				})
			);
			const taken = await storedState();
			await runInDurableObject(currentServer(), (instance) =>
				instance.resumeRootReleases()
			);
			const deadlines = grace.map((storePathHash) => ({
				store_path_hash: storePathHash,
				retain_until: retainUntil
			}));

			// The set moves the rows of `a`, `b` and `f` into incarnation 12 and
			// grants them what the drain would have granted. The drain then finds
			// only the row of `c`.
			expect({ taken, drained: await storedState() }).toStrictEqual({
				taken: {
					releases: [{ root_name: 'run', is_legacy: 0 }],
					targets: [
						{ root_name: 'run', incarnation: 9, targets: 1 },
						{ root_name: 'run', incarnation: 12, targets: 3 }
					],
					legacyTargets: [{ targets: 0 }],
					grace: deadlines
				},
				drained: {
					releases: [],
					targets: [{ root_name: 'run', incarnation: 12, targets: 3 }],
					legacyTargets: [{ targets: 0 }],
					grace: deadlines
				}
			});
		}
	);

	it('reads the release of a taken row through the release index', async () => {
		await initialise();
		const requested = jsonValueList([storePathHashSchema.parse(hash('a'))]);
		const details = await runInDurableObject(
			currentServer(),
			(instance, state) => {
				const statement = takenTargetReleasesSelect(
					instance.context.db,
					{
						cacheId: resolvedCache(instance.context).id,
						name: rootNameSchema.parse('run'),
						incarnation: rootIncarnationSchema.parse(12)
					},
					requested
				).toSQL();
				const parameters = z
					.array(z.union([z.string(), z.number(), z.null()]))
					.parse(statement.params);

				return Array.from(
					state.storage.sql.exec<{ detail: string }>(
						`EXPLAIN QUERY PLAN ${statement.sql}`,
						...parameters
					),
					(row) => row.detail
				);
			}
		);

		expect(details).toStrictEqual([
			'SEARCH retention_root_target USING INDEX sqlite_autoindex_retention_root_target_1 (cache_id=? AND root_name=? AND store_path_hash=?)',
			'LIST SUBQUERY 1',
			'SCAN json_each VIRTUAL TABLE INDEX 1:',
			'CREATE BLOOM FILTER',
			'SEARCH retention_root_release USING INDEX retention_root_release_root_idx (cache_id=? AND root_name=? AND incarnation=?)'
		]);
	});

	it('removes an expired root from the listing when a scan converts it, and a rebind starts empty', async () => {
		const token = await initialise();
		const kept = uploadMetadata({
			fileSize: narBytes.byteLength,
			name: 'kept',
			storePathHash: 'z'.repeat(32)
		});
		await pushPath(token, kept);
		await setRoot(token, {
			name: 'run',
			targets: [kept.storePath],
			retention: { kind: 'duration', seconds: 3600 }
		});
		// 200 more targets, so the scan's drain takes more than one step.
		await runInDurableObject(currentServer(), (instance, state) => {
			const cacheId = resolvedCache(instance.context).id;

			for (let index = 0; index < 200; index += 1) {
				state.storage.sql.exec(
					"INSERT INTO retention_root_target (cache_id, root_name, store_path_hash, store_path, incarnation) SELECT ?1, 'run', ?2, '/nix/store/' || ?2 || '-p', incarnation FROM retention_root WHERE cache_id = ?1 AND name = 'run'",
					cacheId,
					String(index).padStart(32, '0')
				);
			}
		});

		vi.setSystemTime(new Date('2026-01-01T02:00:00.000Z'));
		await collectOneUnitOfWork();
		// The first token has expired by now.
		const later = await initialise();
		const afterConversion = await listRoots(later);
		// A run's negotiation binds the root again without attaching a path. A
		// bind of the unconverted root would keep its 201 targets.
		await bindRunRoot(later, 'run');
		const rebound = await listRootTargets(later, 'run');
		const { roots } = await listRoots(later);

		expect({
			afterConversion,
			rebound,
			counts: roots.map((root) => [root.name, root.targetCount])
		}).toStrictEqual({
			afterConversion: { roots: [] },
			rebound: { targets: [] },
			counts: [['run', 0]]
		});
	});
});

// Negotiates no path with a run root, which binds the root.
async function bindRunRoot(token: string, name: string): Promise<void> {
	const response = await authorisedFetch('/uploads', token, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			pushId: testPushId,
			paths: [],
			attachRoot: { name, retention: { kind: 'duration', seconds: 3600 } }
		})
	});

	expect(response.status).toBe(StatusCodes.OK);
}

const passCostSchema = z.object({
	method: z.literal('root-release'),
	rowsRead: z.number(),
	rowsWritten: z.number()
});

// The state after one drain step of the 10 rows without an incarnation under
// `run`, whose root has `count` targets.
function drainedLegacyStep(count: number) {
	return {
		costs: [{ method: 'root-release', rowsRead: 90, rowsWritten: 11 }],
		state: {
			releases: [],
			targets: [{ root_name: 'run', incarnation: 12, targets: count }],
			legacyTargets: [{ targets: 0 }],
			grace: []
		}
	};
}

// `count` targets of incarnation 9 of `run`, each with a narinfo row
// committed before the release, and the release of that incarnation.
const insertReleasedTargets = `WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < ?2)
	INSERT INTO retention_root_target (cache_id, root_name, store_path_hash, store_path, incarnation)
	SELECT ?1, 'run', printf('%032d', n), printf('/nix/store/%032d-p', n), 9 FROM sequence`;
const insertReleasedNarInfos = `WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < ?2)
	INSERT INTO narinfo (cache_id, store_path_hash, store_path, nar_hash, nar_size, references_json, created_at)
	SELECT ?1, printf('%032d', n), printf('/nix/store/%032d-p', n), 'sha256:nar', 1, '[]', '${before}' FROM sequence`;

describe('one step of the release drain', () => {
	beforeEach(resetTestServer);

	// Runs one drain step under a one-row budget and returns the cost that the
	// pass logged.
	async function stepCost(count: number) {
		await resetTestServer();
		await initialise();
		await seed((cacheId) => [
			[insertReleasedTargets, cacheId, count],
			[insertReleasedNarInfos, cacheId, count],
			[insertRelease, cacheId, 'run', 9, releasedAt, retainUntil, -1]
		]);
		const capture = startCapture();

		try {
			await runInDurableObject(currentServer(), (instance) =>
				underOneUnitOfWork(() => instance.resumeRootReleases())
			);
		} finally {
			capture.stop();
		}

		return capture.logs
			.filter((entry) => entry.properties.method === 'root-release')
			.map((entry) => passCostSchema.parse(entry.properties));
	}

	it('grants and deletes one page whatever the size of the release', async () => {
		const small = await stepCost(1000);
		const large = await stepCost(10_000);
		const expected = [
			{ method: 'root-release', rowsRead: 1933, rowsWritten: 768 }
		];

		expect({ small, large }).toStrictEqual({
			small: expected,
			large: expected
		});
	});

	// `count` targets of incarnation 12 of `run`, with hashes that sort before
	// the name's 10 rows without an incarnation.
	const insertLiveTargets = `WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < ?2)
		INSERT INTO retention_root_target (cache_id, root_name, store_path_hash, store_path, incarnation)
		SELECT ?1, 'run', printf('%032d', n), printf('/nix/store/%032d-p', n), 12 FROM sequence`;

	// Runs one drain step of a release without an incarnation under `run`,
	// whose root has `count` targets, and returns the logged cost and the
	// stored state.
	async function legacyStep(count: number) {
		await resetTestServer();
		await initialise();
		await seed((cacheId) => [
			[insertRoot, cacheId, 'run', 12],
			[insertLiveTargets, cacheId, count],
			...Array.from(
				{ length: 10 },
				(_, n) =>
					[
						insertLegacyTarget,
						cacheId,
						'run',
						`z${String(n).padStart(31, '0')}`
					] as const
			),
			[insertLegacyRelease, cacheId, 'run', releasedAt]
		]);
		const capture = startCapture();

		try {
			await runInDurableObject(currentServer(), (instance) =>
				underOneUnitOfWork(() => instance.resumeRootReleases())
			);
		} finally {
			capture.stop();
		}

		return {
			costs: capture.logs
				.filter((entry) => entry.properties.method === 'root-release')
				.map((entry) => passCostSchema.parse(entry.properties)),
			state: await storedState()
		};
	}

	it("releases the rows without an incarnation in one step whatever the number of the new root's targets", async () => {
		const small = await legacyStep(1000);
		const large = await legacyStep(10_000);

		expect({ small, large }).toStrictEqual({
			small: drainedLegacyStep(1000),
			large: drainedLegacyStep(10_000)
		});
	});
});

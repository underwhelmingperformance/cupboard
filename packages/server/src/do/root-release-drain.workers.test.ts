import { startCapture } from '@cupboard/logger/testing';
import {
	rootNameSchema,
	storePathHashSchema,
	storePathSchema
} from '@cupboard/nix-store/scalars';
import {
	rootRemoveLeftoverTargetsCapability,
	rootRemoveResponseSchema
} from '@cupboard/protocol/retention';
import { acceptCapabilitiesHeader } from '@cupboard/protocol/upload';
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
	removeRoot,
	resetTestServer,
	resolvedCache,
	setRoot,
	testPushId,
	underOneUnitOfWork,
	uploadMetadata,
	uploadPathNegotiation,
	withoutAlarmArming
} from '../test-support.ts';

import {
	collectOneUnitOfWork,
	useMinScanInterval
} from './garbage-collection.test-support.ts';
import { jsonValueList } from './json-list.ts';
import {
	existingRootIncarnationKey,
	insertLiveRootTargets,
	takenTargetReleasesSelect
} from './live-root-targets.ts';
import { RetentionService } from './retention-service.ts';

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

			// The set gives `run` the new incarnation 1, moves the rows of `a`, `b`
			// and `f` into it, and grants them what the drain would have granted.
			// Incarnation 12 has no row, so the set records no release of it. The
			// drain then finds only the row of `c`.
			expect({ taken, drained: await storedState() }).toStrictEqual({
				taken: {
					releases: [{ root_name: 'run', is_legacy: 0 }],
					targets: [
						{ root_name: 'run', incarnation: 1, targets: 3 },
						{ root_name: 'run', incarnation: 9, targets: 1 }
					],
					legacyTargets: [{ targets: 0 }],
					grace: deadlines
				},
				drained: {
					releases: [],
					targets: [{ root_name: 'run', incarnation: 1, targets: 3 }],
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

function legacyRows(cacheId: number, name: string) {
	return ['a', 'b'].map(
		(prefix) => [insertLegacyTarget, cacheId, name, hash(prefix)] as const
	);
}

describe('removing a root that a set recreated before the drain', () => {
	beforeEach(resetTestServer);

	it('keeps the deadline of the first removal after a second removal without grace', async () => {
		const token = await initialise();
		await seed((cacheId) => [
			[insertNarInfo, cacheId, hash('a'), before, 0],
			['UPDATE cache_identity SET grace_seconds = 86400 WHERE id = ?', cacheId]
		]);
		const path = `/nix/store/${hash('a')}-p`;

		await withoutAlarmArming(async () => {
			await setRoot(token, { name: 'run', targets: [path] });
			await removeRoot(token, 'run');
			await setRoot(token, { name: 'run', targets: [path] });
			await seed((cacheId) => [
				['UPDATE cache_identity SET grace_seconds = 0 WHERE id = ?', cacheId]
			]);
			await removeRoot(token, 'run');
		});
		await runInDurableObject(currentServer(), (instance) =>
			instance.resumeRootReleases()
		);

		// The first removal granted `a` a day of grace. The recreated root took
		// `a` back before the drain, and the second removal grants no grace.
		expect(await storedState()).toStrictEqual({
			releases: [],
			targets: [],
			legacyTargets: [{ targets: 0 }],
			grace: [{ store_path_hash: hash('a'), retain_until: retainUntil }]
		});
	});
});

describe('removing a name that has rows without an incarnation', () => {
	beforeEach(resetTestServer);

	it('releases the rows under a name without a root, with grace, when the drain runs', async () => {
		const token = await initialise();
		// A late attach by an earlier version of cupboard left the rows under a
		// name that has no root.
		await seed((cacheId) => [
			[insertNarInfo, cacheId, hash('a'), before, 0],
			['UPDATE cache_identity SET grace_seconds = 86400 WHERE id = ?', cacheId],
			...legacyRows(cacheId, 'orphan')
		]);

		// Without the alarm, the release pass runs only where the test calls it.
		const removed = await withoutAlarmArming(async () => {
			const response = await authorisedFetch('/roots/orphan', token, {
				method: 'DELETE',
				headers: {
					[acceptCapabilitiesHeader]: rootRemoveLeftoverTargetsCapability
				}
			});

			expect(response.status).toBe(StatusCodes.OK);

			return rootRemoveResponseSchema.parse(await response.json());
		});
		const recorded = await storedState();
		await runInDurableObject(currentServer(), (instance) =>
			instance.resumeRootReleases()
		);

		expect({
			removed,
			recorded,
			drained: await storedState()
		}).toStrictEqual({
			removed: {
				name: 'orphan',
				removed: false,
				releasedLeftoverTargets: true
			},
			recorded: {
				releases: [{ root_name: 'orphan', is_legacy: 1 }],
				targets: [],
				legacyTargets: [{ targets: 2 }],
				grace: []
			},
			drained: {
				releases: [],
				targets: [],
				legacyTargets: [{ targets: 0 }],
				grace: [{ store_path_hash: hash('a'), retain_until: retainUntil }]
			}
		});
	});

	it('lists no target of a removed root without an incarnation before the drain reaches its rows', async () => {
		const token = await initialise();
		await seed((cacheId) => [
			[
				"INSERT INTO retention_root (cache_id, name, created_at, updated_at) VALUES (?1, 'old', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
				cacheId
			],
			...legacyRows(cacheId, 'old')
		]);

		await withoutAlarmArming(() => removeRoot(token, 'old'));
		const page = await listRootTargets(token, 'old');
		const { legacyTargets } = await storedState();

		expect({ page, legacyTargets }).toStrictEqual({
			page: { targets: [] },
			legacyTargets: [{ targets: 2 }]
		});
	});

	it.each([
		{
			name: 'a second removal of a root without an incarnation',
			statements: (cacheId: number): readonly SeedStatement[] => [
				[
					"INSERT INTO retention_root (cache_id, name, created_at, updated_at) VALUES (?1, 'old', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
					cacheId
				],
				...legacyRows(cacheId, 'old')
			],
			isRepeated: true,
			releases: [{ root_name: 'old', is_legacy: 1 }],
			targets: [],
			legacyTargets: 2
		},
		{
			name: 'a removal of a name that has only rows of a released incarnation',
			statements: (cacheId: number): readonly SeedStatement[] => [
				[insertTarget, cacheId, 'old', hash('a'), 9],
				[insertRelease, cacheId, 'old', 9, releasedAt, retainUntil, -1]
			],
			isRepeated: false,
			releases: [{ root_name: 'old', is_legacy: 0 }],
			targets: [{ root_name: 'old', incarnation: 9, targets: 1 }],
			legacyTargets: 0
		}
	])(
		'records no release without an incarnation for $name',
		async ({ statements, isRepeated, releases, targets, legacyTargets }) => {
			const token = await initialise();
			await seed(statements);

			const last = await withoutAlarmArming(async () => {
				const first = await removeRoot(token, 'old');

				return isRepeated ? removeRoot(token, 'old') : first;
			});

			expect({ last, state: await storedState() }).toStrictEqual({
				last: { name: 'old', removed: false },
				state: {
					releases,
					targets,
					legacyTargets: [{ targets: legacyTargets }],
					grace: []
				}
			});
		}
	);

	it('releases the rows without an incarnation when a run negotiation creates the run root', async () => {
		const token = await initialise();
		await seed((cacheId) => [
			[insertNarInfo, cacheId, hash('a'), before, 0],
			[insertNarInfo, cacheId, hash('b'), before, 0],
			['UPDATE cache_identity SET grace_seconds = 86400 WHERE id = ?', cacheId],
			...legacyRows(cacheId, 'orphan')
		]);

		await withoutAlarmArming(() => bindRunRoot(token, 'orphan'));
		const recorded = await storedState();
		await runInDurableObject(currentServer(), (instance) =>
			instance.resumeRootReleases()
		);
		const drained = await storedState();
		const page = await listRootTargets(token, 'orphan');

		expect({
			recorded: recorded.releases,
			releases: drained.releases,
			legacyTargets: drained.legacyTargets,
			grace: drained.grace,
			page
		}).toStrictEqual({
			recorded: [{ root_name: 'orphan', is_legacy: 1 }],
			releases: [],
			legacyTargets: [{ targets: 0 }],
			grace: [
				{ store_path_hash: hash('a'), retain_until: retainUntil },
				{ store_path_hash: hash('b'), retain_until: retainUntil }
			],
			page: { targets: [] }
		});
	});

	it('keeps a path that a root attaches between its create-time release and the drain', async () => {
		const token = await initialise();
		await seed((cacheId) => [
			[insertNarInfo, cacheId, hash('a'), before, 0],
			[insertNarInfo, cacheId, hash('b'), before, 0],
			['UPDATE cache_identity SET grace_seconds = 86400 WHERE id = ?', cacheId],
			...legacyRows(cacheId, 'orphan')
		]);

		await withoutAlarmArming(() => bindRunRoot(token, 'orphan'));
		await runInDurableObject(currentServer(), (instance) => {
			const cache = resolvedCache(instance.context);
			const root = existingRootIncarnationKey(
				instance.context.db,
				cache.id,
				rootNameSchema.parse('orphan')
			);

			if (root !== undefined) {
				insertLiveRootTargets(
					instance.context.db,
					new RetentionService(instance.context),
					cache,
					root,
					[
						{
							storePathHash: storePathHashSchema.parse(hash('a')),
							storePath: storePathSchema.parse(`/nix/store/${hash('a')}-p`)
						}
					]
				);
			}
		});
		await runInDurableObject(currentServer(), (instance) =>
			instance.resumeRootReleases()
		);
		const drained = await storedState();
		const page = await listRootTargets(token, 'orphan');

		// The attach moves `a` into the root's incarnation and grants it the
		// release's deadline. The drain then grants `b` the deadline and deletes
		// only its row.
		expect({
			releases: drained.releases,
			legacyTargets: drained.legacyTargets,
			grace: drained.grace,
			page: page.targets.map((target) => target.storePathHash)
		}).toStrictEqual({
			releases: [],
			legacyTargets: [{ targets: 0 }],
			grace: [
				{ store_path_hash: hash('a'), retain_until: retainUntil },
				{ store_path_hash: hash('b'), retain_until: retainUntil }
			],
			page: [hash('a')]
		});
	});

	it.each([
		{
			name: 'a set',
			act: async (token: string) => {
				await setRoot(token, {
					name: 'orphan',
					targets: [`/nix/store/${hash('a')}-p`]
				});
			},
			taken: hash('a'),
			granted: [hash('b')]
		},
		{
			// An ensure needs a target that the cache can serve, so it ensures a
			// pushed path, which gets the cache's grace from its push.
			name: 'an ensure',
			act: async (token: string) => {
				const pushed = uploadMetadata({
					fileSize: narBytes.byteLength,
					name: 'pushed',
					storePathHash: 'z'.repeat(32)
				});
				await pushPath(token, pushed);
				const response = await authorisedFetch('/roots/orphan/ensure', token, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ targets: [pushed.storePath] })
				});

				expect(response.status).toBe(StatusCodes.OK);
			},
			taken: 'z'.repeat(32),
			granted: [hash('a'), hash('b'), 'z'.repeat(32)]
		},
		{
			name: 'a batch entry',
			act: async (token: string) => {
				const response = await authorisedFetch('/roots/batch', token, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						roots: [
							{
								action: 'set',
								name: 'orphan',
								targets: [`/nix/store/${hash('a')}-p`]
							}
						]
					})
				});

				expect(response.status).toBe(StatusCodes.OK);
			},
			taken: hash('a'),
			granted: [hash('b')]
		}
	])(
		'releases the other rows without an incarnation when $name creates the root',
		async ({ act, taken, granted }) => {
			const token = await initialise();
			await seed((cacheId) => [
				[insertNarInfo, cacheId, hash('a'), before, 0],
				[insertNarInfo, cacheId, hash('b'), before, 0],
				[
					'UPDATE cache_identity SET grace_seconds = 86400 WHERE id = ?',
					cacheId
				],
				...legacyRows(cacheId, 'orphan')
			]);

			await withoutAlarmArming(() => act(token));
			const recorded = await storedState();
			await runInDurableObject(currentServer(), (instance) =>
				instance.resumeRootReleases()
			);
			const drained = await storedState();
			const page = await listRootTargets(token, 'orphan');

			// The request takes its target into the root's incarnation, and the
			// release grants the other rows the cache's grace.
			expect({
				recorded: recorded.releases,
				releases: drained.releases,
				legacyTargets: drained.legacyTargets,
				grace: drained.grace,
				page: page.targets.map((target) => target.storePathHash)
			}).toStrictEqual({
				recorded: [{ root_name: 'orphan', is_legacy: 1 }],
				releases: [],
				legacyTargets: [{ targets: 0 }],
				grace: granted.map((storePathHash) => ({
					store_path_hash: storePathHash,
					retain_until: retainUntil
				})),
				page: [taken]
			});
		}
	);
});

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

describe('a root of an earlier version of cupboard', () => {
	beforeEach(resetTestServer);

	// `legacy` has no incarnation and keeps `a` and `b`, which have narinfo
	// rows. The cache has a day of grace.
	async function seedLegacyRoot(expiresAt: string): Promise<string> {
		const token = await initialise();
		await seed((cacheId) => [
			[insertNarInfo, cacheId, hash('a'), before, 0],
			[insertNarInfo, cacheId, hash('b'), before, 0],
			['UPDATE cache_identity SET grace_seconds = 86400 WHERE id = ?', cacheId],
			[
				"INSERT INTO retention_root (cache_id, name, expires_at, created_at, updated_at) VALUES (?1, 'legacy', ?2, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
				cacheId,
				expiresAt
			],
			...legacyRows(cacheId, 'legacy')
		]);

		return token;
	}

	it('lists, pages and attaches to the root as before', async () => {
		const token = await seedLegacyRoot('2099-01-01T00:00:00.000Z');
		const attached = uploadMetadata({
			fileSize: narBytes.byteLength,
			name: 'attached',
			storePathHash: 'z'.repeat(32)
		});
		await pushPath(token, attached);
		const response = await authorisedFetch('/uploads', token, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				pushId: testPushId,
				paths: [uploadPathNegotiation(attached)],
				attachRoot: { name: 'legacy', retention: { kind: 'inherit' } }
			})
		});

		expect(response.status).toBe(StatusCodes.OK);

		const listed = await listRoots(token);
		const page = await listRootTargets(token, 'legacy');
		const state = await storedState();

		expect({
			counts: listed.roots.map((root) => [root.name, root.targetCount]),
			page: page.targets.map((target) => target.storePathHash),
			state
		}).toStrictEqual({
			counts: [['legacy', 3]],
			page: [hash('a'), hash('b'), attached.storePathHash],
			state: {
				releases: [],
				targets: [],
				legacyTargets: [{ targets: 3 }],
				// The push grants its path the cache's grace.
				grace: [
					{ store_path_hash: attached.storePathHash, retain_until: retainUntil }
				]
			}
		});
	});

	it.each([
		{
			name: 'a set',
			expiresAt: '2099-01-01T00:00:00.000Z',
			act: async (token: string) => {
				await setRoot(token, {
					name: 'legacy',
					targets: [`/nix/store/${hash('a')}-p`]
				});
			},
			targets: 1,
			grace: [hash('b')],
			retainUntil
		},
		{
			name: 'a removal',
			expiresAt: '2099-01-01T00:00:00.000Z',
			act: async (token: string) => {
				await removeRoot(token, 'legacy');
			},
			targets: 0,
			grace: [hash('a'), hash('b')],
			retainUntil
		},
		{
			name: 'an expiry',
			expiresAt: '2025-12-31T12:00:00.000Z',
			act: async () => {
				await useMinScanInterval(0);
				await collectOneUnitOfWork();
			},
			targets: 0,
			grace: [hash('a'), hash('b')],
			retainUntil: '2026-01-01T12:00:00.000Z'
		}
	])(
		'releases the old targets with grace after $name',
		async ({ expiresAt, act, targets, grace, retainUntil: deadline }) => {
			const token = await seedLegacyRoot(expiresAt);

			await act(token);
			await runInDurableObject(currentServer(), (instance) =>
				instance.resumeRootReleases()
			);
			const state = await storedState();
			const live = await runInDurableObject(
				currentServer(),
				(_instance, state) =>
					state.storage.sql
						.exec<{ live: number }>(
							'SELECT count(*) AS live FROM retention_root_target WHERE incarnation IS NOT NULL'
						)
						.one().live
			);

			expect({
				releases: state.releases,
				live,
				legacyTargets: state.legacyTargets,
				grace: state.grace
			}).toStrictEqual({
				releases: [],
				live: targets,
				legacyTargets: [{ targets: 0 }],
				grace: grace.map((storePathHash) => ({
					store_path_hash: storePathHash,
					retain_until: deadline
				}))
			});
		}
	);
});

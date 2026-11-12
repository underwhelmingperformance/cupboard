import { storePathHashSchema } from '@cupboard/nix-store/scalars';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import { runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
	currentServer,
	initialise,
	removeRoot,
	resetTestServer,
	resolvedCache,
	setRoot,
	withoutAlarmArming
} from '../test-support.ts';

import {
	collectOneUnitOfWork,
	insertNarInfo,
	storePathString,
	useMinScanInterval
} from './garbage-collection.test-support.ts';

const daySeconds = 86_400;

// `kept` stays a target of `main`. `released` and `spare` are targets of
// `run` that the scenarios release; no root keeps `added` at first.
const kept = storePathHashSchema.parse('k'.repeat(32));
const released = storePathHashSchema.parse('r'.repeat(32));
const spare = storePathHashSchema.parse('s'.repeat(32));
const added = storePathHashSchema.parse('v'.repeat(32));

const paths = [kept, released, spare, added];

type ScanPhase =
	'expire-roots' | 'expire-grace' | 'roots' | 'grace' | 'mark' | 'collect';

async function setTargets(
	token: string,
	name: string,
	targets: readonly string[]
): Promise<void> {
	await setRoot(token, {
		name,
		targets: targets.map((target) =>
			storePathString(storePathHashSchema.parse(target))
		)
	});
}

async function sql(query: string, ...bindings: unknown[]): Promise<void> {
	await runInDurableObject(currentServer(), (_instance, state) => {
		state.storage.sql.exec(query, ...bindings);
	});
}

async function scanPhase(): Promise<string | undefined> {
	return runInDurableObject(
		currentServer(),
		(_instance, state) =>
			state.storage.sql
				.exec<{ phase: string }>('SELECT phase FROM garbage_collection_scan')
				.toArray()[0]?.phase
	);
}

// Runs one unit of collection work at a time until the scan reaches
// `phase`. Each unit advances the scan by one step, so the test observes
// every phase that the scan enters after its first step.
async function advanceScanTo(phase: ScanPhase): Promise<void> {
	while ((await scanPhase()) !== phase) {
		await collectOneUnitOfWork();
	}
}

async function finishScan(): Promise<void> {
	do {
		await collectOneUnitOfWork();
	} while ((await scanPhase()) !== undefined);
}

async function drainReleases(): Promise<void> {
	await runInDurableObject(currentServer(), (instance) =>
		instance.resumeRootReleases()
	);
}

// Drains every release, then runs one complete scan from the start.
async function settle(): Promise<void> {
	await drainReleases();
	await sql(
		'UPDATE garbage_collection_input SET inputs_changed = 1, scan_completed_at = NULL'
	);
	await finishScan();
}

async function remaining() {
	return runInDurableObject(currentServer(), (_instance, state) => ({
		narInfos: Array.from(
			state.storage.sql.exec<{ hash: string }>(
				'SELECT store_path_hash AS hash FROM narinfo ORDER BY store_path_hash'
			),
			(row) => row.hash
		),
		runTargets: Array.from(
			state.storage.sql.exec<{ hash: string }>(
				"SELECT store_path_hash AS hash FROM retention_root_target WHERE root_name = 'run' ORDER BY store_path_hash"
			),
			(row) => row.hash
		),
		releases: state.storage.sql
			.exec('SELECT root_name FROM retention_root_release')
			.toArray()
	}));
}

interface Scenario {
	readonly name: string;
	readonly graceSeconds: number;
	readonly act: (token: string) => Promise<void>;
	readonly narInfos: readonly string[];
	readonly runTargets?: readonly string[];
}

// Releases `released` by emptying `run` while the scan is in `phase`, and
// drains the release before the scan moves on.
function drainDuring(phase: ScanPhase): Scenario {
	return {
		name: `a drain step while the scan is in ${phase} keeps the released path in grace`,
		graceSeconds: daySeconds,
		act: async (token) => {
			await advanceScanTo(phase);
			await setTargets(token, 'run', []);
			await drainReleases();
			await finishScan();
		},
		narInfos: [kept, released]
	};
}

// A grace period of 0 marks the cache grace-managed and grants no deadline,
// so a released path becomes collectable.
const noGrace = 0;

const scenarios: readonly Scenario[] = [
	{
		name: 'the expire-roots phase drains a release recorded before the scan',
		graceSeconds: daySeconds,
		act: async (token) => {
			await setTargets(token, 'run', []);
			await finishScan();
		},
		narInfos: [kept, released]
	},
	...(['expire-grace', 'roots', 'grace', 'mark', 'collect'] as const).map(
		(phase) => drainDuring(phase)
	),
	{
		name: 'a release without grace leaves the path collectable once drained',
		graceSeconds: noGrace,
		act: async (token) => {
			await setTargets(token, 'run', []);
		},
		narInfos: [kept]
	},
	{
		name: 'a set during a scan moves kept targets, adds new ones and releases the rest',
		graceSeconds: daySeconds,
		act: async (token) => {
			await setTargets(token, 'run', [released, spare]);
			await advanceScanTo('mark');
			await setTargets(token, 'run', [released, added]);
			await finishScan();
		},
		narInfos: [added, kept, released, spare],
		runTargets: [released, added].toSorted(byCodeUnit)
	},
	{
		name: 'a removal during a scan keeps the released path in grace',
		graceSeconds: daySeconds,
		act: async (token) => {
			await advanceScanTo('collect');
			await removeRoot(token, 'main');
			await finishScan();
		},
		narInfos: [kept, released],
		runTargets: [released]
	},
	{
		name: 'a root recreated before its release drains keeps the path that it takes back',
		graceSeconds: noGrace,
		act: async (token) => {
			await removeRoot(token, 'run');
			await setTargets(token, 'run', [released]);
		},
		narInfos: [kept, released],
		runTargets: [released]
	},
	{
		name: 'a root recreated after its release drains keeps the path that it takes back',
		graceSeconds: noGrace,
		act: async (token) => {
			await removeRoot(token, 'run');
			await drainReleases();
			await setTargets(token, 'run', [released]);
		},
		narInfos: [kept, released],
		runTargets: [released]
	},
	{
		name: 'a path committed again after its release gets no grace from it',
		graceSeconds: daySeconds,
		act: async (token) => {
			await setTargets(token, 'run', []);
			await sql(
				"UPDATE narinfo SET created_at = '2026-01-01T00:00:01.000Z' WHERE store_path_hash = ?",
				released
			);
		},
		narInfos: [kept]
	},
	{
		name: 'a drain after the deadline grants a deadline that the next scan expires',
		graceSeconds: 1,
		act: async (token) => {
			await setTargets(token, 'run', []);
			vi.setSystemTime(new Date('2026-01-01T01:00:00.000Z'));
		},
		narInfos: [kept]
	},
	{
		// The close also expires `main`, whose closed-root release grants the
		// close's deadline, which has passed.
		name: 'a cache close between the release and the drain keeps the recorded deadline',
		graceSeconds: daySeconds,
		act: async (token) => {
			await setTargets(token, 'run', []);
			await runInDurableObject(currentServer(), (instance, state) => {
				const cacheId = resolvedCache(instance.context).id;

				state.storage.sql.exec(
					"INSERT INTO cache_close_event (cache_id, epoch, closed_at, grace_until) VALUES (?1, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
					cacheId
				);
				state.storage.sql.exec(
					'UPDATE cache_identity SET retention_epoch = 1 WHERE id = ?',
					cacheId
				);
			});
		},
		narInfos: [released]
	},
	{
		name: 'two pending releases of one root each grant their own paths',
		graceSeconds: daySeconds,
		act: async (token) => {
			await setTargets(token, 'run', [released, spare]);
			await setTargets(token, 'run', [spare]);
			await setTargets(token, 'run', []);
		},
		narInfos: [kept, released, spare]
	}
];

describe('collection while root releases drain', () => {
	beforeEach(async () => {
		await resetTestServer();
		await useMinScanInterval(0);
	});

	it.each(scenarios)(
		'$name',
		async ({ graceSeconds, act, narInfos, runTargets }) => {
			const token = await initialise();
			// An alarm could drain a release before `act` finishes, so only
			// `settle` drains them.
			await withoutAlarmArming(async () => {
				await runInDurableObject(currentServer(), (instance, state) => {
					for (const [index, path] of paths.entries()) {
						insertNarInfo(instance.context, path, index);
					}

					state.storage.sql.exec(
						'UPDATE cache_identity SET grace_seconds = ?1 WHERE id = ?2',
						graceSeconds,
						resolvedCache(instance.context).id
					);
				});
				await setTargets(token, 'main', [kept]);
				await setTargets(token, 'run', [released]);

				await act(token);
				await settle();
			});

			expect(await remaining()).toStrictEqual({
				narInfos: narInfos.toSorted(byCodeUnit),
				runTargets: runTargets ?? [],
				releases: []
			});
		}
	);
});

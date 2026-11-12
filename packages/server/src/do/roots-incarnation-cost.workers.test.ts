import { startCapture } from '@cupboard/logger/testing';
import { runInDurableObject } from 'cloudflare:test';
import { StatusCodes } from 'http-status-codes';
import { describe, expect, it, onTestFinished } from 'vitest';
import { z } from 'zod';

import {
	deliverAlarms,
	ignoreAlarmDeliveries
} from '../alarm-fence.test-support.ts';
import {
	authorisedFetch,
	currentServer,
	initialise,
	namedCache,
	narBytes,
	pushPath,
	putTestCache,
	resetTestServer,
	resolvedCache,
	setRoot,
	uploadMetadata
} from '../test-support.ts';

import {
	markCacheRemoved,
	seedCacheRows
} from './cache-teardown.test-support.ts';

const smallRoot = 149;
const largeRoot = 10_000;

// D1 rows written are left out: the first request of a test writes two more
// D1 rows than a later one, whatever the size of the root.
const requestCostSchema = z.object({
	route: z.string(),
	rowsRead: z.number(),
	rowsWritten: z.number(),
	d1Calls: z.number(),
	d1RowsRead: z.number(),
	r2Head: z.number(),
	r2Get: z.number()
});

const targetPath = `/nix/store/${'z'.repeat(32)}-next`;

// `count` rows of one root under one incarnation, with hashes that start
// with `prefix`.
const insertTargets = `WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < ?3)
	INSERT INTO retention_root_target (cache_id, root_name, store_path_hash, store_path, incarnation)
	SELECT ?1, ?2, printf('%s%031d', ?4, n), printf('/nix/store/%s%031d-p', ?4, n), ?5 FROM sequence`;

const insertLegacyTargets = `WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < 100)
	INSERT INTO retention_root_target (cache_id, root_name, store_path_hash, store_path)
	SELECT ?1, 'legacy', printf('l%031d', n), printf('/nix/store/l%031d-p', n) FROM sequence`;

// Half of the deadlines have passed.
const insertGrace = `WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < 100)
	INSERT INTO retention_grace (cache_id, store_path_hash, retain_until)
	SELECT ?1, printf('g%031d', n), CASE WHEN n % 2 = 0 THEN '2020-01-01T00:00:00.000Z' ELSE '2099-01-01T00:00:00.000Z' END FROM sequence`;

const insertLegacyRoot =
	"INSERT INTO retention_root (cache_id, name, created_at, updated_at) VALUES (?1, 'legacy', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')";

const insertRelease =
	"INSERT INTO retention_root_release (cache_id, root_name, incarnation, released_at) VALUES (?1, 'big', ?2, '2026-01-01T00:00:00.000Z')";

const selectIncarnation =
	'SELECT incarnation FROM retention_root WHERE name = ?';

interface RootRequest {
	readonly name: string;
	readonly path: string;
	readonly init: RequestInit;
	readonly cost: z.infer<typeof requestCostSchema>;
}

function json(method: string, body: unknown): RequestInit {
	return {
		method,
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	};
}

const requests: readonly RootRequest[] = [
	{
		name: 'set',
		path: '/roots/big',
		init: json('PUT', { targets: [targetPath] }),
		cost: {
			route: '/roots/{name}',
			rowsRead: 47,
			rowsWritten: 8,
			d1Calls: 3,
			d1RowsRead: 7,
			r2Head: 2,
			r2Get: 0
		}
	},
	{
		name: 'ensure',
		path: '/roots/big/ensure',
		init: json('POST', { targets: [targetPath] }),
		cost: {
			route: '/roots/{name}/ensure',
			rowsRead: 52,
			rowsWritten: 8,
			d1Calls: 3,
			d1RowsRead: 7,
			r2Head: 2,
			r2Get: 0
		}
	},
	{
		name: 'batch',
		path: '/roots/batch',
		init: json('POST', {
			roots: [{ action: 'set', name: 'big', targets: [targetPath] }]
		}),
		cost: {
			route: '/roots/batch',
			rowsRead: 50,
			rowsWritten: 8,
			d1Calls: 3,
			d1RowsRead: 7,
			r2Head: 2,
			r2Get: 0
		}
	},
	{
		name: 'remove',
		path: '/roots/big',
		init: { method: 'DELETE' },
		cost: {
			route: '/roots/{name}',
			rowsRead: 26,
			rowsWritten: 5,
			d1Calls: 1,
			d1RowsRead: 1,
			r2Head: 0,
			r2Get: 0
		}
	}
];

// Pushes the target and seeds a removed cache that is still draining.
async function seedTenant(token: string): Promise<void> {
	await pushPath(
		token,
		uploadMetadata({
			fileSize: narBytes.byteLength,
			name: 'next',
			storePathHash: 'z'.repeat(32)
		})
	);
	await putTestCache(token, namedCache('gone'));
	await runInDurableObject(currentServer(), async (instance, state) => {
		seedCacheRows(
			instance.context,
			state.storage,
			instance.context.cacheRepository.require(namedCache('gone')),
			'r',
			50
		);
		await markCacheRemoved(instance.context, state.storage, namedCache('gone'));
	});
}

// Replaces the default cache's roots. `big` keeps the target and `live`
// more paths, and the cache gets rows in every state that a root request
// must not read: `earlier` rows of an undrained earlier incarnation of
// `big`, a legacy root, an expired root, another root, and live and passed
// grace deadlines.
async function seedRoots(
	token: string,
	live: number,
	earlier: number
): Promise<void> {
	await runInDurableObject(currentServer(), (instance, state) => {
		const cacheId = resolvedCache(instance.context).id;

		for (const table of [
			'retention_root_release',
			'retention_root_target',
			'retention_root',
			'retention_grace'
		]) {
			state.storage.sql.exec(
				`DELETE FROM ${table} WHERE cache_id = ?`,
				cacheId
			);
		}
	});

	for (const name of ['big', 'other']) {
		await setRoot(token, { name, targets: [targetPath] });
	}

	await setRoot(token, {
		name: 'expired',
		targets: [targetPath],
		retention: { kind: 'duration', seconds: 1 }
	});

	await runInDurableObject(currentServer(), (instance, state) => {
		const cacheId = resolvedCache(instance.context).id;
		const incarnationOf = (name: string): number =>
			state.storage.sql
				.exec<{ incarnation: number }>(selectIncarnation, name)
				.one().incarnation;
		const big = incarnationOf('big');
		const released = big + 1_000_000;

		// The recursive sequence always yields its first row.
		if (live > 0) {
			state.storage.sql.exec(insertTargets, cacheId, 'big', live, 'b', big);
		}

		state.storage.sql.exec(
			insertTargets,
			cacheId,
			'big',
			earlier,
			'e',
			released
		);
		state.storage.sql.exec(insertRelease, cacheId, released);
		state.storage.sql.exec(
			insertTargets,
			cacheId,
			'other',
			100,
			'o',
			incarnationOf('other')
		);
		state.storage.sql.exec(insertLegacyRoot, cacheId);
		state.storage.sql.exec(insertLegacyTargets, cacheId);
		state.storage.sql.exec(insertGrace, cacheId);
	});
}

// Sends one request and returns its status and the cost that the object
// logged for it.
async function measuredRequest(token: string, request: RootRequest) {
	const capture = startCapture();

	try {
		const response = await authorisedFetch(request.path, token, request.init);
		await response.text();
		const costs = capture.logs
			.filter((entry) => entry.message === 'request finished')
			.map((entry) => requestCostSchema.parse(entry.properties));

		return { status: response.status, costs };
	} finally {
		capture.stop();
	}
}

// The incarnation counter, the release rows and the default cache's
// collection-input flag.
async function releaseState() {
	return runInDurableObject(currentServer(), (instance, state) => ({
		workSequence: state.storage.sql
			.exec<{ value: number }>('SELECT value FROM work_sequence WHERE id = 1')
			.one().value,
		releases: state.storage.sql
			.exec('SELECT root_name FROM retention_root_release ORDER BY id')
			.toArray(),
		inputsChanged: state.storage.sql
			.exec<{ inputsChanged: number }>(
				'SELECT inputs_changed AS inputsChanged FROM garbage_collection_input WHERE cache_id = ?',
				resolvedCache(instance.context).id
			)
			.one().inputsChanged
	}));
}

async function seededTenant(): Promise<string> {
	await resetTestServer();
	const token = await initialise();
	await seedTenant(token);
	// An alarm would drain the seeded releases before the request.
	const id = currentServer().id;
	ignoreAlarmDeliveries(id);
	onTestFinished(() => {
		deliverAlarms(id);
	});

	return token;
}

describe('root request cost', () => {
	it.each(requests)(
		'answers $name at a cost that the number of stored targets does not change',
		async (request) => {
			const token = await seededTenant();
			const measure = async (size: number) => {
				await seedRoots(token, size, size);

				return measuredRequest(token, request);
			};

			const small = await measure(smallRoot);
			const large = await measure(largeRoot);
			const expected = { status: StatusCodes.OK, costs: [request.cost] };

			expect({ small, large }).toStrictEqual({
				small: expected,
				large: expected
			});
		}
	);

	it('keeps an unchanged root without an incarnation, a release or a collection input', async () => {
		const token = await seededTenant();
		const ensure = requests.find((request) => request.name === 'ensure');
		const measure = async (size: number) => {
			await seedRoots(token, 0, size);
			await runInDurableObject(currentServer(), (_instance, state) => {
				state.storage.sql.exec(
					'UPDATE garbage_collection_input SET inputs_changed = 0'
				);
			});
			const before = await releaseState();
			const response =
				ensure === undefined ? undefined : await measuredRequest(token, ensure);

			return { before, response, after: await releaseState() };
		};

		const small = await measure(smallRoot);
		const large = await measure(largeRoot);

		// The request writes only the root's update time.
		expect({ small, large }).toStrictEqual({
			small: {
				before: small.before,
				after: small.before,
				response: { status: StatusCodes.OK, costs: [unchangedEnsureCost] }
			},
			large: {
				before: large.before,
				after: large.before,
				response: { status: StatusCodes.OK, costs: [unchangedEnsureCost] }
			}
		});
	});

	// The seed releases an earlier incarnation of `big`, and the first removal
	// releases its current one. The second removal finds no root, and the
	// released rows of both are still waiting for the drain.
	it('answers a repeated removal at a cost that the undrained released rows do not change', async () => {
		const token = await seededTenant();
		const remove = requests.find((request) => request.name === 'remove');
		const measure = async (size: number) => {
			await seedRoots(token, size, size);

			if (remove !== undefined) {
				await measuredRequest(token, remove);
			}

			return remove === undefined ? undefined : measuredRequest(token, remove);
		};

		const small = await measure(smallRoot);
		const large = await measure(largeRoot);
		const expected = { status: StatusCodes.OK, costs: [repeatedRemovalCost] };

		expect({ small, large }).toStrictEqual({
			small: expected,
			large: expected
		});
	});
});

const repeatedRemovalCost: z.infer<typeof requestCostSchema> = {
	route: '/roots/{name}',
	rowsRead: 16,
	rowsWritten: 0,
	d1Calls: 1,
	d1RowsRead: 1,
	r2Head: 0,
	r2Get: 0
};

const unchangedEnsureCost: z.infer<typeof requestCostSchema> = {
	route: '/roots/{name}/ensure',
	rowsRead: 39,
	rowsWritten: 1,
	d1Calls: 3,
	d1RowsRead: 7,
	r2Head: 2,
	r2Get: 0
};

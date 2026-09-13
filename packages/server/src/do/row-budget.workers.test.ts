import { storePathHashSchema } from '@cupboard/nix-store/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../db/schema.ts';
import { MissingRowBudgetError } from '../errors.ts';
import {
	currentServer,
	initialise,
	resetTestServer,
	resolvedCache
} from '../test-support.ts';

import { type SchemaDatabase, type ServerContext } from './context.ts';
import { withDeadlineBudget } from './deadline.ts';
import {
	isRowBudgetExhausted,
	rowsRemaining,
	withRowBudget
} from './row-budget.ts';

// Each unit of the pass scans the seeded marks, so a budget of a given size
// admits a predictable number of units.
const rowsPerUnit = 20;

const ampleRows = rowsPerUnit * 1000;

const nixBase32 = '0123456789abcdfghijklmnpqrsvwxyz';

interface PassOutcome {
	readonly completed: number;
	readonly deferred: number;
}

/**
 * A pass in the shape the measuring helpers will take: it completes a unit of
 * work, asks whether the budget is spent, and stops before starting another.
 * It reports the units it did not reach so a caller can resume them.
 *
 * The reads go through `context.db`, which is the path the services use, so
 * the budget sees the rows without the pass reporting them.
 */
function runPass(
	database: SchemaDatabase,
	units: number,
	budgetRows: number
): PassOutcome {
	return withRowBudget((): PassOutcome => {
		let completed = 0;

		for (let unit = 0; unit < units; unit += 1) {
			database.select().from(schema.garbageCollectionMarks).all();
			completed += 1;

			if (isRowBudgetExhausted()) {
				break;
			}
		}

		return { completed, deferred: units - completed };
	}, budgetRows);
}

function seedMarks(context: ServerContext): void {
	const cache = resolvedCache(context);
	const rows = Array.from({ length: rowsPerUnit }, (_, index) => ({
		cacheId: cache.id,
		storePathHash: storePathHashSchema.parse(
			`${'0'.repeat(30)}${nixBase32.charAt(Math.floor(index / nixBase32.length))}${nixBase32.charAt(index % nixBase32.length)}`
		)
	}));

	context.db.insert(schema.garbageCollectionMarks).values(rows).run();
}

describe('Durable Object row budget', () => {
	beforeEach(resetTestServer);

	it('stops a pass once its rows are spent and reports the deferred work', async () => {
		await initialise();

		const outcome = await runInDurableObject(currentServer(), (instance) => {
			seedMarks(instance.context);

			// Room for three of the ten units the pass offers.
			return runPass(instance.context.db, 10, rowsPerUnit * 3);
		});

		expect(outcome).toStrictEqual({ completed: 3, deferred: 7 });
	});

	it('runs a pass to completion when the budget is ample', async () => {
		await initialise();

		const outcome = await runInDurableObject(currentServer(), (instance) => {
			seedMarks(instance.context);

			return runPass(instance.context.db, 10, ampleRows);
		});

		expect(outcome).toStrictEqual({ completed: 10, deferred: 0 });
	});

	it('stops a pass whose enclosing deadline has expired, with rows to spare', async () => {
		await initialise();

		const outcome = await runInDurableObject(
			currentServer(),
			async (instance) => {
				seedMarks(instance.context);
				let observed: PassOutcome | undefined;

				try {
					// A zero deadline aborts the scope before the body runs. The scope
					// reports its own expiry by throwing once the body returns.
					await withDeadlineBudget(0, () => {
						observed = runPass(instance.context.db, 10, ampleRows);

						return Promise.resolve();
					});
				} catch {
					// The expiry is what this test arranges; the pass result is what it
					// asserts.
				}

				return observed;
			}
		);

		// One unit runs before the pass asks, so a pass always makes progress.
		expect(outcome).toStrictEqual({ completed: 1, deferred: 9 });
	});

	it('refuses to size a pass that runs outside a budget', () => {
		expect(() => rowsRemaining()).toThrow(MissingRowBudgetError);
	});
});

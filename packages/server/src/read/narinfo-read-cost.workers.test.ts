import { env } from 'cloudflare:workers';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';

import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	initialiseViaWorker,
	narBytes,
	pushPathToTenant,
	readFetch,
	resetTestServer,
	uploadMetadata
} from '../test-support.ts';

/**
 * A D1 binding that counts round trips rather than statements: one for a batch,
 * whatever it holds, and one for a statement run on its own.
 *
 * Admission reads the tenant row, the cache credential and the cache lifecycle
 * in a single batch, so a read that consults nothing else spends exactly one
 * round trip.
 */
function roundTripCountingD1(inner: D1Database): {
	readonly binding: D1Database;
	readonly roundTrips: () => number;
} {
	let roundTrips = 0;
	const executions = new Set(['first', 'run', 'all', 'raw']);
	const counted = (statement: D1PreparedStatement): D1PreparedStatement =>
		new Proxy(statement, {
			get(target, property, receiver) {
				const value: unknown = Reflect.get(target, property, receiver);

				if (typeof value !== 'function') {
					return value;
				}

				if (property === 'bind') {
					return (...values: unknown[]) => counted(target.bind(...values));
				}

				return (...parameters: unknown[]): unknown => {
					if (executions.has(String(property))) {
						roundTrips += 1;
					}

					return Reflect.apply(value, target, parameters);
				};
			}
		});

	return {
		roundTrips: () => roundTrips,
		binding: {
			prepare: (query) => counted(inner.prepare(query)),
			batch: (statements) => {
				roundTrips += 1;

				return inner.batch(statements);
			},
			exec: (query) => {
				roundTrips += 1;

				return inner.exec(query);
			},
			withSession: (constraint) => inner.withSession(constraint),
			dump: () => Promise.reject(new Error('dump is not supported here'))
		}
	};
}

describe('public narinfo read cost', () => {
	beforeEach(resetTestServer);

	// The object key carries the cache's incarnation, and no object outlives the
	// reference edge that authorises it, so the object the read finds needs no
	// further check against D1. Counting the round trips states that as a number
	// a later change has to revise deliberately.
	it('spends only the admission read on a hit', async () => {
		const token = await initialiseViaWorker();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		await pushPathToTenant(fixtureTenant, token, metadata);

		const counting = roundTripCountingD1(env.CUPBOARD_DB);
		const response = await readFetch(
			`/${metadata.storePathHash}.narinfo`,
			undefined,
			{ CUPBOARD_DB: counting.binding }
		);

		expect({
			status: response.status,
			roundTrips: counting.roundTrips()
		}).toStrictEqual({ status: StatusCodes.OK, roundTrips: 1 });
	});
});

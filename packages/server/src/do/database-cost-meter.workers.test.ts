import { startCapture } from '@cupboard/logger/testing';
import { nixSha256HashSchema } from '@cupboard/nix-store/scalars';
import { uploadIdSchema } from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import * as schema from '../db/schema.ts';
import {
	currentServer,
	initialise,
	negotiateUploads,
	negotiateViaInstance,
	resetTestServer,
	uploadMetadata
} from '../test-support.ts';

import { type SchemaWriter } from './context.ts';
import {
	type DatabaseCost,
	type DatabaseCostMeter,
	withRequestCost
} from './database-cost-meter.ts';

const costLineSchema = z.object({
	method: z.string(),
	path: z.string(),
	status: z.number(),
	rowsRead: z.number(),
	rowsWritten: z.number()
});

// The meter reports the rows the Durable Object's SQLite actually read and wrote,
// the figure the platform bills on, so the cost-regression tests assert on a real
// measurement. A full table scan reads one
// row per row present, so the read count tracks the table and a read writes
// nothing.
describe('db cost meter', () => {
	beforeEach(resetTestServer);

	it('measures the rows a full scan reads as the table grows', async () => {
		const measured = await runInDurableObject(currentServer(), (instance) => {
			const { db, dbCost } = instance.context;

			insertUploads(db, 0, 3);
			dbCost.settle();
			const writesBeforeScan = dbCost.rowsWritten;
			const smallScan = scanUploads(db, dbCost);
			const writesWhileScanning = dbCost.rowsWritten - writesBeforeScan;

			insertUploads(db, 3, 7);
			dbCost.settle();
			const largeScan = scanUploads(db, dbCost);

			return { smallScan, largeScan, writesWhileScanning };
		});

		expect(measured).toStrictEqual({
			smallScan: 3,
			largeScan: 7,
			writesWhileScanning: 0
		});
	});

	it('measures the rows an insert writes', async () => {
		const measured = await runInDurableObject(currentServer(), (instance) => {
			const { db, dbCost } = instance.context;

			dbCost.settle();
			const before = dbCost.rowsWritten;
			insertUploads(db, 0, 3);
			dbCost.settle();

			return dbCost.rowsWritten - before;
		});

		// Writes are folded on their own accumulation, so pin a positive count: each
		// insert writes the table row plus its primary-key, `expires_at`, `verdict`
		// and garbage-collection path index entries, five per row across three rows.
		expect(measured).toBe(15);
	});

	it('attributes rows to the request that read them, not a concurrent one', async () => {
		const measured = await runInDurableObject(
			currentServer(),
			async (instance) => {
				const { db } = instance.context;
				insertUploads(db, 0, 4);

				const scanAll = (): void => {
					db.select().from(schema.pendingUploads).all();
				};

				let costA: DatabaseCost | undefined;
				let costB: DatabaseCost | undefined;

				// A reads the four rows, yields so B can interleave, then reads them
				// again; B reads them once while A is suspended. Each request must see
				// only its own statements' rows: A eight, B four.
				const a = withRequestCost(
					async () => {
						scanAll();
						await Promise.resolve();
						scanAll();
					},
					(cost) => {
						costA = cost;
					}
				);
				const b = withRequestCost(
					() => {
						scanAll();

						return Promise.resolve();
					},
					(cost) => {
						costB = cost;
					}
				);

				await Promise.all([a, b]);

				return { a: costA?.rowsRead, b: costB?.rowsRead };
			}
		);

		expect(measured).toStrictEqual({ a: 8, b: 4 });
	});

	it('logs the row cost of a request handled through the entrypoint', async () => {
		const token = await initialise();

		const capture = startCapture();

		try {
			await negotiateUploads(token, [uploadMetadata({ fileSize: 1 })]);
		} finally {
			capture.stop();
		}

		// The meter is integrated into the entrypoint, not just exercised in
		// isolation, so a real request emits one cost line reporting the exact rows
		// the request moved. A mis-count that stayed positive would slip past a
		// `> 0` assertion.
		const negotiate = capture.logs
			.filter((entry) => entry.message === 'request finished')
			.map((entry) => costLineSchema.parse(entry.properties))
			.find((cost) => cost.method === 'POST' && cost.path.endsWith('/uploads'));

		expect({
			status: negotiate?.status,
			rowsRead: negotiate?.rowsRead,
			rowsWritten: negotiate?.rowsWritten
		}).toStrictEqual({
			status: StatusCodes.OK,
			rowsRead: 14,
			rowsWritten: 5
		});
	});

	it('logs the cost line with a 500 status when the request fails', async () => {
		const token = await initialise();

		const capture = startCapture();

		try {
			await runInDurableObject(currentServer(), async (instance) => {
				// Fail the negotiate's slot write after its reads, so the request returns a
				// 500 once the meter has already accumulated rows.
				Object.defineProperty(instance.context.db, 'insert', {
					value: () => {
						throw new Error('forced negotiate failure');
					},
					configurable: true
				});

				return negotiateViaInstance(instance, token, 'a'.repeat(32));
			});
		} finally {
			capture.stop();
		}

		// A failed request still emits its cost line: the meter settles in a `finally`,
		// and `fetch` reports the 500 the failed body resolved to with the rows it had
		// already read.
		const negotiate = capture.logs
			.filter((entry) => entry.message === 'request finished')
			.map((entry) => costLineSchema.parse(entry.properties))
			.find((cost) => cost.method === 'POST' && cost.path.endsWith('/uploads'));

		expect({
			status: negotiate?.status,
			rowsRead: negotiate?.rowsRead,
			rowsWritten: negotiate?.rowsWritten
		}).toStrictEqual({
			status: StatusCodes.INTERNAL_SERVER_ERROR,
			rowsRead: 14,
			rowsWritten: 0
		});
	});
});

// Reads every pending-upload row and returns how many rows that scan read.
function scanUploads(
	database: SchemaWriter,
	databaseCost: DatabaseCostMeter
): number {
	const before = databaseCost.rowsRead;
	database.select().from(schema.pendingUploads).all();
	databaseCost.settle();

	return databaseCost.rowsRead - before;
}

function insertUploads(database: SchemaWriter, from: number, to: number): void {
	for (let index = from; index < to; index += 1) {
		database.insert(schema.pendingUploads).values(pendingUpload(index)).run();
	}
}

function pendingUpload(
	index: number
): typeof schema.pendingUploads.$inferInsert {
	return {
		id: uploadIdSchema.parse(`upload-${String(index)}`),
		cache: '',
		narHash: nixSha256HashSchema.parse(`sha256:${'0'.repeat(52)}`),
		r2Key: `staging/upload-${String(index)}`,
		metadataJson: '{}',
		createdAt: '2026-01-01T00:00:00.000Z',
		expiresAt: '2026-01-02T00:00:00.000Z'
	};
}

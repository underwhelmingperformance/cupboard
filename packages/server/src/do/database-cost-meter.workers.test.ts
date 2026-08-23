import { startCapture } from '@cupboard/logger/testing';
import { nixSha256HashSchema } from '@cupboard/nix-store/scalars';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import { uploadIdSchema } from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import * as schema from '../db/schema.ts';
import { r2ObjectKeySchema } from '../http/http.ts';
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

// The platform bills the SQLite rows that the Durable Object reads and writes.
// These tests use those runtime measurements rather than an estimate. A full
// table scan reads one row per stored row and writes none.
describe('db cost meter', () => {
	beforeEach(resetTestServer);

	it('measures the rows a full scan reads as the table grows', async () => {
		const measured = await runInDurableObject(currentServer(), (instance) => {
			const { db, dbCost } = instance.context;

			insertUploads(db, 0, 3);
			dbCost.recordOutstanding();
			const writesBeforeScan = dbCost.rowsWritten;
			const smallScan = scanUploads(db, dbCost);
			const writesWhileScanning = dbCost.rowsWritten - writesBeforeScan;

			insertUploads(db, 3, 7);
			dbCost.recordOutstanding();
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

			dbCost.recordOutstanding();
			const before = dbCost.rowsWritten;
			insertUploads(db, 0, 3);
			dbCost.recordOutstanding();

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

		// Assert the exact entrypoint measurement because a positive but incorrect
		// count would still pass a looser integration check.
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

function scanUploads(
	database: SchemaWriter,
	databaseCost: DatabaseCostMeter
): number {
	const before = databaseCost.rowsRead;
	database.select().from(schema.pendingUploads).all();
	databaseCost.recordOutstanding();

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
		r2Key: r2ObjectKeySchema.parse(`staging/upload-${String(index)}`),
		metadataJson: '{}',
		createdAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z'),
		expiresAt: isoTimestampSchema.parse('2026-01-02T00:00:00.000Z')
	};
}

import type { DataMigrationBudget } from '@cupboard/protocol/deployment-manifest';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SubrequestTimeoutError, UnboundableIoError } from '../errors.ts';
import { OidcDiscoveryStore } from '../oidc/oidc.ts';
import { currentServer, initialise, resetTestServer } from '../test-support.ts';

import { boundedBlobs, boundedD1 } from './bounded-io.ts';
import { withDataMigrationBudget } from './database-cost-meter.ts';

const migrationBudget: DataMigrationBudget = {
	maximumStatements: 4,
	maximumRowsReturned: 4,
	maximumReportedD1RowsRead: 4,
	maximumRowsWritten: 4,
	maximumParametersPerStatement: 4,
	maximumR2Operations: 4,
	maximumR2BytesRead: 4,
	maximumR2BytesWritten: 4
};

function streamBody(value: string): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(value));
			controller.close();
		}
	});
}

describe('bounded gated subrequest', () => {
	beforeEach(resetTestServer);

	it('times out a hung gated R2 call and keeps the object alive', async () => {
		await initialise();
		const server = currentServer();

		// An in-memory marker whose survival proves the instance was not reset: the
		// runtime replaces a broken object, and a fresh instance builds a fresh
		// discovery store.
		const marker = new OidcDiscoveryStore();
		await runInDurableObject(server, (instance) => {
			instance.context.discovery = marker;
			instance.context.gateBudgetMs = 100;
		});

		const hang = vi
			.spyOn(env.BLOBS, 'delete')
			.mockImplementation(() => Promise.race([]));

		let rejection: unknown;
		try {
			await runInDurableObject(server, (instance) =>
				instance.context.criticalSection(() =>
					instance.context.env.BLOBS.delete('gated-key')
				)
			);
		} catch (error) {
			rejection = error;
		} finally {
			hang.mockRestore();
		}

		const afterTimeout = await runInDurableObject(server, (instance) =>
			instance.context.criticalSection(() => Promise.resolve('ok'))
		);
		const isSameInstance = await runInDurableObject(
			server,
			(instance) => instance.context.discovery === marker
		);

		expect({
			timedOut: rejection instanceof SubrequestTimeoutError,
			isSameInstance,
			afterTimeout
		}).toStrictEqual({
			timedOut: true,
			isSameInstance: true,
			afterTimeout: 'ok'
		});
	});
});

describe('unboundable members', () => {
	it('allows a streamed R2 write outside a data migration', async () => {
		const stored = await env.BLOBS.put('ordinary-stream-result', 'ordinary');

		if (stored === null) {
			throw new TypeError('The test R2 write did not return an object');
		}

		const put = vi.spyOn(env.BLOBS, 'put').mockResolvedValue(stored);
		const blobs = boundedBlobs(env.BLOBS);

		try {
			await expect(
				blobs.put('ordinary-stream', streamBody('ordinary'))
			).resolves.toBe(stored);
			expect(put).toHaveBeenCalledOnce();
		} finally {
			put.mockRestore();
		}
	});

	it('refuses a streamed R2 write during a data migration', () => {
		const blobs = boundedBlobs(env.BLOBS);

		expect(() =>
			withDataMigrationBudget(migrationBudget, () =>
				blobs.put('migration-stream', streamBody('migration'))
			)
		).toThrow(UnboundableIoError);
	});

	it('refuses an R2 multipart handle through the bounded bucket', () => {
		const blobs = boundedBlobs(env.BLOBS);

		expect(() => blobs.createMultipartUpload('unbounded-key')).toThrow(
			UnboundableIoError
		);
		expect(() =>
			blobs.resumeMultipartUpload('unbounded-key', 'upload-id')
		).toThrow(UnboundableIoError);
	});

	it('refuses a D1 session through the bounded database', () => {
		const database = boundedD1(env.CUPBOARD_DB);

		expect(() => database.withSession()).toThrow(UnboundableIoError);
	});

	it('executes raw D1 reads through auditable results', async () => {
		const database = boundedD1(env.CUPBOARD_DB);

		await withDataMigrationBudget(migrationBudget, async () => {
			const statement = database.prepare('SELECT 1 AS value');

			expect(() => statement.first()).toThrow(UnboundableIoError);
			await expect(statement.raw()).resolves.toStrictEqual([[1]]);
			await expect(statement.raw({ columnNames: true })).rejects.toBeInstanceOf(
				UnboundableIoError
			);
		});
	});
});

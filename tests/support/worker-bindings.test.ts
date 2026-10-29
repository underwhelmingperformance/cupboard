import { Miniflare } from 'miniflare';
import { expect, it } from 'vitest';

import {
	bindingsWorker,
	BindingsWorkerBundle,
	bindingsWorkerScript,
	WorkerBindings
} from './worker-bindings.ts';

async function withBindings(
	use: (bindings: WorkerBindings) => Promise<void>
): Promise<void> {
	const worker = new Miniflare({
		workers: [
			bindingsWorker(await bindingsWorkerScript(), {
				d1Databases: {
					CUPBOARD_DB: 'bindings-test',
					CONTROL_DB: 'bindings-test-control'
				},
				r2Buckets: { BLOBS: 'bindings-test' }
			})
		]
	});

	try {
		await use(new WorkerBindings(worker));
	} finally {
		await worker.dispose();
	}
}

it('reads D1 rows as a D1 binding returns them', async () => {
	await withBindings(async (bindings) => {
		const database = bindings.database('CUPBOARD_DB');
		await database.run([
			{ sql: 'CREATE TABLE item (id INTEGER, data BLOB)', params: [] }
		]);
		await database
			.prepare('INSERT INTO item (id, data) VALUES (?, ?)')
			.bind(1, new Uint8Array([0, 1, 255]))
			.run();

		const missing = await database
			.prepare('SELECT id FROM item WHERE id = ?')
			.bind(2)
			.first();

		expect({
			rows: await database.prepare('SELECT id, data FROM item').all(),
			isMissingRowNull: missing === null
		}).toStrictEqual({
			rows: { results: [{ id: 1, data: [0, 1, 255] }] },
			isMissingRowNull: true
		});
	});
});

it('stores R2 keys and metadata outside Latin-1', async () => {
	await withBindings(async (bindings) => {
		const bucket = bindings.bucket();
		const key = 'nar/ключ-✓';
		await bucket.put(key, 'body', {
			contentType: 'text/plain; charset=utf-8',
			customMetadata: { note: 'café ✓' }
		});

		const missing = await bucket.head('nar/missing');

		expect({
			stored: await bucket.head(key),
			isMissingObjectNull: missing === null
		}).toStrictEqual({
			stored: {
				contentType: 'text/plain; charset=utf-8',
				customMetadata: { note: 'café ✓' }
			},
			isMissingObjectNull: true
		});
	});
});

it('bundles the bindings Worker again after a failed bundle', async () => {
	const failure = new Error('bundle failed');
	let attempts = 0;
	const bundle = new BindingsWorkerBundle(() => {
		attempts += 1;

		return attempts === 1 ? Promise.reject(failure) : Promise.resolve('script');
	});
	let first: unknown;
	try {
		first = await bundle.get();
	} catch (error) {
		first = error;
	}

	expect({ first, second: await bundle.get(), attempts }).toStrictEqual({
		first: failure,
		second: 'script',
		attempts: 2
	});
});

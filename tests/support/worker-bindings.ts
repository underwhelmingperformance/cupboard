import path from 'node:path';

import type { Miniflare, WorkerOptions } from 'miniflare';
import type { z } from 'zod';

import { createEsbuildBundler } from '../../packages/cli/src/deploy/bundle.ts';
import type { D1BoundStatement } from '../../packages/cli/src/deploy/d1-query.ts';

import {
	firstRowResponseSchema,
	type ManualAlarmMethod,
	manualAlarmResponseSchema,
	objectHeadResponseSchema,
	objectPutHeader,
	queryResponseSchema,
	type TestDatabase
} from './bindings-protocol.ts';
import type { ManualAlarmControl } from './manual-alarms.ts';

// The name of the Worker that gives the harnesses access to storage.
// `bindingsWorker` adds it to a Miniflare instance.
const bindingsWorkerName = 'cupboard-test-bindings';

// Miniflare's entry Worker sends a request with this header to the Worker that
// the header names. Without it, the entry Worker matches the URL against the
// Workers' routes and uses the first Worker if none matches.
const routeOverrideHeader = 'MF-Route-Override';

const bindingsOrigin = 'http://bindings.invalid';

type MiniflareResponse = Awaited<ReturnType<Miniflare['dispatchFetch']>>;

type BindingsWorkerBindings = Partial<
	Pick<
		WorkerOptions,
		'd1Databases' | 'durableObjects' | 'kvNamespaces' | 'r2Buckets'
	>
>;

async function bundleBindingsWorker(): Promise<string> {
	const bundle = await createEsbuildBundler().bundle(
		path.join(import.meta.dirname, 'bindings-worker.ts'),
		'bindings-worker.js'
	);

	return bundle.code;
}

/**
Bundles a script once and reuses it. A failed bundle is not kept, so the next
call bundles again.
*/
export class BindingsWorkerBundle {
	private script: Promise<string> | undefined;

	constructor(private readonly bundle: () => Promise<string>) {}

	async get(): Promise<string> {
		const script = this.script ?? this.bundle();
		this.script = script;

		try {
			return await script;
		} catch (error) {
			if (this.script === script) {
				this.script = undefined;
			}

			throw error;
		}
	}
}

const bindingsWorkerBundle = new BindingsWorkerBundle(bundleBindingsWorker);

/**
The bindings Worker's script. It is bundled once for each test process.
*/
export function bindingsWorkerScript(): Promise<string> {
	return bindingsWorkerBundle.get();
}

export function bindingsWorker(
	script: string,
	bindings: BindingsWorkerBindings
): WorkerOptions {
	return {
		name: bindingsWorkerName,
		modules: true,
		script,
		compatibilityDate: '2026-05-15',
		...bindings
	};
}

class BindingsWorkerRequestError extends Error {
	constructor(
		readonly operation: string,
		readonly status: number,
		readonly body: string
	) {
		super(
			`The bindings Worker refused ${operation} with ${String(status)}: ${body}`
		);
		this.name = 'BindingsWorkerRequestError';
	}
}

class BindingsWorkerClient {
	constructor(private readonly worker: Pick<Miniflare, 'dispatchFetch'>) {}

	async send(
		method: 'POST' | 'PUT',
		pathname: string,
		body: string | Uint8Array,
		headers: Readonly<Record<string, string>>
	): Promise<MiniflareResponse> {
		const response = await this.worker.dispatchFetch(
			new URL(pathname, bindingsOrigin).href,
			{
				method,
				headers: { ...headers, [routeOverrideHeader]: bindingsWorkerName },
				body
			}
		);

		if (!response.ok) {
			throw new BindingsWorkerRequestError(
				`${method} ${pathname}`,
				response.status,
				await response.text()
			);
		}

		return response;
	}

	post(pathname: string, value: unknown): Promise<MiniflareResponse> {
		return this.send('POST', pathname, JSON.stringify(value), {
			'content-type': 'application/json'
		});
	}
}

type TestD1Value = D1BoundStatement['params'][number] | Uint8Array;

interface TestBoundStatement {
	readonly sql: string;
	readonly params: readonly TestD1Value[];
}

function wireStatement(statement: TestBoundStatement): unknown {
	return {
		sql: statement.sql,
		params: statement.params.map((value) =>
			value instanceof Uint8Array ? { bytes: [...value] } : value
		)
	};
}

/**
A prepared statement for {@link TestD1Database}, with the methods of a D1
prepared statement that the harnesses use. A BLOB column reads as an array of
byte values, as D1 returns it.
*/
class TestD1Statement {
	constructor(
		private readonly database: TestD1Database,
		readonly statement: TestBoundStatement
	) {}

	bind(...parameters: TestD1Value[]): TestD1Statement {
		return new TestD1Statement(this.database, {
			sql: this.statement.sql,
			params: parameters
		});
	}

	async all(): Promise<{
		readonly results: readonly Record<string, unknown>[];
	}> {
		return { results: await this.database.rows(this.statement) };
	}

	/**
	The first row, or `null` if there is none, as D1 returns it.
	*/
	first(): Promise<Record<string, unknown> | null> {
		return this.database.firstRow(this.statement);
	}

	run(): Promise<void> {
		return this.database.run([this.statement]);
	}
}

/**
A D1 database reached through the bindings Worker.
*/
export class TestD1Database {
	constructor(
		private readonly client: BindingsWorkerClient,
		private readonly database: TestDatabase
	) {}

	prepare(sql: string): TestD1Statement {
		return new TestD1Statement(this, { sql, params: [] });
	}

	/**
	Runs the statements one at a time, in order, outside a transaction.
	*/
	async run(statements: readonly TestBoundStatement[]): Promise<void> {
		await this.client.post('/d1/run', {
			database: this.database,
			statements: statements.map((statement) => wireStatement(statement))
		});
	}

	/**
	Runs the statements as one D1 batch, which is a single transaction.
	*/
	async batch(statements: readonly TestD1Statement[]): Promise<void> {
		await this.client.post('/d1/batch', {
			database: this.database,
			statements: statements.map(({ statement }) => wireStatement(statement))
		});
	}

	async rows(
		statement: TestBoundStatement
	): Promise<readonly Record<string, unknown>[]> {
		const response = await this.client.post('/d1/all', {
			database: this.database,
			statement: wireStatement(statement)
		});

		return queryResponseSchema.parse(await response.json()).results;
	}

	async firstRow(
		statement: TestBoundStatement
	): Promise<Record<string, unknown> | null> {
		const response = await this.client.post('/d1/first', {
			database: this.database,
			statement: wireStatement(statement)
		});

		return firstRowResponseSchema.parse(await response.json()).row;
	}
}

type TestR2Object = z.infer<typeof objectHeadResponseSchema>['object'];

/**
The R2 bucket bound as `BLOBS`, reached through the bindings Worker.
*/
export class TestR2Bucket {
	constructor(private readonly client: BindingsWorkerClient) {}

	async put(
		key: string,
		value: string | Uint8Array,
		options: {
			readonly sha256?: string;
			readonly contentType?: string;
			readonly customMetadata?: Readonly<Record<string, string>>;
		} = {}
	): Promise<void> {
		await this.client.send('PUT', '/r2/object', value, {
			[objectPutHeader]: encodeURIComponent(JSON.stringify({ key, ...options }))
		});
	}

	/**
	The object's HTTP content type and custom metadata, or `null` if the
	bucket has no object with the key, as an R2 `head` returns.
	*/
	async head(key: string): Promise<TestR2Object> {
		const response = await this.client.post('/r2/head', { key });

		return objectHeadResponseSchema.parse(await response.json()).object;
	}
}

/**
Manual alarm control of the tenant Durable Object with the given name.
*/
interface TestManualAlarms extends ManualAlarmControl {
	isManualAlarmFenceOpen(): Promise<boolean>;
}

/**
The harnesses' access to a Miniflare instance's storage. Every request goes
through `Miniflare#dispatchFetch` to the bindings Worker.

Do not use Miniflare's binding proxies, such as `getD1Database`, here. They
send their synchronous calls over a kept-alive connection. After a stall,
workerd can close that connection without reading the next request
(cloudflare/workers-sdk#16445). In Miniflare 4.20260730.0, `dispatchFetch` sets
undici's `reset` option, so each request uses a new connection. Miniflare
5.20261006 and later reuse connections (cloudflare/workers-sdk#16243); the
stall test in `cupboard-server.test.ts` fails if an upgrade does that.
*/
export class WorkerBindings {
	private readonly client: BindingsWorkerClient;

	constructor(worker: Pick<Miniflare, 'dispatchFetch'>) {
		this.client = new BindingsWorkerClient(worker);
	}

	database(database: TestDatabase): TestD1Database {
		return new TestD1Database(this.client, database);
	}

	bucket(): TestR2Bucket {
		return new TestR2Bucket(this.client);
	}

	async putTenantCacheValue(key: string, value: string): Promise<void> {
		await this.client.post('/kv/put', { key, value });
	}

	manualAlarms(name: string): TestManualAlarms {
		const call = async (method: ManualAlarmMethod): Promise<void> => {
			await this.client.post('/manual-alarms', { name, method });
		};

		return {
			beginManualAlarms: () => call('beginManualAlarms'),
			runAlarmPass: () => call('runAlarmPass'),
			endManualAlarms: () => call('endManualAlarms'),
			isManualAlarmFenceOpen: async () => {
				const response = await this.client.post('/manual-alarms', {
					name,
					method: 'isManualAlarmFenceOpen'
				});

				return manualAlarmResponseSchema.parse(await response.json()).value;
			}
		};
	}
}

import { StatusCodes } from 'http-status-codes';
import type { z } from 'zod';

import {
	type boundStatementSchema,
	kvPutRequestSchema,
	manualAlarmRequestSchema,
	objectHeadRequestSchema,
	objectPutHeader,
	objectPutSchema,
	queryRequestSchema,
	statementsRequestSchema
} from './bindings-protocol.ts';

// The Worker runs in workerd, but this file is type-checked with the Node test
// configuration, so it describes only the parts of each binding that it uses.
type D1Value = string | number | null | Uint8Array;

interface D1PreparedStatement {
	bind(...values: D1Value[]): D1PreparedStatement;
	all(): Promise<{ readonly results: readonly unknown[] }>;
	first(): Promise<unknown>;
	run(): Promise<unknown>;
}

interface D1Binding {
	prepare(sql: string): D1PreparedStatement;
	batch(statements: D1PreparedStatement[]): Promise<unknown>;
}

interface R2Binding {
	put(
		key: string,
		value: ArrayBuffer,
		options: {
			readonly sha256?: string;
			readonly httpMetadata?: { readonly contentType: string };
			readonly customMetadata?: Readonly<Record<string, string>>;
		}
	): Promise<unknown>;
	head(key: string): Promise<{
		readonly httpMetadata?: { readonly contentType?: string };
		readonly customMetadata?: Readonly<Record<string, string>>;
	} | null>;
}

interface KvBinding {
	put(key: string, value: string): Promise<void>;
}

interface ManualAlarmObject {
	beginManualAlarms(): Promise<void>;
	runAlarmPass(): Promise<void>;
	endManualAlarms(): Promise<void>;
	isManualAlarmFenceOpen(): Promise<boolean>;
}

interface DurableObjectBinding {
	idFromName(name: string): unknown;
	get(id: unknown): ManualAlarmObject;
}

interface BindingsEnvironment {
	readonly CUPBOARD_DB: D1Binding;
	readonly CONTROL_DB: D1Binding;
	readonly BLOBS?: R2Binding;
	readonly TENANT_CACHE?: KvBinding;
	readonly CUPBOARD_DO?: DurableObjectBinding;
}

class MissingBindingError extends Error {
	constructor(binding: string) {
		super(`The test bindings Worker has no ${binding} binding`);
		this.name = 'MissingBindingError';
	}
}

function requiredBinding<T>(binding: T | undefined, name: string): T {
	if (binding === undefined) {
		throw new MissingBindingError(name);
	}

	return binding;
}

function prepared(
	database: D1Binding,
	statement: z.infer<typeof boundStatementSchema>
): D1PreparedStatement {
	return database
		.prepare(statement.sql)
		.bind(
			...statement.params.map((value): D1Value =>
				typeof value === 'object' && value !== null
					? new Uint8Array(value.bytes)
					: value
			)
		);
}

function emptyResponse(): Response {
	return new Response(undefined, { status: StatusCodes.NO_CONTENT });
}

type Operation = (
	request: Request,
	env: BindingsEnvironment
) => Promise<Response>;

const operations: Readonly<Record<string, Operation>> = {
	// Runs each statement on its own, in order. Some migrations set `PRAGMA
	// foreign_keys`, which SQLite ignores inside the transaction of a batch.
	async 'POST /d1/run'(request, env) {
		const body = statementsRequestSchema.parse(await request.json());
		const database = env[body.database];

		for (const statement of body.statements) {
			await prepared(database, statement).run();
		}

		return emptyResponse();
	},
	async 'POST /d1/batch'(request, env) {
		const body = statementsRequestSchema.parse(await request.json());
		const database = env[body.database];

		await database.batch(
			body.statements.map((statement) => prepared(database, statement))
		);

		return emptyResponse();
	},
	async 'POST /d1/all'(request, env) {
		const body = queryRequestSchema.parse(await request.json());
		const result = await prepared(env[body.database], body.statement).all();

		return Response.json({ results: result.results });
	},
	async 'POST /d1/first'(request, env) {
		const body = queryRequestSchema.parse(await request.json());
		const row = await prepared(env[body.database], body.statement).first();

		return Response.json({ row });
	},
	async 'PUT /r2/object'(request, env) {
		const header = request.headers.get(objectPutHeader) ?? '';
		const options = objectPutSchema.parse(
			JSON.parse(decodeURIComponent(header))
		);
		const bucket = requiredBinding(env.BLOBS, 'BLOBS');

		await bucket.put(options.key, await request.arrayBuffer(), {
			...(options.sha256 !== undefined && { sha256: options.sha256 }),
			...(options.contentType !== undefined && {
				httpMetadata: { contentType: options.contentType }
			}),
			...(options.customMetadata !== undefined && {
				customMetadata: options.customMetadata
			})
		});

		return emptyResponse();
	},
	async 'POST /r2/head'(request, env) {
		const body = objectHeadRequestSchema.parse(await request.json());
		const object = await requiredBinding(env.BLOBS, 'BLOBS').head(body.key);

		return Response.json({
			object:
				object === null
					? object
					: {
							contentType: object.httpMetadata?.contentType,
							customMetadata: object.customMetadata ?? {}
						}
		});
	},
	async 'POST /kv/put'(request, env) {
		const body = kvPutRequestSchema.parse(await request.json());

		await requiredBinding(env.TENANT_CACHE, 'TENANT_CACHE').put(
			body.key,
			body.value
		);

		return emptyResponse();
	},
	async 'POST /manual-alarms'(request, env) {
		const body = manualAlarmRequestSchema.parse(await request.json());
		const namespace = requiredBinding(env.CUPBOARD_DO, 'CUPBOARD_DO');
		const stub = namespace.get(namespace.idFromName(body.name));

		if (body.method === 'isManualAlarmFenceOpen') {
			return Response.json({ value: await stub.isManualAlarmFenceOpen() });
		}

		await stub[body.method]();

		return emptyResponse();
	}
};

export default {
	async fetch(request: Request, env: BindingsEnvironment): Promise<Response> {
		const operation =
			operations[`${request.method} ${new URL(request.url).pathname}`];

		if (operation === undefined) {
			return new Response(undefined, { status: StatusCodes.NOT_FOUND });
		}

		try {
			return await operation(request, env);
		} catch (error) {
			return new Response(
				error instanceof Error ? (error.stack ?? error.message) : String(error),
				{ status: StatusCodes.INTERNAL_SERVER_ERROR }
			);
		}
	}
};

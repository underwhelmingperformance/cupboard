import { env } from 'cloudflare:workers';
import { z } from 'zod';

interface Statement {
	readonly sql: string;
	readonly values: readonly unknown[];
}

const resultSchema = z.object({
	success: z.literal(true),
	results: z.array(z.unknown()),
	meta: z.looseObject({
		duration: z.number(),
		size_after: z.number(),
		rows_read: z.number(),
		rows_written: z.number(),
		last_row_id: z.number(),
		changed_db: z.boolean(),
		changes: z.number()
	})
});

class ControlTestDatabaseError extends Error {}

class ControlTestDatabase implements D1Database {
	private bookmark = env.CUPBOARD_DB.withSession('first-primary').getBookmark();

	constructor(
		private readonly service: Fetcher,
		private session?: string
	) {}

	async execute(
		operation: string,
		statements: readonly Statement[],
		options: {
			readonly column?: string;
			readonly hasColumnNames?: boolean;
		} = {}
	): Promise<unknown> {
		const response = await this.service.fetch(
			'https://control-database.test/',
			{
				method: 'POST',
				body: JSON.stringify({
					operation,
					statements,
					columnNames: options.hasColumnNames ?? false,
					column: options.column,
					session: this.session
				})
			}
		);
		const result: unknown = await response.json();
		if (!response.ok) {
			throw new ControlTestDatabaseError(
				z.object({ error: z.string() }).parse(result).error
			);
		}
		const parsed = z
			.object({ value: z.unknown(), bookmark: z.string().nullable() })
			.parse(result);
		this.bookmark = parsed.bookmark;
		if (typeof parsed.bookmark === 'string') {
			this.session = parsed.bookmark;
		}
		return parsed.value;
	}

	prepare(sql: string): D1PreparedStatement {
		return new ControlTestStatement(this, { sql, values: [] });
	}

	async batch<T = unknown>(
		statements: D1PreparedStatement[]
	): Promise<D1Result<T>[]> {
		const queries = statements.map((statement) => {
			if (!(statement instanceof ControlTestStatement)) {
				throw new ControlTestDatabaseError(
					'Control database batches require statements from the control test database.'
				);
			}
			return statement.query;
		});
		return z
			.array(resultSchema)
			.parse(await this.execute('batch', queries)) as D1Result<T>[];
	}

	async exec(sql: string): Promise<D1ExecResult> {
		return z
			.object({ count: z.number(), duration: z.number() })
			.parse(await this.execute('exec', [{ sql, values: [] }]));
	}

	withSession(
		constraint: D1SessionBookmark = 'first-unconstrained'
	): D1DatabaseSession {
		const session = new ControlTestDatabase(this.service, constraint);
		return {
			prepare: (sql) => session.prepare(sql),
			batch: (statements) => session.batch(statements),
			getBookmark: () => session.bookmark
		};
	}

	dump(): Promise<ArrayBuffer> {
		return Promise.reject(
			new ControlTestDatabaseError(
				'The control test database does not support dumps.'
			)
		);
	}
}

class ControlTestStatement implements D1PreparedStatement {
	constructor(
		private readonly database: ControlTestDatabase,
		readonly query: Statement
	) {}

	bind(...values: unknown[]): D1PreparedStatement {
		return new ControlTestStatement(this.database, {
			sql: this.query.sql,
			values
		});
	}

	async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
		return (await this.database.execute('first', [this.query], {
			column
		})) as T | null;
	}

	async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
		return resultSchema.parse(
			await this.database.execute('run', [this.query])
		) as D1Result<T>;
	}

	async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
		return resultSchema.parse(
			await this.database.execute('all', [this.query])
		) as D1Result<T>;
	}

	raw<T = unknown[]>(options: {
		columnNames: true;
	}): Promise<[string[], ...T[]]>;
	raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
	async raw<T = unknown[]>(options?: {
		columnNames?: boolean;
	}): Promise<T[] | [string[], ...T[]]> {
		const result = await this.database.execute('raw', [this.query], {
			hasColumnNames: options?.columnNames
		});
		return z.array(z.array(z.unknown())).parse(result) as
			T[] | [string[], ...T[]];
	}
}

const database = new ControlTestDatabase(env.TEST_CONTROL_DATABASE);

/**
 * The separate control database used by the workers tests. Its native binding
 * belongs to an auxiliary Worker, so tenant objects cannot access the binding.
 */
export function testControlDatabase(): D1Database {
	return database;
}

export async function applyControlD1TestMigrations(): Promise<void> {
	await database.execute('migrate', []);
}

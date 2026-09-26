import type { DatabaseId } from './identifiers.ts';

/**
The D1 query endpoints that the deploy uses for migrations and its own records.
*/
export interface D1QueryApi {
	queryBatch(
		databaseId: DatabaseId,
		statements: readonly string[]
	): Promise<void>;
	queryRows(databaseId: DatabaseId, sql: string): Promise<readonly string[]>;
}

/**
The value as a single-quoted SQL string literal.
*/
export function sqlString(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

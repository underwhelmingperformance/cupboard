import { type SQL, sql, type SQLWrapper } from 'drizzle-orm';

import { BoundValueLengthError } from '../errors.ts';

/**
 * A value that SQLite reads back from JSON as it was written: a string becomes
 * text and a number becomes an integer or a real.
 */
export type JsonListValue = string | number;

/**
A row of a list that SQL compares or inserts column by column.
*/
export type JsonListRow = Readonly<Record<string, JsonListValue>>;

// Cloudflare documents a maximum string of 2,000,000 bytes for D1 and for
// Durable Object SQLite. A list travels as one JSON string, so this is the only
// platform limit its length can reach. The factories measure the serialised
// bytes and split a list that would exceed it, which at roughly 35 bytes for a
// quoted hash happens above about 57,000 hashes.
const maxBoundStringBytes = 2_000_000;

const utf8 = new TextEncoder();

interface SerialisedList<T> {
	readonly values: readonly T[];
	readonly json: string;
}

/**
 * Splits `values` into groups whose serialised JSON each fit within a bound
 * string. The whole list is one group unless it is very long. A value that
 * exceeds the limit on its own is refused, because no split can make it fit.
 */
function serialiseLists<T>(values: readonly T[]): readonly SerialisedList<T>[] {
	if (values.length === 0) {
		return [];
	}

	const json = JSON.stringify(values);
	const bytes = utf8.encode(json).length;

	if (bytes <= maxBoundStringBytes) {
		return [{ values, json }];
	}

	if (values.length === 1) {
		throw new BoundValueLengthError(bytes, maxBoundStringBytes);
	}

	const middle = Math.ceil(values.length / 2);

	return [
		...serialiseLists(values.slice(0, middle)),
		...serialiseLists(values.slice(middle))
	];
}

// SQLite reads an `INSERT ... SELECT` that carries an `ON CONFLICT` clause as
// ambiguous unless the select has a `WHERE`, so every source carries one.
function insertSource(json: string, columns: readonly SQL[]): SQL {
	return sql`select ${sql.join([...columns], sql`, `)} from json_each(${json}) where true`;
}

/**
 * A list of values bound as one JSON parameter. `inArray(column, list)` expands
 * it with `json_each`, so a statement binds one parameter for the list however
 * many values it holds.
 */
class JsonValueList<T extends JsonListValue> implements SQLWrapper {
	constructor(
		readonly values: readonly T[],
		private readonly json: string
	) {}

	getSQL(): SQL {
		return sql`select value from json_each(${this.json})`;
	}

	/**
	The value of the row `json_each` is on, for {@link insertSource}.
	*/
	element(): SQL {
		return sql`value`;
	}

	/**
	 * The source of an `INSERT ... SELECT` over the list. Each column is an
	 * expression: a fixed value the statement binds, or {@link element}.
	 */
	insertSource(columns: readonly SQL[]): SQL {
		return insertSource(this.json, columns);
	}
}

/**
 * A list of rows bound as one JSON parameter, for a comparison or an insert
 * over several columns at once.
 */
class JsonRowList<T extends JsonListRow> {
	constructor(
		readonly rows: readonly T[],
		private readonly json: string
	) {}

	/**
	The row's value for one key.
	*/
	column(key: keyof T & string): SQL {
		return sql`json_extract(value, ${`$.${key}`})`;
	}

	/**
	 * A predicate that holds for a row of the table whose `columns` equal the
	 * values a row of the list holds under the same keys.
	 */
	matches(
		columns: Readonly<Partial<Record<keyof T & string, SQLWrapper>>>
	): SQL {
		const entries = Object.entries(columns) as readonly [
			keyof T & string,
			SQLWrapper
		][];
		const compared = sql.join(
			entries.map(([, column]) => column),
			sql`, `
		);
		const listed = sql.join(
			entries.map(([key]) => this.column(key)),
			sql`, `
		);

		return sql`(${compared}) in (select ${listed} from json_each(${this.json}))`;
	}

	/**
	 * The source of an `INSERT ... SELECT` over the list. Each column is an
	 * expression: a fixed value the statement binds, or {@link column}.
	 */
	insertSource(columns: readonly SQL[]): SQL {
		return insertSource(this.json, columns);
	}
}

export type { JsonRowList, JsonValueList };

/**
 * Prepares `values` for statements that bind the list as one JSON parameter.
 * The result holds one list unless the values serialise to more than a bound
 * string can carry.
 */
export function jsonValueLists<T extends JsonListValue>(
	values: readonly T[]
): readonly JsonValueList<T>[] {
	return serialiseLists(values).map(
		(list) => new JsonValueList(list.values, list.json)
	);
}

/**
 * Prepares `rows` for statements that compare or insert several columns from
 * one JSON parameter. The result holds one list unless the rows serialise to
 * more than a bound string can carry.
 */
export function jsonRowLists<T extends JsonListRow>(
	rows: readonly T[]
): readonly JsonRowList<T>[] {
	return serialiseLists(rows).map(
		(list) => new JsonRowList(list.values, list.json)
	);
}

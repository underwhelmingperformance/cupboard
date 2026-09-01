import {
	type ReuseViewSelector,
	reuseViewSelectorSchema,
	reuseViewSelectorsSchema
} from '@cupboard/protocol/reuse-views';

import * as schema from '../db/schema.ts';
import { StoredReuseViewSelectorInvalidError } from '../errors.ts';

export function reuseViewSelectorRow(
	selector: ReuseViewSelector
): Pick<
	typeof schema.reuseViewSelectors.$inferInsert,
	'kind' | 'cacheName' | 'prefix'
> {
	switch (selector.kind) {
		case 'default':
		case 'all-named':
		case 'all': {
			return { kind: selector.kind, cacheName: undefined, prefix: undefined };
		}
		case 'named': {
			return { kind: 'named', cacheName: selector.name, prefix: undefined };
		}
		case 'prefix': {
			return { kind: 'prefix', cacheName: undefined, prefix: selector.prefix };
		}
	}
}

/**
 * Reads a stored selector back, or returns `undefined` when the two columns do
 * not describe one. The migration that introduced these kinds rewrote every
 * existing row, so a caller treats `undefined` as a stored-data fault.
 */
export function reuseViewSelectorFromRow(
	row: Pick<
		typeof schema.reuseViewSelectors.$inferSelect,
		'kind' | 'cacheName' | 'prefix'
	>
): ReuseViewSelector | undefined {
	switch (row.kind) {
		case 'default':
		case 'all-named':
		case 'all': {
			return row.cacheName === null && row.prefix === null
				? { kind: row.kind }
				: undefined;
		}
		case 'named': {
			return reuseViewSelectorSchema.safeParse({
				kind: 'named',
				name: row.cacheName
			}).data;
		}
		case 'prefix': {
			return reuseViewSelectorSchema.safeParse({
				kind: 'prefix',
				prefix: row.prefix
			}).data;
		}
	}
}

/**
 * Reads every stored selector of one view. A row the two columns do not
 * describe is a stored-data fault: skipping it would change the set of caches
 * the view reads from, so the read refuses instead.
 */
export function reuseViewSelectorsFromRows(
	view: string,
	rows: readonly Pick<
		typeof schema.reuseViewSelectors.$inferSelect,
		'kind' | 'cacheName' | 'prefix'
	>[]
): ReuseViewSelector[] {
	const selectors = rows.map((row) => {
		const selector = reuseViewSelectorFromRow(row);

		if (selector === undefined) {
			throw new StoredReuseViewSelectorInvalidError(view);
		}

		return selector;
	});
	const parsed = reuseViewSelectorsSchema.safeParse(selectors);

	if (!parsed.success) {
		throw new StoredReuseViewSelectorInvalidError(view);
	}

	return parsed.data;
}

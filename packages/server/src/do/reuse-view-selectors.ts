import {
	type ReuseViewSelector,
	reuseViewSelectorSchema,
	storedReuseViewSelectorsSchema
} from '@cupboard/protocol/reuse-views';

import * as schema from '../db/schema.ts';
import { StoredReuseViewSelectorInvalidError } from '../errors.ts';

export function reuseViewSelectorRow(
	selector: ReuseViewSelector
): Pick<
	typeof schema.reuseViewSelectors.$inferInsert,
	'kind' | 'cacheName' | 'prefix' | 'managedGroupId'
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
		case 'managed-group': {
			return {
				kind: 'managed-group',
				cacheName: undefined,
				prefix: undefined,
				managedGroupId: selector.groupId
			};
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
		'kind' | 'cacheName' | 'prefix' | 'managedGroupId'
	>
): ReuseViewSelector | undefined {
	switch (row.kind) {
		case 'default':
		case 'all-named':
		case 'all': {
			return row.cacheName === null &&
				row.prefix === null &&
				row.managedGroupId === null
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
		case 'managed-group': {
			return reuseViewSelectorSchema.safeParse({
				kind: 'managed-group',
				groupId: row.managedGroupId
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
		'kind' | 'cacheName' | 'prefix' | 'managedGroupId'
	>[]
): ReuseViewSelector[] {
	const selectors = rows.map((row) => {
		const selector = reuseViewSelectorFromRow(row);

		if (selector === undefined) {
			throw new StoredReuseViewSelectorInvalidError(view);
		}

		return selector;
	});
	const parsed = storedReuseViewSelectorsSchema.safeParse(selectors);

	if (!parsed.success) {
		throw new StoredReuseViewSelectorInvalidError(view);
	}

	return parsed.data;
}

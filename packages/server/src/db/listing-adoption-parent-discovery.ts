import { type CacheScope } from '@cupboard/nix-store/scalars';
import { type SQL, sql, type SQLWrapper } from 'drizzle-orm';
import { type DrizzleD1Database } from 'drizzle-orm/d1';
import { z } from 'zod';

import {
	listingAdoptionDefaultParentKeySchema,
	listingAdoptionNamedParentKeySchema,
	type ListingAdoptionParentPage,
	type ListingAdoptionParentWindow,
	listingAdoptionParentWindowSchema
} from '../blob/listing-adoption-parent-discovery.ts';
import { SharedFactsUnavailableError } from '../errors.ts';

import * as schema from './d1-schema.ts';

const pageSize = 32;
// A prefix-only lower bound can scan every generation of one path. Include
// the maximum SQLite integer so the full key seeks beyond that path.
const maxSqliteInteger = sql`9223372036854775807`;
const rowSchema = z.strictObject({ identity: z.string() });
type ParentKey = ListingAdoptionParentWindow['through'];

/**
Finds unique cache paths through the existing reference identity indexes.
Discovery does not select a publication or grant cache authority.
*/
export class ListingAdoptionParentDiscovery {
	constructor(private readonly database: DrizzleD1Database<typeof schema>) {}

	private columns(kind: CacheScope['kind']): SQLWrapper[] {
		const table = schema.blobReference;
		if (kind === 'default') {
			return [table.tenant, table.storePathHash];
		}
		return [table.tenant, table.cacheName, table.storePathHash];
	}

	private condition(kind: CacheScope['kind']): SQL {
		const table = schema.blobReference;
		return kind === 'default'
			? sql`${table.cacheKind} = 'default'`
			: sql`${table.cacheKind} = 'named'`;
	}

	private identity(kind: CacheScope['kind']): SQL {
		const table = schema.blobReference;
		return kind === 'default'
			? sql`json_object('tenant',${table.tenant},'storePathHash',${table.storePathHash})`
			: sql`json_object('tenant',${table.tenant},'cacheName',${table.cacheName},'storePathHash',${table.storePathHash})`;
	}

	private key(kind: CacheScope['kind'], row: unknown): ParentKey {
		const parsed = rowSchema.parse(row);
		const keySchema =
			kind === 'default'
				? listingAdoptionDefaultParentKeySchema
				: listingAdoptionNamedParentKeySchema;
		return keySchema.parse(JSON.parse(parsed.identity));
	}

	private values(key: ParentKey): SQL[] {
		if ('cacheName' in key) {
			return [
				sql`${key.tenant}`,
				sql`${key.cacheName}`,
				sql`${key.storePathHash}`
			];
		}
		return [sql`${key.tenant}`, sql`${key.storePathHash}`];
	}

	private pageQuery(window: ListingAdoptionParentWindow): SQL {
		const columns = this.columns(window.kind);
		const prefix = sql`(${sql.join(columns, sql`, `)})`;
		const compared = sql`(${sql.join([...columns, schema.blobReference.generation], sql`, `)})`;
		const upper = sql`(${sql.join(this.values(window.through), sql`, `)})`;
		const lower =
			window.after === undefined
				? sql`true`
				: sql`${compared} > (${sql.join(this.values(window.after), sql`, `)},${maxSqliteInteger})`;
		const cursor =
			window.kind === 'default'
				? sql`(json_extract(page.identity,'$.tenant'),json_extract(page.identity,'$.storePathHash'),${maxSqliteInteger})`
				: sql`(json_extract(page.identity,'$.tenant'),json_extract(page.identity,'$.cacheName'),json_extract(page.identity,'$.storePathHash'),${maxSqliteInteger})`;
		const identity = this.identity(window.kind);
		const condition = this.condition(window.kind);
		const ordered = sql.join(columns, sql`, `);
		const first = sql`SELECT ${identity} FROM ${schema.blobReference}
 WHERE ${condition} AND ${lower} AND ${prefix} <= ${upper}
 ORDER BY ${ordered} LIMIT 1`;
		const next = sql`SELECT ${identity} FROM ${schema.blobReference}
 WHERE ${condition} AND ${compared} > ${cursor} AND ${prefix} <= ${upper}
 ORDER BY ${ordered} LIMIT 1`;
		return sql`WITH RECURSIVE page(identity,position) AS (
 SELECT (${first}),1
 UNION ALL
 SELECT (${next}),position+1 FROM page WHERE identity IS NOT NULL AND position < ${pageSize + 1}
) SELECT identity FROM page WHERE identity IS NOT NULL ORDER BY position`;
	}

	async open(
		kind: CacheScope['kind']
	): Promise<ListingAdoptionParentWindow | undefined> {
		try {
			const ordered = this.columns(kind).map((column) => sql`${column} DESC`);
			const row = await this.database
				.select({ identity: this.identity(kind) })
				.from(schema.blobReference)
				.where(this.condition(kind))
				.orderBy(...ordered)
				.limit(1)
				.get();
			if (row === undefined) {
				return undefined;
			}
			return listingAdoptionParentWindowSchema.parse({
				kind,
				through: this.key(kind, row)
			});
		} catch (error) {
			throw new SharedFactsUnavailableError(error);
		}
	}

	async page(
		input: ListingAdoptionParentWindow
	): Promise<ListingAdoptionParentPage> {
		try {
			const window = listingAdoptionParentWindowSchema.parse(input);
			const rows = await this.database.all(this.pageQuery(window));
			const keys = rows.map((row) => this.key(window.kind, row));
			const selected = keys.slice(0, pageSize);
			const isComplete = keys.length <= pageSize;
			return {
				parents: selected.map((key) => ({
					tenant: key.tenant,
					cache:
						'cacheName' in key
							? { kind: 'named', name: key.cacheName }
							: { kind: 'default' },
					storePathHash: key.storePathHash
				})),
				window: listingAdoptionParentWindowSchema.parse({
					...window,
					after: isComplete ? window.through : selected.at(-1)
				}),
				isComplete
			};
		} catch (error) {
			throw new SharedFactsUnavailableError(error);
		}
	}
}

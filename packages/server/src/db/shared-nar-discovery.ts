import { type NixSha256HashString } from '@cupboard/nix-store/scalars';
import { asc, eq, exists, gt, sql } from 'drizzle-orm';
import { type DrizzleD1Database } from 'drizzle-orm/d1';

import { registeredLiveObjectIncarnation } from '../blob/object-incarnation.ts';
import { SharedFactsUnavailableError } from '../errors.ts';

import * as schema from './d1-schema.ts';

const pageSize = 32;

export interface SharedNarSource {
	readonly narHash: NixSha256HashString;
	readonly sourceIncarnation: number;
	readonly narSize: number;
	readonly fileSize: number;
}

export interface SharedNarDiscoveryPage {
	readonly sources: readonly SharedNarSource[];
	readonly cursor?: NixSha256HashString;
	readonly isComplete: boolean;
}

/**
 * Enumerates retained shared NARs. A source does not grant cache read or
 * publication authority, and executors must recheck its captured incarnation.
 */
export class SharedNarDiscovery {
	constructor(private readonly database: DrizzleD1Database<typeof schema>) {}

	async page(cursor?: NixSha256HashString): Promise<SharedNarDiscoveryPage> {
		const reference = this.database
			.select({ one: sql`1` })
			.from(schema.blobReference)
			.where(eq(schema.blobReference.narHash, schema.blobState.narHash));
		try {
			// Filtering eligibility before LIMIT can scan an unbounded run of
			// unreferenced or unavailable objects.
			const rows = await this.database
				.select({
					narHash: schema.blobState.narHash,
					sourceIncarnation: schema.blobState.incarnation,
					narSize: schema.blobState.narSize,
					fileSize: schema.blobState.fileSize,
					isRetained: exists(reference).mapWith(Boolean),
					isLive: registeredLiveObjectIncarnation(
						this.database,
						'nar',
						schema.blobState.narHash,
						schema.blobState.incarnation
					).mapWith(Boolean)
				})
				.from(schema.blobState)
				.where(
					cursor === undefined
						? undefined
						: gt(schema.blobState.narHash, cursor)
				)
				.orderBy(asc(schema.blobState.narHash))
				.limit(pageSize + 1);
			const selected = rows.slice(0, pageSize);
			return {
				sources: selected
					.filter((row) => row.isRetained && row.isLive)
					.map(({ narHash, sourceIncarnation, narSize, fileSize }) => ({
						narHash,
						sourceIncarnation,
						narSize,
						fileSize
					})),
				cursor: selected.at(-1)?.narHash ?? cursor,
				isComplete: rows.length <= pageSize
			};
		} catch (error) {
			throw new SharedFactsUnavailableError(error);
		}
	}
}

import { type IsoTimestamp } from '@cupboard/protocol/scalars';
import { eq } from 'drizzle-orm';

import { type ResolvedCache } from '../db/cache.ts';
import * as schema from '../db/schema.ts';

import { type ServerContext } from './context.ts';

export interface CollectionInputState {
	readonly inputsChanged: boolean;
	readonly scanCompletedAt: IsoTimestamp | undefined;
}

/**
The `garbage_collection_input` row of each cache.

Triggers set `inputs_changed` on each write that can change which paths a
scan keeps: to narinfos, root targets, grace rows, uploads in flight, cache
closes and the grace-managed mark. Root and grace deadlines have no
trigger; a pass reads them directly. A new scan clears the flag because
it reads every input as it is then. The scan clears the flag again after
its own writes, if the flag was clear when the invocation started.
*/
export class GarbageCollectionInputs {
	constructor(private readonly context: ServerContext) {}

	private write(
		cache: ResolvedCache,
		set: Partial<
			Pick<
				typeof schema.garbageCollectionInputs.$inferInsert,
				'inputsChanged' | 'scanCompletedAt'
			>
		>
	): void {
		this.context.db
			.insert(schema.garbageCollectionInputs)
			.values({ cacheId: cache.id, ...set })
			.onConflictDoUpdate({
				target: schema.garbageCollectionInputs.cacheId,
				set
			})
			.run();
	}

	state(cache: ResolvedCache): CollectionInputState | undefined {
		const row = this.context.db
			.select({
				inputsChanged: schema.garbageCollectionInputs.inputsChanged,
				scanCompletedAt: schema.garbageCollectionInputs.scanCompletedAt
			})
			.from(schema.garbageCollectionInputs)
			.where(eq(schema.garbageCollectionInputs.cacheId, cache.id))
			.get();

		return row === undefined
			? undefined
			: {
					inputsChanged: row.inputsChanged,
					scanCompletedAt: row.scanCompletedAt ?? undefined
				};
	}

	clearChanged(cache: ResolvedCache): void {
		this.write(cache, { inputsChanged: false });
	}

	recordCompletion(cache: ResolvedCache, completedAt: IsoTimestamp): void {
		this.write(cache, { scanCompletedAt: completedAt });
	}
}

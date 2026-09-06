import { type StorePathHash } from '@cupboard/nix-store/scalars';

import type { CacheId } from '../db/cache.ts';
import { type RequestOrigin, requestOriginSchema } from '../http/http.ts';

import { chunk, maxInClauseValues } from './bulk.ts';
import { type ServerContext } from './context.ts';
import { maintenancePassStatements } from './maintenance-eligibility-service.ts';

export interface ReconcileTarget {
	readonly cacheId: CacheId;
	readonly storePathHash: StorePathHash;
}

// DO storage KV stores one entry per (cache, store path hash) under this prefix.
// The store path hash is a fixed-length value from a colon-free alphabet. Its
// suffix therefore keeps the key unique even when a cache name contains a colon.
const reconcileEntryPrefix = 'maintenance:reconcile:';

// Each enqueue overwrites this with its request origin. An alarm therefore uses
// the most recently enqueued origin for every target it claims, including
// targets left by an earlier enqueue. The hyphen keeps this key outside
// `reconcileEntryPrefix`, so a queue listing never returns it.
const reconcileOriginKey = 'maintenance:reconcile-origin';

// DO storage writes at most this many KV pairs in one `put`, so a larger closure
// is split into successive writes.
const maxStoragePutEntries = 128;

// These constants determine the page size for a reconcile pass. The D1 binding
// enforces the statement limit if one becomes inaccurate, which can reduce the
// work completed by the pass.
//
// Probing one target reads the shared blob row for the NAR's current
// incarnation. The subsequent R2 HEAD requests do not use D1.
export const statementsPerReconcileProbe = 1;

// One query reads the committed reference edges for a whole page. Every page
// fits in one `IN (...)` list.
export const statementsPerReconcileEdgeQuery = 1;

// Restoring a missing narinfo object re-reads the NAR's incarnation under the
// critical section, then reads the shared blob row used to render the narinfo.
export const statementsPerReconcileRestore = 2;

// Removing a path after its NAR disappears credits and deletes the reference
// edge, reads the remaining edges and the presence row, then credits and deletes
// that presence row. It also queries the path's attestation references and
// checks for references from other tenants. Each attestation reference requires
// five additional statements from the remaining allowance.
export const statementsPerReconcileRemoval = 8;

/**
 * The maximum number of queued paths claimed by one alarm.
 *
 * The page reserves one statement per probe, the edge query and one removal.
 * Every pass can therefore repair at least one probed target. The page also
 * fits in one `IN (...)` list, so the edge query requires one statement.
 */
export const maxPathsReconciledPerRun = Math.min(
	maxInClauseValues,
	Math.floor(
		(maintenancePassStatements -
			statementsPerReconcileEdgeQuery -
			statementsPerReconcileRemoval) /
			statementsPerReconcileProbe
	)
);

export class ReconcileQueueService {
	constructor(private readonly context: ServerContext) {}

	/**
	 * The queue key of one target. A pass that finishes only part of its page
	 * uses this to clear the targets it finished and leave the rest queued.
	 */
	entryKey(target: ReconcileTarget): string {
		return `${reconcileEntryPrefix}${String(target.cacheId)}:${target.storePathHash}`;
	}

	async enqueue(
		origin: RequestOrigin,
		targets: readonly ReconcileTarget[]
	): Promise<void> {
		if (targets.length === 0) {
			return;
		}

		for (const batch of chunk(targets, maxStoragePutEntries)) {
			await this.context.ctx.storage.put(
				Object.fromEntries(
					batch.map((target) => [this.entryKey(target), target])
				)
			);
		}

		await this.context.ctx.storage.put(reconcileOriginKey, origin);
		await this.context.ctx.storage.setAlarm(Date.now());
	}

	claimChunk(
		limit: number = maxPathsReconciledPerRun
	): Promise<Map<string, ReconcileTarget>> {
		return this.context.ctx.storage.list<ReconcileTarget>({
			prefix: reconcileEntryPrefix,
			limit
		});
	}

	// Durable storage returns the origin as an unvalidated string. Parse it before
	// use. A missing or malformed origin reconciles without an edge purge.
	async origin(): Promise<RequestOrigin | undefined> {
		const stored =
			await this.context.ctx.storage.get<string>(reconcileOriginKey);
		const parsed =
			stored === undefined ? undefined : requestOriginSchema.safeParse(stored);

		return parsed?.success === true ? parsed.data : undefined;
	}

	async clearKeys(keys: readonly string[]): Promise<void> {
		await this.context.ctx.storage.delete([...keys]);
	}

	async hasPending(): Promise<boolean> {
		const remaining = await this.context.ctx.storage.list({
			prefix: reconcileEntryPrefix,
			limit: 1
		});

		return remaining.size > 0;
	}

	async clearOrigin(): Promise<void> {
		await this.context.ctx.storage.delete(reconcileOriginKey);
	}
}

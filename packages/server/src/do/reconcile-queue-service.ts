import {
	type StoredCache,
	type StorePathHash
} from '@cupboard/nix-store/scalars';

import { type RequestOrigin, requestOriginSchema } from '../http/http.ts';

import { chunk } from './bulk.ts';
import { type ServerContext } from './context.ts';

// A committed path queued for an off-hot-path reconcile of the R2 objects its
// narinfo points at. Negotiate persists the closure's committed paths here and
// arms an immediate alarm; the alarm drains them in bounded chunks, so a push
// returns without hitting R2 and a large closure spreads its probes across
// firings within the per-invocation subrequest cap.
export interface ReconcileTarget {
	readonly cache: StoredCache;
	readonly storePathHash: StorePathHash;
}

// DO storage KV holds one entry per (cache, store path hash) under this prefix.
// The store path hash is a fixed-length value from a colon-free alphabet, so a
// `<cache>:<storePathHash>` key recovers the pair unambiguously even when a cache
// name itself contains a colon.
const reconcileEntryPrefix = 'maintenance:reconcile:';

// The origin of the push that queued the current targets, kept beside the queue
// so the reconcile can purge the edge cache exactly as the request would have.
// The hyphen keeps it outside `reconcileEntryPrefix`, so a queue listing never
// returns it.
const reconcileOriginKey = 'maintenance:reconcile-origin';

// DO storage writes at most this many KV pairs in one `put`, so a larger closure
// is split into successive writes.
const maxStoragePutEntries = 128;

// One alarm firing reconciles at most this many queued paths, each costing up to
// two R2 heads, so a firing stays well under the Worker subrequest cap and a
// large backlog converges across firings.
const maxPathsReconciledPerRun = 200;

// The durable queue of committed paths a recent negotiate asked to reconcile,
// backed by DO storage KV so no SQLite migration is needed. Negotiate enqueues
// and arms the alarm; the alarm claims a bounded chunk, reconciles it, clears it,
// and re-arms while more remain.
export class ReconcileQueueService {
	constructor(private readonly context: ServerContext) {}

	private entryKey(target: ReconcileTarget): string {
		return `${reconcileEntryPrefix}${target.cache}:${target.storePathHash}`;
	}

	// Records the targets and the push origin, then arms an immediate alarm. Empty
	// input neither writes nor arms.
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

	// A bounded chunk of queued targets keyed by their storage key, so the caller
	// reconciles the values and then deletes exactly these keys.
	claimChunk(
		limit: number = maxPathsReconciledPerRun
	): Promise<Map<string, ReconcileTarget>> {
		return this.context.ctx.storage.list<ReconcileTarget>({
			prefix: reconcileEntryPrefix,
			limit
		});
	}

	// A stored row holds a plain origin string, so the value is minted through
	// the schema on read. A malformed or absent value reconciles without an edge
	// purge.
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

	// Whether any queued target remains, so the alarm re-arms only while there is
	// more to drain: a chunk that empties the queue stops the loop.
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

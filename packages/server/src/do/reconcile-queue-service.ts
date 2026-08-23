import {
	type StoredCache,
	type StorePathHash
} from '@cupboard/nix-store/scalars';

import { type RequestOrigin, requestOriginSchema } from '../http/http.ts';

import { chunk } from './bulk.ts';
import { type ServerContext } from './context.ts';

export interface ReconcileTarget {
	readonly cache: StoredCache;
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

// One alarm firing reconciles at most this many queued paths, each costing up to
// two R2 heads, so a firing stays well under the Worker subrequest cap and a
// large backlog converges across firings.
const maxPathsReconciledPerRun = 200;

export class ReconcileQueueService {
	constructor(private readonly context: ServerContext) {}

	private entryKey(target: ReconcileTarget): string {
		return `${reconcileEntryPrefix}${target.cache}:${target.storePathHash}`;
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

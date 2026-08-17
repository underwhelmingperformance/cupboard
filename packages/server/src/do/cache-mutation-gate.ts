import type { StoredCache } from '@cupboard/nix-store/scalars';
import { WritesNotAcceptedError } from '@cupboard/s3/errors';

const blockPrefix = 's3:cache-mutation-block:';

/**
Orders cache teardown after S3 mutations that have already started.
*/
export class CacheMutationGate {
	private readonly active = new Map<StoredCache, number>();
	private readonly blocked = new Set<StoredCache>();
	private readonly idleWaiters = new Map<StoredCache, Set<() => void>>();

	constructor(private readonly storage: DurableObjectStorage) {}

	private key(cache: StoredCache): string {
		return `${blockPrefix}${cache}`;
	}

	private finish(cache: StoredCache): void {
		const remaining = (this.active.get(cache) ?? 1) - 1;
		if (remaining > 0) {
			this.active.set(cache, remaining);
			return;
		}

		this.active.delete(cache);
		const waiters = this.idleWaiters.get(cache);
		this.idleWaiters.delete(cache);
		const pending = waiters ?? [];
		for (const resolve of pending) {
			resolve();
		}
	}

	/**
	Runs one S3 mutation unless cache teardown has blocked new work.
	*/
	async run<T>(cache: StoredCache, operation: () => Promise<T>): Promise<T> {
		if (
			this.blocked.has(cache) ||
			(await this.storage.get(this.key(cache))) !== undefined
		) {
			throw new WritesNotAcceptedError();
		}

		// `block` can run while the storage read is pending. Check the in-memory
		// state again before registering this operation as active.
		if (this.blocked.has(cache)) {
			throw new WritesNotAcceptedError();
		}

		this.active.set(cache, (this.active.get(cache) ?? 0) + 1);
		try {
			return await operation();
		} finally {
			this.finish(cache);
		}
	}

	/**
	Durably blocks new S3 mutations for a cache.
	*/
	async block(cache: StoredCache): Promise<void> {
		this.blocked.add(cache);
		await this.storage.put(this.key(cache), true);
	}

	/**
	Resolves after every S3 mutation that started before the block has ended.
	*/
	waitForIdle(cache: StoredCache): Promise<void> {
		if (!this.active.has(cache)) {
			return Promise.resolve();
		}

		return new Promise((resolve) => {
			const waiters = this.idleWaiters.get(cache) ?? new Set();
			waiters.add(resolve);
			this.idleWaiters.set(cache, waiters);
		});
	}

	/**
	Removes the durable block after cache teardown has completed.
	*/
	async unblock(cache: StoredCache): Promise<void> {
		await this.storage.delete(this.key(cache));
		this.blocked.delete(cache);
	}
}

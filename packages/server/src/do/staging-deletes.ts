import { SubrequestTimeoutError } from '../errors.ts';
import { type R2ObjectKey } from '../http/http.ts';

import { boundedSubrequest } from './deadline.ts';

const stagingDeleteWaitMs = 5000;

/**
The publication staged objects that this Durable Object is deleting, from
before the transaction that clears an upload's pending row until the R2
delete finishes. Admission must not track such a key again in that
interval, because the delete would remove bytes that the client uploads for
the new pending row.
*/
export class StagingDeletes {
	private readonly counts = new Map<R2ObjectKey, number>();
	private readonly waiters = new Map<R2ObjectKey, (() => void)[]>();

	has(key: R2ObjectKey): boolean {
		return this.counts.has(key);
	}

	begin(key: R2ObjectKey): void {
		this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
	}

	end(key: R2ObjectKey): void {
		const remaining = (this.counts.get(key) ?? 1) - 1;
		if (remaining <= 0) {
			this.counts.delete(key);
			const waiters = this.waiters.get(key) ?? [];
			this.waiters.delete(key);
			for (const release of waiters) {
				release();
			}
			return;
		}
		this.counts.set(key, remaining);
	}

	/**
	Waits until no delete of `key` is recorded. The wait is a bounded
	subrequest, so it rejects retryably when a delete outlasts the bound.
	*/
	async finished(key: R2ObjectKey): Promise<void> {
		if (!this.has(key)) {
			return;
		}
		const { promise, resolve } = Promise.withResolvers<undefined>();
		const release = () => {
			resolve(undefined);
		};
		this.waiters.set(key, [...(this.waiters.get(key) ?? []), release]);
		try {
			await boundedSubrequest(
				() => promise,
				'r2.staging-delete-wait',
				stagingDeleteWaitMs
			);
		} finally {
			const remaining = (this.waiters.get(key) ?? []).filter(
				(waiter) => waiter !== release
			);
			if (remaining.length === 0) {
				this.waiters.delete(key);
			} else {
				this.waiters.set(key, remaining);
			}
		}
	}

	/**
	Deletes a staged object. A bounded delete that stops waiting does not
	cancel the R2 call, which can still remove the object later, so the key
	stays recorded until that call finishes.
	*/
	async delete(
		bucket: Pick<R2Bucket, 'delete'>,
		key: R2ObjectKey
	): Promise<void> {
		try {
			await bucket.delete(key);
		} catch (error) {
			if (
				error instanceof SubrequestTimeoutError &&
				error.abandoned !== undefined
			) {
				this.begin(key);
				void error.abandoned.finally(() => {
					this.end(key);
				});
			}
			throw error;
		}
	}

	async around<T>(key: R2ObjectKey, run: () => Promise<T>): Promise<T> {
		this.begin(key);
		try {
			return await run();
		} finally {
			this.end(key);
		}
	}
}

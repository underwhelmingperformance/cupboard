import { SubrequestTimeoutError } from '../errors.ts';

import { boundedSubrequest } from './deadline.ts';

// Both signals resolve and never reject, so awaiting them in sequence joins
// them without racing.
async function settleBoth(
	first: Promise<void>,
	second: Promise<void>
): Promise<void> {
	await first;
	await second;
}

/**
 * Orders the mutations of path-keyed R2 objects so they land in issue order.
 *
 * A timed-out R2 call is abandoned, not cancelled (see
 * {@link boundedSubrequest}), so it can land at the object store after later
 * calls to the same key. A content-addressed key tolerates that: any landing
 * put carries the same bytes, and the reaper's compare-and-delete is designed
 * for late deletes. A path-keyed object (a tenant narinfo, an attestation
 * list) has no such immunity: an abandoned delete landing after a fresh put
 * destroys a live object the database still records as servable.
 *
 * Every mutation of such a key therefore runs through {@link write}, which
 * first waits for the settled-signals of any abandoned mutations of the same
 * keys. The registry is in-memory and per-instance, which suffices because the
 * tenant Durable Object is the single writer of its path-keyed objects; the
 * verify/reconcile scan remains the durable backstop for an instance that dies
 * with a zombie still in flight.
 */
export class ObjectWriteOrder {
	private readonly outstanding = new Map<string, Promise<void>>();

	private async settleOutstanding(keys: readonly string[]): Promise<void> {
		const signals = keys
			.map((key) => this.outstanding.get(key))
			.filter((signal): signal is Promise<void> => signal !== undefined);

		if (signals.length === 0) {
			return;
		}

		await boundedSubrequest(async () => {
			await Promise.all(signals);
		}, 'r2.abandoned-settle');
	}

	// A bulk mutation carries one signal for every key it covered: waiting on a
	// key the abandoned call never touched costs one settled await, while
	// missing a key it did touch would reopen the ordering hole.
	private registerAbandoned(
		keys: readonly string[],
		settled: Promise<void>
	): void {
		for (const key of keys) {
			const previous = this.outstanding.get(key);
			const entry =
				previous === undefined ? settled : settleBoth(previous, settled);

			this.outstanding.set(key, entry);
			void this.removeWhenSettled(key, entry);
		}
	}

	private async removeWhenSettled(
		key: string,
		entry: Promise<void>
	): Promise<void> {
		await entry;

		if (this.outstanding.get(key) === entry) {
			this.outstanding.delete(key);
		}
	}

	/**
	 * Runs one R2 mutation of `keys`, first waiting for any abandoned earlier
	 * mutation of those keys to settle. The wait is itself a bounded
	 * subrequest: inside a critical section it consumes the section's deadline
	 * budget and rejects retryably if the zombie outlasts it, leaving the
	 * signal registered for the retry. When the mutation times out, its
	 * settled-signal is registered against every key so later mutations order
	 * behind it.
	 */
	async write<T>(
		keys: readonly string[],
		mutate: () => Promise<T>
	): Promise<T> {
		await this.settleOutstanding(keys);

		try {
			return await mutate();
		} catch (error) {
			if (
				error instanceof SubrequestTimeoutError &&
				error.abandoned !== undefined
			) {
				this.registerAbandoned(keys, error.abandoned);
			}

			throw error;
		}
	}
}

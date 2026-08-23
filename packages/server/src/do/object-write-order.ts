import { SubrequestTimeoutError } from '../errors.ts';
import { type R2ObjectKey } from '../http/http.ts';

import { boundedSubrequest } from './deadline.ts';

// Settlement signals never reject. Await both so a later write does not start
// until every abandoned mutation for the key has finished.
async function settleBoth(
	first: Promise<void>,
	second: Promise<void>
): Promise<void> {
	await first;
	await second;
}

/**
 * Orders mutations of path-keyed R2 objects by issue time.
 *
 * A timed-out R2 call is abandoned, not cancelled (see
 * {@link boundedSubrequest}), so it can reach R2 after a later call to the
 * same key. Content-addressed keys tolerate that ordering. Path-keyed objects,
 * such as tenant narinfos and attestation lists, do not: a late delete could
 * remove an object that a newer put restored.
 *
 * {@link write} waits for abandoned mutations of the same keys to settle. The
 * registry can remain in memory because the tenant Durable Object is the only
 * writer of its path-keyed objects. Verification and reconciliation repair
 * state after an instance dies with a mutation still in flight.
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

	// Register a bulk mutation against every affected key. Otherwise a later
	// write to one key could overtake the abandoned bulk call.
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
	 * budget and rejects retryably if the abandoned mutation outlasts it,
	 * leaving the signal registered for the retry. When the mutation times out,
	 * its settled-signal is registered against every key so later mutations
	 * order behind it.
	 */
	async write<T>(
		keys: readonly R2ObjectKey[],
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

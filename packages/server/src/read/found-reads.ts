import { chunk } from '@cupboard/shared/collections';

import { maxOutgoingConnections } from '../do/bulk.ts';

interface FoundReads<Key, Version, Entry> {
	/**
	Returns the version of `key` that a read needs, or `undefined` when the
	key has none. A key without a version gets `missing(key)` and no read.
	A key with a version is read with it, and the read can still return a
	missing entry.
	*/
	readonly version: (key: Key) => Version | undefined;
	readonly missing: (key: Key) => Entry;
	readonly read: (key: Key, version: Version) => Promise<Entry>;
	/**
	Called with the keys of each group before any read of the group starts.
	*/
	readonly beforeGroup?: (keys: readonly Key[]) => void;
	/**
	Called with the first failure of a group. The generator throws the value
	that this function returns.
	*/
	readonly refusal: (failure: unknown) => unknown;
}

function isRejected(
	outcome: PromiseSettledResult<unknown>
): outcome is PromiseRejectedResult {
	return outcome.status === 'rejected';
}

function isFulfilled<Value>(
	outcome: PromiseSettledResult<Value>
): outcome is PromiseFulfilledResult<Value> {
	return outcome.status === 'fulfilled';
}

interface Pending<Key, Version> {
	readonly key: Key;
	readonly version: Version;
	readonly missingBefore: readonly Key[];
}

/**
Yields an entry for every key, in the order of `keys`. Keys without a
version cost no read. The other keys are read in groups of
`maxOutgoingConnections`, so reads of keys that are far apart in `keys`
still run together.

A group yields its entries, and the missing entries before each of them,
only after all of its reads have finished. The missing entries after the
last read key are yielded at the end.
*/
export async function* readFoundInGroups<Key, Version, Entry>(
	keys: readonly Key[],
	reads: FoundReads<Key, Version, Entry>
): AsyncGenerator<Entry> {
	const pending: Pending<Key, Version>[] = [];
	let missingKeys: Key[] = [];

	for (const key of keys) {
		const version = reads.version(key);

		if (version === undefined) {
			missingKeys.push(key);
			continue;
		}

		pending.push({ key, version, missingBefore: missingKeys });
		missingKeys = [];
	}

	for (const group of chunk(pending, maxOutgoingConnections)) {
		reads.beforeGroup?.(group.map(({ key }) => key));
		const outcomes = await Promise.allSettled(
			group.map(async ({ key, version, missingBefore }) => ({
				missingBefore,
				entry: await reads.read(key, version)
			}))
		);
		const failed = outcomes.find(isRejected);

		if (failed !== undefined) {
			const error: unknown = reads.refusal(failed.reason);
			throw error;
		}

		const settled = outcomes.filter(isFulfilled).map(({ value }) => value);

		for (const { missingBefore, entry } of settled) {
			for (const key of missingBefore) {
				yield reads.missing(key);
			}

			yield entry;
		}
	}

	for (const key of missingKeys) {
		yield reads.missing(key);
	}
}

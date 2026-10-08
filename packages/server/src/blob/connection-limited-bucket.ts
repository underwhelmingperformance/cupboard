import { CountingSemaphore } from '@cupboard/shared/concurrency';

import {
	holdSubrequests,
	type SubrequestHold
} from '../do/subrequest-slice.ts';
import { type R2ObjectKey } from '../http/http.ts';

/**
 * The R2 operations that NAR verification uses. A get with options returns
 * only the object's metadata when its `onlyIf` condition fails.
 */
export interface R2ObjectStore {
	get(key: R2ObjectKey): Promise<R2ObjectBody | null>;
	get(
		key: R2ObjectKey,
		options: R2GetOptions
	): Promise<R2ObjectBody | R2Object | null>;
	put(
		key: R2ObjectKey,
		value: ReadableStream,
		options: R2PutOptions
	): Promise<R2Object | null>;
}

/**
 * Admits at most `limit` R2 requests at once and queues the rest. A request
 * keeps its connection until R2 sends the response headers. For a `get` that
 * is when the object's body starts to arrive, and for a `put` it is after R2
 * has received the whole body.
 *
 * A put's body can come from gets that start after the put, so puts never take
 * the last connection. Each request counts against the invocation's
 * subrequest slice from the moment it is admitted, so a caller that checks the
 * slice sees requests that are still waiting for a connection.
 *
 * Use one instance for every R2 request that an invocation makes, so that
 * concurrent reads and streamed writes share the same limit.
 */
export class ConnectionLimitedBucket implements R2ObjectStore {
	private readonly connections: CountingSemaphore;
	private readonly writes: CountingSemaphore;

	constructor(
		private readonly bucket: R2ObjectStore,
		limit: number
	) {
		if (!Number.isSafeInteger(limit) || limit < 2) {
			throw new RangeError(
				'The connection limit must leave a connection for reads.'
			);
		}

		this.connections = new CountingSemaphore(limit);
		this.writes = new CountingSemaphore(limit - 1);
	}

	// The bucket counts the request against the slice when it makes it, so the
	// hold ends at that moment.
	private connect<T>(
		admitted: SubrequestHold,
		call: () => Promise<T>
	): Promise<T> {
		return this.connections.run(() => {
			admitted.release();

			return call();
		});
	}

	get(key: R2ObjectKey): Promise<R2ObjectBody | null>;
	get(
		key: R2ObjectKey,
		options: R2GetOptions
	): Promise<R2ObjectBody | R2Object | null>;
	get(
		key: R2ObjectKey,
		options?: R2GetOptions
	): Promise<R2ObjectBody | R2Object | null> {
		const admitted = holdSubrequests(1);

		return this.connect(admitted, () =>
			options === undefined
				? this.bucket.get(key)
				: this.bucket.get(key, options)
		);
	}

	put(
		key: R2ObjectKey,
		value: ReadableStream,
		options: R2PutOptions
	): Promise<R2Object | null> {
		const admitted = holdSubrequests(1);

		return this.writes.run(() =>
			this.connect(admitted, () => this.bucket.put(key, value, options))
		);
	}
}

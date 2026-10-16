import { type R2ObjectKey } from '../http/http.ts';

import { R2RequestAdmission } from './r2-request-admission.ts';

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
 * Pass one shared admission to native and metadata adapters in an invocation.
 * A numeric limit creates an admission for this bucket.
 */
export class ConnectionLimitedBucket implements R2ObjectStore {
	private readonly admission: R2RequestAdmission;

	constructor(
		private readonly bucket: R2ObjectStore,
		admission: R2RequestAdmission | number
	) {
		this.admission =
			typeof admission === 'number'
				? new R2RequestAdmission(admission)
				: admission;
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
		return this.admission.read(() =>
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
		return this.admission.write(() => this.bucket.put(key, value, options));
	}
}

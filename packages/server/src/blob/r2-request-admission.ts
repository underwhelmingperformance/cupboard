import { CountingSemaphore } from '@cupboard/shared/concurrency';

import {
	holdSubrequests,
	requireSubrequestsFor,
	type SubrequestHold
} from '../do/subrequest-slice.ts';

export interface R2AdmissionOptions {
	readonly signal?: AbortSignal;
	/**
	 * Optional calls must fit the unreserved subrequest allowance.
	 */
	readonly priority?: 'required' | 'optional';
}

/**
 * Shares connection admission across native and metadata operations. Streamed
 * writes leave one connection for reads because their input may depend on a
 * read that starts after the write.
 */
export class R2RequestAdmission {
	private readonly connections: CountingSemaphore;
	private readonly writes: CountingSemaphore;
	constructor(limit: number) {
		if (!Number.isSafeInteger(limit) || limit < 2) {
			throw new RangeError(
				'The connection limit must leave a connection for reads.'
			);
		}
		this.connections = new CountingSemaphore(limit);
		this.writes = new CountingSemaphore(limit - 1);
	}
	private check(options: R2AdmissionOptions): void {
		options.signal?.throwIfAborted();
		if (options.priority === 'optional') {
			requireSubrequestsFor(1, 'optional R2 request');
		}
	}
	private connect<T>(
		admitted: SubrequestHold,
		call: () => Promise<T>,
		options: R2AdmissionOptions
	): Promise<T> {
		return this.connections.run(() => {
			// The binding counts the call at entry, so release its reservation first.
			admitted.release();
			this.check(options);
			return call();
		});
	}
	private async request<T>(
		kind: 'read' | 'write',
		call: () => Promise<T>,
		options: R2AdmissionOptions
	): Promise<T> {
		this.check(options);
		const admitted = holdSubrequests(1);
		const release = () => {
			admitted.release();
		};
		options.signal?.addEventListener('abort', release, { once: true });
		try {
			const connect = () => this.connect(admitted, call, options);
			return await (kind === 'write' ? this.writes.run(connect) : connect());
		} finally {
			admitted.release();
			options.signal?.removeEventListener('abort', release);
		}
	}
	read<T>(
		call: () => Promise<T>,
		options: R2AdmissionOptions = {}
	): Promise<T> {
		return this.request('read', call, options);
	}
	write<T>(
		call: () => Promise<T>,
		options: R2AdmissionOptions = {}
	): Promise<T> {
		return this.request('write', call, options);
	}
}

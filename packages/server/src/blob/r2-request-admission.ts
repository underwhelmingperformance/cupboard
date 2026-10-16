import { CountingSemaphore } from '@cupboard/shared/concurrency';

import {
	checkSubrequestAdmission,
	holdSubrequests,
	type SubrequestAdmissionOptions,
	type SubrequestHold
} from '../do/subrequest-slice.ts';
import { SubrequestTimeoutError } from '../errors.ts';

export type R2AdmissionOptions = SubrequestAdmissionOptions;

/**
 * Shares connection admission across native and metadata operations. Streamed
 * writes leave one connection for reads because their input may depend on a
 * read that starts after the write. A caller timeout keeps admission until
 * the underlying binding call finishes.
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
	private async perform<T>(
		call: () => Promise<T>,
		outcome: PromiseWithResolvers<T>
	): Promise<void> {
		try {
			outcome.resolve(await call());
		} catch (error) {
			outcome.reject(error);
			if (error instanceof SubrequestTimeoutError) {
				await error.abandoned;
			}
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
			checkSubrequestAdmission(options, 'optional R2 request');
			return call();
		});
	}
	private async request<T>(
		kind: 'read' | 'write',
		call: () => Promise<T>,
		options: R2AdmissionOptions
	): Promise<T> {
		checkSubrequestAdmission(options, 'optional R2 request');
		const admitted = holdSubrequests(1);
		const release = () => {
			admitted.release();
		};
		options.signal?.addEventListener('abort', release, { once: true });
		try {
			const outcome = Promise.withResolvers<T>();
			const connect = () =>
				this.connect(admitted, () => this.perform(call, outcome), options);
			const completion =
				kind === 'write' ? this.writes.run(connect) : connect();
			void completion.catch(outcome.reject);
			return await outcome.promise;
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

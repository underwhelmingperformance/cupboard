import {
	checkSubrequestAdmission,
	holdSubrequests,
	type SubrequestAdmissionOptions
} from '../do/subrequest-slice.ts';
import { SubrequestTimeoutError } from '../errors.ts';

export type R2AdmissionOptions = SubrequestAdmissionOptions;

type R2RequestKind = 'read' | 'write';

interface QueuedR2Request {
	readonly kind: R2RequestKind;
	readonly isOptional: boolean;
	start(): void;
}

/**
 * Keeps capacity available to required calls until `release` is called.
 * Releasing the reservation more than once has no effect.
 */
export interface R2ConnectionReservation {
	release(): void;
}

/**
 * Shares connection admission across native and metadata operations. Streamed
 * native writes leave one connection for required reads, including when
 * optional head calls remain active. A caller timeout keeps admission until
 * the underlying binding call finishes.
 */
export class R2RequestAdmission {
	private active = 0;
	private writes = 0;
	private optional = 0;
	private optionalReads = 0;
	private requiredWrites = 0;
	private readonly queued: QueuedR2Request[] = [];
	private readonly reservations = new Map<symbol, number>();

	constructor(private readonly limit: number) {
		if (!Number.isSafeInteger(limit) || limit < 2) {
			throw new RangeError(
				'The connection limit must leave a connection for reads.'
			);
		}
	}

	private get requiredConnections(): number {
		return Math.max(0, ...this.reservations.values());
	}

	private canStart(request: QueuedR2Request): boolean {
		if (this.active >= this.limit) {
			return false;
		}
		if (request.kind === 'write' && this.writes >= this.limit - 1) {
			return false;
		}
		if (
			request.isOptional &&
			this.optional >= this.limit - this.requiredConnections
		) {
			return false;
		}
		const requiresSourceRead =
			this.requiredConnections > 0 ||
			this.requiredWrites > 0 ||
			(!request.isOptional && request.kind === 'write');
		return (
			!requiresSourceRead ||
			(!request.isOptional && request.kind === 'read') ||
			this.writes + this.optionalReads < this.limit - 1
		);
	}

	private dispatch(): void {
		while (this.active < this.limit) {
			const required = this.queued.findIndex(
				(request) => !request.isOptional && this.canStart(request)
			);
			const index =
				required === -1
					? this.queued.findIndex((request) => this.canStart(request))
					: required;
			if (index === -1) {
				return;
			}
			const [request] = this.queued.splice(index, 1);
			request?.start();
		}
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

	private started(request: QueuedR2Request): void {
		this.active++;
		if (request.kind === 'write') {
			this.writes++;
		}
		if (request.isOptional) {
			this.optional++;
		}
		if (request.isOptional && request.kind === 'read') {
			this.optionalReads++;
		}
		if (!request.isOptional && request.kind === 'write') {
			this.requiredWrites++;
		}
	}

	private finished(request: QueuedR2Request): void {
		this.active--;
		if (request.kind === 'write') {
			this.writes--;
		}
		if (request.isOptional) {
			this.optional--;
		}
		if (request.isOptional && request.kind === 'read') {
			this.optionalReads--;
		}
		if (!request.isOptional && request.kind === 'write') {
			this.requiredWrites--;
		}
		this.dispatch();
	}

	private async request<T>(
		kind: R2RequestKind,
		call: () => Promise<T>,
		options: R2AdmissionOptions
	): Promise<T> {
		checkSubrequestAdmission(options, 'optional R2 request');
		const admitted = holdSubrequests(1);
		const outcome = Promise.withResolvers<T>();
		const readiness = Promise.withResolvers<boolean>();
		const request: QueuedR2Request = {
			kind,
			isOptional: options.priority === 'optional',
			start: () => {
				this.started(request);
				readiness.resolve(true);
			}
		};
		// Await admission in the caller's async context so dispatch from another
		// request cannot change the binding's deadline or subrequest slice.
		const execute = async () => {
			if (!(await readiness.promise)) {
				return;
			}
			try {
				await this.perform(() => {
					// The binding counts the call at entry, so release its reservation first.
					admitted.release();
					checkSubrequestAdmission(options, 'optional R2 request');
					return call();
				}, outcome);
			} finally {
				this.finished(request);
			}
		};
		void execute().catch(outcome.reject);
		const cancel = () => {
			const index = this.queued.indexOf(request);
			if (index === -1) {
				return;
			}
			this.queued.splice(index, 1);
			admitted.release();
			readiness.resolve(false);
			outcome.reject(options.signal?.reason);
			this.dispatch();
		};
		options.signal?.addEventListener('abort', cancel, { once: true });
		try {
			this.queued.push(request);
			this.dispatch();
			return await outcome.promise;
		} finally {
			admitted.release();
			options.signal?.removeEventListener('abort', cancel);
		}
	}

	/**
	 * Creates a foreground capacity reservation before optional work starts.
	 * Nested reservations use the maximum count, bounded by the pool's capacity.
	 * Existing calls continue, so a reservation cannot reclaim a connection from
	 * a call already in progress.
	 */
	reserveRequiredConnections(count: number): R2ConnectionReservation {
		if (!Number.isSafeInteger(count) || count < 1) {
			throw new RangeError(
				'The required connection count must be a positive safe integer.'
			);
		}
		const token = Symbol();
		this.reservations.set(token, Math.min(count, this.limit));
		return {
			release: () => {
				if (this.reservations.delete(token)) {
					this.dispatch();
				}
			}
		};
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

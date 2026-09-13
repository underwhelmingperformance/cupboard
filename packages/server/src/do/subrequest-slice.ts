import { AsyncLocalStorage } from 'node:async_hooks';

import {
	subrequestSafetyReserve,
	workersInvocationAllowances
} from '@cupboard/protocol/platform';

import { SubrequestSliceExceededError } from '../errors.ts';

import { wrapDispatchedMethods } from './dispatch-scope.ts';

/**
 * Tracks D1 and R2 binding calls against one dispatch's subrequest allowance.
 *
 * Cloudflare does not expose its live subrequest count. Redirects and other
 * bindings can consume calls that this slice does not record, so admission
 * also leaves a reserve. A maintenance pass checks {@link hasSubrequestsFor}
 * before each unit of work and saves its cursor when the allowance is too low
 * to continue.
 */
class SubrequestSlice {
	private spent = 0;
	private held = 0;

	constructor(
		private readonly slice: number,
		private readonly reserve: number
	) {}

	get available(): number {
		return Math.max(0, this.slice - this.reserve - this.spent - this.held);
	}

	/**
	Whether `subrequests` more calls stay within the slice less its reserve.
	*/
	admits(subrequests: number): boolean {
		return subrequests <= this.available;
	}

	spend(subrequests: number, subject: string): void {
		if (this.spent + subrequests > this.slice) {
			throw new SubrequestSliceExceededError(subject, subrequests);
		}

		this.spent += subrequests;
	}

	hold(subrequests: number): void {
		this.held += subrequests;
	}

	releaseHold(subrequests: number): void {
		this.held -= subrequests;
	}
}

const sliceScope = new AsyncLocalStorage<SubrequestSlice>();

/**
 * The part of a slice that {@link hasSubrequestsFor} never admits. Redirects
 * and bindings outside the D1 and R2 wrappers may consume calls that the
 * slice cannot count. The reserve is a chosen margin, not a measured upper
 * bound on those calls.
 */
export const subrequestSliceReserve = subrequestSafetyReserve;

export interface SubrequestSliceOptions {
	/**
	The slice's size. Defaults to the Free plan allowance.
	*/
	readonly subrequests?: number;
	/**
	The part of the slice never admitted. Defaults to `subrequestSliceReserve`.
	*/
	readonly reserve?: number;
}

/**
 * Runs `body` under one dispatch's slice of the object's subrequests.
 *
 * A nested call reuses the enclosing slice, so every dispatched method can open
 * one without giving the same pass a second share.
 */
export function withSubrequestSlice<T>(
	body: () => T,
	options: SubrequestSliceOptions = {}
): T {
	if (sliceScope.getStore() !== undefined) {
		return body();
	}

	return sliceScope.run(
		new SubrequestSlice(
			options.subrequests ?? workersInvocationAllowances.free.subrequests,
			options.reserve ?? subrequestSliceReserve
		),
		body
	);
}

/**
 * Whether the current pass can afford `subrequests` more R2 or D1 calls.
 *
 * A pass asks before each unit of work and defers when the answer is no.
 * Reserve the calls that finish the pass by asking for them alongside the
 * unit, so running out partway cannot prevent the work already done from
 * being recorded.
 *
 * Outside a slice nothing is metered and the answer is yes. Worker entrypoints
 * and Durable Object dispatches open slices.
 */
export function hasSubrequestsFor(subrequests: number): boolean {
	return sliceScope.getStore()?.admits(subrequests) ?? true;
}

export function subrequestsAvailable(): number {
	return sliceScope.getStore()?.available ?? Number.MAX_SAFE_INTEGER;
}

export function affordableSubrequestOperations(
	subrequestsEach: number,
	keepBack = 0
): number {
	return Math.floor(
		Math.max(0, subrequestsAvailable() - keepBack) / subrequestsEach
	);
}

export async function withHeldSubrequests<T>(
	subrequests: number,
	body: () => Promise<T>
): Promise<T> {
	const slice = sliceScope.getStore();

	if (slice === undefined) {
		return body();
	}

	slice.hold(subrequests);

	try {
		return await body();
	} finally {
		slice.releaseHold(subrequests);
	}
}

/**
 * Refuses a unit of work the current slice cannot afford. A caller uses this
 * where the unit was sized by the sender to fit one invocation, so a refusal
 * is a defect in that sizing and not a condition to defer on.
 */
export function requireSubrequestsFor(
	subrequests: number,
	subject: string
): void {
	if (!hasSubrequestsFor(subrequests)) {
		throw new SubrequestSliceExceededError(subject, subrequests);
	}
}

/**
 * Records `subrequests` against the current slice. The bounded R2 and D1
 * bindings call this before each call they make; a D1 batch is one call.
 * Durable Object storage is not counted, because the runtime counts no storage
 * operation as a subrequest; the row budget measures that work.
 */
export function spendSubrequests(
	subrequests: number,
	subject = 'binding call'
): void {
	sliceScope.getStore()?.spend(subrequests, subject);
}

/**
 * Wraps every method on `prototype` so each dispatch runs under one slice, and
 * so nested dispatches share it.
 */
export function enterSubrequestSliceOnDispatch<Receiver extends object>(
	prototype: Receiver,
	allowanceOf: (receiver: Receiver) => number
): void {
	wrapDispatchedMethods(prototype, (body, receiver) =>
		withSubrequestSlice(body, { subrequests: allowanceOf(receiver) })
	);
}

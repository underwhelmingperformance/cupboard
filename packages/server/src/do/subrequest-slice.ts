import { AsyncLocalStorage } from 'node:async_hooks';

import { subrequestsPerInvocation } from '@cupboard/protocol/platform';

import { SubrequestSliceExceededError } from '../errors.ts';

import { wrapDispatchedMethods } from './dispatch-scope.ts';

/**
 * One dispatch's self-imposed share of the subrequests a Durable Object may
 * make.
 *
 * This is not a balance the platform agrees with, which is why it answers a
 * question instead of reporting a number as `statementsRemaining` and
 * `rowsRemaining` do. The runtime's own count is readable nowhere, each hop
 * of a redirect counts, and Cloudflare states the total may exceed the calls
 * the code makes. A pass asks {@link hasSubrequestsFor} before a unit of work
 * and defers with its cursor when the answer is no; the alternative is
 * stopping where the platform refuses a call.
 */
class SubrequestSlice {
	private spent = 0;

	constructor(
		private readonly slice: number,
		private readonly reserve: number
	) {}

	/**
	Whether `subrequests` more calls stay within the slice less its reserve.
	*/
	admits(subrequests: number): boolean {
		return this.spent + subrequests + this.reserve <= this.slice;
	}

	spend(subrequests: number): void {
		this.spent += subrequests;
	}
}

const sliceScope = new AsyncLocalStorage<SubrequestSlice>();

/**
 * The part of a slice {@link hasSubrequestsFor} never admits. Calls the slice
 * does not see land here instead of at the ceiling: Cloudflare states its
 * count may exceed the calls the code makes, and a dispatch may read D1 or
 * KV through a binding the slice does not wrap. The figure is chosen, not
 * measured; the calls it covers number a few per request.
 */
export const subrequestSliceReserve = 100;

export interface SubrequestSliceOptions {
	/**
	The slice's size. Defaults to the pinned ceiling.
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
			options.subrequests ?? subrequestsPerInvocation,
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
 * Outside a slice nothing is metered and the answer is yes. Worker code runs
 * there: only a Durable Object dispatch opens a slice.
 */
export function hasSubrequestsFor(subrequests: number): boolean {
	return sliceScope.getStore()?.admits(subrequests) ?? true;
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
export function spendSubrequests(subrequests: number): void {
	sliceScope.getStore()?.spend(subrequests);
}

/**
 * Wraps every method on `prototype` so each dispatch runs under one slice, and
 * so nested dispatches share it.
 */
export function enterSubrequestSliceOnDispatch(prototype: object): void {
	wrapDispatchedMethods(prototype, (body) => withSubrequestSlice(body));
}

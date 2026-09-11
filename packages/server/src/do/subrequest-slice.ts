import { AsyncLocalStorage } from 'node:async_hooks';

import { subrequestsPerInvocation } from '@cupboard/protocol/platform';

import { wrapDispatchedMethods } from './dispatch-scope.ts';

/**
 * One pass's self-imposed share of the subrequests a Durable Object may make.
 *
 * This is not a balance the platform agrees with, and it deliberately reads
 * differently from `statementsRemaining` and `rowsRemaining`, which report
 * something one invocation genuinely owns. The runtime's own subrequest count is
 * readable nowhere: not on the context, not on the request, not on the
 * environment. It belongs to the object's I/O context rather than to one
 * request, so every concurrent request to the same object spends from it. It is
 * topped up on each new request and on each WebSocket message by an amount
 * Cloudflare does not publish, and this repository holds a commit WebSocket, so
 * that is not hypothetical. The runtime may also count calls this slice cannot
 * see, because a redirect counts more than once and the documentation says the
 * total may exceed the calls a script makes.
 *
 * What the slice is good for is letting a pass stop at a boundary it chose. A
 * pass asks {@link hasSubrequestsFor} before a granule, does the granule, and
 * defers with its cursor when the answer is no. That is worth having even though
 * the figure is approximate, because the alternative is stopping where the
 * platform refuses a call, which is a boundary nobody picked.
 */
class SubrequestSlice {
	private spent = 0;

	constructor(private readonly slice: number) {}

	/**
	Whether `subrequests` more calls stay within the slice.
	*/
	admits(subrequests: number): boolean {
		return this.spent + subrequests <= this.slice;
	}

	spend(subrequests: number): void {
		this.spent += subrequests;
	}
}

const sliceScope = new AsyncLocalStorage<SubrequestSlice>();

/**
 * Runs `body` under one pass's slice of the object's subrequests.
 *
 * A nested call reuses the enclosing slice, so every dispatched method can open
 * one without giving the same pass a second share.
 */
export function withSubrequestSlice<T>(
	body: () => T,
	subrequests: number = subrequestsPerInvocation
): T {
	if (sliceScope.getStore() !== undefined) {
		return body();
	}

	return sliceScope.run(new SubrequestSlice(subrequests), body);
}

/**
 * Whether the current pass can afford `subrequests` more R2 or D1 calls.
 *
 * A pass asks before each granule of work and defers when the answer is no.
 * Reserve the calls that finish the pass by asking for them alongside the
 * granule, so running out partway cannot prevent the work already done from
 * being recorded.
 *
 * Outside a slice nothing is metered and the answer is yes. Worker code runs
 * there: its bindings are the ones the runtime supplies, which this slice does
 * not wrap.
 */
export function hasSubrequestsFor(subrequests: number): boolean {
	return sliceScope.getStore()?.admits(subrequests) ?? true;
}

/**
 * Records `subrequests` against the current pass's slice. The bounded R2 and D1
 * bindings call this before each call they make.
 *
 * Durable Object storage is not counted, because the runtime does not count it:
 * reading and writing the object's own SQLite, and setting its alarm, reach no
 * subrequest. The row budget measures that work instead, and the two do not
 * overlap.
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

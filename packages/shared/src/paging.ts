import { getLogger } from '@logtape/logtape';

import { chunk, type ProgressivePage } from './collections.ts';
import { mapWithConcurrency } from './concurrency.ts';
import { CodedError } from './errors.ts';
import {
	abortableSleep,
	backoffDelayMs,
	loggedUrl,
	type ReplaySafety
} from './retry.ts';
import {
	attemptWithDeadline,
	probeDeadlineMs,
	ProbeTimeoutError
} from './timeout.ts';

const logger = getLogger(['cupboard', 'probe']);

/**
The number of attempts, including the first, that {@link requestWithDeadline}
makes at a replay-safe request before it reports a deadline expiry.
*/
export const maxProbeAttempts = 3;

/**
Identifies a probe in debug logs: an HTTP request by its URL, or an admin
API call by its procedure, such as `caches.list`.
*/
export type ProbeTarget = (
	| {
			/**
			The probe URL without user information or a query.
			*/
			readonly url: string;
	  }
	| { readonly procedure: string }
) & {
	/**
	The number of inputs in the request, for a request with several.
	*/
	readonly inputs?: number;
};

function describeTarget(target: ProbeTarget): string {
	return 'url' in target ? target.url : `the ${target.procedure} procedure`;
}

export interface DeadlineOptions {
	/**
	Identifies the request in debug logs and in its deadline expiry.
	*/
	readonly target: ProbeTarget;
	/**
	Whether the server can receive the request again without a different
	effect. Only a replay-safe request is sent again after its deadline
	expires.
	*/
	readonly replaySafety: ReplaySafety;
	/**
	The caller's signal. It aborts the attempt in progress, and after it
	aborts no further attempt starts.
	*/
	readonly signal?: AbortSignal | undefined;
	readonly deadlineMs?: number;
}

type ProbeOutcome =
	| { readonly outcome: 'succeeded' }
	| { readonly outcome: 'timed out' }
	| { readonly outcome: 'failed'; readonly errorName: string };

function failureOutcome(error: unknown, isExpiry: boolean): ProbeOutcome {
	if (isExpiry) {
		return { outcome: 'timed out' };
	}

	return {
		outcome: 'failed',
		errorName: error instanceof Error ? error.name : typeof error
	};
}

/**
Runs `request` with a deadline, which defaults to {@link probeDeadlineMs}.
`request` receives a signal that aborts when the deadline passes, so a
request that uses it releases its connection. The attempt then rejects with
a {@link ProbeTimeoutError} for the target.

A replay-safe request starts again after its own deadline expires, up to
{@link maxProbeAttempts} attempts in total, with a full-jitter backoff
between them. A replay-unsafe request makes one attempt. Every other error
propagates unchanged, including a `ProbeTimeoutError` that `request` raises
itself, and an abort during the backoff rejects with the abort reason. Each
attempt and each retry is logged at debug level.

Put transport retries inside `request`. One deadline then covers each
attempt and its transport retries.
*/
export async function requestWithDeadline<T>(
	request: (signal: AbortSignal) => Promise<T>,
	options: DeadlineOptions
): Promise<T> {
	const attempts =
		options.replaySafety === 'replay-safe' ? maxProbeAttempts : 1;

	for (let attempt = 1; ; attempt += 1) {
		options.signal?.throwIfAborted();

		let expiry: ProbeTimeoutError | undefined;
		const startedAt = Date.now();
		try {
			const result = await attemptWithDeadline(
				request,
				options.deadlineMs ?? probeDeadlineMs,
				() => (expiry = new ProbeTimeoutError(describeTarget(options.target))),
				options.signal
			);
			logger.debug('probe attempt finished', () => ({
				...options.target,
				attempt,
				outcome: 'succeeded',
				elapsedMs: Date.now() - startedAt
			}));

			return result;
		} catch (error) {
			const isExpiry = expiry !== undefined && error === expiry;
			logger.debug('probe attempt finished', () => ({
				...options.target,
				attempt,
				...failureOutcome(error, isExpiry),
				elapsedMs: Date.now() - startedAt
			}));

			if (
				!isExpiry ||
				options.signal?.aborted === true ||
				attempt >= attempts
			) {
				throw error;
			}
		}

		const delayMs = backoffDelayMs(attempt);
		logger.debug('retrying probe after its deadline expired', {
			...options.target,
			nextAttempt: attempt + 1,
			delayMs
		});
		await abortableSleep(delayMs, options.signal);
	}
}

export interface ProbeFetchOptions {
	readonly deadlineMs?: number;
}

/**
Sends a replay-safe read probe through {@link requestWithDeadline}, which
applies one deadline to the request and the consumption of its response
and sends the request again when the deadline expires. The abort that ends
a timed-out attempt closes its connection, so the next attempt does not
wait on the same stalled connection. `init.signal` is the caller's signal
for both the requests and the backoff.
*/
export async function fetchWithProbeRetries<Result>(
	fetcher: typeof fetch,
	url: string,
	init: RequestInit | undefined,
	consume: (response: Response) => Result | Promise<Result>,
	options: ProbeFetchOptions = {}
): Promise<Result> {
	return requestWithDeadline(
		async (signal) => consume(await fetcher(url, { ...init, signal })),
		{
			target: { url: loggedUrl(url) },
			replaySafety: 'replay-safe',
			signal: init?.signal ?? undefined,
			...(options.deadlineMs !== undefined && {
				deadlineMs: options.deadlineMs
			})
		}
	);
}

export class PageResultCountError extends CodedError {
	constructor(
		public readonly requested: number,
		public readonly returned: number
	) {
		super(
			`A paged lookup requested ${String(requested)} inputs but received ${String(returned)} results; the response must contain between 1 and ${String(requested)} results`
		);
		this.name = 'PageResultCountError';
	}
}

/**
Sends one request for a list of inputs. It returns results for a non-empty
prefix of `inputs`, in input order. When the server stops early, the lookup
sends the remaining inputs in another request. The request must use
`signal`, which aborts when its deadline expires.

A request can still finish after its deadline, while the lookup sends the
same inputs again, and the lookup then discards its results. A request that
changes state outside its results must check `signal` before it does so.
*/
export type PageRequest<Input, Result> = (
	inputs: readonly Input[],
	signal: AbortSignal
) => Promise<readonly Result[]>;

export interface PageLookup<Input, Result> {
	readonly request: PageRequest<Input, Result>;
	/**
	The deadline and replay safety of each request. The lookup adds the
	number of inputs in each request to the target.
	*/
	readonly deadline: DeadlineOptions;
	/**
	Whether a failed request had too many inputs for the server. The lookup
	then sends the first half of those inputs, halving again until a request
	has one input, and sends the remaining inputs in later requests.
	*/
	readonly isPageTooLarge?: (error: unknown) => boolean;
	/**
	The largest number of inputs in one request, which the lookup reads again
	before each request. Without it, each request sends every remaining
	input.
	*/
	readonly requestSize?: () => number;
}

export interface PagedLookup<Input, Result> extends PageLookup<Input, Result> {
	/**
	The largest number of inputs in one page.
	*/
	readonly pageSize: number;
	/**
	The largest number of pages in progress at once.
	*/
	readonly concurrency: number;
	/**
	Whether to complete the first page before starting the others, for example
	so its response can establish state that later requests send.
	*/
	readonly finishFirstPage?: boolean;
}

/**
Requests `inputs` as one page through {@link requestWithDeadline}, in
requests of at most `requestSize` inputs when the lookup sets it. When a
response has results for only a prefix of the inputs, sends the rest in a
further request. Returns one result for each input, in input order. A
response with no results, or with more results than the request had inputs,
rejects with {@link PageResultCountError}.
*/
export async function lookupPage<Input, Result>(
	inputs: readonly Input[],
	lookup: PageLookup<Input, Result>
): Promise<Result[]> {
	const results: Result[] = [];
	let offset = 0;

	while (offset < inputs.length) {
		const requestSize = lookup.requestSize?.() ?? inputs.length;
		const requested = inputs.slice(offset, offset + requestSize);
		const pageResults = await requestPrefix(requested, lookup);

		if (pageResults.length === 0 || pageResults.length > requested.length) {
			throw new PageResultCountError(requested.length, pageResults.length);
		}

		results.push(...pageResults);
		offset += pageResults.length;
	}

	return results;
}

async function requestPrefix<Input, Result>(
	inputs: readonly Input[],
	lookup: PageLookup<Input, Result>
): Promise<readonly Result[]> {
	try {
		return await requestWithDeadline(
			(signal) => lookup.request(inputs, signal),
			{
				...lookup.deadline,
				target: { ...lookup.deadline.target, inputs: inputs.length }
			}
		);
	} catch (error) {
		if (inputs.length === 1 || lookup.isPageTooLarge?.(error) !== true) {
			throw error;
		}

		return lookupPage(inputs.slice(0, Math.ceil(inputs.length / 2)), lookup);
	}
}

/**
Splits `inputs` into pages of at most `pageSize`, looks up each page with
{@link lookupPage} with at most `concurrency` pages in progress, and returns
one result for each input, in input order. After a page fails, no further
pages start, the lookup aborts the requests of the pages in progress, and it
rejects with the first failure.
*/
export async function lookupInPages<Input, Result>(
	inputs: readonly Input[],
	lookup: PagedLookup<Input, Result>
): Promise<Result[]> {
	const failed = new AbortController();
	const callerSignal = lookup.deadline.signal;
	const pageLookup: PageLookup<Input, Result> = {
		...lookup,
		deadline: {
			...lookup.deadline,
			signal:
				callerSignal === undefined
					? failed.signal
					: AbortSignal.any([callerSignal, failed.signal])
		}
	};
	const lookUp = async (page: readonly Input[]): Promise<Result[]> => {
		try {
			return await lookupPage(page, pageLookup);
		} catch (error) {
			failed.abort(error);
			throw error;
		}
	};
	const pages = chunk(inputs, lookup.pageSize);
	const firstPage = lookup.finishFirstPage === true ? pages.shift() : undefined;
	const first = firstPage === undefined ? [] : await lookUp(firstPage);
	const rest = await mapWithConcurrency(pages, lookup.concurrency, lookUp);

	return [...first, ...rest.flat()];
}

/**
One page of a listing that the server returns in pages. `next` is the
cursor for the following page, and the last page has none.
*/
export interface CursorPage<Item, Cursor> {
	readonly items: readonly Item[];
	readonly next?: Cursor | undefined;
}

/**
Requests the first page of a listing and returns it as a
{@link ProgressivePage} whose continuation requests the next page. Each
page request goes through {@link requestWithDeadline} with `deadline`.
`request` receives the cursor from the previous page, or `undefined` for
the first page, and must use `signal`, which aborts when the deadline
expires. As with a {@link PageRequest}, a request that changes state outside
its page must check `signal` before it does so.
*/
export async function cursorPages<Item, Cursor>(
	request: (
		cursor: Cursor | undefined,
		signal: AbortSignal
	) => Promise<CursorPage<Item, Cursor>>,
	deadline: DeadlineOptions
): Promise<ProgressivePage<Item>> {
	const pageAfter = async (
		cursor: Cursor | undefined
	): Promise<ProgressivePage<Item>> => {
		const page = await requestWithDeadline(
			(signal) => request(cursor, signal),
			deadline
		);
		const next = page.next;

		return {
			items: page.items,
			...(next !== undefined && { next: () => pageAfter(next) })
		};
	};

	return pageAfter(undefined);
}

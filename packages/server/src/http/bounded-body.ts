import { getLogger } from '@cupboard/logger';

import {
	currentDeadlineSignal,
	withDeadlineBudget,
	withoutDeadline
} from '../do/deadline.ts';
import { SubrequestTimeoutError } from '../errors.ts';
import { minimumBodyBudgetMs } from '../policy/streaming.ts';

/**
Identifies a response body in the record of its truncation. `operation` is
also the `subrequest` of the `SubrequestTimeoutError` that ends the body.
*/
export interface BodyContext {
	readonly operation: string;
	readonly objectKey?: string;
}

/**
Keeps a bounded body's pipe running after the handler that returns the body.
It receives the promise that settles when the pipe ends, or when a refused
body has been cancelled. A client that disconnects while the source is stalled
goes unnoticed until the deadline, and a deployed Worker that did not keep the
pipe alive was cancelled at the disconnect, so the deadline and its record
never happened. A Durable Object ignores `waitUntil`.
*/
export type KeepAlive = (settled: Promise<void>) => void;

/**
Returns a {@link KeepAlive} that passes the pipe to `ctx.waitUntil`.
*/
export function keepAliveIn(
	ctx: Pick<ExecutionContext, 'waitUntil'>
): KeepAlive {
	return (settled) => {
		ctx.waitUntil(settled);
	};
}

const logger = getLogger(['cupboard', 'storage', 'stream']);

/**
Returns a stream of exactly `length` bytes, piped natively from `body`. The
pipe stops when `deadlineMs` passes.

A body that misses its deadline, or whose source fails, errors the stream,
and the client receives fewer bytes than the declared length. Only a missed
deadline writes a record. After a native pipe fails, workerd leaves both
streams in the same state whichever side failed, and a client that
disconnects rejects the pipe with a generic error, so the pipe does not tell
a failed source from a client that has gone. Workers Logs already show both,
as an exception or a cancelled invocation. Build the response's headers with
{@link boundedBodyHeaders}.

Throws `SubrequestTimeoutError`, after cancelling `body`, when `deadlineMs` is
less than `minimumBodyBudgetMs`. The route then returns a retryable 503
before it sends any headers.
*/
export function boundedBody(
	body: ReadableStream,
	length: number,
	deadlineMs: number,
	context: BodyContext,
	keepAlive: KeepAlive
): ReadableStream {
	if (deadlineMs < minimumBodyBudgetMs) {
		keepAlive(cancelUnread(body));

		throw new SubrequestTimeoutError(context.operation);
	}

	const destination = new FixedLengthStream(length);

	keepAlive(pipeBody(body, destination.writable, deadlineMs, context, length));

	return destination.readable;
}

async function pipeBody(
	body: ReadableStream,
	destination: WritableStream,
	deadlineMs: number,
	context: BodyContext,
	length: number
): Promise<void> {
	try {
		// The pipe outlives the handler, whose deadline scope stops its timer
		// when the handler returns, so the pipe starts a scope of its own.
		await withoutDeadline(() =>
			withDeadlineBudget(
				deadlineMs,
				() =>
					body.pipeTo(destination, {
						preventAbort: true,
						signal: currentDeadlineSignal()
					}),
				context.operation
			)
		);
	} catch (error) {
		if (
			error instanceof SubrequestTimeoutError &&
			error.subrequest === context.operation
		) {
			logger.warn('response body deadline passed', {
				...context,
				length,
				deadlineMs
			});
		}

		try {
			await destination.abort(error);
		} catch {
			// The destination has already failed, so nothing reads the body.
		}
	}
}

/**
Cancels a body that the response will not send, so its source stops
delivering bytes. Resolves even when the source has already failed.
*/
export async function cancelUnread(body: ReadableStream): Promise<void> {
	try {
		await body.cancel();
	} catch {
		// `cancel()` rejects only when the source has already failed.
	}
}

/**
Declares a bounded body's length in `headers` and adds `no-transform` to
their `Cache-Control`.

A client detects a truncated body only by comparing it with the declared
length. Cloudflare drops `Content-Length` from a response that it compresses
for the client, which `no-transform` prevents.
*/
export function boundedBodyHeaders(headers: Headers, length: number): Headers {
	headers.set('content-length', String(length));

	const directives = cacheDirectives(headers);

	if (!directives.includes(noTransform)) {
		headers.set('cache-control', [...directives, noTransform].join(', '));
	}

	return headers;
}

/**
Sets `Cache-Control: no-store` and keeps `no-transform` if the response has
it, so a bounded body that must not be stored still keeps its declared
length at the edge.
*/
export function forbidStoring(headers: Headers): void {
	headers.set(
		'cache-control',
		cacheDirectives(headers).includes(noTransform)
			? `no-store, ${noTransform}`
			: 'no-store'
	);
}

const noTransform = 'no-transform';

function cacheDirectives(headers: Headers): string[] {
	const cacheControl = headers.get('cache-control');

	return cacheControl === null
		? []
		: cacheControl.split(',').map((directive) => directive.trim());
}

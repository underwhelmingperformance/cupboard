import { type CapturedLog } from '@cupboard/logger/testing';
import { env } from 'cloudflare:workers';
import { type MockInstance, vi } from 'vitest';

import { passThrough } from '../do/pass-through.ts';
import { SubrequestTimeoutError } from '../errors.ts';

/**
How long a stalled body waits before it fails. A read without a deadline
therefore ends with the origin's own error, not the deadline's.
*/
const stallReleaseMs = 2000;

/**
Returns a body that arrives over a service binding, as an R2 body does,
delivers `sentBytes` zero bytes and then stalls.
*/
export async function stalledBody(
	sentBytes: number,
	releaseMs = stallReleaseMs
): Promise<ReadableStream<Uint8Array>> {
	const response = await env.TEST_STALLING_ORIGIN.fetch(
		`https://stalling-origin.invalid/?bytes=${String(sentBytes)}&releaseMs=${String(releaseMs)}`
	);

	if (response.body === null) {
		throw new TypeError('The stalling origin returned no body');
	}

	return response.body;
}

/**
Decides which R2 reads stall: the number of bytes that the stalled body
delivers, or undefined to serve the stored object.
*/
export type StallPlan = (
	key: string,
	options: R2GetOptions | undefined
) => number | undefined;

function withBody(
	object: R2ObjectBody,
	body: ReadableStream<Uint8Array>
): R2ObjectBody {
	return new Proxy(object, {
		get(target, property) {
			return property === 'body' ? body : passThrough(target, property);
		}
	});
}

/**
An R2 bucket whose reads return a stalled body when `plan` selects them. The
object's metadata is the stored object's, so the response that a read
builds is unchanged until the body stalls.
*/
export function stallingBlobs(
	bucket: R2Bucket,
	plan: StallPlan,
	releaseMs = stallReleaseMs
): R2Bucket {
	return new Proxy(bucket, {
		get(target, property) {
			if (property !== 'get') {
				return passThrough(target, property);
			}

			return async (key: string, options?: R2GetOptions) => {
				const object = await target.get(key, options);
				const sentBytes = plan(key, options);

				if (sentBytes === undefined || object === null || !('body' in object)) {
					return object;
				}

				await object.body.cancel();

				return withBody(object, await stalledBody(sentBytes, releaseMs));
			};
		}
	});
}

/**
What a reader of a body received: the number of bytes, and how the body
ended. A deadline ends it with the name of the operation that missed the
deadline; any other failure ends it with the name of the error.
*/
export interface DrainedBody {
	readonly bytes: number;
	readonly ending:
		| { readonly kind: 'complete' }
		| { readonly kind: 'deadline'; readonly operation: string }
		| { readonly kind: 'failed'; readonly error: string };
}

export async function drain(
	body: ReadableStream<Uint8Array> | null
): Promise<DrainedBody> {
	if (body === null) {
		return { bytes: 0, ending: { kind: 'complete' } };
	}

	const reader = body.getReader();
	let bytes = 0;

	try {
		for (;;) {
			const result = await reader.read();

			if (result.done) {
				return { bytes, ending: { kind: 'complete' } };
			}

			bytes += result.value.byteLength;
		}
	} catch (error) {
		const operation = deadlineOperation(error);

		return {
			bytes,
			ending:
				operation === undefined
					? { kind: 'failed', error: errorName(error) }
					: { kind: 'deadline', operation }
		};
	}
}

// A stream tunnels the error that aborted it, so the reader receives an
// error with the same name and fields but not the original class.
function deadlineOperation(error: unknown): string | undefined {
	if (
		!(error instanceof Error) ||
		error.name !== new SubrequestTimeoutError('').name ||
		!('subrequest' in error) ||
		typeof error.subrequest !== 'string'
	) {
		return undefined;
	}

	return error.subrequest;
}

const warningLevels = new Set(['warning', 'error', 'fatal']);

function errorName(error: unknown): string {
	return error instanceof Error ? error.name : typeof error;
}

/**
Every warning, from any logger, written while a test reads a bounded body. A
test asserts on all of them, so a warning from another part of the read, such
as a cost recorded late, is visible as well. An `error` property is replaced
by the error's name. Each property in `variable`, whose value differs from one
run to the next, is replaced by its type.
*/
export function streamRecords(
	logs: readonly CapturedLog[],
	variable: readonly string[] = []
): readonly CapturedLog[] {
	return logs
		.filter((log) => warningLevels.has(log.level))
		.map((log) => ({
			...log,
			properties: Object.fromEntries(
				Object.entries(log.properties).map(([name, value]) => {
					if (name === 'error') {
						return [name, errorName(value)];
					}

					return [name, variable.includes(name) ? typeof value : value];
				})
			)
		}));
}

/**
Whether a promise passed to `waitUntil` has settled.
*/
export type Settlement = 'pending' | 'settled';

/**
The promises passed to a context's `waitUntil` while it is recorded.
*/
export interface KeptPromises {
	settlements(): readonly Settlement[];
	stop(): void;
}

/**
Records each promise passed to `target.waitUntil` and still passes it on, so
a test can see which work outlives the handler and when it ends.
*/
export function recordKeptPromises(
	target: Pick<ExecutionContext, 'waitUntil'>
): KeptPromises {
	const waitUntil = target.waitUntil.bind(target);
	const settlements: Settlement[] = [];
	const spy: MockInstance = vi
		.spyOn(target, 'waitUntil')
		.mockImplementation((promise: Promise<unknown>) => {
			const index = settlements.length;
			settlements.push('pending');
			const settle = (): void => {
				settlements[index] = 'settled';
			};
			void promise.then(settle).catch(settle);
			waitUntil(promise);
		});

	return {
		settlements: () => [...settlements],
		stop: () => {
			spy.mockRestore();
		}
	};
}

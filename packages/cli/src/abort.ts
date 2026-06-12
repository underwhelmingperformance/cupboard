import { setTimeout as delay } from 'node:timers/promises';

import { CliAbortError } from './errors.ts';

export type Delay = (ms: number) => Promise<void>;

export interface DelayOptions {
	readonly signal?: AbortSignal;
	readonly delay?: Delay;
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted !== true) {
		return;
	}

	throw abortReason(signal);
}

export async function abortable<T>(
	promise: Promise<T>,
	signal: AbortSignal | undefined
): Promise<T> {
	throwIfAborted(signal);

	if (signal === undefined) {
		return await promise;
	}

	let abort: (() => void) | undefined;
	const aborted = new Promise<never>((_, reject) => {
		abort = () => {
			reject(abortReason(signal));
		};

		signal.addEventListener('abort', abort, { once: true });
	});

	try {
		throwIfAborted(signal);

		return await Promise.race([promise, aborted]);
	} finally {
		if (abort !== undefined) {
			signal.removeEventListener('abort', abort);
		}
	}
}

export function delayMs(ms: number, options: DelayOptions = {}): Promise<void> {
	return options.delay === undefined
		? delay(ms, undefined, { signal: options.signal })
		: abortable(options.delay(ms), options.signal);
}

export function isAbortError(error: unknown): boolean {
	return (
		error instanceof CliAbortError ||
		(error instanceof Error && error.name === 'AbortError')
	);
}

function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new CliAbortError();
}

import { vi } from 'vitest';

/**
Fake `setTimeout` and `clearTimeout` for a test in which one probe request
stalls until its deadline expires. The test advances fake time past the
deadline, and the probe sends the request again.

Other requests of the same test run with real I/O, for example while they read
the netrc file. Each of them has a deadline timer until it finishes, and
advancing fake time while one is pending would expire its deadline too.
`untilOnlyStalledRequestPending` therefore waits until the stalled request's
timer is the only one. It rechecks on every change to the timers, because
every deadline timer is armed with `setTimeout` and cleared with
`clearTimeout`.

The timers must be faked only through `start`, and `stop` must run when the
test ends. Only `setTimeout` and `clearTimeout` are faked, so that
`setImmediate` still lets the real I/O complete.
*/
export class StalledRequestTimers {
	static start(): StalledRequestTimers {
		return new StalledRequestTimers();
	}

	readonly #stop: () => void;
	#hasStalled = false;
	#changed = Promise.withResolvers<undefined>();

	private constructor() {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		const fakeSetTimeout = setTimeout;
		const fakeClearTimeout = clearTimeout;
		const setTimeoutSpy = vi
			.spyOn(globalThis, 'setTimeout')
			.mockImplementation((...arguments_) => {
				const timer = fakeSetTimeout(...arguments_);
				this.#notify();

				return timer;
			});
		const clearTimeoutSpy = vi
			.spyOn(globalThis, 'clearTimeout')
			.mockImplementation((...arguments_) => {
				fakeClearTimeout(...arguments_);
				this.#notify();
			});
		this.#stop = () => {
			setTimeoutSpy.mockRestore();
			clearTimeoutSpy.mockRestore();
			vi.useRealTimers();
		};
	}

	#notify(): void {
		const changed = this.#changed;
		this.#changed = Promise.withResolvers<undefined>();
		changed.resolve(undefined);
	}

	/**
	Restores the real timers.
	*/
	stop(): void {
		this.#stop();
	}

	/**
	Records that the stalled request has been sent. The caller calls this
	when the request reaches the fake network, and then returns a response
	that never completes.
	*/
	markStalled(): void {
		this.#hasStalled = true;
		this.#notify();
	}

	/**
	Records the stalled request and returns the response that stays pending
	until `signal` aborts, as `stalledResponse` does.
	*/
	stalledResponse(signal: AbortSignal | null | undefined): Promise<Response> {
		this.markStalled();

		return stalledResponse(signal);
	}

	/**
	Waits until the stalled request has been sent and its deadline timer is
	the only pending timer.
	*/
	async untilOnlyStalledRequestPending(): Promise<void> {
		while (!this.#hasStalled || vi.getTimerCount() !== 1) {
			await this.#changed.promise;
		}
	}
}

/**
Returns a promise that stays pending, as a response on a stalled connection
does, until `signal` aborts. The promise then rejects with the abort reason.
*/
export function stalledResponse(
	signal: AbortSignal | null | undefined
): Promise<Response> {
	const { promise, reject } = Promise.withResolvers<Response>();

	signal?.addEventListener(
		'abort',
		() => {
			reject(
				signal.reason instanceof Error
					? signal.reason
					: new Error('The request was aborted', { cause: signal.reason })
			);
		},
		{ once: true }
	);

	return promise;
}

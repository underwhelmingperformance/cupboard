export function waitForProtection(
	operation: Promise<void>,
	signal: AbortSignal
): Promise<void> {
	if (signal.aborted) {
		return Promise.reject(abortReason(signal));
	}

	return new Promise((resolve, reject) => {
		const abort = (): void => {
			reject(abortReason(signal));
		};

		signal.addEventListener('abort', abort, { once: true });
		void operation
			.then(resolve)
			.catch(reject)
			.finally(() => {
				signal.removeEventListener('abort', abort);
			});
	});
}

export function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error
		? signal.reason
		: new Error('Output protection was cancelled.');
}

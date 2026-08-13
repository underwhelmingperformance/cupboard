import { describe, expect, it, vi } from 'vitest';

import {
	type ChildProcessLifecycle,
	waitForChildProcess
} from './child-process.ts';

class ControlledChildProcess implements ChildProcessLifecycle {
	private errorListener: ((error: Error) => void) | undefined;

	private closeListener:
		| ((status: number | null, signal: NodeJS.Signals | undefined) => void)
		| undefined;

	onceError(listener: (error: Error) => void): void {
		this.errorListener = listener;
	}

	onceClose(
		listener: (
			status: number | null,
			signal: NodeJS.Signals | undefined
		) => void
	): void {
		this.closeListener = listener;
	}

	emitError(error: Error): void {
		if (this.errorListener === undefined) {
			throw new Error('Expected the child error listener to be installed');
		}

		this.errorListener(error);
	}

	emitClose(status: number | null, signal?: NodeJS.Signals): void {
		if (this.closeListener === undefined) {
			throw new Error('Expected the child close listener to be installed');
		}

		this.closeListener(status, signal);
	}
}

describe('waitForChildProcess', () => {
	it('records an error without settling before process closure', async () => {
		const child = new ControlledChildProcess();
		const failure = new Error('spawn failed');
		const settled = vi.fn();
		const completion = waitForChildProcess(child);

		void completion.then(settled).catch(settled);
		child.emitError(failure);
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(settled.mock.calls).toStrictEqual([]);

		child.emitClose(0);

		await expect(completion).resolves.toStrictEqual({
			error: failure,
			signal: undefined,
			status: 0
		});
	});

	it('preserves the signal that terminated the child', async () => {
		const child = new ControlledChildProcess();
		const completion = waitForChildProcess(child);

		child.emitClose(1, 'SIGKILL');

		await expect(completion).resolves.toStrictEqual({
			error: undefined,
			signal: 'SIGKILL',
			status: 1
		});
	});
});

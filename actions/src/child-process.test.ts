import { describe, expect, it, vi } from 'vitest';

import {
	type AbortableChildProcessLifecycle,
	type ChildProcessEscalationScheduler,
	type ChildProcessLifecycle,
	terminationGracePeriodMs,
	waitForAbortableChildProcess,
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

class ControlledAbortableChildProcess
	extends ControlledChildProcess
	implements AbortableChildProcessLifecycle
{
	readonly signals: NodeJS.Signals[] = [];

	kill(signal: NodeJS.Signals): boolean {
		this.signals.push(signal);

		return true;
	}
}

interface ScheduledEscalation {
	readonly delayMs: number;
	readonly run: () => void;
	cancelled: boolean;
}

class ControlledScheduler implements ChildProcessEscalationScheduler {
	readonly escalations: ScheduledEscalation[] = [];

	schedule(run: () => void, delayMs: number): { cancel(): void } {
		const escalation = { delayMs, run, cancelled: false };

		this.escalations.push(escalation);

		return {
			cancel() {
				escalation.cancelled = true;
			}
		};
	}

	runPending(): void {
		for (const escalation of this.escalations) {
			if (!escalation.cancelled) {
				escalation.run();
			}
		}
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

describe('waitForAbortableChildProcess', () => {
	it('terminates exactly once when the signal is already aborted', async () => {
		const child = new ControlledAbortableChildProcess();
		const scheduler = new ControlledScheduler();
		const reason = new Error('already cancelled');
		const completion = waitForAbortableChildProcess(
			child,
			AbortSignal.abort(reason),
			scheduler
		);

		expect(child.signals).toStrictEqual(['SIGTERM']);

		child.emitClose(1, 'SIGTERM');

		await expect(completion).rejects.toBe(reason);
		expect(scheduler.escalations).toHaveLength(1);
	});

	it('terminates, escalates and preserves the exact abort reason after close', async () => {
		const child = new ControlledAbortableChildProcess();
		const scheduler = new ControlledScheduler();
		const controller = new AbortController();
		const reason = new Error('cancel the child');
		const settled = vi.fn();
		const completion = waitForAbortableChildProcess(
			child,
			controller.signal,
			scheduler
		);

		void completion.then(settled).catch(settled);
		controller.abort(reason);
		child.emitError(new Error('The operation was aborted'));
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect({
			signals: child.signals,
			escalations: scheduler.escalations.map(({ delayMs, cancelled }) => ({
				delayMs,
				cancelled
			})),
			settled: settled.mock.calls
		}).toStrictEqual({
			signals: ['SIGTERM'],
			escalations: [{ delayMs: terminationGracePeriodMs, cancelled: false }],
			settled: []
		});

		scheduler.runPending();

		expect(child.signals).toStrictEqual(['SIGTERM', 'SIGKILL']);

		child.emitClose(1, 'SIGKILL');

		await expect(completion).rejects.toBe(reason);
	});

	it('cancels escalation when the child closes during the grace period', async () => {
		const child = new ControlledAbortableChildProcess();
		const scheduler = new ControlledScheduler();
		const controller = new AbortController();
		const reason = new Error('cancel gracefully');
		const completion = waitForAbortableChildProcess(
			child,
			controller.signal,
			scheduler
		);

		controller.abort(reason);
		child.emitClose(1, 'SIGTERM');
		scheduler.runPending();

		await expect(completion).rejects.toBe(reason);
		expect({
			signals: child.signals,
			escalations: scheduler.escalations.map(({ delayMs, cancelled }) => ({
				delayMs,
				cancelled
			}))
		}).toStrictEqual({
			signals: ['SIGTERM'],
			escalations: [{ delayMs: terminationGracePeriodMs, cancelled: true }]
		});
	});
});

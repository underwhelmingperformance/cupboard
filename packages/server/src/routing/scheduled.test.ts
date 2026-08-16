import { describe, expect, it } from 'vitest';

import { runScheduledMaintenance } from './scheduled.ts';

class ScheduledMaintenanceTestError extends Error {
	constructor(public readonly phase: 'gc' | 'verify') {
		super(`${phase} failed`);
	}
}

const gcError = new ScheduledMaintenanceTestError('gc');
const verifyError = new ScheduledMaintenanceTestError('verify');

function expectScheduledMaintenanceTestError(
	error: unknown
): asserts error is ScheduledMaintenanceTestError {
	expect(error).toBeInstanceOf(ScheduledMaintenanceTestError);
}

function recorder(): {
	readonly calls: string[];
	pass: (label: string) => () => Promise<void>;
	fail: (
		label: string,
		error: ScheduledMaintenanceTestError
	) => () => Promise<void>;
} {
	const calls: string[] = [];

	return {
		calls,
		pass: (label) => () => {
			calls.push(label);

			return Promise.resolve();
		},
		fail: (label, error) => () => {
			calls.push(label);

			return Promise.reject(error);
		}
	};
}

describe('runScheduledMaintenance', () => {
	it('runs both passes when each succeeds', async () => {
		const { calls, pass } = recorder();

		await runScheduledMaintenance(pass('gc'), pass('verify'));

		expect(calls).toStrictEqual(['gc', 'verify']);
	});

	it('runs the verify and then reports the failure when the collection fails', async () => {
		const { calls, pass, fail } = recorder();

		let error: unknown;
		try {
			await runScheduledMaintenance(fail('gc', gcError), pass('verify'));
		} catch (error_: unknown) {
			error = error_;
		}

		expectScheduledMaintenanceTestError(error);
		expect({ error: { phase: error.phase }, calls }).toStrictEqual({
			error: { phase: 'gc' },
			calls: ['gc', 'verify']
		});
	});

	it('does not mask the collection when the verify fails', async () => {
		const { calls, pass, fail } = recorder();

		let error: unknown;
		try {
			await runScheduledMaintenance(pass('gc'), fail('verify', verifyError));
		} catch (error_: unknown) {
			error = error_;
		}

		expectScheduledMaintenanceTestError(error);
		expect({ error: { phase: error.phase }, calls }).toStrictEqual({
			error: { phase: 'verify' },
			calls: ['gc', 'verify']
		});
	});

	it('surfaces the collection failure first when both fail', async () => {
		const { calls, fail } = recorder();

		let error: unknown;
		try {
			await runScheduledMaintenance(
				fail('gc', gcError),
				fail('verify', verifyError)
			);
		} catch (error_: unknown) {
			error = error_;
		}

		expectScheduledMaintenanceTestError(error);
		expect({ error: { phase: error.phase }, calls }).toStrictEqual({
			error: { phase: 'gc' },
			calls: ['gc', 'verify']
		});
	});
});

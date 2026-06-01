import { describe, expect, it } from 'vitest';

import { runScheduledMaintenance } from './scheduled.ts';

const gcError = new Error('gc boom');
const verifyError = new Error('verify boom');

function recorder(): {
	readonly calls: string[];
	pass: (label: string) => () => Promise<void>;
	fail: (label: string, error: Error) => () => Promise<void>;
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

	it('runs the verify and then reports the failure when the sweep fails', async () => {
		const { calls, pass, fail } = recorder();

		const error = await runScheduledMaintenance(
			fail('gc', gcError),
			pass('verify')
		).catch((error_: unknown) => error_);

		expect({ error, calls }).toStrictEqual({
			error: gcError,
			calls: ['gc', 'verify']
		});
	});

	it('does not mask the sweep when the verify fails', async () => {
		const { calls, pass, fail } = recorder();

		const error = await runScheduledMaintenance(
			pass('gc'),
			fail('verify', verifyError)
		).catch((error_: unknown) => error_);

		expect({ error, calls }).toStrictEqual({
			error: verifyError,
			calls: ['gc', 'verify']
		});
	});

	it('surfaces the sweep failure first when both fail', async () => {
		const { fail } = recorder();

		await expect(
			runScheduledMaintenance(fail('gc', gcError), fail('verify', verifyError))
		).rejects.toBe(gcError);
	});
});

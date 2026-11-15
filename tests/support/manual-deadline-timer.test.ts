import { expect, it } from 'vitest';

import { ManualDeadlineTimer } from './manual-deadline-timer.ts';

const deadlineMs = 30_000;

function expiry(): { readonly expire: () => void; readonly calls: string[] } {
	const calls: string[] = [];

	return {
		calls,
		expire: () => {
			calls.push('expired');
		}
	};
}

function failureOf(action: () => void): unknown {
	try {
		action();
	} catch (error) {
		return error;
	}

	return undefined;
}

it('expires only the deadline of the attempt that it names', () => {
	const timer = new ManualDeadlineTimer(deadlineMs);
	const first = expiry();
	const second = expiry();
	const secondAttempt = new AbortController().signal;
	timer.arm(first.expire, deadlineMs, new AbortController().signal);
	timer.arm(second.expire, deadlineMs, secondAttempt);

	timer.expire(secondAttempt);

	expect({ first: first.calls, second: second.calls }).toStrictEqual({
		first: [],
		second: ['expired']
	});
});

it('does not expire a deadline after the code under test cancelled it', () => {
	const timer = new ManualDeadlineTimer(deadlineMs);
	const attempt = new AbortController().signal;
	const armed = expiry();
	const cancel = timer.arm(armed.expire, deadlineMs, attempt);
	cancel();

	expect({
		failure: failureOf(() => {
			timer.expire(attempt);
		}),
		calls: armed.calls
	}).toMatchObject({
		failure: { name: 'DeadlineSelectionError', matching: 0, armed: 0 },
		calls: []
	});
});

it('refuses to choose between two armed deadlines', () => {
	const timer = new ManualDeadlineTimer(deadlineMs);
	timer.arm(expiry().expire, deadlineMs, new AbortController().signal);
	timer.arm(expiry().expire, deadlineMs, new AbortController().signal);

	expect(
		failureOf(() => {
			timer.expireOnly();
		})
	).toMatchObject({ name: 'DeadlineSelectionError', matching: 2, armed: 2 });
});

it('rejects a deadline of an unexpected duration', () => {
	const timer = new ManualDeadlineTimer(deadlineMs);

	expect(
		failureOf(() => {
			timer.arm(expiry().expire, 5000, new AbortController().signal);
		})
	).toMatchObject({
		name: 'UnexpectedDeadlineError',
		milliseconds: 5000,
		expectedMilliseconds: deadlineMs
	});
});

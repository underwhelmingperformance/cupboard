import { describe, expect, it } from 'vitest';

import {
	CronGarbageCollectionFailedError,
	CronVerificationFailedError
} from './errors.ts';
import { runScheduledMaintenance } from './scheduled.ts';

interface Outcome {
	readonly status: number;
	readonly body: string;
}

const ok: Outcome = { status: 200, body: 'ok' };

function recordingPoster(outcomes: Record<string, Outcome>): {
	readonly post: (path: string) => Promise<Response>;
	readonly calls: string[];
} {
	const calls: string[] = [];

	return {
		calls,
		post(path) {
			calls.push(path);
			const outcome = outcomes[path] ?? ok;

			return Promise.resolve(
				new Response(outcome.body, { status: outcome.status })
			);
		}
	};
}

describe('runScheduledMaintenance', () => {
	it('runs the sweep then the verify when both succeed', async () => {
		const { post, calls } = recordingPoster({});

		await runScheduledMaintenance(post);

		expect(calls).toStrictEqual(['/gc', '/verify']);
	});

	it('still runs the verify, then reports the failure, when the sweep fails', async () => {
		const { post, calls } = recordingPoster({
			'/gc': { status: 500, body: 'gc boom' }
		});

		await expect(runScheduledMaintenance(post)).rejects.toBeInstanceOf(
			CronGarbageCollectionFailedError
		);
		expect(calls).toStrictEqual(['/gc', '/verify']);
	});

	it('does not mask the sweep when the verify fails', async () => {
		const { post, calls } = recordingPoster({
			'/verify': { status: 500, body: 'verify boom' }
		});

		const error = await runScheduledMaintenance(post).catch(
			(error_: unknown) => error_
		);

		expect({
			error: error instanceof CronVerificationFailedError,
			status: (error as CronVerificationFailedError).status,
			calls
		}).toStrictEqual({
			error: true,
			status: 500,
			calls: ['/gc', '/verify']
		});
	});

	it('surfaces the sweep failure first when both fail', async () => {
		const { post } = recordingPoster({
			'/gc': { status: 500, body: 'gc boom' },
			'/verify': { status: 503, body: 'verify boom' }
		});

		await expect(runScheduledMaintenance(post)).rejects.toBeInstanceOf(
			CronGarbageCollectionFailedError
		);
	});
});

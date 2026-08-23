import { rootLogger } from '@cupboard/logger';
import { uploadIdSchema } from '@cupboard/protocol/upload';
import { describe, expect, it, vi } from 'vitest';

import { type VerificationResult } from '../do/verification-service.ts';

import { VerdictRecorder } from './scheduled.ts';

function verdict(uploadId: string): VerificationResult {
	return {
		uploadId: uploadIdSchema.parse(uploadId),
		verdict: { kind: 'promoted' }
	};
}

describe('VerdictRecorder', () => {
	it('coalesces verdicts added while a flush is in flight', async () => {
		const batches: VerificationResult[][] = [];
		const resolvers: ((applied: number) => void)[] = [];
		const recorder = new VerdictRecorder(rootLogger(), (results) => {
			batches.push([...results]);

			return new Promise((resolve) => {
				resolvers.push(resolve);
			});
		});

		// The first verdict starts a flush. The next two arrive while its RPC is in
		// flight and must share one subsequent flush.
		recorder.add(verdict('a'));
		recorder.add(verdict('b'));
		recorder.add(verdict('c'));

		resolvers.at(0)?.(1);
		await vi.waitFor(() => {
			expect(resolvers.length).toBe(2);
		});
		resolvers.at(1)?.(2);

		const applied = await recorder.finishRecording();

		expect({ applied, batches }).toStrictEqual({
			applied: 3,
			batches: [[verdict('a')], [verdict('b'), verdict('c')]]
		});
	});

	it('heals a transient recording fault with an in-place retry', async () => {
		const batches: VerificationResult[][] = [];
		let outcomes = [
			() => Promise.reject(new Error('record outage')),
			(count: number) => Promise.resolve(count)
		];
		const recorder = new VerdictRecorder(
			rootLogger(),
			(results) => {
				batches.push([...results]);
				const outcome = outcomes.at(0);
				outcomes = outcomes.slice(1);

				return outcome === undefined
					? Promise.resolve(results.length)
					: outcome(results.length);
			},
			3,
			0
		);

		recorder.add(verdict('a'));

		const applied = await recorder.finishRecording();

		// Retry the same batch so a transient recording failure does not require
		// decoding those uploads again.
		expect({ applied, batches }).toStrictEqual({
			applied: 1,
			batches: [[verdict('a')], [verdict('a')]]
		});
	});

	it('stops and surfaces a failure the retries cannot clear', async () => {
		const outage = new Error('record outage');
		const record = vi.fn(() => Promise.reject(outage));
		const recorder = new VerdictRecorder(rootLogger(), record, 3, 0);

		recorder.add(verdict('a'));
		await expect(recorder.finishRecording()).rejects.toBe(outage);

		// A verdict reached after the failure buffers without spinning fresh
		// RPCs against a DO that is down, and the failure keeps surfacing.
		recorder.add(verdict('b'));
		await expect(recorder.finishRecording()).rejects.toBe(outage);

		expect(record.mock.calls).toStrictEqual([
			[[verdict('a')]],
			[[verdict('a')]],
			[[verdict('a')]]
		]);
	});

	it('returns zero when no verdict was recorded', async () => {
		const recorder = new VerdictRecorder(rootLogger(), () =>
			Promise.resolve(0)
		);

		expect(await recorder.finishRecording()).toBe(0);
	});
});

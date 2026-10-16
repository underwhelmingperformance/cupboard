import { describe, expect, it } from 'vitest';

import {
	artifactQueueHeaderSchema,
	artifactQueueMessageSchema
} from './artifact-queue-message.ts';

const message = {
	kind: 'artifact-job',
	tenant: 'acme',
	job: { id: '00000000-0000-4000-8000-000000000001', generation: 1 },
	artifactKind: 'listing'
};

describe('artifact queue messages', () => {
	it('preserves the tenant, job generation and artifact kind', () => {
		expect(artifactQueueMessageSchema.parse(message)).toStrictEqual(message);
	});

	it.each([
		{ ...message, tenant: 'not/a/tenant' },
		{ ...message, job: { ...message.job, generation: 0 } },
		{ ...message, artifactKind: 'unknown' },
		{ ...message, extra: true }
	])('rejects a malformed queue envelope', (input) => {
		expect(artifactQueueMessageSchema.safeParse(input).success).toBe(false);
	});

	const admission = {
		id: '00000000-0000-4000-8000-000000000002',
		job: message.job,
		taskId: '00000000-0000-4000-8000-000000000003',
		cacheGeneration: 1,
		expiresAt: '2099-01-01T00:00:00.000Z'
	};
	it('preserves an admission for the same job generation', () => {
		const admitted = { ...message, admission };
		expect(artifactQueueMessageSchema.parse(admitted)).toStrictEqual(admitted);
	});
	it.each([
		{
			...admission,
			job: { id: '00000000-0000-4000-8000-000000000099', generation: 1 }
		},
		{ ...admission, job: { ...message.job, generation: 2 } },
		{ ...admission, taskId: 'not-a-task' },
		{ ...admission, cacheGeneration: 0 },
		{ ...admission, extra: true }
	])('rejects an admission outside the envelope scope or schema', (input) => {
		expect(
			artifactQueueMessageSchema.safeParse({ ...message, admission: input })
				.success
		).toBe(false);
	});

	it('routes malformed artifact envelopes to their own validator', () => {
		expect({
			artifact: artifactQueueHeaderSchema.safeParse({ kind: 'artifact-job' })
				.success,
			maintenance: artifactQueueHeaderSchema.safeParse({
				kind: 'tenant-verify'
			}).success,
			primitive: artifactQueueHeaderSchema.safeParse('artifact-job').success
		}).toStrictEqual({ artifact: true, maintenance: false, primitive: false });
	});
});

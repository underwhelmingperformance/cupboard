import { describe, expect, it } from 'vitest';

import {
	sharedListingCleanupHeaderSchema,
	sharedListingCleanupMessageSchema
} from './shared-listing-cleanup-message.ts';

const id = '00000000-0000-4000-8000-000000000001';
const through = '2026-01-01T00:01:00.000Z';
const sweep = {
	kind: 'shared-listing-stage-sweep',
	through,
	after: { at: through, id }
};
const cleanup = { kind: 'shared-listing-stage-cleanup', id };

describe('shared listing cleanup messages', () => {
	it.each([sweep, cleanup])('preserves a valid $kind envelope', (message) => {
		expect(sharedListingCleanupMessageSchema.parse(message)).toStrictEqual(
			message
		);
	});

	it.each([
		{ ...sweep, through: 'not-a-date' },
		{ ...sweep, through: '2026-01-01T00:01:00Z' },
		{ ...sweep, after: { at: '2026-01-01T00:02:00.000Z', id } },
		{ ...cleanup, id: 'not-a-stage' },
		{ ...cleanup, tenant: 'acme' },
		{ ...sweep, extra: true }
	])('rejects a malformed cleanup envelope', (message) => {
		expect(sharedListingCleanupMessageSchema.safeParse(message).success).toBe(
			false
		);
	});

	it('routes malformed cleanup payloads to the cleanup validator', () => {
		expect({
			cleanup: sharedListingCleanupHeaderSchema.safeParse({
				kind: cleanup.kind
			}).success,
			sweep: sharedListingCleanupHeaderSchema.safeParse({ kind: sweep.kind })
				.success,
			tenant: sharedListingCleanupHeaderSchema.safeParse({
				kind: 'artifact-job'
			}).success
		}).toStrictEqual({ cleanup: true, sweep: true, tenant: false });
	});
});

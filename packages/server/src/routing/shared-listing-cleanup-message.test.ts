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
const forwardSweep = { ...sweep, kind: 'forward-listing-stage-sweep' };
const forwardCleanup = { kind: 'forward-listing-stage-cleanup', id };
const narHash = `sha256:${'0'.repeat(52)}`;
const outputSweep = {
	kind: 'shared-listing-output-sweep',
	through,
	after: { at: through, narHash }
};
const outputCleanup = { kind: 'shared-listing-output-cleanup', narHash };

describe('shared listing cleanup messages', () => {
	it.each([
		sweep,
		cleanup,
		forwardSweep,
		forwardCleanup,
		outputSweep,
		outputCleanup
	])('preserves a valid $kind envelope', (message) => {
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
		{ ...sweep, extra: true },
		{ ...forwardSweep, through: 'not-a-date' },
		{ ...forwardSweep, after: { at: '2026-01-01T00:02:00.000Z', id } },
		{ ...forwardSweep, extra: true },
		{ ...forwardCleanup, id: 'not-a-stage' },
		{ ...forwardCleanup, owner: id },
		{ ...outputSweep, through: 'not-a-date' },
		{ ...outputSweep, after: { at: '2026-01-01T00:02:00.000Z', narHash } },
		{ ...outputCleanup, narHash: 'bad' },
		{ ...outputCleanup, tenant: 'acme' }
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
			output: sharedListingCleanupHeaderSchema.safeParse({
				kind: outputCleanup.kind
			}).success,
			outputSweep: sharedListingCleanupHeaderSchema.safeParse({
				kind: outputSweep.kind
			}).success,
			forward: sharedListingCleanupHeaderSchema.safeParse({
				kind: forwardCleanup.kind
			}).success,
			forwardSweep: sharedListingCleanupHeaderSchema.safeParse({
				kind: forwardSweep.kind
			}).success,
			tenant: sharedListingCleanupHeaderSchema.safeParse({
				kind: 'artifact-job'
			}).success
		}).toStrictEqual({
			cleanup: true,
			sweep: true,
			output: true,
			outputSweep: true,
			forward: true,
			forwardSweep: true,
			tenant: false
		});
	});
});

import { rootNameSchema, storePathSchema } from '@cupboard/nix-store/scalars';
import { rootBatchCapacity } from '@cupboard/protocol/retention';
import { describe, expect, it } from 'vitest';

import { RootTargetLimitError } from '../push/push.ts';

import { type RootBatchEntry, rootBatches } from './root-batches.ts';

function entry(index: number, targetCount: number): RootBatchEntry {
	return {
		action: 'set',
		name: rootNameSchema.parse(`github:acme/app/main/${String(index)}`),
		targets: Array.from({ length: targetCount }, (_, target) =>
			storePathSchema.parse(
				`/nix/store/${String(target % 10).repeat(32)}-${String(index)}-${String(target)}`
			)
		),
		retention: { kind: 'inherit' }
	};
}

function entries(counts: readonly number[]): readonly RootBatchEntry[] {
	return counts.map((count, index) => entry(index, count));
}

describe('rootBatches', () => {
	it.each([
		{
			name: 'one batch for roots within the capacity',
			counts: [1, 2, 3],
			expected: [[1, 2, 3]]
		},
		{
			name: 'a new batch once roots without targets fill the capacity',
			counts: Array.from({ length: rootBatchCapacity + 1 }, () => 0),
			expected: [Array.from({ length: rootBatchCapacity }, () => 0), [0]]
		},
		{
			name: 'a new batch before targets pass the capacity',
			counts: [rootBatchCapacity - 1, 1, 1],
			expected: [[rootBatchCapacity - 1, 1], [1]]
		},
		{
			name: 'a new batch when a root without targets would pass the capacity',
			counts: [rootBatchCapacity - 1, 0, 0],
			expected: [[rootBatchCapacity - 1, 0], [0]]
		},
		{ name: 'no batch for no roots', counts: [], expected: [] }
	])('makes $name', ({ counts, expected }) => {
		const batches = rootBatches(entries(counts));

		expect(
			batches.map((batch) => batch.map((root) => root.targets.length))
		).toStrictEqual(expected);
		expect(batches.flat()).toStrictEqual(entries(counts));
	});

	it('refuses a root with more targets than one batch accepts', () => {
		let failure: unknown;

		try {
			rootBatches(entries([1, rootBatchCapacity + 1]));
		} catch (error) {
			failure = error;
		}

		expect({
			isLimitError: failure instanceof RootTargetLimitError,
			count: failure instanceof RootTargetLimitError ? failure.count : 0,
			limit: failure instanceof RootTargetLimitError ? failure.limit : 0
		}).toStrictEqual({
			isLimitError: true,
			count: rootBatchCapacity + 1,
			limit: rootBatchCapacity
		});
	});
});

import { collectProgressively } from '@cupboard/shared/collections';
import { probeDeadlineMs } from '@cupboard/shared/timeout';
import { describe, expect, it, vi } from 'vitest';

import { stalledResponse } from '../../../../tests/support/stalled-request.ts';

import { cachePages, listingLimits } from './listings.ts';
import type { CallOptions } from './orpc.ts';

const maximumBackoffMs = 5000;

describe('cachePages', () => {
	it('lists every page under a prefix and retries a page that hangs past its deadline', async () => {
		const calls: unknown[] = [];
		const lister = {
			async list(
				input?: { readonly namePrefix?: string; readonly cursor?: string },
				options?: CallOptions
			) {
				calls.push(input);
				if (input?.cursor === undefined) {
					return { caches: ['pr-1'], cursor: 'pr-1' };
				}
				if (calls.length === 2) {
					await stalledResponse(options?.signal);
				}
				return { caches: ['pr-2'] };
			}
		};

		vi.useFakeTimers();
		try {
			const collect = async (): Promise<string[]> =>
				collectProgressively(
					await cachePages(lister, 'pr-'),
					listingLimits('The test listing')
				);
			const pending = collect();
			const settled = expect(pending).resolves.toStrictEqual(['pr-1', 'pr-2']);
			await vi.advanceTimersByTimeAsync(probeDeadlineMs + maximumBackoffMs);
			await settled;
		} finally {
			vi.useRealTimers();
		}

		expect(calls).toStrictEqual([
			{ namePrefix: 'pr-' },
			{ namePrefix: 'pr-', cursor: 'pr-1' },
			{ namePrefix: 'pr-', cursor: 'pr-1' }
		]);
	});
});

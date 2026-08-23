import { describe, expect, it, vi } from 'vitest';

import { maxOutgoingConnections } from './bulk.ts';
import { mapVerificationProbes } from './verification-service.ts';

describe('verification probes', () => {
	it('uses the shared outgoing-connection limit', async () => {
		let active = 0;
		let maximum = 0;
		const gates = Array.from({ length: maxOutgoingConnections + 2 }, () =>
			Promise.withResolvers<undefined>()
		);
		const running = mapVerificationProbes(
			Array.from({ length: maxOutgoingConnections + 2 }, (_, index) => index),
			async (item) => {
				active += 1;
				maximum = Math.max(maximum, active);

				try {
					await gates[item]?.promise;

					return item;
				} finally {
					active -= 1;
				}
			}
		);

		await vi.waitFor(() => {
			expect(active).toBe(maxOutgoingConnections);
		});

		for (const gate of gates.slice(0, maxOutgoingConnections)) {
			gate.resolve(undefined);
		}

		await vi.waitFor(() => {
			expect(active).toBe(2);
		});
		gates.at(-2)?.resolve(undefined);
		gates.at(-1)?.resolve(undefined);

		const results = await running;

		expect({ maximum, results }).toStrictEqual({
			maximum: maxOutgoingConnections,
			results: [0, 1, 2, 3, 4, 5, 6, 7]
		});
	});
});

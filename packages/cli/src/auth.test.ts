import type { BootstrapResponse } from '@cupboard/shared';
import { describe, expect, it } from 'vitest';

import { authenticate } from './auth.ts';
import { CupboardClient } from './client.ts';

describe('authenticate', () => {
	it('exchanges the bootstrap secret eagerly, caches the token, and re-exchanges on refresh', async () => {
		const authorisations: (string | undefined)[] = [];
		let issued = 0;
		const client = new CupboardClient(
			new URL('https://cupboard.test'),
			(_input, init) => {
				authorisations.push(
					new Headers(init?.headers).get('authorization') ?? undefined
				);
				issued += 1;

				return Promise.resolve(
					Response.json({
						url: 'https://cupboard.test',
						publicKey: 'cupboard:key',
						token: `jwt-${String(issued)}`
					} satisfies BootstrapResponse)
				);
			}
		);

		const provider = await authenticate(client, 'bootstrap-secret');
		const eager = await provider.get();
		const refreshed = await provider.refresh();
		const afterRefresh = await provider.get();

		expect({ eager, refreshed, afterRefresh, authorisations }).toStrictEqual({
			eager: 'jwt-1',
			refreshed: 'jwt-2',
			afterRefresh: 'jwt-2',
			authorisations: ['Bearer bootstrap-secret', 'Bearer bootstrap-secret']
		});
	});
});

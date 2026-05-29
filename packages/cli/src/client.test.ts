import type { DeletePathResponse } from '@cupboard/shared';
import { describe, expect, it } from 'vitest';

import { CupboardClient } from './client.ts';

describe('CupboardClient.deleteStorePath', () => {
	it('posts the store path hash with the admin token', async () => {
		const response: DeletePathResponse = {
			storePathHash: '0123456789abcdfghijklmnpqrsvwxyz',
			deleted: true,
			narScheduledForDeletion: true
		};
		let captured:
			| {
					readonly url: string;
					readonly method: string | undefined;
					readonly authorization: string | null;
					readonly contentType: string | null;
					readonly body: unknown;
			  }
			| undefined;

		const client = new CupboardClient(
			new URL('https://cupboard.test'),
			(input, init) => {
				if (!(input instanceof URL)) {
					throw new TypeError('expected the client to request a URL');
				}

				const headers = new Headers(init?.headers);
				captured = {
					url: input.href,
					method: init?.method,
					authorization: headers.get('authorization'),
					contentType: headers.get('content-type'),
					body: init?.body
				};

				return Promise.resolve(Response.json(response));
			}
		);

		const result = await client.deleteStorePath(
			'admin-token',
			'0123456789abcdfghijklmnpqrsvwxyz'
		);

		expect(result).toStrictEqual(response);
		expect(captured).toStrictEqual({
			url: 'https://cupboard.test/admin/delete',
			method: 'POST',
			authorization: 'Bearer admin-token',
			contentType: 'application/json',
			body: JSON.stringify({
				storePathHash: '0123456789abcdfghijklmnpqrsvwxyz'
			})
		});
	});
});

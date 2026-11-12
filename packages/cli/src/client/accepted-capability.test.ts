import { acceptCapabilitiesHeader } from '@cupboard/protocol/upload';
import { describe, expect, it } from 'vitest';

import { acceptingCapability } from './accepted-capability.ts';

describe('acceptingCapability', () => {
	it('sends the capability with the request and keeps its other headers', async () => {
		const sent: Request[] = [];
		const fetcher = acceptingCapability('some-capability', (input, init) => {
			sent.push(new Request(input, init));
			return Promise.resolve(new Response('ok'));
		});

		const response = await fetcher('https://cupboard.example.workers.dev/x', {
			method: 'DELETE',
			headers: { authorization: 'Bearer token' }
		});

		expect({
			body: await response.text(),
			requests: sent.map((request) => ({
				method: request.method,
				url: request.url,
				headers: Object.fromEntries(request.headers)
			}))
		}).toStrictEqual({
			body: 'ok',
			requests: [
				{
					method: 'DELETE',
					url: 'https://cupboard.example.workers.dev/x',
					headers: {
						authorization: 'Bearer token',
						[acceptCapabilitiesHeader]: 'some-capability'
					}
				}
			]
		});
	});
});

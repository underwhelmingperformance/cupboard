import {
	acceptCapabilitiesHeader,
	uploadCapabilitiesHeader,
	uploadGraceFactsCapability
} from '@cupboard/protocol/upload';
import { describe, expect, it } from 'vitest';

import { pushClientFor } from './push-client.ts';

describe('pushClientFor', () => {
	it.each([
		{ name: 'acknowledges it', responseCapability: uploadGraceFactsCapability },
		{ name: 'does not acknowledge it', responseCapability: undefined }
	])(
		'probes upload grace facts when the server $name',
		async ({ responseCapability }) => {
			const requests: {
				readonly url: string;
				readonly method: string;
				readonly capability: string | null;
				readonly body: unknown;
			}[] = [];
			const client = pushClientFor(
				new URL('https://cupboard.test/t/acme'),
				'token',
				{
					cache: { kind: 'default' },
					fetcher: async (input, init) => {
						const request = new Request(input, init);
						requests.push({
							url: request.url,
							method: request.method,
							capability: request.headers.get(acceptCapabilitiesHeader),
							body: await request.json()
						});

						return Response.json(
							{ uploads: [] },
							{
								headers:
									responseCapability === undefined
										? undefined
										: { [uploadCapabilitiesHeader]: responseCapability }
							}
						);
					}
				}
			);

			const supported = await client.probeUploadGraceFacts?.('preview');

			expect({ supported, requests }).toStrictEqual({
				supported: responseCapability !== undefined,
				requests: [
					{
						url: 'https://cupboard.test/t/acme/uploads/preview',
						method: 'POST',
						capability: uploadGraceFactsCapability,
						body: { paths: [] }
					}
				]
			});
		}
	);
});

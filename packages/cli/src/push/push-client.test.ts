import { uploadPathNegotiationSchema } from '@cupboard/protocol/upload';
import {
	acceptCapabilitiesHeader,
	uploadCapabilitiesHeader,
	uploadGraceFactsCapability,
	uploadNegotiateRequestSchema,
	uploadPreviewRequestSchema
} from '@cupboard/protocol/upload';
import { describe, expect, it } from 'vitest';

import { pushClientFor } from './push-client.ts';

describe('pushClientFor', () => {
	it('splits negotiation and preview before canonical NAR probes exhaust a Worker invocation', async () => {
		const paths = Array.from({ length: 101 }, (_, index) => {
			const storePathHash = String(index).padStart(32, '0');

			return uploadPathNegotiationSchema.parse({
				storePathHash,
				storePath: `/nix/store/${storePathHash}-path`,
				narHash: `sha256:${'0'.repeat(52)}`,
				narSize: 1,
				references: []
			});
		});
		const requests: { path: string; count: number; pushId?: string }[] = [];
		const client = pushClientFor(
			new URL('https://cupboard.test/t/acme'),
			'token',
			{
				cache: { kind: 'default' },
				fetcher: async (input, init) => {
					const request = new Request(input, init);
					const path = new URL(request.url).pathname;

					if (path.endsWith('/uploads/credential')) {
						requests.push({ path, count: 0 });

						return Response.json({
							pushId: 'push-1',
							accessKeyId: 'access',
							secretAccessKey: 'secret',
							sessionToken: 'session',
							endpoint: 'https://r2.test',
							bucket: 'blobs',
							expiresAt: '2099-01-01T00:00:00.000Z'
						});
					}

					if (path.endsWith('/uploads/preview')) {
						const body = uploadPreviewRequestSchema.parse(await request.json());
						requests.push({ path, count: body.paths.length });

						return Response.json(
							{
								uploads: body.paths.map((entry) => ({
									action: 'skip',
									storePathHash: entry.storePathHash,
									narHash: entry.narHash
								}))
							},
							{
								headers: {
									[uploadCapabilitiesHeader]: uploadGraceFactsCapability
								}
							}
						);
					}

					const body = uploadNegotiateRequestSchema.parse(await request.json());
					requests.push({
						path,
						count: body.paths.length,
						pushId: body.pushId
					});

					return Response.json(
						{
							uploads: body.paths.map((entry) => ({
								action: 'skip',
								storePathHash: entry.storePathHash,
								narHash: entry.narHash
							}))
						},
						{
							headers: {
								[uploadCapabilitiesHeader]: uploadGraceFactsCapability
							}
						}
					);
				}
			}
		);

		const negotiated = await client.negotiate({ paths });
		const preview = await client.preview({ paths });

		expect({ negotiated, preview, requests }).toStrictEqual({
			negotiated: {
				uploads: paths.map((entry) => ({
					action: 'skip',
					storePathHash: entry.storePathHash,
					narHash: entry.narHash
				}))
			},
			preview: {
				uploads: paths.map((entry) => ({
					action: 'skip',
					storePathHash: entry.storePathHash,
					narHash: entry.narHash
				}))
			},
			requests: [
				{ path: '/t/acme/uploads/credential', count: 0 },
				{ path: '/t/acme/uploads', count: 100, pushId: 'push-1' },
				{ path: '/t/acme/uploads', count: 1, pushId: 'push-1' },
				{ path: '/t/acme/uploads/preview', count: 100 },
				{ path: '/t/acme/uploads/preview', count: 1 }
			]
		});
	});

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

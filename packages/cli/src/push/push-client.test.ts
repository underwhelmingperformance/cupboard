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
	it.each([
		{ cache: { kind: 'default' } satisfies CacheScope, prefix: '' },
		{
			cache: {
				kind: 'named',
				name: cacheNameSchema.parse('ci')
			} satisfies CacheScope,
			prefix: '/cache/ci'
		}
	])(
		'uses the selected $cache.kind cache for bundle negotiation and attachment',
		async ({ cache, prefix }) => {
			const requests: {
				path: string;
				authorization: string | null;
				body: unknown;
			}[] = [];
			const digest = 'a'.repeat(64);
			const storePathHash = '0'.repeat(32);
			const client = pushClientFor(
				new URL('https://cupboard.test/t/acme'),
				'token',
				{
					cache,
					fetcher: async (input, init) => {
						const request = new Request(input, init);
						const path = new URL(request.url).pathname;
						const body: unknown = await request.json();
						requests.push({
							path,
							authorization: request.headers.get('authorization'),
							body
						});
						if (path.endsWith('/uploads/credential')) {
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
						if (path.endsWith('/attestations/bundles')) {
							attestationBundleNegotiateRequestSchema.parse(body);
							return Response.json({
								bundles: [
									{
										action: 'upload',
										digest,
										uploadId: 'bundle-1',
										r2Key: 'staging/bundle-1',
										expiresAt: '2099-01-01T00:00:00.000Z'
									}
								]
							});
						}
						return Response.json({
							expiresAt: '2099-01-01T00:00:00.000Z',
							paths: [
								{
									storePathHash,
									digest,
									predicateType: 'https://slsa.dev/provenance/v1',
									status: 'attached'
								}
							]
						});
					}
				}
			);
			if (
				client.negotiateAttestationBundles === undefined ||
				client.attachAttestationPaths === undefined
			) {
				throw new Error('Expected bundle attachment methods');
			}
			await client.negotiateAttestationBundles({ bundles: [{ digest }] });
			await client.attachAttestationPaths('bundle-1', {
				storePathHashes: [storePathHash]
			});
			expect(requests).toStrictEqual([
				{
					path: `/t/acme${prefix}/uploads/credential`,
					authorization: 'Bearer token',
					body: {}
				},
				{
					path: `/t/acme${prefix}/attestations/bundles`,
					authorization: 'Bearer token',
					body: { pushId: 'push-1', bundles: [{ digest }] }
				},
				{
					path: `/t/acme${prefix}/attestations/bundles/bundle-1/attach`,
					authorization: 'Bearer token',
					body: { storePathHashes: [storePathHash] }
				}
			]);
		}
	);

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
import { cacheNameSchema, type CacheScope } from '@cupboard/nix-store/scalars';
import { attestationBundleNegotiateRequestSchema } from '@cupboard/protocol/attestations';

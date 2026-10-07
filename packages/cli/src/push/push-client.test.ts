import { uploadPathNegotiationSchema } from '@cupboard/protocol/upload';
import {
	acceptCapabilitiesHeader,
	uploadCapabilitiesHeader,
	uploadGraceFactsCapability,
	uploadNegotiateRequestSchema,
	uploadPreviewRequestSchema,
	uploadRequestMaxPathsHeader
} from '@cupboard/protocol/upload';
import { ORPCError } from '@orpc/client';
import { describe, expect, it } from 'vitest';

import { translateRpcError } from '../client/rpc-errors.ts';
import { errorExitCode } from '../exit-code.ts';

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

	it.each([
		{
			advertised: undefined,
			negotiateSizes: [100, 100, 100, 1],
			previewSizes: [100, 100, 100, 1]
		},
		{
			advertised: '150',
			negotiateSizes: [100, 150, 51],
			previewSizes: [150, 150, 1]
		},
		{
			advertised: '50',
			negotiateSizes: [100, 50, 50, 50, 50, 1],
			previewSizes: [50, 50, 50, 50, 50, 50, 1]
		},
		{
			advertised: '0',
			negotiateSizes: [100, 100, 100, 1],
			previewSizes: [100, 100, 100, 1]
		},
		{
			advertised: 'junk',
			negotiateSizes: [100, 100, 100, 1],
			previewSizes: [100, 100, 100, 1]
		}
	])(
		'uses the advertised page limit $advertised while preserving grace facts',
		async ({ advertised, negotiateSizes, previewSizes }) => {
			const paths = Array.from({ length: 301 }, (_, index) => {
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
							const body = uploadPreviewRequestSchema.parse(
								await request.json()
							);
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
										[uploadCapabilitiesHeader]: uploadGraceFactsCapability,
										...(advertised !== undefined && {
											[uploadRequestMaxPathsHeader]: advertised
										})
									}
								}
							);
						}

						const body = uploadNegotiateRequestSchema.parse(
							await request.json()
						);
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
									[uploadCapabilitiesHeader]: uploadGraceFactsCapability,
									...(advertised !== undefined && {
										[uploadRequestMaxPathsHeader]: advertised
									})
								}
							}
						);
					}
				}
			);

			const negotiated = await client.negotiate({ paths });
			const preview = await client.preview({ paths });

			expect({
				negotiated,
				preview,
				requests
			}).toStrictEqual({
				negotiated: {
					uploads: paths.map((entry) => ({
						action: 'skip',
						storePathHash: entry.storePathHash,
						narHash: entry.narHash
					})),
					hasUploadGraceFacts: true
				},
				preview: {
					uploads: paths.map((entry) => ({
						action: 'skip',
						storePathHash: entry.storePathHash,
						narHash: entry.narHash
					})),
					hasUploadGraceFacts: true
				},
				requests: [
					{ path: '/t/acme/uploads/credential', count: 0 },
					...negotiateSizes.map((count) => ({
						path: '/t/acme/uploads',
						count,
						pushId: 'push-1'
					})),
					...previewSizes.map((count) => ({
						path: '/t/acme/uploads/preview',
						count
					}))
				]
			});
		}
	);

	it.each([
		{
			status: 401,
			code: 'UNAUTHORIZED',
			attempts: 1,
			exitCode: 77,
			data: undefined
		},
		{
			status: 413,
			code: 'UPLOAD_REQUEST_LIMIT_EXCEEDED',
			attempts: 1,
			exitCode: 2,
			data: { maxPaths: 1 }
		},
		{
			status: 507,
			code: 'INSUFFICIENT_STORAGE',
			attempts: 1,
			exitCode: 1,
			data: undefined
		},
		{
			status: 503,
			code: 'SERVICE_UNAVAILABLE',
			attempts: 5,
			exitCode: 75,
			data: undefined
		}
	])(
		'preserves $status failures without changing the refused page size',
		async ({ status, code, attempts, exitCode, data }) => {
			const path = uploadPathNegotiationSchema.parse({
				storePathHash: '0'.repeat(32),
				storePath: `/nix/store/${'0'.repeat(32)}-path`,
				narHash: `sha256:${'0'.repeat(52)}`,
				narSize: 1,
				references: []
			});
			const pages: number[] = [];
			const client = pushClientFor(
				new URL('https://cupboard.test/t/acme'),
				'token',
				{
					cache: { kind: 'default' },
					fetcher: async (input, init) => {
						const request = new Request(input, init);
						const body = uploadPreviewRequestSchema.parse(await request.json());
						pages.push(body.paths.length);
						return Response.json(
							{ defined: true, code, status, message: 'Service refusal', data },
							{
								status,
								headers: {
									'retry-after': '0',
									[uploadRequestMaxPathsHeader]: '1'
								}
							}
						);
					}
				}
			);
			let failure: unknown;
			try {
				await client.preview({
					paths: Array.from({ length: 101 }, () => path)
				});
			} catch (error) {
				failure = error;
			}
			if (!(failure instanceof ORPCError)) {
				throw new TypeError('Expected a decoded service refusal');
			}
			expect({
				status: failure.status,
				code: String(failure.code),
				exitCode: errorExitCode(translateRpcError(failure)),
				pages
			}).toStrictEqual({
				status,
				code,
				exitCode,
				pages: Array.from({ length: attempts }, () => 100)
			});
		}
	);

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

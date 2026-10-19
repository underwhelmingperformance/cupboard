import { publicationCapability } from '@cupboard/protocol/upload';
import { uploadPathNegotiationSchema } from '@cupboard/protocol/upload';
import {
	acceptCapabilitiesHeader,
	uploadCapabilitiesHeader,
	uploadGraceFactsCapability,
	uploadIdSchema,
	uploadNegotiateRequestSchema,
	uploadPreviewRequestSchema,
	uploadRequestMaxPathsHeader
} from '@cupboard/protocol/upload';
import { probeDeadlineMs, ProbeTimeoutError } from '@cupboard/shared/timeout';
import { ORPCError } from '@orpc/client';
import { describe, expect, it, vi } from 'vitest';

import { stalledResponse } from '../../../../tests/support/stalled-request.ts';
import { CupboardClient } from '../client/client.ts';
import { translateRpcError } from '../client/rpc-errors.ts';
import { CupboardHttpError } from '../errors.ts';
import { errorExitCode } from '../exit-code.ts';

import { pushClientFor } from './push-client.ts';

function later(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

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
		{
			operation: 'preview',
			outcome: { uploads: 1, timedOut: undefined },
			pages: 2
		},
		{
			operation: 'negotiate',
			outcome: {
				uploads: undefined,
				timedOut: 'the uploads.negotiate procedure'
			},
			pages: 1
		}
	] as const)(
		'sends a hung $operation page $pages times',
		async ({ operation, outcome, pages }) => {
			const path = uploadPathNegotiationSchema.parse({
				storePathHash: '0'.repeat(32),
				storePath: `/nix/store/${'0'.repeat(32)}-path`,
				narHash: `sha256:${'0'.repeat(52)}`,
				narSize: 1,
				references: []
			});
			let pageRequests = 0;
			const client = pushClientFor(
				new URL('https://cupboard.test/t/acme'),
				'token',
				{
					cache: { kind: 'default' },
					fetcher: async (input, init) => {
						const request = new Request(input, init);
						if (request.url.endsWith('/uploads/credential')) {
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

						pageRequests += 1;
						if (pageRequests === 1) {
							return stalledResponse(request.signal);
						}

						return Response.json({
							uploads: [
								{
									action: 'skip',
									storePathHash: path.storePathHash,
									narHash: path.narHash
								}
							]
						});
					}
				}
			);

			const send = async (): Promise<{
				readonly uploads?: number;
				readonly timedOut?: unknown;
			}> => {
				try {
					const response =
						operation === 'preview'
							? await client.preview({ paths: [path] })
							: await client.negotiate({ paths: [path] });

					return { uploads: response.uploads.length, timedOut: undefined };
				} catch (error) {
					return {
						uploads: undefined,
						timedOut: error instanceof ProbeTimeoutError ? error.target : error
					};
				}
			};

			vi.useFakeTimers();
			try {
				const pending = send();
				await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

				expect({ outcome: await pending, pageRequests }).toStrictEqual({
					outcome,
					pageRequests: pages
				});
			} finally {
				vi.useRealTimers();
			}
		}
	);

	// The first attempt ignores its signal and answers without the
	// acknowledgement after the retry's headers, while the retry's body is
	// still arriving.
	it('reports the grace-facts acknowledgement of the attempt that it uses', async () => {
		vi.spyOn(Math, 'random').mockReturnValue(0.5);
		let requests = 0;
		const client = pushClientFor(
			new URL('https://cupboard.test/t/acme'),
			'token',
			{
				cache: { kind: 'default' },
				fetcher: async () => {
					requests += 1;
					if (requests === 1) {
						await later(probeDeadlineMs + 200);
						return Response.json({ uploads: [] });
					}

					const body = new ReadableStream<Uint8Array>({
						async start(controller) {
							await later(200);
							controller.enqueue(new TextEncoder().encode('{"uploads":[]}'));
							controller.close();
						}
					});
					return new Response(body, {
						headers: {
							'content-type': 'application/json',
							[uploadCapabilitiesHeader]: uploadGraceFactsCapability
						}
					});
				}
			}
		);

		vi.useFakeTimers();
		try {
			const supported = client.probeUploadGraceFacts?.('preview');
			await vi.advanceTimersByTimeAsync(probeDeadlineMs + 5000);

			expect({ supported: await supported, requests }).toStrictEqual({
				supported: true,
				requests: 2
			});
		} finally {
			vi.useRealTimers();
			vi.restoreAllMocks();
		}
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

it.each([
	{
		credentialCapability: true,
		socketCapability: true,
		expected: '/uploads/plan'
	},
	{ credentialCapability: true, socketCapability: false, expected: '/uploads' },
	{
		credentialCapability: true,
		socketCapability: false,
		socketRefused: true,
		expected: '/uploads'
	},
	{ credentialCapability: false, socketCapability: true, expected: '/uploads' },
	{ credentialCapability: false, socketCapability: false, expected: '/uploads' }
])(
	'selects $expected with credential=$credentialCapability, socket=$socketCapability and refused=$socketRefused',
	async ({
		credentialCapability,
		socketCapability,
		socketRefused,
		expected
	}) => {
		const operationId = 'a'.repeat(64);
		const metadata = uploadPathNegotiationSchema.parse({
			storePathHash: '0'.repeat(32),
			storePath: `/nix/store/${'0'.repeat(32)}-app`,
			narHash: `sha256:${'1'.repeat(52)}`,
			narSize: 1,
			references: []
		});
		const paths: string[] = [];
		const open = vi
			.spyOn(CupboardClient.prototype, 'openCommitSession')
			.mockImplementation((_credential, options) => {
				if (socketRefused === true) {
					options?.onFailure?.(
						new CupboardHttpError(
							'GET',
							'/cache/new/commit',
							404,
							'Cache not found'
						)
					);
				}
				options?.onCapabilities?.(
					new Map(socketCapability ? [[publicationCapability, {}]] : [])
				);
				return Promise.resolve({
					commit: () => Promise.reject(new Error('No commit expected')),
					close: vi.fn()
				});
			});
		const client = pushClientFor(new URL('https://cupboard.test'), 'token', {
			cache: { kind: 'default' },
			fetcher: async (input, init) => {
				const request = new Request(input, init);
				await request.json();
				const pathname = new URL(request.url).pathname;
				paths.push(pathname);
				if (pathname === '/uploads/credential') {
					return Response.json(
						{
							pushId: 'push-1',
							accessKeyId: 'access',
							secretAccessKey: 'secret',
							sessionToken: 'session',
							endpoint: 'https://r2.test',
							bucket: 'blobs',
							expiresAt: '2099-01-01T00:00:00.000Z'
						},
						{
							headers: credentialCapability
								? { [uploadCapabilitiesHeader]: publicationCapability }
								: {}
						}
					);
				}
				if (pathname === '/uploads/plan') {
					return Response.json({
						cacheGeneration: 1,
						pushExpiresAt: '2099-01-01T00:00:00.000Z',
						uploads: [
							{
								action: 'skip',
								storePathHash: metadata.storePathHash,
								narHash: metadata.narHash,
								operationId,
								r2Key: `staging-v2/acme/push-1/${operationId}.nar.zst`
							}
						]
					});
				}
				return Response.json({
					uploads: [
						{
							action: 'skip',
							storePathHash: metadata.storePathHash,
							narHash: metadata.narHash
						}
					]
				});
			}
		});
		try {
			const result = await client.negotiate({ paths: [metadata] });
			expect({ paths, uploads: result.uploads }).toStrictEqual({
				paths: ['/uploads/credential', expected],
				uploads: [
					{
						action: 'skip',
						storePathHash: metadata.storePathHash,
						narHash: metadata.narHash
					}
				]
			});
			const decision = result.uploads[0];
			if (decision === undefined) {
				throw new Error('Expected a decision');
			}
			expect({
				original: client.publicationFor?.(decision)?.uploadId,
				clone: client.publicationFor?.({ ...decision })?.uploadId
			}).toStrictEqual({
				original: expected === '/uploads/plan' ? operationId : undefined,
				clone: expected === '/uploads/plan' ? operationId : undefined
			});
			const onCapabilities = vi.fn();
			const opensBefore = open.mock.calls.length;
			const session = await client.openCommitSession?.({ onCapabilities });
			if (session === undefined) {
				throw new Error('Expected a commit session');
			}
			expect(open.mock.calls.length).toBe(opensBefore);
			await expect(
				session.commit({
					uploadId: uploadIdSchema.parse(operationId),
					storePathHash: metadata.storePathHash,
					narHash: metadata.narHash
				})
			).rejects.toThrow('No commit expected');
			expect({
				opens: open.mock.calls.length,
				callback: open.mock.lastCall?.[1]?.onCapabilities
			}).toStrictEqual({ opens: opensBefore + 1, callback: onCapabilities });
			session.close();
		} finally {
			open.mockRestore();
		}
	}
);

it.each([false, true])(
	'keeps an empty publication plan read-only with root=%s',
	async (hasRoot) => {
		const commit = vi.fn(() => Promise.reject(new Error('No commit expected')));
		const close = vi.fn();
		const open = vi
			.spyOn(CupboardClient.prototype, 'openCommitSession')
			.mockImplementation((_credential, options) => {
				options?.onCapabilities?.(new Map([[publicationCapability, {}]]));
				return Promise.resolve({ commit, close });
			});
		const requests: { path: string; body: unknown }[] = [];
		const attachRoot = {
			name: 'run',
			retention: { kind: 'duration' as const, seconds: 3600 }
		};
		const client = pushClientFor(new URL('https://cupboard.test'), 'token', {
			cache: { kind: 'default' },
			fetcher: async (input, init) => {
				const request = new Request(input, init);
				const path = new URL(request.url).pathname;
				const body: unknown = await request.json();
				requests.push({ path, body });
				if (path === '/uploads/credential') {
					return Response.json(
						{
							pushId: 'push-1',
							accessKeyId: 'access',
							secretAccessKey: 'secret',
							sessionToken: 'session',
							endpoint: 'https://r2.test',
							bucket: 'blobs',
							expiresAt: '2099-01-01T00:00:00.000Z'
						},
						{ headers: { [uploadCapabilitiesHeader]: publicationCapability } }
					);
				}
				if (path === '/uploads/plan') {
					return Response.json({
						cacheGeneration: 1,
						pushExpiresAt: '2099-01-01T00:00:00.000Z',
						uploads: []
					});
				}
				throw new Error(`Unexpected request: ${path}`);
			}
		});
		try {
			const result = await client.negotiate({
				paths: [],
				...(hasRoot && { attachRoot })
			});
			expect({
				result,
				requests,
				opens: open.mock.calls.length,
				commits: commit.mock.calls,
				closes: close.mock.calls
			}).toStrictEqual({
				result: { uploads: [], hasUploadGraceFacts: true },
				requests: [
					{ path: '/uploads/credential', body: {} },
					{
						path: '/uploads/plan',
						body: {
							pushId: 'push-1',
							paths: [],
							...(hasRoot && { attachRoot })
						}
					}
				],
				opens: 1,
				commits: [],
				closes: [[]]
			});
		} finally {
			open.mockRestore();
		}
	}
);

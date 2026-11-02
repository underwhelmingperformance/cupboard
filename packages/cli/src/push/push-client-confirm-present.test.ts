import {
	cacheNameSchema,
	type CacheScope,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import {
	publicationIdentity,
	uploadConfirmPresentMaxCanonicalBytes
} from '@cupboard/protocol/publication';
import {
	acceptCapabilitiesHeader,
	publicationCapability,
	type UploadAttachRoot,
	uploadAttachRootSchema,
	uploadCapabilitiesHeader,
	uploadConfirmPresentCapability,
	uploadConfirmPresentMaxRequestBytes,
	type UploadConfirmPresentRequest,
	uploadConfirmPresentRequestSchema,
	type UploadPathNegotiation,
	uploadPathNegotiationSchema,
	uploadPlanRequestSchema,
	type UploadSkipDecision
} from '@cupboard/protocol/upload';
import { maxTransientRetries } from '@cupboard/shared/retry';
import { probeDeadlineMs } from '@cupboard/shared/timeout';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CupboardClient } from '../client/client.ts';
import type { CommitSession } from '../client/commit-socket.ts';

import { pushClientFor } from './push-client.ts';

const capabilities = `${publicationCapability},${uploadConfirmPresentCapability}`;
const metadata = Array.from({ length: 65 }, (_, index) => {
	const storePathHash = String(index).padStart(32, '0');
	return uploadPathNegotiationSchema.parse({
		storePathHash,
		storePath: `/nix/store/${storePathHash}-app`,
		narHash: `sha256:${'1'.repeat(52)}`,
		narSize: index + 1,
		references: []
	});
});
const attachRoot = {
	name: 'run',
	retention: { kind: 'duration' as const, seconds: 3600 }
};

interface Call {
	readonly path: string;
	readonly body: unknown;
	readonly accepted: string | null;
}

function fixture(
	options: {
		readonly cache?: CacheScope;
		readonly metadata?: readonly UploadPathNegotiation[];
		readonly attachRoot?: UploadAttachRoot;
		readonly credentialCapabilities?: string;
		readonly socketCapabilities?: string;
		readonly confirm?: (
			request: UploadConfirmPresentRequest,
			attempt: number
		) => Response | Promise<Response>;
	} = {}
) {
	const calls: Call[] = [];
	const encodedRequests: { path: string; body: string }[] = [];
	const commit = vi.fn<CommitSession['commit']>(() =>
		Promise.reject(new Error('Unexpected commit'))
	);
	const close = vi.fn();
	const optionsForSocket = options.socketCapabilities;
	const open = vi
		.spyOn(CupboardClient.prototype, 'openCommitSession')
		.mockImplementation((_credential, options) => {
			options?.onCapabilities?.(
				new Map(
					(optionsForSocket ?? capabilities)
						.split(',')
						.map((value) => [value, {}])
				)
			);
			return Promise.resolve({ commit, close });
		});
	let attempts = 0;
	let nextOperation = 0;
	const client = pushClientFor(
		new URL('https://cupboard.test/t/acme'),
		'token',
		{
			cache: options.cache ?? { kind: 'default' },
			fetcher: async (input, init) => {
				const request = new Request(input, init);
				const path = new URL(request.url).pathname;
				const encodedBody = await request.text();
				encodedRequests.push({ path, body: encodedBody });
				const body: unknown = JSON.parse(encodedBody);
				calls.push({
					path,
					body,
					accepted: request.headers.get(acceptCapabilitiesHeader)
				});
				if (path.endsWith('/uploads/credential')) {
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
							headers: {
								[uploadCapabilitiesHeader]:
									options.credentialCapabilities ?? capabilities
							}
						}
					);
				}
				if (path.endsWith('/uploads/plan')) {
					const parsed = uploadPlanRequestSchema.parse(body);
					return Response.json({
						cacheGeneration: 3,
						pushExpiresAt: '2099-01-01T00:00:00.000Z',
						uploads: parsed.paths.map((path, index) => ({
							action: 'skip',
							storePathHash: path.storePathHash,
							narHash: path.narHash,
							operationId: (nextOperation++).toString(16).padStart(64, '0'),
							r2Key: `staging/${String(index)}`
						}))
					});
				}
				if (path.endsWith('/uploads/confirm-present')) {
					attempts += 1;
					const parsed = uploadConfirmPresentRequestSchema.parse(body);
					return (
						options.confirm?.(parsed, attempts) ??
						Response.json({
							paths: parsed.paths.map((path, index) =>
								index % 2 === 0
									? {
											storePathHash: path.storePathHash,
											status: 'confirmed',
											narHash: `sha256:${'2'.repeat(52)}`,
											generation: 9,
											grace: { retainUntil: '2099-01-01T00:00:00.000Z' }
										}
									: {
											storePathHash: path.storePathHash,
											status: 'needs-publication'
										}
							)
						})
					);
				}
				throw new Error(`Unexpected request ${path}`);
			}
		}
	);
	const plan = async (count = 65) => {
		const result = await client.negotiate({
			paths: (options.metadata ?? metadata).slice(0, count),
			attachRoot: options.attachRoot ?? attachRoot
		});
		return result.uploads.map((decision): UploadSkipDecision => {
			if (decision.action !== 'skip') {
				throw new Error('Expected skip');
			}
			return decision;
		});
	};
	return { client, calls, encodedRequests, plan, open, commit, close };
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe('pushClientFor confirmPresent', () => {
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
		'confirms immutable ordered 32-path pages in the $cache.kind cache',
		async ({ cache, prefix }) => {
			const { client, calls, plan, commit, open, close } = fixture({ cache });
			const skips = await plan();
			const selected = skips.filter((_skip, index) => index !== 1);
			const result = await client.confirmPresent?.(selected);
			const pages = [
				metadata.filter((_path, index) => index !== 1).slice(0, 32),
				metadata.slice(33)
			];
			expect({
				calls,
				result,
				commits: commit.mock.calls,
				opens: open.mock.calls.length,
				closes: close.mock.calls
			}).toStrictEqual({
				calls: [
					{
						path: `/t/acme${prefix}/uploads/credential`,
						body: {},
						accepted: capabilities
					},
					{
						path: `/t/acme${prefix}/uploads/plan`,
						body: { pushId: 'push-1', paths: metadata, attachRoot },
						accepted: capabilities
					},
					...pages.map((paths) => ({
						path: `/t/acme${prefix}/uploads/confirm-present`,
						body: { pushId: 'push-1', cacheGeneration: 3, paths, attachRoot },
						accepted: capabilities
					}))
				],
				result: {
					paths: pages.flatMap((page) =>
						page.map((path, index) =>
							index % 2 === 0
								? {
										storePathHash: path.storePathHash,
										status: 'confirmed',
										narHash: `sha256:${'2'.repeat(52)}`,
										generation: 9,
										grace: { retainUntil: '2099-01-01T00:00:00.000Z' }
									}
								: {
										storePathHash: path.storePathHash,
										status: 'needs-publication'
									}
						)
					)
				},
				commits: [],
				opens: 1,
				closes: [[]]
			});
			// Negative results preserve the original publication metadata and ID.
			const negative = selected[1];
			if (negative === undefined) {
				throw new Error('Expected negative');
			}
			expect(client.publicationFor?.(negative)).toStrictEqual({
				action: 'upload',
				storePathHash: metadata[2]?.storePathHash,
				narHash: metadata[2]?.narHash,
				uploadId: '2'.padStart(64, '0'),
				r2Key: 'staging/2',
				expiresAt: '2099-01-01T00:00:00.000Z'
			});
		}
	);

	it.each([0, 1, 32, 33, 65])(
		'uses fixed full pages and a final remainder for %s skips',
		async (count) => {
			const { client, calls, plan } = fixture();
			const skips = await plan(count);
			const result = await client.confirmPresent?.(skips);
			expect({
				sizes: calls
					.filter((call) => call.path.endsWith('/confirm-present'))
					.map(
						(call) =>
							uploadConfirmPresentRequestSchema.parse(call.body).paths.length
					),
				paths: result?.paths.length
			}).toStrictEqual({
				sizes:
					count === 0
						? []
						: count <= 32
							? [count]
							: count === 33
								? [32, 1]
								: [32, 32, 1],
				paths: count
			});
		}
	);

	it('keeps the original publication identity, metadata and root after a negative confirmation', async () => {
		const { client, plan, commit } = fixture({
			confirm: (request) =>
				Response.json({
					paths: request.paths.map((path) => ({
						storePathHash: path.storePathHash,
						status: 'needs-publication'
					}))
				})
		});
		const skips = await plan(1);
		await client.confirmPresent?.(skips);
		const skip = skips[0];
		if (skip === undefined) {
			throw new Error('Expected skip');
		}
		const upload = client.publicationFor?.(skip);
		if (upload === undefined) {
			throw new Error('Expected original publication');
		}
		const target = {
			uploadId: upload.uploadId,
			storePathHash: upload.storePathHash,
			narHash: upload.narHash,
			retention: true
		};
		const session = await client.openCommitSession?.({});
		if (session === undefined) {
			throw new Error('Expected session');
		}
		await expect(session.commit(target)).rejects.toThrow('Unexpected commit');
		expect(commit.mock.calls).toStrictEqual([
			[
				{
					...target,
					publication: {
						pushId: 'push-1',
						entry: {
							operationId: upload.uploadId,
							cacheGeneration: 3,
							metadata: metadata[0],
							attachRoot
						}
					}
				}
			]
		]);
		session.close();
	});

	it('never treats the independent confirmation capability as publication support', async () => {
		const { client, calls, open } = fixture({
			credentialCapabilities: uploadConfirmPresentCapability
		});
		expect(await client.confirmPresent?.([])).toBeUndefined();
		expect({
			paths: calls.map((call) => call.path),
			opens: open.mock.calls
		}).toStrictEqual({ paths: ['/t/acme/uploads/credential'], opens: [] });
	});

	it.each([
		{
			credentialCapabilities: publicationCapability,
			socketCapabilities: capabilities
		},
		{
			credentialCapabilities: capabilities,
			socketCapabilities: publicationCapability
		}
	])(
		'leaves planned skips unchanged without both confirmation advertisements: %j',
		async (options) => {
			const { client, calls, plan } = fixture(options);
			const skips = await plan(1);
			expect(await client.confirmPresent?.(skips)).toBeUndefined();
			expect(calls.map((call) => call.path)).toStrictEqual([
				'/t/acme/uploads/credential',
				'/t/acme/uploads/plan'
			]);
			const skip = skips[0];
			if (skip === undefined) {
				throw new Error('Expected skip');
			}
			expect(client.publicationFor?.(skip)).toBeDefined();
		}
	);

	it.each([
		'missing',
		'extra',
		'reordered',
		'unknown',
		'duplicate',
		'malformed',
		'json',
		'403',
		'409'
	])(
		'refuses %s replies without falling back to publication',
		async (failure) => {
			const { client, calls, plan, commit } = fixture({
				confirm: (request) => {
					if (failure === '403' || failure === '409') {
						return new Response('refused', { status: Number(failure) });
					}
					if (failure === 'json') {
						return new Response('{');
					}
					const paths: unknown[] = request.paths.map((path) => ({
						storePathHash: path.storePathHash,
						status: 'needs-publication'
					}));
					switch (failure) {
						case 'missing': {
							paths.pop();

							break;
						}
						case 'extra': {
							paths.push({
								storePathHash: metadata[2]?.storePathHash,
								status: 'needs-publication'
							});

							break;
						}
						case 'reordered': {
							paths.reverse();

							break;
						}
						case 'duplicate': {
							paths[1] = paths[0];

							break;
						}
						case 'unknown': {
							paths[0] = {
								storePathHash: metadata[2]?.storePathHash,
								status: 'needs-publication'
							};

							break;
						}
						case 'malformed': {
							paths[0] = {
								storePathHash: request.paths[0]?.storePathHash,
								status: 'confirmed'
							};

							break;
						}
						// No default
					}
					return Response.json({ paths });
				}
			});
			const skips = await plan(2);
			await expect(client.confirmPresent?.(skips)).rejects.toThrow();
			expect({
				calls: calls.map((call) => call.path),
				commits: commit.mock.calls
			}).toStrictEqual({
				calls: [
					'/t/acme/uploads/credential',
					'/t/acme/uploads/plan',
					'/t/acme/uploads/confirm-present'
				],
				commits: []
			});
		}
	);

	it.each([
		'503',
		'network',
		'body-timeout',
		'exhausted-timeout',
		'exhausted-503'
	])(
		'retries an identical immutable page after %s and never downgrades',
		async (failure) => {
			vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
			const { client, calls, plan, commit } = fixture({
				confirm: (request, attempt) => {
					if (attempt === 1 || failure.startsWith('exhausted-')) {
						if (failure === '503' || failure === 'exhausted-503') {
							return new Response('retry', {
								status: 503,
								headers: { 'Retry-After': '0' }
							});
						}
						if (failure === 'network') {
							throw new TypeError('fetch failed', {
								cause: { code: 'ECONNRESET' }
							});
						}
						return new Response(
							new ReadableStream({
								start(controller) {
									controller.enqueue(new TextEncoder().encode('{'));
								}
							})
						);
					}
					return Response.json({
						paths: request.paths.map((path) => ({
							storePathHash: path.storePathHash,
							status: 'needs-publication'
						}))
					});
				}
			});
			const skips = await plan(2);
			const result = client.confirmPresent?.(skips);
			const checked = failure.startsWith('exhausted-')
				? expect(result).rejects.toThrow()
				: expect(result).resolves.toStrictEqual({
						paths: skips.map((skip) => ({
							storePathHash: skip.storePathHash,
							status: 'needs-publication'
						}))
					});
			await Promise.all([
				checked,
				vi.advanceTimersByTimeAsync(5 * probeDeadlineMs)
			]);
			const pages = calls.filter((call) =>
				call.path.endsWith('/confirm-present')
			);
			expect(pages.length).toBe(
				failure === 'exhausted-timeout'
					? 3
					: failure === 'exhausted-503'
						? maxTransientRetries + 1
						: 2
			);
			expect(
				pages.every((page) => JSON.stringify(page) === JSON.stringify(pages[0]))
			).toBe(true);
			expect(commit.mock.calls).toStrictEqual([]);
		}
	);
});

const maximumTenant = tenantIdSchema.parse('x'.repeat(63));
const unicodeRoot = uploadAttachRootSchema.parse({
	name: '界'.repeat(256),
	retention: { kind: 'duration', seconds: 3600 }
});
const namedCache: CacheScope = {
	kind: 'named',
	name: cacheNameSchema.parse('x'.repeat(63))
};

function referenceMetadata(
	index: number,
	referenceCount: number,
	hasDistinctReferences = true,
	referenceNameLength = 211
): UploadPathNegotiation {
	const original = metadata[index];
	if (original === undefined) {
		throw new Error('Expected metadata');
	}
	return uploadPathNegotiationSchema.parse({
		...original,
		references: Array.from(
			{ length: referenceCount },
			(_, reference) =>
				`${String(hasDistinctReferences ? reference : 0).padStart(32, '0')}-${'r'.repeat(referenceNameLength)}`
		)
	});
}

async function canonicalPageBytes(
	request: UploadConfirmPresentRequest
): Promise<number> {
	const identities = await Promise.all(
		request.paths.map((path) =>
			publicationIdentity({
				tenant: maximumTenant,
				cache: namedCache,
				...request,
				metadata: path
			})
		)
	);
	return new TextEncoder().encode(
		JSON.stringify([
			'cupboard/confirmation/v1',
			identities.map((identity) => identity.canonical)
		])
	).byteLength;
}

async function boundedConfirmationRequests(
	requests: readonly { path: string; body: string }[]
): Promise<UploadConfirmPresentRequest[]> {
	const pages = requests.filter((request) =>
		request.path.endsWith('/confirm-present')
	);
	const bodies: UploadConfirmPresentRequest[] = [];
	for (const page of pages) {
		const body = uploadConfirmPresentRequestSchema.parse(JSON.parse(page.body));
		expect(new TextEncoder().encode(page.body).byteLength).toBeLessThanOrEqual(
			uploadConfirmPresentMaxRequestBytes
		);
		expect(await canonicalPageBytes(body)).toBeLessThanOrEqual(
			uploadConfirmPresentMaxCanonicalBytes
		);
		expect(body.paths.length).toBeLessThanOrEqual(32);
		expect(body.attachRoot).toStrictEqual(unicodeRoot);
		bodies.push(body);
	}
	return bodies;
}

describe('pushClientFor confirmation byte pages', () => {
	it('bounds large distinct-reference pages by canonical bytes including repeated UTF-8 root context', async () => {
		const paths = Array.from({ length: 32 }, (_, index) =>
			referenceMetadata(index, 1000, true, 32)
		);
		const { client, plan, encodedRequests } = fixture({
			cache: namedCache,
			metadata: paths,
			attachRoot: unicodeRoot
		});
		const selected = await plan(32);
		const result = await client.confirmPresent?.(selected);
		const pages = await boundedConfirmationRequests(encodedRequests);
		expect(pages.length).toBeGreaterThan(1);
		expect(pages.flatMap((page) => page.paths)).toStrictEqual(paths);
		expect(result?.paths.map((path) => path.storePathHash)).toStrictEqual(
			paths.map((path) => path.storePathHash)
		);
	});

	it('measures encoded UTF-8 request bytes rather than string length when canonical references deduplicate', async () => {
		const first = referenceMetadata(0, 10_000, false);
		const second = referenceMetadata(1, 0, false);
		const request = {
			pushId: 'push-1',
			cacheGeneration: 3,
			paths: [first, second],
			attachRoot: unicodeRoot
		};
		const referenceBytes = JSON.stringify(first.references[0]).length + 1;
		const count = Math.floor(
			(uploadConfirmPresentMaxRequestBytes - JSON.stringify(request).length) /
				referenceBytes
		);
		const paths = [first, referenceMetadata(1, count, false)];
		const combined = JSON.stringify({ ...request, paths });
		expect(combined.length).toBeLessThanOrEqual(
			uploadConfirmPresentMaxRequestBytes
		);
		expect(new TextEncoder().encode(combined).byteLength).toBeGreaterThan(
			uploadConfirmPresentMaxRequestBytes
		);
		expect(
			await canonicalPageBytes(
				uploadConfirmPresentRequestSchema.parse({ ...request, paths })
			)
		).toBeLessThan(uploadConfirmPresentMaxCanonicalBytes);
		const { client, encodedRequests } = fixture({
			cache: namedCache,
			metadata: paths,
			attachRoot: unicodeRoot
		});
		const planned = [];
		for (const path of paths) {
			const response = await client.negotiate({
				paths: [path],
				attachRoot: unicodeRoot
			});
			planned.push(
				...response.uploads.flatMap((decision) =>
					decision.action === 'skip' ? [decision] : []
				)
			);
		}
		await client.confirmPresent?.(planned);
		const pages = await boundedConfirmationRequests(encodedRequests);
		expect(pages.map((page) => page.paths)).toStrictEqual(
			paths.map((path) => [path])
		);
	});

	it('publishes an individually ineligible skip with its original identity without preventing eligible confirmation', async () => {
		const paths = [
			referenceMetadata(0, 1),
			referenceMetadata(1, 10_000),
			referenceMetadata(2, 1)
		];
		const { client, plan, encodedRequests, commit } = fixture({
			cache: namedCache,
			metadata: paths,
			attachRoot: unicodeRoot
		});
		const selected = await plan(3);
		const result = await client.confirmPresent?.(selected);
		const pages = await boundedConfirmationRequests(encodedRequests);
		expect(pages.flatMap((page) => page.paths)).toStrictEqual([
			paths[0],
			paths[2]
		]);
		expect(result?.paths).toHaveLength(3);
		expect(result?.paths[1]).toStrictEqual({
			storePathHash: paths[1]?.storePathHash,
			status: 'needs-publication'
		});
		const skipped = selected[1];
		if (skipped === undefined) {
			throw new Error('Expected oversized skip');
		}
		const upload = client.publicationFor?.(skipped);
		if (upload === undefined) {
			throw new Error('Expected original publication');
		}
		const target = {
			uploadId: upload.uploadId,
			storePathHash: upload.storePathHash,
			narHash: upload.narHash,
			retention: true
		};
		const session = await client.openCommitSession?.({});
		if (session === undefined) {
			throw new Error('Expected session');
		}
		await expect(session.commit(target)).rejects.toThrow('Unexpected commit');
		expect(commit.mock.calls).toStrictEqual([
			[
				{
					...target,
					publication: {
						pushId: 'push-1',
						entry: {
							operationId: '1'.padStart(64, '0'),
							cacheGeneration: 3,
							metadata: paths[1],
							attachRoot: unicodeRoot
						}
					}
				}
			]
		]);
		session.close();
	});
});

it('keeps byte-sized pages unchanged through an ambiguous transient reply', async () => {
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
	const paths = Array.from({ length: 12 }, (_, index) =>
		referenceMetadata(index, 1000)
	);
	const { client, plan, encodedRequests } = fixture({
		cache: namedCache,
		metadata: paths,
		attachRoot: unicodeRoot,
		confirm: (request, attempt) =>
			attempt === 1
				? new Response('retry', {
						status: 503,
						headers: { 'Retry-After': '0' }
					})
				: Response.json({
						paths: request.paths.map((path) => ({
							storePathHash: path.storePathHash,
							status: 'needs-publication'
						}))
					})
	});
	const selected = await plan(12);
	const result = client.confirmPresent?.(selected);
	const checked = expect(result).resolves.toStrictEqual({
		paths: selected.map((path) => ({
			storePathHash: path.storePathHash,
			status: 'needs-publication'
		}))
	});
	await Promise.all([checked, vi.advanceTimersByTimeAsync(probeDeadlineMs)]);
	const pages = await boundedConfirmationRequests(encodedRequests);
	const encodedPages = encodedRequests.filter((request) =>
		request.path.endsWith('/confirm-present')
	);
	expect(encodedPages[0]).toStrictEqual(encodedPages[1]);
	expect(pages.slice(1).flatMap((page) => page.paths)).toStrictEqual(paths);
});

it('does not send confirmation when every selected path is individually over the canonical budget', async () => {
	const paths = [referenceMetadata(0, 10_000)];
	const { client, plan, encodedRequests } = fixture({
		cache: namedCache,
		metadata: paths,
		attachRoot: unicodeRoot
	});
	const selected = await plan(1);
	expect(await client.confirmPresent?.(selected)).toStrictEqual({
		paths: [
			{ storePathHash: paths[0]?.storePathHash, status: 'needs-publication' }
		]
	});
	expect(
		encodedRequests.filter((request) =>
			request.path.endsWith('/confirm-present')
		)
	).toStrictEqual([]);
});

it('preserves original per-page root contexts while byte paging', async () => {
	const { client, encodedRequests } = fixture({ cache: namedCache });
	const first = await client.negotiate({
		paths: metadata.slice(0, 2),
		attachRoot: unicodeRoot
	});
	const second = await client.negotiate({
		paths: metadata.slice(2, 4),
		attachRoot
	});
	const selected = [...first.uploads, ...second.uploads].flatMap((decision) =>
		decision.action === 'skip' ? [decision] : []
	);
	await client.confirmPresent?.(selected);
	const pages = encodedRequests
		.filter((request) => request.path.endsWith('/confirm-present'))
		.map((request) =>
			uploadConfirmPresentRequestSchema.parse(JSON.parse(request.body))
		);
	expect(pages).toStrictEqual([
		{
			pushId: 'push-1',
			cacheGeneration: 3,
			paths: metadata.slice(0, 2),
			attachRoot: unicodeRoot
		},
		{
			pushId: 'push-1',
			cacheGeneration: 3,
			paths: metadata.slice(2, 4),
			attachRoot
		}
	]);
});

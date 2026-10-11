import { storePathSchema } from '@cupboard/nix-store/scalars';
import {
	cacheIntersectionMaxRequestBytes,
	type CacheMetadataEntry,
	cacheMetadataMaxNarInfoBytes,
	cacheMetadataMaxResponseBytes
} from '@cupboard/protocol/cache-metadata';
import { describe, expect, it, vi } from 'vitest';

import {
	MetadataNarInfoInvalidError,
	MetadataNarInfoTooLargeError,
	MetadataRequestTooLargeError,
	ServerHttpError
} from '../errors.ts';

import {
	cacheMetadataPageResponse,
	parseCacheMetadataRequest,
	parseCachePathInfoRequest
} from './metadata-page.ts';

const paths = ['1', '2', '3'].map((hash) =>
	storePathSchema.parse(`/nix/store/${hash.repeat(32)}-path`)
);

describe('bounded metadata pages', () => {
	it('counts JSON escaping and returns an advancing input prefix', async () => {
		const entries = paths.map((storePath): CacheMetadataEntry => ({
			storePath,
			status: 'found',
			narinfo: '"'.repeat(cacheMetadataMaxNarInfoBytes)
		}));
		const onPage = vi.fn();
		const response = await cacheMetadataPageResponse(
			'cache:1:1:public:false',
			paths,
			entries,
			onPage
		);
		const bytes = new Uint8Array(await response.arrayBuffer());
		const result: unknown = JSON.parse(new TextDecoder().decode(bytes));
		expect(result).toStrictEqual({
			scopeVersion: 'cache:1:1:public:false',
			entries: [entries[0]],
			nextIndex: 1
		});
		expect(bytes.byteLength).toBeLessThanOrEqual(cacheMetadataMaxResponseBytes);
		expect(onPage.mock.calls).toStrictEqual([[result]]);
	});

	it('refuses one oversized UTF-8 narinfo instead of returning an empty continuation', async () => {
		const first = paths[0];
		if (first === undefined) {
			throw new Error('Missing fixture path');
		}
		await expect(
			cacheMetadataPageResponse(
				'cache:1:1:public:false',
				[first],
				[
					{
						storePath: first,
						status: 'found',
						narinfo: 'é'.repeat(cacheMetadataMaxNarInfoBytes)
					}
				]
			)
		).rejects.toBeInstanceOf(MetadataNarInfoTooLargeError);
	});

	it.each(['empty', 'short', 'out-of-order', 'extra'] as const)(
		'rejects an %s metadata source',
		async (kind) => {
			const entries = paths.map((storePath): CacheMetadataEntry => ({
				storePath,
				status: 'missing'
			}));
			const source =
				kind === 'empty'
					? []
					: kind === 'short'
						? entries.slice(0, 1)
						: kind === 'out-of-order'
							? entries.toReversed()
							: [...entries, ...entries];
			await expect(
				cacheMetadataPageResponse('cache:1:1:public:false', paths, source)
			).rejects.toBeInstanceOf(MetadataNarInfoInvalidError);
		}
	);

	it('attributes an out-of-order entry to the affected requested path', async () => {
		const entries = paths
			.map((storePath): CacheMetadataEntry => ({
				storePath,
				status: 'missing'
			}))
			.toReversed();
		await expect(
			cacheMetadataPageResponse('cache:1:1:public:false', paths, entries)
		).rejects.toMatchObject({ storePath: paths[0] });
	});

	it('omits path attribution when the metadata source includes an excess entry', async () => {
		const entries = paths.map((storePath): CacheMetadataEntry => ({
			storePath,
			status: 'missing'
		}));
		await expect(
			cacheMetadataPageResponse('cache:1:1:public:false', paths, [
				...entries,
				...entries
			])
		).rejects.toMatchObject({
			storePath: undefined,
			message: 'The cache returned invalid narinfo metadata.'
		});
	});

	it('cancels an oversized streaming request before JSON parsing', async () => {
		let isCancelled = false;
		const init = {
			method: 'POST',
			duplex: 'half',
			body: new ReadableStream({
				start(controller) {
					controller.enqueue(new Uint8Array(65_537));
				},
				cancel() {
					isCancelled = true;
				}
			})
		};
		const request = new Request(
			'https://cupboard.example.workers.dev/api/v1/path-info',
			init
		);
		await expect(parseCacheMetadataRequest(request)).rejects.toBeInstanceOf(
			MetadataRequestTooLargeError
		);
		expect(isCancelled).toBe(true);
	});
});

describe('path-info operation dispatch', () => {
	it('accepts a sparse intersection request beyond the metadata page limit', async () => {
		const storePathHashes = Array.from({ length: 3000 }, (_, index) =>
			String(index).padStart(32, '0')
		);
		const input = { operation: 'intersection', storePathHashes };
		const request = new Request('https://cache.test/api/v1/path-info', {
			method: 'POST',
			body: JSON.stringify(input)
		});
		const result = await parseCachePathInfoRequest(request);
		expect(result).toStrictEqual(input);
	});
	it('keeps the metadata byte limit including original whitespace', async () => {
		const request = new Request('https://cache.test/api/v1/path-info', {
			method: 'POST',
			body: ' '.repeat(65_536) + JSON.stringify({ storePaths: paths })
		});
		await expect(parseCachePathInfoRequest(request)).rejects.toBeInstanceOf(
			MetadataRequestTooLargeError
		);
	});
	it.each([
		{ operation: 'unknown', storePathHashes: ['0'.repeat(32)] },
		{
			operation: 'intersection',
			storePathHashes: ['0'.repeat(32), '0'.repeat(32)]
		},
		{ operation: 'intersection', storePathHashes: ['bad-hash'] },
		{
			operation: 'intersection',
			storePathHashes: Array.from({ length: 32_769 }, (_, index) =>
				String(index).padStart(32, '0')
			)
		},
		{
			storePaths: Array.from(
				{ length: 33 },
				(_, index) => `/nix/store/${String(index).padStart(32, '0')}-path`
			)
		}
	])('refuses invalid or over-count requests', async (input) => {
		const request = new Request('https://cache.test/api/v1/path-info', {
			method: 'POST',
			body: JSON.stringify(input)
		});
		await expect(parseCachePathInfoRequest(request)).rejects.toThrow();
	});

	it('cancels an intersection stream beyond its separate byte cap', async () => {
		let isCancelled = false;
		const init = {
			method: 'POST',
			duplex: 'half',
			body: new ReadableStream({
				start(controller) {
					controller.enqueue(
						new Uint8Array(cacheIntersectionMaxRequestBytes + 1)
					);
				},
				cancel() {
					isCancelled = true;
				}
			})
		};
		const request = new Request('https://cache.test/api/v1/path-info', init);
		await expect(parseCachePathInfoRequest(request)).rejects.toBeInstanceOf(
			MetadataRequestTooLargeError
		);
		expect(isCancelled).toBe(true);
	});
});

it('bounds diagnostics before validating an oversized array of invalid hashes', async () => {
	const request = new Request('https://cache.test/api/v1/path-info', {
		method: 'POST',
		body: JSON.stringify({
			operation: 'intersection',
			storePathHashes: Array.from({ length: 100_000 }, () => 0)
		})
	});
	let error: unknown;
	try {
		await parseCachePathInfoRequest(request);
	} catch (error_) {
		error = error_;
	}
	if (!(error instanceof ServerHttpError)) {
		throw new Error('Expected a bounded HTTP refusal');
	}
	expect({
		status: error.status,
		diagnostic:
			error.message.length > 200 ? 'oversized diagnostic' : error.message
	}).toStrictEqual({
		status: 413,
		diagnostic:
			'The intersection request has 100000 hashes; send at most 32768 hashes per request.'
	});
});

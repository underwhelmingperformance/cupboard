import { storePathSchema } from '@cupboard/nix-store/scalars';
import {
	type CacheMetadataEntry,
	cacheMetadataMaxNarInfoBytes,
	cacheMetadataMaxResponseBytes
} from '@cupboard/protocol/cache-metadata';
import { describe, expect, it } from 'vitest';

import {
	MetadataNarInfoInvalidError,
	MetadataNarInfoTooLargeError,
	MetadataRequestTooLargeError
} from '../errors.ts';

import {
	cacheMetadataPageResponse,
	parseCacheMetadataRequest
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
		const response = await cacheMetadataPageResponse(
			'cache:1:1:public:false',
			paths,
			entries
		);
		const bytes = new Uint8Array(await response.arrayBuffer());
		const result: unknown = JSON.parse(new TextDecoder().decode(bytes));
		expect(result).toStrictEqual({
			scopeVersion: 'cache:1:1:public:false',
			entries: [entries[0]],
			nextIndex: 1
		});
		expect(bytes.byteLength).toBeLessThanOrEqual(cacheMetadataMaxResponseBytes);
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

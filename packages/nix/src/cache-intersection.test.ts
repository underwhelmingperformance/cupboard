import { createHash } from 'node:crypto';

import {
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import {
	cacheIntersectionMaxHashes,
	cacheIntersectionMaxResponseBytes,
	cacheIntersectionRequestSchema,
	cacheMetadataRequestSchema
} from '@cupboard/protocol/cache-metadata';
import { readUserSchema } from '@cupboard/shared/http';
import { describe, expect, it } from 'vitest';

import {
	type CachedClosureProgress,
	CachedClosureReader,
	CachedClosureSourceChangedError,
	CachedClosureSourceInvalidError
} from './cache-metadata.ts';

const url = new URL('https://cache.example.test/t/acme/cache/falcon');
const scopeVersion = 'cache:1:1:private:false';
const paths = Array.from({ length: 1000 }, (_, index) =>
	storePathSchema.parse(
		`/nix/store/${String(index).padStart(32, '0')}-dependency`
	)
);

function narinfo(storePath: StorePathString): string {
	return `StorePath: ${storePath}\nURL: nar/file.nar\nCompression: none\nFileHash: sha256:${'0'.repeat(64)}\nFileSize: 1\nNarHash: sha256:${'0'.repeat(64)}\nNarSize: 1\nReferences: \n`;
}

interface ProbeRequest {
	readonly operation?: string;
	readonly storePathHashes?: readonly string[];
	readonly storePaths?: readonly StorePathString[];
	readonly expectedScopeVersion?: string;
}

function fixture(
	matches: readonly string[],
	mutate?: (response: object) => object,
	missingPaths: readonly StorePathString[] = []
) {
	const requests: ProbeRequest[] = [];
	const progress: CachedClosureProgress[] = [];
	const reader = new CachedClosureReader(
		{
			url,
			paths: [],
			credential: { user: readUserSchema.parse('alice'), password: 'secret' }
		},
		async (_input, init) => {
			if (init?.method !== 'POST') {
				return new Response(undefined, {
					status: 404,
					headers: {
						'x-cupboard-read-capabilities': 'path-info-v1 path-intersection-v1'
					}
				});
			}
			if (typeof init.body !== 'string') {
				throw new TypeError('Expected a JSON request body');
			}
			const value: unknown = await new Response(init.body).json();
			const request = cacheIntersectionRequestSchema
				.or(cacheMetadataRequestSchema)
				.parse(value);
			requests.push(request);
			if ('operation' in request) {
				const hashes = request.storePathHashes;
				const response = {
					complete: true,
					scopeVersion,
					checked: hashes.length,
					inputFingerprint: createHash('sha256')
						.update(JSON.stringify(hashes))
						.digest('hex'),
					matchingHashes: hashes.filter((hash) => matches.includes(hash))
				};
				return Response.json(mutate?.(response) ?? response);
			}
			return Response.json({
				scopeVersion,
				entries: request.storePaths.map((storePath) =>
					missingPaths.includes(storePath)
						? { storePath, status: 'missing' }
						: { storePath, status: 'found', narinfo: narinfo(storePath) }
				)
			});
		},
		undefined,
		(event) => {
			progress.push(event);
		}
	);
	return { reader, requests, progress };
}

describe('sparse dependency intersection', () => {
	it.each([{ indices: [] }, { indices: [0, 999] }])(
		'reads canonical metadata only for possible matches %j and counts every path once',
		async ({ indices }) => {
			const matches = indices.map((index) =>
				StorePath.hash(storePathSchema.parse(paths[index]))
			);
			const { reader, requests, progress } = fixture(matches);
			const offers = await reader.offers(paths);
			expect({
				matchingPaths: offers.flatMap((offer, index) =>
					offer === undefined ? [] : [paths[index]]
				),
				requests,
				progress
			}).toStrictEqual({
				matchingPaths: indices.map((index) => paths[index]),
				requests: [
					{
						operation: 'intersection',
						storePathHashes: paths.map((path) => StorePath.hash(path))
					},
					...(indices.length === 0
						? []
						: [
								{
									storePaths: indices.map((index) => paths[index]),
									expectedScopeVersion: scopeVersion
								}
							])
				],
				progress: [
					{ mode: 'bulk', checked: paths.length - indices.length, found: 0 },
					...(indices.length === 0
						? []
						: [
								{ mode: 'bulk', checked: indices.length, found: indices.length }
							])
				]
			});
		}
	);

	it('keeps full-path aliases when hashes match', async () => {
		const first = paths[0];
		if (first === undefined) {
			throw new Error('Missing fixture path');
		}
		const alias = storePathSchema.parse(`${first}-alias`);
		const { reader, requests } = fixture([StorePath.hash(first)]);
		const offers = await reader.offers([first, alias]);
		expect({
			paths: offers.map((offer) => offer?.narinfo),
			requests
		}).toStrictEqual({
			paths: [narinfo(first), narinfo(alias)],
			requests: [
				{ operation: 'intersection', storePathHashes: [StorePath.hash(first)] },
				{ storePaths: [first, alias], expectedScopeVersion: scopeVersion }
			]
		});
	});

	it.each([
		{ complete: false },
		{ checked: 999 },
		{ inputFingerprint: '0'.repeat(64) },
		{ matchingHashes: ['9'.repeat(32)] },
		{ matchingHashes: ['0'.repeat(32), '0'.repeat(32)] },
		{ matchingHashes: ['invalid'] }
	])('refuses incomplete or inconsistent accounting %j', async (override) => {
		const { reader } = fixture([], (response) => ({
			...response,
			...override
		}));
		await expect(reader.offers(paths)).rejects.toBeInstanceOf(
			CachedClosureSourceInvalidError
		);
	});

	it('binds repeated lookups to the admitted lifecycle version', async () => {
		let isChange = false;
		const { reader } = fixture([], (response) =>
			isChange
				? { ...response, scopeVersion: 'cache:2:1:private:false' }
				: response
		);
		await reader.offers(paths);
		isChange = true;
		await expect(reader.offers(paths)).rejects.toBeInstanceOf(
			CachedClosureSourceChangedError
		);
	});
	it('chunks the full dependency set without discarding build-only candidates', async () => {
		const candidates = Array.from(
			{ length: cacheIntersectionMaxHashes + 1 },
			(_, index) =>
				storePathSchema.parse(
					`/nix/store/${String(index).padStart(32, '0')}-build-only`
				)
		);
		const { reader, requests, progress } = fixture([]);
		const offers = await reader.offers(candidates);
		expect({
			requestSizes: requests.map((request) => request.storePathHashes?.length),
			versions: requests.map((request) => request.expectedScopeVersion),
			checked: progress.reduce((sum, event) => sum + event.checked, 0),
			found: offers.filter((offer) => offer !== undefined)
		}).toStrictEqual({
			requestSizes: [cacheIntersectionMaxHashes, 1],
			versions: [undefined, scopeVersion],
			checked: candidates.length,
			found: []
		});
	});

	it('refuses an oversized intersection response', async () => {
		const { reader } = fixture([], (response) => ({
			...response,
			padding: 'x'.repeat(cacheIntersectionMaxResponseBytes)
		}));
		await expect(reader.offers(paths)).rejects.toBeInstanceOf(
			CachedClosureSourceInvalidError
		);
	});
	it('does not accept a possible match without canonical metadata', async () => {
		const first = paths[0];
		if (first === undefined) {
			throw new Error('Missing fixture path');
		}
		const { reader, progress } = fixture([StorePath.hash(first)], undefined, [
			first
		]);
		const offers = await reader.offers([first]);
		expect({ offers, progress }).toStrictEqual({
			offers: [undefined],
			progress: [
				{ mode: 'bulk', checked: 0, found: 0 },
				{ mode: 'bulk', checked: 1, found: 0 }
			]
		});
	});

	it('reads dense matches in bounded canonical pages', async () => {
		const { reader, requests, progress } = fixture(
			paths.map((path) => StorePath.hash(path))
		);
		const offers = await reader.offers(paths);
		expect({
			metadataSizes: requests.flatMap((request) =>
				request.storePaths === undefined ? [] : [request.storePaths.length]
			),
			narinfos: offers.map((offer) => offer?.narinfo),
			checked: progress.reduce((sum, event) => sum + event.checked, 0),
			found: progress.reduce((sum, event) => sum + event.found, 0)
		}).toStrictEqual({
			metadataSizes: [...Array.from({ length: 31 }, () => 32), 8],
			narinfos: paths.map((path) => narinfo(path)),
			checked: 1000,
			found: 1000
		});
	});
});

it('bounds invalid over-count intersection response diagnostics', async () => {
	const { reader } = fixture([], (response) => ({
		...response,
		matchingHashes: Array.from({ length: 100_000 }, () => 0)
	}));
	let error: unknown;
	try {
		await reader.offers(paths);
	} catch (error_) {
		error = error_;
	}
	if (!(error instanceof CachedClosureSourceInvalidError)) {
		throw new Error('Expected an invalid intersection response');
	}
	expect(
		error.message.length > 256 ? 'oversized diagnostic' : error.message
	).toBe(
		'Cannot read cache at https://cache.example.test/t/acme/cache/falcon: the intersection response exceeds the 32768-hash limit'
	);
});

import { parseBaseUrl } from '@cupboard/nix-store/url';
import { describe, expect, it } from 'vitest';

import {
	assertCanonicalVersion,
	assetContentType,
	checksumTargets,
	createDraftBody,
	fetchCachePublicKey,
	MissingInputError,
	NonCanonicalVersionError,
	PublicKeyFetchError,
	renderChecksums,
	selectDraftRelease,
	substituterSection,
	updateDraftBody
} from './release.ts';

const draftOne = {
	id: 1,
	tagName: 'v1.2.3',
	draft: true,
	uploadUrl: 'https://uploads.example.test/1',
	htmlUrl: 'https://example.test/releases/1',
	assets: []
};

const draftTwo = {
	id: 2,
	tagName: 'v1.2.3',
	draft: true,
	uploadUrl: 'https://uploads.example.test/2',
	htmlUrl: 'https://example.test/releases/2',
	assets: []
};

const publishedRelease = {
	id: 3,
	tagName: 'v1.2.3',
	draft: false,
	uploadUrl: 'https://uploads.example.test/3',
	htmlUrl: 'https://example.test/releases/3',
	assets: []
};

const otherDraft = {
	id: 4,
	tagName: 'v9.9.9',
	draft: true,
	uploadUrl: 'https://uploads.example.test/4',
	htmlUrl: 'https://example.test/releases/4',
	assets: []
};

describe('assertCanonicalVersion', () => {
	it('returns a canonical version unchanged', () => {
		expect(assertCanonicalVersion('v1.2.3')).toBe('v1.2.3');
	});

	it('rejects an empty version', () => {
		expect(() => assertCanonicalVersion('')).toThrow(MissingInputError);
	});

	it.each([
		['1.2.3'],
		['V1.2.3'],
		['v01.2.3'],
		['v1.02.3'],
		['v1.2.03'],
		['v1.2'],
		['v1.2.3-rc.1'],
		['v1.2.3+build'],
		['vgarbage']
	])('rejects the non-canonical version %s', (version) => {
		expect(() => assertCanonicalVersion(version)).toThrow(
			NonCanonicalVersionError
		);
	});
});

describe('selectDraftRelease', () => {
	it('reuses the first draft, reports duplicates and a published clash', () => {
		expect(
			selectDraftRelease(
				[draftOne, draftTwo, publishedRelease, otherDraft],
				'v1.2.3'
			)
		).toStrictEqual({
			existing: draftOne,
			duplicates: [draftTwo],
			published: publishedRelease
		});
	});

	it('returns nothing when no release matches', () => {
		expect(selectDraftRelease([otherDraft], 'v1.2.3')).toStrictEqual({
			existing: undefined,
			duplicates: [],
			published: undefined
		});
	});
});

describe('createDraftBody', () => {
	it('requests a draft with generated notes pinned to the build commit', () => {
		expect(
			createDraftBody({
				version: 'v1.2.3',
				commitish: 'abc123',
				name: 'v1.2.3',
				body: 'substituters...'
			})
		).toStrictEqual({
			tag_name: 'v1.2.3',
			target_commitish: 'abc123',
			name: 'v1.2.3',
			body: 'substituters...',
			draft: true,
			generate_release_notes: true
		});
	});
});

const unavailable = () =>
	Promise.resolve({
		ok: false,
		status: 503,
		text: () => Promise.resolve('')
	});

// A `CACHE_URL` reaches the script through `parseBaseUrl`, so the bases here
// are built the same way, spelled both with and without a trailing slash.
const baseUrl = parseBaseUrl(new URL('https://cupboard.example/t/acme'));
const slashedBaseUrl = parseBaseUrl(
	new URL('https://cupboard.example/t/acme/')
);
const baseUrls = [baseUrl, slashedBaseUrl];

describe('fetchCachePublicKey', () => {
	it.each(baseUrls)('addresses /pubkey under %s', async (base) => {
		const requests: string[] = [];
		const fetchLike = (url: string) => {
			requests.push(url);

			return Promise.resolve({
				ok: true,
				status: 200,
				text: () => Promise.resolve('cupboard-1:abc123=\n')
			});
		};

		const key = await fetchCachePublicKey(base, fetchLike);

		expect(key).toBe('cupboard-1:abc123=');
		expect(requests).toStrictEqual(['https://cupboard.example/t/acme/pubkey']);
	});

	it('rejects a response that is not ok', async () => {
		await expect(fetchCachePublicKey(baseUrl, unavailable)).rejects.toThrow(
			PublicKeyFetchError
		);
	});
});

describe('substituterSection', () => {
	it.each(baseUrls)('renders the cache URL and key under %s', (base) => {
		expect(
			substituterSection({
				baseUrl: base,
				publicKey: 'cupboard-1:abc123='
			})
		).toBe(
			[
				'## Substitute from the release cache',
				'',
				'Cupboard publishes every versioned release to one Nix binary cache.',
				'Configure it once in nix.conf to fetch releases instead of building:',
				'',
				'```',
				'extra-substituters = https://cupboard.example/t/acme/cache/releases',
				'extra-trusted-public-keys = cupboard-1:abc123=',
				'```'
			].join('\n')
		);
	});
});

describe('updateDraftBody', () => {
	it('re-pins the draft without regenerating notes', () => {
		expect(
			updateDraftBody({ commitish: 'def456', name: 'v1.2.3' })
		).toStrictEqual({
			target_commitish: 'def456',
			name: 'v1.2.3',
			draft: true
		});
	});
});

describe('assetContentType', () => {
	it.each([
		['cupboard-linux-x64.tar.gz', 'application/gzip'],
		['checksums.txt', 'text/plain; charset=utf-8'],
		['cupboard', 'application/octet-stream']
	])('types %s', (assetName, expected) => {
		expect(assetContentType(assetName)).toBe(expected);
	});
});

describe('checksumTargets', () => {
	it('keeps only archives, sorted', () => {
		expect(
			checksumTargets([
				'checksums.txt',
				'cupboard-linux-x64.tar.gz',
				'cupboard-linux-arm64.tar.gz'
			])
		).toStrictEqual([
			'cupboard-linux-arm64.tar.gz',
			'cupboard-linux-x64.tar.gz'
		]);
	});
});

describe('renderChecksums', () => {
	it('renders two-space separated sha256sum lines', () => {
		expect(
			renderChecksums([
				{
					name: 'cupboard-linux-x64.tar.gz',
					sha256:
						'1111111111111111111111111111111111111111111111111111111111111111'
				},
				{
					name: 'cupboard-linux-arm64.tar.gz',
					sha256:
						'2222222222222222222222222222222222222222222222222222222222222222'
				}
			])
		).toBe(
			'1111111111111111111111111111111111111111111111111111111111111111  cupboard-linux-x64.tar.gz\n' +
				'2222222222222222222222222222222222222222222222222222222222222222  cupboard-linux-arm64.tar.gz\n'
		);
	});
});

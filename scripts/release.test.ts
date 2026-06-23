import { describe, expect, it } from 'vitest';

import {
	assetContentType,
	checksumTargets,
	createDraftBody,
	normaliseVersion,
	renderChecksums,
	selectDraftRelease,
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

describe('normaliseVersion', () => {
	it.each([
		['1.2.3', 'v1.2.3'],
		['v1.2.3', 'v1.2.3'],
		[' 1.2.3 ', 'v1.2.3']
	])('normalises %s', (version, expected) => {
		expect(normaliseVersion(version)).toBe(expected);
	});

	it('rejects an empty version', () => {
		expect(() => normaliseVersion('  ')).toThrow('version must not be empty');
	});
});

describe('selectDraftRelease', () => {
	it('reuses the first draft, reports duplicates and a published clash', () => {
		expect(
			selectDraftRelease(
				[draftOne, draftTwo, publishedRelease, otherDraft],
				'1.2.3'
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
				version: '1.2.3',
				commitish: 'abc123',
				name: 'v1.2.3'
			})
		).toStrictEqual({
			tag_name: 'v1.2.3',
			target_commitish: 'abc123',
			name: 'v1.2.3',
			draft: true,
			generate_release_notes: true
		});
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
		['cupboard-v1.2.3-linux-x64.tar.gz', 'application/gzip'],
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
				'cupboard-v1.2.3-linux-x64.tar.gz',
				'cupboard-v1.2.3-linux-arm64.tar.gz'
			])
		).toStrictEqual([
			'cupboard-v1.2.3-linux-arm64.tar.gz',
			'cupboard-v1.2.3-linux-x64.tar.gz'
		]);
	});
});

describe('renderChecksums', () => {
	it('renders two-space separated sha256sum lines', () => {
		expect(
			renderChecksums([
				{
					name: 'cupboard-v1.2.3-linux-x64.tar.gz',
					sha256:
						'1111111111111111111111111111111111111111111111111111111111111111'
				},
				{
					name: 'cupboard-v1.2.3-linux-arm64.tar.gz',
					sha256:
						'2222222222222222222222222222222222222222222222222222222222222222'
				}
			])
		).toBe(
			'1111111111111111111111111111111111111111111111111111111111111111  cupboard-v1.2.3-linux-x64.tar.gz\n' +
				'2222222222222222222222222222222222222222222222222222222222222222  cupboard-v1.2.3-linux-arm64.tar.gz\n'
		);
	});
});

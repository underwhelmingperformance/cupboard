import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
	NixPublicKey,
	parsePublishedNixPublicKeys
} from '@cupboard/nix-store/public-key';
import { parseBaseUrl } from '@cupboard/nix-store/url';
import { StatusCodes } from 'http-status-codes';
import { describe, expect, it, vi } from 'vitest';

import { isolateGitEnvironment } from '../tests/support/git.ts';

import {
	assertCanonicalVersion,
	assetContentType,
	checksumTargets,
	createDraftBody,
	fetchCachePublicKeys,
	MissingInputError,
	NonCanonicalVersionError,
	PublicKeyFetchError,
	publishAction,
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
	body: '',
	assets: []
};

const draftTwo = {
	id: 2,
	tagName: 'v1.2.3',
	draft: true,
	uploadUrl: 'https://uploads.example.test/2',
	htmlUrl: 'https://example.test/releases/2',
	body: '',
	assets: []
};

const publishedRelease = {
	id: 3,
	tagName: 'v1.2.3',
	draft: false,
	uploadUrl: 'https://uploads.example.test/3',
	htmlUrl: 'https://example.test/releases/3',
	body: '',
	assets: []
};

const otherDraft = {
	id: 4,
	tagName: 'v9.9.9',
	draft: true,
	uploadUrl: 'https://uploads.example.test/4',
	htmlUrl: 'https://example.test/releases/4',
	body: '',
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
	it.each([
		{ owner: 'acme', repo: 'app', version: 'v1.2.3' },
		{ owner: 'acme', repo: 'other', version: 'v2.0.0' }
	])(
		'embeds the $version upgrade guidance for $repo in a new draft',
		(input) => {
			expect(
				createDraftBody({
					version: input.version,
					repository: { owner: input.owner, repo: input.repo },
					commitish: 'abc123',
					name: input.version,
					body: 'substituters...',
					upgradeNotes: [
						{ path: 'notes.md', body: 'Upgrade the tenant schema.' }
					]
				})
			).toStrictEqual({
				tag_name: input.version,
				target_commitish: 'abc123',
				name: input.version,
				body: 'substituters...\n\n<!-- cupboard:upgrade-notes:start -->\n## Upgrade guidance\n\nUpgrade the tenant schema.\n<!-- cupboard:upgrade-notes:end -->',
				draft: true,
				generate_release_notes: true
			});
		}
	);
});

const unavailable = () =>
	Promise.resolve(
		new Response('', { status: StatusCodes.SERVICE_UNAVAILABLE })
	);

const baseUrl = parseBaseUrl(new URL('https://cupboard.example/t/acme'));
const slashedBaseUrl = parseBaseUrl(
	new URL('https://cupboard.example/t/acme/')
);
const baseUrls = [baseUrl, slashedBaseUrl];
const firstKey = 'cupboard-acme-1:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const rotationKeys = [
	firstKey,
	'cupboard-acme-2:ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8='
];
// During a key rotation, `/pubkey` lists more than one key, one on each line.
const publishRotationKeys = () =>
	Promise.resolve(new Response(`${rotationKeys.join('\n')}\n`));

describe('fetchCachePublicKeys', () => {
	it.each(baseUrls)('requests /pubkey from %s', async (base) => {
		const requests: string[] = [];
		const fetchLike = (url: string) => {
			requests.push(url);

			return Promise.resolve(
				new Response(
					'cupboard-1:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=\n'
				)
			);
		};

		const keys = await fetchCachePublicKeys(base, fetchLike);

		expect(keys).toStrictEqual([
			new NixPublicKey(
				'cupboard-1:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8='
			)
		]);
		expect(requests).toStrictEqual(['https://cupboard.example/t/acme/pubkey']);
	});

	it('returns every key published during a rotation', async () => {
		const keys = await fetchCachePublicKeys(baseUrl, publishRotationKeys);

		expect(keys).toStrictEqual(
			rotationKeys.map((key) => new NixPublicKey(key))
		);
	});

	it('rejects a response that is not ok', async () => {
		await expect(fetchCachePublicKeys(baseUrl, unavailable)).rejects.toThrow(
			PublicKeyFetchError
		);
	});
});

function releaseSection(trustedPublicKeys: string): string {
	return [
		'## Substitute from the release cache',
		'',
		'Cupboard publishes every versioned release to one Nix binary cache.',
		'Configure it once in nix.conf to fetch releases instead of building:',
		'',
		'```',
		'extra-substituters = https://cupboard.example/t/acme/cache/releases',
		`extra-trusted-public-keys = ${trustedPublicKeys}`,
		'```'
	].join('\n');
}

describe('substituterSection', () => {
	it.each(baseUrls)('renders the cache URL and key for %s', (base) => {
		expect(
			substituterSection({
				baseUrl: base,
				publicKeys: parsePublishedNixPublicKeys(firstKey)
			})
		).toBe(releaseSection(firstKey));
	});

	it('renders every key of a rotation on one trusted-public-keys line', async () => {
		const section = substituterSection({
			baseUrl,
			publicKeys: await fetchCachePublicKeys(baseUrl, publishRotationKeys)
		});

		expect(section).toBe(releaseSection(rotationKeys.join(' ')));
	});
});

describe('updateDraftBody', () => {
	it('preserves maintainer prose and embeds the selected guidance', () => {
		expect(
			updateDraftBody({
				commitish: 'def456',
				name: 'v1.2.3',
				version: 'v1.2.3',
				repository: { owner: 'acme', repo: 'app' },
				body: 'Maintainer notes.',
				upgradeNotes: [{ path: 'notes.md', body: 'Upgrade the tenant schema.' }]
			})
		).toStrictEqual({
			target_commitish: 'def456',
			name: 'v1.2.3',
			body: 'Maintainer notes.\n\n<!-- cupboard:upgrade-notes:start -->\n## Upgrade guidance\n\nUpgrade the tenant schema.\n<!-- cupboard:upgrade-notes:end -->',
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
	it('filters archive assets and sorts them by name', () => {
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

const execFileAsync = promisify(execFile);

it.each(['release metadata', 'target Git metadata'] as const)(
	'fails before draft mutations when %s is unavailable',
	async (failure) => {
		const requests: string[] = [];
		vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(input, init);
			requests.push(request.method + ' ' + request.url);
			if (failure === 'release metadata') {
				return Promise.resolve(
					Response.json({ message: 'Unavailable' }, { status: 401 })
				);
			}
			return Promise.resolve(
				Response.json(
					[draftOne, draftTwo].map((draft) => ({
						...draft,
						tag_name: draft.tagName,
						upload_url: draft.uploadUrl,
						html_url: draft.htmlUrl
					}))
				)
			);
		});
		try {
			await expect(
				publishAction({
					VERSION: 'v1.2.3',
					DIRECTORY: '/missing-assets',
					REPOSITORY_DIRECTORY: '/missing-release-repository',
					RELEASE_REPOSITORY: 'acme/app',
					COMMITISH: 'missing',
					GITHUB_TOKEN: 'test-token',
					CACHE_URL: 'https://cupboard.example/t/acme'
				})
			).rejects.toThrow();
			expect(requests).toStrictEqual([
				'GET https://api.github.com/repos/acme/app/releases?page=1&per_page=100'
			]);
		} finally {
			vi.unstubAllGlobals();
		}
	}
);

it('publishes without preparation from the exact commit and preserves draft edits on retry', async () => {
	isolateGitEnvironment();
	const directory = await mkdtemp(path.join(tmpdir(), 'release-publish-'));
	const git = async (...arguments_: string[]) => {
		const result = await execFileAsync('git', arguments_, { cwd: directory });
		return result.stdout.trim();
	};
	await git('init', '--initial-branch=main');
	await git('config', 'user.email', 'test@example.com');
	await git('config', 'user.name', 'Release fixture');
	await git('config', 'commit.gpgsign', 'false');
	// `git commit` can start a background repack, which writes to the
	// repository while the cleanup removes it.
	await git('config', 'maintenance.auto', 'false');
	await mkdir(path.join(directory, '.github/workflows'), { recursive: true });
	await mkdir(path.join(directory, 'docs/operator/upgrade-notes'), {
		recursive: true
	});
	await mkdir(path.join(directory, 'assets'));
	const workflow =
		'jobs:\n  publish:\n    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@main\n    with:\n      cache: releases\n';
	await writeFile(
		path.join(directory, '.github/workflows/release-cache.yml'),
		workflow
	);
	await writeFile(
		path.join(directory, 'docs/operator/upgrade-notes/schema.md'),
		'Upgrade from the tagged schema.'
	);
	await git('add', '--all');
	await git('commit', '-qm', 'fixture');
	const commitish = await git('rev-parse', 'HEAD');
	await writeFile(
		path.join(directory, 'docs/operator/upgrade-notes/schema.md'),
		'Uncommitted guidance must not appear.'
	);
	let draft: Record<string, unknown> | undefined;
	const requests: string[] = [];
	const fetcher: typeof fetch = async (input, init) => {
		const request = new Request(input, init);
		requests.push(request.method + ' ' + request.url);
		if (request.url.endsWith('/pubkey')) {
			return new Response(firstKey);
		}
		if (request.method === 'GET') {
			return Response.json(draft === undefined ? [] : [draft]);
		}
		const body: unknown = await request.json();
		if (typeof body !== 'object' || body === null || !('body' in body)) {
			throw new Error('Expected release body');
		}
		draft = {
			id: 1,
			tag_name: 'v1.2.3',
			draft: true,
			upload_url: 'https://uploads.example.test/1',
			html_url: 'https://example.test/releases/1',
			assets: [],
			...body
		};
		return Response.json(draft);
	};
	vi.stubGlobal('fetch', fetcher);
	try {
		const environment = {
			VERSION: 'v1.2.3',
			DIRECTORY: path.join(directory, 'assets'),
			REPOSITORY_DIRECTORY: directory,
			RELEASE_REPOSITORY: 'acme/app',
			COMMITISH: commitish,
			GITHUB_TOKEN: 'test-token',
			CACHE_URL: 'https://cupboard.example/t/acme'
		};
		await publishAction(environment);
		if (draft === undefined || typeof draft.body !== 'string') {
			throw new Error('Expected created draft');
		}
		const firstBody = draft.body;
		draft.body =
			'Maintainer introduction.\n\n' +
			firstBody +
			'\n\nGenerated GitHub notes.\nMaintainer follow-up.';
		await publishAction(environment);
		expect({
			body: draft.body,
			workflow: await readFile(
				path.join(directory, '.github/workflows/release-cache.yml'),
				'utf8'
			),
			requests
		}).toStrictEqual({
			body:
				'Maintainer introduction.\n\n' +
				firstBody +
				'\n\nGenerated GitHub notes.\nMaintainer follow-up.',
			workflow,
			requests: [
				'GET https://api.github.com/repos/acme/app/releases?page=1&per_page=100',
				'GET https://cupboard.example/t/acme/pubkey',
				'POST https://api.github.com/repos/acme/app/releases',
				'GET https://api.github.com/repos/acme/app/releases?page=1&per_page=100',
				'GET https://cupboard.example/t/acme/pubkey',
				'PATCH https://api.github.com/repos/acme/app/releases/1'
			]
		});
	} finally {
		vi.unstubAllGlobals();
		await rm(directory, { recursive: true, force: true });
	}
});

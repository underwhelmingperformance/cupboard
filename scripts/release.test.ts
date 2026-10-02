import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
	NixPublicKey,
	parsePublishedNixPublicKeys
} from '@cupboard/nix-store/public-key';
import { parseBaseUrl } from '@cupboard/nix-store/url';
import { StatusCodes } from 'http-status-codes';
import { describe, expect, it, vi } from 'vitest';
import { parseDocument } from 'yaml';

import { resolveCupboard } from '../actions/src/cupboard-resolution.ts';

import {
	assertCanonicalVersion,
	assetContentType,
	checkPreparationAction,
	checksumTargets,
	createDraftBody,
	fetchCachePublicKeys,
	MissingInputError,
	NonCanonicalVersionError,
	prepareAction,
	PublicKeyFetchError,
	publishAction,
	ReleasePreparationError,
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
	])('links the $version upgrade notes for $repo in a new draft', (input) => {
		expect(
			createDraftBody({
				version: input.version,
				repository: { owner: input.owner, repo: input.repo },
				commitish: 'abc123',
				name: input.version,
				body: 'substituters...'
			})
		).toStrictEqual({
			tag_name: input.version,
			target_commitish: 'abc123',
			name: input.version,
			body:
				`substituters...\n\nBefore upgrading an existing deployment, read the [${input.version} upgrade notes][cupboard-upgrade-notes-${input.version}].\n\n` +
				`[cupboard-upgrade-notes-${input.version}]: https://github.com/${input.owner}/${input.repo}/blob/${input.version}/docs/operator/upgrade-notes.md`,
			draft: true,
			generate_release_notes: true
		});
	});
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
	const linkedNotes =
		'Maintainer notes.\n\nBefore upgrading an existing deployment, read the [v1.2.3 upgrade notes][cupboard-upgrade-notes-v1.2.3].\n\n' +
		'[cupboard-upgrade-notes-v1.2.3]: https://github.com/acme/app/blob/v1.2.3/docs/operator/upgrade-notes.md';

	it.each(['Maintainer notes.', linkedNotes])(
		'preserves existing notes and includes one upgrade link',
		(body) => {
			expect(
				updateDraftBody({
					commitish: 'def456',
					name: 'v1.2.3',
					version: 'v1.2.3',
					repository: { owner: 'acme', repo: 'app' },
					body
				})
			).toStrictEqual({
				target_commitish: 'def456',
				name: 'v1.2.3',
				body: linkedNotes,
				draft: true
			});
		}
	);
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

const releaseScript = new URL('release.ts', import.meta.url);
const execFileAsync = promisify(execFile);
const preparationWorkflow = `name: release cache
on:
  release:
    types: [published]
jobs:
  publish:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@main
    with:
      cache: releases
      build: rebuild
      trusted-public-key: cupboard-acme-1:test
      cupboard-version: \${{ github.event.release.tag_name }}
  flakehub:
    needs: publish
    runs-on: ubuntu-24.04
`;
const preparedWorkflow = `name: release cache
on:
  release:
    types: [published]
jobs:
  publish:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@v1.2.3
    with:
      cache: releases
      build: rebuild
      trusted-public-key: cupboard-acme-1:test
  flakehub:
    needs: publish
    runs-on: ubuntu-24.04
`;
const preparationNotes =
	'# Upgrade notes\n\n## Next release\n\nDeploy the server first.\n\n## v1.0.0\n\nEarlier notes.\n';

async function releaseFixture(
	workflow = preparationWorkflow,
	notes = preparationNotes
) {
	const directory = await mkdtemp(
		path.join(tmpdir(), 'cupboard-release-preparation-')
	);
	await mkdir(path.join(directory, '.github/workflows'), { recursive: true });
	await mkdir(path.join(directory, 'docs/operator'), { recursive: true });
	await writeFile(
		path.join(directory, '.github/workflows/release-cache.yml'),
		workflow
	);
	await writeFile(
		path.join(directory, '.github/workflows/cache-publish.yml'),
		'dogfood @main\n'
	);
	await writeFile(
		path.join(directory, 'docs/operator/upgrade-notes.md'),
		notes
	);
	return directory;
}

async function fixtureSources(directory: string) {
	return {
		workflow: await readFile(
			path.join(directory, '.github/workflows/release-cache.yml'),
			'utf8'
		),
		upgradeNotes: await readFile(
			path.join(directory, 'docs/operator/upgrade-notes.md'),
			'utf8'
		),
		dogfood: await readFile(
			path.join(directory, '.github/workflows/cache-publish.yml'),
			'utf8'
		)
	};
}

describe('release preparation command', () => {
	it('prepares the entered tag and preserves the dogfood workflow and earlier notes', async () => {
		const directory = await releaseFixture();
		try {
			const { stdout } = await execFileAsync(
				process.execPath,
				[
					'--experimental-transform-types',
					'--disable-warning=ExperimentalWarning',
					fileURLToPath(releaseScript),
					'prepare'
				],
				{
					env: {
						...process.env,
						VERSION: 'v1.2.3',
						REPOSITORY_DIRECTORY: directory
					}
				}
			);
			expect(await fixtureSources(directory)).toStrictEqual({
				workflow: preparedWorkflow,
				upgradeNotes: preparationNotes.replace('## Next release', '## v1.2.3'),
				dogfood: 'dogfood @main\n'
			});
			expect(stdout).toContain(
				'underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@refs/tags/v1.2.3'
			);
			const first = await fixtureSources(directory);
			await execFileAsync(
				process.execPath,
				[
					'--experimental-transform-types',
					'--disable-warning=ExperimentalWarning',
					fileURLToPath(releaseScript),
					'prepare'
				],
				{
					env: {
						...process.env,
						VERSION: 'v1.2.3',
						REPOSITORY_DIRECTORY: directory
					}
				}
			);
			expect(await fixtureSources(directory)).toStrictEqual(first);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});

const preparedNotes = preparationNotes.replace('## Next release', '## v1.2.3');

describe('release preparation validation', () => {
	it.each([
		{
			name: 'malformed workflow',
			workflow: 'jobs: [\n',
			notes: preparedNotes
		},
		{
			name: 'main workflow',
			workflow: preparedWorkflow.replace('@v1.2.3', '@main'),
			notes: preparedNotes
		},
		{
			name: 'different tag',
			workflow: preparedWorkflow.replace('@v1.2.3', '@v2.0.0'),
			notes: preparedNotes
		},
		{
			name: 'CLI override',
			workflow: preparedWorkflow.replace(
				'      cache: releases',
				'      cupboard-version: v1.2.3\n      cache: releases'
			),
			notes: preparedNotes
		},
		{
			name: 'pending upgrade notes',
			workflow: preparedWorkflow,
			notes: preparationNotes
		}
	])(
		'rejects $name before any draft API request',
		async ({ workflow, notes }) => {
			const directory = await releaseFixture(workflow, notes);
			const fetcher = vi.fn(() =>
				Promise.reject(new Error('Unexpected GitHub request'))
			);
			vi.stubGlobal('fetch', fetcher);
			try {
				const environment = {
					VERSION: 'v1.2.3',
					REPOSITORY_DIRECTORY: directory,
					DIRECTORY: directory,
					RELEASE_REPOSITORY: 'acme/app',
					COMMITISH: 'a'.repeat(40),
					GITHUB_TOKEN: 'test-token'
				};
				const before = await fixtureSources(directory);
				await expect(checkPreparationAction(environment)).rejects.toThrow(
					ReleasePreparationError
				);
				await expect(publishAction(environment)).rejects.toThrow(
					ReleasePreparationError
				);
				expect({
					sources: await fixtureSources(directory),
					requests: fetcher.mock.calls
				}).toStrictEqual({ sources: before, requests: [] });
			} finally {
				vi.unstubAllGlobals();
				await rm(directory, { recursive: true, force: true });
			}
		}
	);

	it.each([
		{
			name: 'invalid version',
			version: '1.2.3',
			workflow: preparationWorkflow,
			notes: preparationNotes,
			error: NonCanonicalVersionError
		},
		{
			name: 'malformed YAML',
			version: 'v1.2.3',
			workflow: 'jobs: [\n',
			notes: preparationNotes,
			error: ReleasePreparationError
		},
		{
			name: 'unexpected workflow',
			version: 'v1.2.3',
			workflow: preparationWorkflow.replace(
				'underwhelmingperformance/cupboard/',
				'acme/app/'
			),
			notes: preparationNotes,
			error: ReleasePreparationError
		},
		{
			name: 'duplicate pending headings',
			version: 'v1.2.3',
			workflow: preparationWorkflow,
			notes: preparationNotes + '\n## Next release\n',
			error: ReleasePreparationError
		},
		{
			name: 'existing selected heading',
			version: 'v1.2.3',
			workflow: preparationWorkflow,
			notes: preparationNotes + '\n## v1.2.3\n',
			error: ReleasePreparationError
		}
	])(
		'rejects $name before writing preparation files',
		async ({ version, workflow, notes, error }) => {
			const directory = await releaseFixture(workflow, notes);
			try {
				const before = await fixtureSources(directory);
				await expect(
					prepareAction({ VERSION: version, REPOSITORY_DIRECTORY: directory })
				).rejects.toThrow(error);
				expect(await fixtureSources(directory)).toStrictEqual(before);
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		}
	);

	it('checks the prepared files and resolves the matching release from the workflow commit', async () => {
		const directory = await releaseFixture();
		try {
			await prepareAction({
				VERSION: 'v1.2.3',
				REPOSITORY_DIRECTORY: directory
			});
			await checkPreparationAction({
				VERSION: 'v1.2.3',
				REPOSITORY_DIRECTORY: directory
			});
			const sources = await fixtureSources(directory);
			const document = parseDocument(sources.workflow);
			const uses = document.getIn(['jobs', 'publish', 'uses']);
			const override = document.getIn([
				'jobs',
				'publish',
				'with',
				'cupboard-version'
			]);
			if (typeof uses !== 'string' || override !== undefined) {
				throw new Error('Expected a prepared workflow without a CLI override');
			}
			const workflowSha = 'a'.repeat(40);
			const release = await resolveCupboard(
				{
					includePrereleases: true,
					releaseRepository: 'underwhelmingperformance/cupboard',
					githubToken: '',
					workflowSha,
					workflowRef: uses.replace('@v1.2.3', '@refs/tags/v1.2.3')
				},
				{
					releaseDiscoveryPage: () =>
						Promise.resolve({
							data: {
								repository: {
									releases: {
										nodes: [
											{
												tagName: 'v1.2.3',
												isDraft: false,
												tagCommit: { oid: workflowSha }
											},
											{
												tagName: 'v1.2.2',
												isDraft: false,
												tagCommit: { oid: workflowSha }
											}
										],
										pageInfo: { hasNextPage: false, endCursor: 'last-page' }
									}
								}
							}
						})
				}
			);
			expect({ release, override }).toStrictEqual({
				release: {
					kind: 'release',
					repository: 'underwhelmingperformance/cupboard',
					tag: 'v1.2.3',
					sourceCommit: workflowSha
				},
				override: undefined
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it('prepares a release without new upgrade instructions without changing historical notes', async () => {
		const directory = await releaseFixture(
			preparationWorkflow,
			'# Upgrade notes\n\n## v1.0.0\n\nEarlier notes.\n'
		);
		try {
			const before = await fixtureSources(directory);
			await prepareAction({
				VERSION: 'v1.2.3',
				REPOSITORY_DIRECTORY: directory
			});
			expect(await fixtureSources(directory)).toStrictEqual({
				...before,
				workflow: preparedWorkflow
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});

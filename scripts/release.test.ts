import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
	NixPublicKey,
	parsePublishedNixPublicKeys
} from '@cupboard/nix-store/public-key';
import { parseBaseUrl } from '@cupboard/nix-store/url';
import { StatusCodes } from 'http-status-codes';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { parse } from 'yaml';
import { z } from 'zod';

import { isolateGitEnvironment } from '../tests/support/git.ts';

import { releaseAssetNameFor } from './build-cupboard-binary.ts';
import {
	assertCanonicalVersion,
	assetContentType,
	checksumsAction,
	createDraftBody,
	fetchCachePublicKeys,
	matchReleaseFiles,
	MissingInputError,
	NonCanonicalVersionError,
	PublicKeyFetchError,
	publishAction,
	releaseArchiveNames,
	ReleaseAssetMismatchError,
	releaseAssetNames,
	renderChecksums,
	selectDraftRelease,
	substituterSection,
	updateDraftBody
} from './release.ts';

const matrixEntrySchema = z.object({
	'asset-platform': z.enum(['linux', 'macos']),
	'asset-arch': z.string()
});
const stepSchema = z.object({
	uses: z.string().optional(),
	with: z.record(z.string(), z.unknown()).optional()
});
const matrixSchema = z.object({ include: z.array(matrixEntrySchema) });
const buildJobSchema = z.object({
	strategy: z.object({ matrix: matrixSchema })
});
const draftJobSchema = z.object({ steps: z.array(stepSchema) });
const releaseWorkflowSchema = z.object({
	jobs: z.object({ build: buildJobSchema, draft: draftJobSchema })
});
const runtimePlatforms = { linux: 'linux', macos: 'darwin' } as const;

async function loadReleaseWorkflow() {
	const workflowFile = new URL(
		'../.github/workflows/release.yml',
		import.meta.url
	);
	const document: unknown = parse(await readFile(workflowFile, 'utf8'));

	return releaseWorkflowSchema.parse(document);
}

function archiveNameFor(entry: z.infer<typeof matrixEntrySchema>): string {
	return releaseAssetNameFor(
		runtimePlatforms[entry['asset-platform']],
		entry['asset-arch']
	);
}

async function listDirectory(directory: string): Promise<string[]> {
	const names = await readdir(directory);

	return names.toSorted((left, right) => left.localeCompare(right));
}

const diagnosticLog =
	'process-1338-d0dd32ae-a269-4c71-a8a8-bf6f9989f405.jsonl.zst';

/**
Creates a temporary directory with one file for each name. Each file
contains its own name.
*/
async function createAssetDirectory(
	assetNames: readonly string[]
): Promise<string> {
	const directory = await mkdtemp(path.join(tmpdir(), 'release-assets-'));
	onTestFinished(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	for (const name of assetNames) {
		await writeFile(path.join(directory, name), name);
	}

	return directory;
}

async function captureError<T>(
	type: new (...parameters: never[]) => T,
	action: () => unknown
): Promise<T> {
	try {
		await action();
	} catch (error) {
		if (error instanceof type) {
			return error;
		}

		throw error;
	}

	throw new TypeError('expected the call to throw');
}

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

describe('release archive names', () => {
	it('match the archives that the release workflow builds and downloads', async () => {
		const workflow = await loadReleaseWorkflow();
		const builtArchives = workflow.jobs.build.strategy.matrix.include
			.map((entry) => archiveNameFor(entry))
			.toSorted((left, right) => left.localeCompare(right));
		const download = workflow.jobs.draft.steps.find((step) =>
			step.uses?.startsWith('actions/download-artifact@')
		);

		expect({ builtArchives, download: download?.with }).toStrictEqual({
			builtArchives: releaseArchiveNames,
			download: {
				path: 'dist/assets',
				pattern: 'cupboard-*.tar.gz',
				'merge-multiple': true
			}
		});
	});
});

describe('checksumsAction', () => {
	it('writes the archive checksums again when checksums.txt already exists', async () => {
		const directory = await createAssetDirectory(releaseArchiveNames);

		await checksumsAction({ DIRECTORY: directory });
		await checksumsAction({ DIRECTORY: directory });

		expect({
			files: await listDirectory(directory),
			checksums: await readFile(path.join(directory, 'checksums.txt'), 'utf8')
		}).toStrictEqual({
			files: releaseAssetNames,
			checksums: renderChecksums(
				releaseArchiveNames.map((name) => ({
					name,
					sha256: createHash('sha256').update(name).digest('hex')
				}))
			)
		});
	});

	it('refuses a diagnostic log and writes no checksums', async () => {
		const directory = await createAssetDirectory([
			...releaseArchiveNames,
			diagnosticLog
		]);

		const error = await captureError(ReleaseAssetMismatchError, () =>
			checksumsAction({ DIRECTORY: directory })
		);

		expect({
			error: { unexpected: error.unexpected, missing: error.missing },
			files: await listDirectory(directory)
		}).toStrictEqual({
			error: { unexpected: [diagnosticLog], missing: [] },
			files: [...releaseArchiveNames, diagnosticLog]
		});
	});
});

describe('matchReleaseFiles', () => {
	it('returns the expected names whatever the order of the listing', () => {
		expect(
			matchReleaseFiles(releaseArchiveNames.toReversed(), releaseArchiveNames)
		).toStrictEqual(releaseArchiveNames);
	});

	it.each([
		{
			problem: 'an extra file',
			fileNames: [...releaseArchiveNames, 'checksums.txt'],
			unexpected: ['checksums.txt'],
			missing: []
		},
		{
			problem: 'a missing archive',
			fileNames: releaseArchiveNames.slice(1),
			unexpected: [],
			missing: ['cupboard-linux-arm64.tar.gz']
		}
	])('rejects $problem', async ({ fileNames, unexpected, missing }) => {
		const error = await captureError(ReleaseAssetMismatchError, () =>
			matchReleaseFiles(fileNames, releaseArchiveNames)
		);

		expect({
			unexpected: error.unexpected,
			missing: error.missing
		}).toStrictEqual({ unexpected, missing });
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

const releaseCacheWorkflow =
	'jobs:\n  publish:\n    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@main\n    with:\n      cache: releases\n';
const releasesUrl = 'https://api.github.com/repos/acme/app/releases';

interface ReleaseFixture {
	readonly directory: string;
	readonly environment: Readonly<Record<string, string>>;
}

/**
Creates a Git repository with committed upgrade notes, an uncommitted edit
to them, and an `assets` directory with one file for each name.
*/
async function createReleaseFixture(
	assetNames: readonly string[]
): Promise<ReleaseFixture> {
	isolateGitEnvironment();
	const directory = await mkdtemp(path.join(tmpdir(), 'release-publish-'));
	onTestFinished(async () => {
		await rm(directory, { recursive: true, force: true });
	});
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
	await writeFile(
		path.join(directory, '.github/workflows/release-cache.yml'),
		releaseCacheWorkflow
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

	for (const name of assetNames) {
		await writeFile(path.join(directory, 'assets', name), name);
	}

	return {
		directory,
		environment: {
			VERSION: 'v1.2.3',
			DIRECTORY: path.join(directory, 'assets'),
			REPOSITORY_DIRECTORY: directory,
			RELEASE_REPOSITORY: 'acme/app',
			COMMITISH: commitish,
			GITHUB_TOKEN: 'test-token',
			CACHE_URL: 'https://cupboard.example/t/acme'
		}
	};
}

function draftRecord(id: number): Record<string, unknown> {
	return {
		id,
		tag_name: 'v1.2.3',
		draft: true,
		upload_url: `https://uploads.example.test/repos/acme/app/releases/${String(id)}/assets{?name,label}`,
		html_url: `https://example.test/releases/${String(id)}`,
		body: ''
	};
}

/**
Serves draft release 1 with its assets, any duplicate drafts, and the cache's
public key, and records every request.
*/
class FakeReleaseApi {
	#assets: { readonly id: number; readonly name: string }[] = [];
	#duplicates: Record<string, unknown>[] = [];
	#nextAssetId = 1;
	draft: Record<string, unknown> | undefined;
	readonly requests: string[] = [];

	readonly fetch: typeof fetch = async (input, init) => {
		const request = new Request(input, init);
		const url = new URL(request.url);
		this.requests.push(request.method + ' ' + request.url);

		if (url.pathname.endsWith('/pubkey')) {
			return new Response(firstKey);
		}

		if (url.hostname === 'uploads.example.test') {
			this.#attach(url.searchParams.get('name') ?? '');
			return Response.json({}, { status: StatusCodes.CREATED });
		}

		if (request.method === 'GET') {
			return Response.json([
				...(this.draft === undefined
					? []
					: [{ ...this.draft, assets: this.#assets }]),
				...this.#duplicates.map((duplicate) => ({ ...duplicate, assets: [] }))
			]);
		}

		if (request.method === 'DELETE') {
			const id = Number(url.pathname.split('/').at(-1));
			this.#assets = this.#assets.filter((asset) => asset.id !== id);
			this.#duplicates = this.#duplicates.filter(
				(duplicate) => duplicate.id !== id
			);
			return new Response(undefined, { status: StatusCodes.NO_CONTENT });
		}

		const body: unknown = await request.json();
		if (typeof body !== 'object' || body === null || !('body' in body)) {
			throw new Error('Expected release body');
		}
		this.draft = { ...draftRecord(1), ...body };
		return Response.json({ ...this.draft, assets: this.#assets });
	};

	constructor() {
		vi.stubGlobal('fetch', this.fetch);
		onTestFinished(() => {
			vi.unstubAllGlobals();
		});
	}

	#attach(name: string): void {
		this.#assets.push({ id: this.#nextAssetId, name });
		this.#nextAssetId += 1;
	}

	/**
	The names of the assets on draft 1, in upload order.
	*/
	get assetNames(): string[] {
		return this.#assets.map((asset) => asset.name);
	}

	/**
	Creates draft 1 with the named assets, and a duplicate draft with id 100 if
	`hasDuplicate` is true.
	*/
	seedDraft(assetNames: readonly string[], hasDuplicate = false): void {
		this.draft = draftRecord(1);

		for (const name of assetNames) {
			this.#attach(name);
		}

		if (hasDuplicate) {
			this.#duplicates.push(draftRecord(100));
		}
	}
}

function uploadRequest(name: string): string {
	return `POST https://uploads.example.test/repos/acme/app/releases/1/assets?name=${name}&`;
}

it('publishes without preparation from the exact commit and preserves draft edits on retry', async () => {
	const fixture = await createReleaseFixture(releaseAssetNames);
	const api = new FakeReleaseApi();

	await publishAction(fixture.environment);
	if (api.draft === undefined || typeof api.draft.body !== 'string') {
		throw new Error('Expected created draft');
	}
	const firstBody = api.draft.body;
	api.draft.body =
		'Maintainer introduction.\n\n' +
		firstBody +
		'\n\nGenerated GitHub notes.\nMaintainer follow-up.';
	await publishAction(fixture.environment);

	expect({
		body: api.draft.body,
		workflow: await readFile(
			path.join(fixture.directory, '.github/workflows/release-cache.yml'),
			'utf8'
		),
		requests: api.requests
	}).toStrictEqual({
		body:
			'Maintainer introduction.\n\n' +
			firstBody +
			'\n\nGenerated GitHub notes.\nMaintainer follow-up.',
		workflow: releaseCacheWorkflow,
		requests: [
			`GET ${releasesUrl}?page=1&per_page=100`,
			'GET https://cupboard.example/t/acme/pubkey',
			`POST ${releasesUrl}`,
			...releaseAssetNames.map((name) => uploadRequest(name)),
			`GET ${releasesUrl}?page=1&per_page=100`,
			'GET https://cupboard.example/t/acme/pubkey',
			`PATCH ${releasesUrl}/1`,
			...releaseAssetNames.flatMap((name, index) => [
				`DELETE ${releasesUrl}/assets/${String(index + 1)}`,
				uploadRequest(name)
			])
		]
	});
});

it.each([
	{ releases: 'no draft exists', existingDraft: false },
	{ releases: 'a draft and a duplicate draft exist', existingDraft: true }
])(
	'changes no release when the asset directory has a diagnostic log and $releases',
	async ({ existingDraft }) => {
		const fixture = await createReleaseFixture([
			...releaseAssetNames,
			diagnosticLog
		]);
		const api = new FakeReleaseApi();
		if (existingDraft) {
			api.seedDraft(releaseAssetNames, true);
		}

		const error = await captureError(ReleaseAssetMismatchError, () =>
			publishAction(fixture.environment)
		);

		expect({
			error: { unexpected: error.unexpected, missing: error.missing },
			requests: api.requests
		}).toStrictEqual({
			error: { unexpected: [diagnosticLog], missing: [] },
			requests: [
				`GET ${releasesUrl}?page=1&per_page=100`,
				'GET https://cupboard.example/t/acme/pubkey'
			]
		});
	}
);

it('deletes draft assets that are not release assets when it updates a draft', async () => {
	const fixture = await createReleaseFixture(releaseAssetNames);
	const api = new FakeReleaseApi();
	api.seedDraft(['checksums.txt', diagnosticLog]);

	await publishAction(fixture.environment);

	expect({ requests: api.requests, assets: api.assetNames }).toStrictEqual({
		requests: [
			`GET ${releasesUrl}?page=1&per_page=100`,
			'GET https://cupboard.example/t/acme/pubkey',
			`PATCH ${releasesUrl}/1`,
			`DELETE ${releasesUrl}/assets/2`,
			`DELETE ${releasesUrl}/assets/1`,
			...releaseAssetNames.map((name) => uploadRequest(name))
		],
		assets: releaseAssetNames
	});
});

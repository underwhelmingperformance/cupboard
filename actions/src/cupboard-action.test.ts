import { createHash, createPublicKey } from 'node:crypto';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { NixValidPathInfo } from '@cupboard/nix';
import { NixSha256Hash } from '@cupboard/nix-store/hash';
import { createOctokitClient } from '@cupboard/shared/octokit';
import {
	AttestationPredicateTypeMismatchError,
	AttestationSubjectMismatchError,
	type VerifiedBundle
} from '@cupboard/shared/sigstore';
import { describe, expect, it } from 'vitest';

import {
	assetNameFor,
	attestationSubjects,
	attestInputs,
	buildPushArguments,
	cachePublicKeyRequestHeaders,
	cachePublicKeyUrl,
	cacheUrlFor,
	dispatch,
	fetchRelease,
	normaliseVersion,
	parseChecksums,
	parseLines,
	pushInputs,
	releaseWorkflowIdentityRegex,
	renderChecksums,
	setupAction,
	setupInputs,
	splitRepository,
	verifyReleaseAttestation,
	writeNetrc
} from './cupboard-action.ts';
import {
	AttestationNotFoundError,
	AttestationSourceMismatchError,
	AttestationVerificationFailedError,
	InvalidInputError,
	MalformedReleaseResponseError,
	MissingInputError,
	NoReleaseFoundError,
	UnknownCommandError,
	UnsupportedPlatformError
} from './errors.ts';

describe('normaliseVersion', () => {
	it.each([
		['latest', 'latest'],
		['1.2.3', 'v1.2.3'],
		['v1.2.3', 'v1.2.3'],
		['v1.2.3-rc.1', 'v1.2.3-rc.1'],
		[' v1.2.3 ', 'v1.2.3']
	])('normalises %s', (version, expected) => {
		expect(normaliseVersion(version)).toBe(expected);
	});

	it.each([['  '], ['v'], ['v1'], ['1.2'], ['garbage'], ['v01.2.3']])(
		'rejects %s',
		(version) => {
			expect(() => normaliseVersion(version)).toThrow(InvalidInputError);
		}
	);
});

describe('splitRepository', () => {
	it('splits a single owner and name', () => {
		expect(splitRepository('owner/repo')).toStrictEqual(['owner', 'repo']);
	});

	it.each([
		['owner/repo/extra'],
		['owner repo'],
		['owner/'],
		['/repo'],
		['ownerrepo'],
		['https://github.com/owner/repo']
	])('rejects %s', (repository) => {
		expect(() => splitRepository(repository)).toThrow(InvalidInputError);
	});
});

describe('assetNameFor', () => {
	it.each([
		['darwin', 'arm64', 'cupboard-v1.2.3-macos-arm64.tar.gz'],
		['darwin', 'x64', 'cupboard-v1.2.3-macos-x64.tar.gz'],
		['linux', 'arm64', 'cupboard-v1.2.3-linux-arm64.tar.gz'],
		['linux', 'x64', 'cupboard-v1.2.3-linux-x64.tar.gz']
	])(
		'builds the asset name for %s %s',
		(runtimePlatform, runtimeArchitecture, expected) => {
			expect(assetNameFor('v1.2.3', runtimePlatform, runtimeArchitecture)).toBe(
				expected
			);
		}
	);
});

describe('parseLines', () => {
	it('parses newline-delimited inputs', () => {
		expect(parseLines('/nix/store/a\n\n /nix/store/b \r\n')).toStrictEqual([
			'/nix/store/a',
			'/nix/store/b'
		]);
	});
});

describe('parseChecksums', () => {
	it('parses sha256sum output', () => {
		expect(
			Object.fromEntries(
				parseChecksums(
					'0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef  cupboard-v1.2.3-linux-x64.tar.gz\n'
				)
			)
		).toStrictEqual({
			'cupboard-v1.2.3-linux-x64.tar.gz':
				'0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
		});
	});
});

describe('renderChecksums', () => {
	it('renders sha256sum lines that parseChecksums round-trips', () => {
		const rendered = renderChecksums([
			{
				storePath: '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app',
				sha256:
					'1111111111111111111111111111111111111111111111111111111111111111'
			},
			{
				storePath: '/nix/store/3123456789abcdfghijklmnpqrsvwxyz-runtime',
				sha256:
					'2222222222222222222222222222222222222222222222222222222222222222'
			}
		]);

		expect(rendered).toBe(
			'1111111111111111111111111111111111111111111111111111111111111111  0123456789abcdfghijklmnpqrsvwxyz-app\n' +
				'2222222222222222222222222222222222222222222222222222222222222222  3123456789abcdfghijklmnpqrsvwxyz-runtime\n'
		);
		expect(Object.fromEntries(parseChecksums(rendered))).toStrictEqual({
			'0123456789abcdfghijklmnpqrsvwxyz-app':
				'1111111111111111111111111111111111111111111111111111111111111111',
			'3123456789abcdfghijklmnpqrsvwxyz-runtime':
				'2222222222222222222222222222222222222222222222222222222222222222'
		});
	});
});

function attestPathInfo(
	storePath: string,
	digestByte: number,
	isUltimate: boolean
): NixValidPathInfo {
	return {
		storePath,
		narHash: NixSha256Hash.fromDigest(Buffer.alloc(32, digestByte)),
		narSize: 1,
		references: [],
		signatures: isUltimate ? [] : ['cache-1:signature'],
		ultimate: isUltimate
	};
}

describe('attestationSubjects', () => {
	const builtPath = '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app';
	const substitutedPath = '/nix/store/3123456789abcdfghijklmnpqrsvwxyz-lib';

	it('emits subjects for built paths and skips substituted ones', () => {
		const partitioned = attestationSubjects([
			attestPathInfo(builtPath, 0xaa, true),
			attestPathInfo(substitutedPath, 0xbb, false)
		]);

		expect(partitioned).toStrictEqual({
			subjects: [{ storePath: builtPath, sha256: 'aa'.repeat(32) }],
			skipped: [substitutedPath]
		});
	});

	it('emits no subjects when every path was substituted', () => {
		const partitioned = attestationSubjects([
			attestPathInfo(builtPath, 0xaa, false),
			attestPathInfo(substitutedPath, 0xbb, false)
		]);

		expect(partitioned).toStrictEqual({
			subjects: [],
			skipped: [builtPath, substitutedPath]
		});
	});
});

describe('cacheUrlFor', () => {
	it.each([
		['https://cache.example.test/', '', 'https://cache.example.test'],
		['https://cache.example.test', 'ci', 'https://cache.example.test/cache/ci']
	])('builds a substituter URL', (baseUrl, cache, expected) => {
		expect(cacheUrlFor(baseUrl, cache)).toBe(expected);
	});
});

describe('cachePublicKeyUrl', () => {
	it.each([
		[
			'https://cache.example.test/t/acme',
			'https://cache.example.test/t/acme/pubkey'
		],
		[
			'https://cache.example.test/t/acme/',
			'https://cache.example.test/t/acme/pubkey'
		],
		['https://cache.example.test', 'https://cache.example.test/pubkey']
	])('keeps the tenant path for %s', (cacheUrl, expected) => {
		expect(cachePublicKeyUrl(cacheUrl)).toBe(expected);
	});
});

describe('cachePublicKeyRequestHeaders', () => {
	it('does not include GitHub authentication headers', () => {
		expect(cachePublicKeyRequestHeaders()).toStrictEqual({
			accept: 'text/plain',
			'user-agent': 'cupboard-action'
		});
	});
});

describe('buildPushArguments', () => {
	it('builds a GitHub OIDC push invocation', () => {
		expect(
			buildPushArguments({
				url: 'https://cache.example.test',
				paths: ['/nix/store/a', '/nix/store/b'],
				audience: '',
				root: 'github:owner/repo/main',
				cache: 'ci',
				ttl: '7d',
				wait: true,
				waitTimeout: '10m',
				attestations: ['/tmp/a.json', '/tmp/b.json']
			})
		).toStrictEqual([
			'--no-colour',
			'push',
			'https://cache.example.test',
			'/nix/store/a',
			'/nix/store/b',
			'--github-oidc',
			'--audience',
			'https://cache.example.test',
			'--root',
			'github:owner/repo/main',
			'--cache',
			'ci',
			'--ttl',
			'7d',
			'--wait-timeout',
			'10m',
			'--attestation',
			'/tmp/a.json',
			'--attestation',
			'/tmp/b.json'
		]);
	});
});

describe('releaseWorkflowIdentityRegex', () => {
	it('matches the release workflow on any ref but no other workflow', () => {
		const regex = new RegExp(releaseWorkflowIdentityRegex('owner/repo'));
		const base = 'https://github.com/owner/repo/.github/workflows';

		expect({
			main: regex.test(`${base}/release.yml@refs/heads/main`),
			tag: regex.test(`${base}/release.yml@refs/tags/v1.0.0`),
			other: regex.test(`${base}/evil.yml@refs/heads/main`)
		}).toStrictEqual({ main: true, tag: true, other: false });
	});
});

const attestationTagCommit = 'a'.repeat(40);
const attestationOptions = {
	releaseRepository: 'owner/repo',
	version: 'v1.0.0',
	includePrereleases: false,
	githubToken: '',
	environment: {}
};

function attestationInputUrl(input: string | URL | Request): string {
	if (typeof input === 'string') {
		return input;
	}

	if (input instanceof URL) {
		return input.href;
	}

	return input.url;
}

async function writeArchive(): Promise<{
	readonly path: string;
	readonly digest: string;
}> {
	const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-attest-'));
	const archivePath = path.join(directory, 'cupboard.tar.gz');
	const bytes = new Uint8Array([1, 2, 3]);

	await writeFile(archivePath, bytes);

	return {
		path: archivePath,
		digest: createHash('sha256').update(bytes).digest('hex')
	};
}

function stubAttestationFetch(attestations: unknown[]): typeof fetch {
	return (input) => {
		const url = attestationInputUrl(input);

		if (url.includes('/commits/v1.0.0')) {
			return Promise.resolve(Response.json({ sha: attestationTagCommit }));
		}

		if (url.includes('/attestations/')) {
			return Promise.resolve(Response.json({ attestations }));
		}

		return Promise.resolve(new Response('not found', { status: 404 }));
	};
}

function verifiedAs(digest: string, commit: string): VerifiedBundle {
	return {
		signer: {
			key: createPublicKey({
				key: Buffer.from(
					'MCowBQYDK2VwAyEA74apN5wWAk7Q7yJ1hzf0EMHdcmIRanVgF1Xqz+VpOl8=',
					'base64'
				),
				format: 'der',
				type: 'spki'
			})
		},
		predicateType: 'https://slsa.dev/provenance/v1',
		subjectDigests: [digest],
		predicate: {
			buildDefinition: {
				resolvedDependencies: [
					{
						uri: 'git+https://github.com/owner/repo@refs/heads/main',
						digest: { gitCommit: commit }
					}
				]
			}
		},
		signedTimestampCount: 0,
		tlogEntries: []
	};
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;

		return undefined;
	} catch (error: unknown) {
		return error;
	}
}

describe('verifyReleaseAttestation', () => {
	it('accepts a bundle built by the release workflow from the tag commit', async () => {
		const archive = await writeArchive();

		await expect(
			verifyReleaseAttestation(attestationOptions, archive.path, 'v1.0.0', {
				fetch: stubAttestationFetch([{ bundle: {} }]),
				verify: () =>
					Promise.resolve(verifiedAs(archive.digest, attestationTagCommit))
			})
		).resolves.toBeUndefined();
	});

	it('rejects a bundle built from a different commit', async () => {
		const archive = await writeArchive();
		const error = await rejectionOf(
			verifyReleaseAttestation(attestationOptions, archive.path, 'v1.0.0', {
				fetch: stubAttestationFetch([{ bundle: {} }]),
				verify: () =>
					Promise.resolve(verifiedAs(archive.digest, 'b'.repeat(40)))
			})
		);

		expect(error).toBeInstanceOf(AttestationVerificationFailedError);

		if (!(error instanceof AttestationVerificationFailedError)) {
			throw error;
		}

		expect(error.cause).toBeInstanceOf(AttestationSourceMismatchError);
	});

	it('rejects when there is no attestation', async () => {
		const archive = await writeArchive();

		await expect(
			verifyReleaseAttestation(attestationOptions, archive.path, 'v1.0.0', {
				fetch: stubAttestationFetch([])
			})
		).rejects.toThrow(AttestationNotFoundError);
	});

	it('accepts a later bundle after an earlier one fails to verify', async () => {
		const archive = await writeArchive();
		let calls = 0;

		await expect(
			verifyReleaseAttestation(attestationOptions, archive.path, 'v1.0.0', {
				fetch: stubAttestationFetch([
					{ bundle: { n: 1 } },
					{ bundle: { n: 2 } }
				]),
				verify: () => {
					calls += 1;

					return calls === 1
						? Promise.reject(new Error('untrusted signer'))
						: Promise.resolve(verifiedAs(archive.digest, attestationTagCommit));
				}
			})
		).resolves.toBeUndefined();
	});

	it('rejects a bundle whose subject does not match the archive', async () => {
		const archive = await writeArchive();
		const error = await rejectionOf(
			verifyReleaseAttestation(attestationOptions, archive.path, 'v1.0.0', {
				fetch: stubAttestationFetch([{ bundle: {} }]),
				verify: () =>
					Promise.resolve(verifiedAs('f'.repeat(64), attestationTagCommit))
			})
		);

		expect(error).toBeInstanceOf(AttestationVerificationFailedError);

		if (!(error instanceof AttestationVerificationFailedError)) {
			throw error;
		}

		expect(error.cause).toBeInstanceOf(AttestationSubjectMismatchError);
	});

	it('rejects a bundle with the wrong predicate type', async () => {
		const archive = await writeArchive();
		const error = await rejectionOf(
			verifyReleaseAttestation(attestationOptions, archive.path, 'v1.0.0', {
				fetch: stubAttestationFetch([{ bundle: {} }]),
				verify: () =>
					Promise.resolve({
						...verifiedAs(archive.digest, attestationTagCommit),
						predicateType: 'https://example.test/other'
					})
			})
		);

		expect(error).toBeInstanceOf(AttestationVerificationFailedError);

		if (!(error instanceof AttestationVerificationFailedError)) {
			throw error;
		}

		expect(error.cause).toBeInstanceOf(AttestationPredicateTypeMismatchError);
	});
});

function octokitFor(
	handler: (url: URL) => unknown
): ReturnType<typeof createOctokitClient> {
	const fetcher: typeof fetch = (input) => {
		const url = new URL(attestationInputUrl(input));

		return Promise.resolve(Response.json(handler(url)));
	};

	return createOctokitClient({ request: { fetch: fetcher } });
}

describe('fetchRelease', () => {
	const base = { releaseRepository: 'owner/repo' };

	it('installs the newest non-draft release when prereleases are allowed', async () => {
		const release = await fetchRelease(
			octokitFor((url) => {
				expect(url.pathname).toBe('/repos/owner/repo/releases');

				return [
					{ draft: true, tag_name: 'v9.9.9-draft', assets: [] },
					{
						draft: false,
						tag_name: 'v0.0.2',
						assets: [{ name: 'a', url: 'u' }]
					}
				];
			}),
			{ ...base, version: 'latest', includePrereleases: true }
		);

		expect(release).toStrictEqual({
			tagName: 'v0.0.2',
			assets: [{ name: 'a', url: 'u' }]
		});
	});

	it('installs the stable release when prereleases are excluded', async () => {
		const release = await fetchRelease(
			octokitFor((url) => {
				expect(url.pathname).toBe('/repos/owner/repo/releases/latest');

				return { tag_name: 'v1.0.0', assets: [] };
			}),
			{ ...base, version: 'latest', includePrereleases: false }
		);

		expect(release.tagName).toBe('v1.0.0');
	});

	it('installs a specific tag regardless of the prerelease setting', async () => {
		const release = await fetchRelease(
			octokitFor((url) => {
				expect(url.pathname).toBe('/repos/owner/repo/releases/tags/v1.2.3');

				return { tag_name: 'v1.2.3', assets: [] };
			}),
			{ ...base, version: 'v1.2.3', includePrereleases: true }
		);

		expect(release.tagName).toBe('v1.2.3');
	});

	it('rejects when only draft releases exist', async () => {
		await expect(
			fetchRelease(
				octokitFor(() => [{ draft: true, tag_name: 'v1', assets: [] }]),
				{ ...base, version: 'latest', includePrereleases: true }
			)
		).rejects.toThrow(NoReleaseFoundError);
	});

	it('rejects a malformed release response', async () => {
		await expect(
			fetchRelease(
				octokitFor(() => ({ unexpected: true })),
				{
					...base,
					version: 'v1.2.3',
					includePrereleases: false
				}
			)
		).rejects.toThrow(MalformedReleaseResponseError);
	});
});

describe('dispatch', () => {
	it.each([['frobnicate'], ['']])(
		'rejects the unknown command %p',
		async (command) => {
			await expect(dispatch(command, {})).rejects.toThrow(UnknownCommandError);
		}
	);

	it('rejects a missing command', async () => {
		await expect(dispatch(undefined, {})).rejects.toThrow(UnknownCommandError);
	});
});

describe('writeNetrc', () => {
	it('writes a private netrc file scoped to the cache host', async () => {
		const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-netrc-'));
		const netrcFile = await writeNetrc({
			cacheUrl: 'https://cache.example.test/t/acme',
			readUser: 'ci',
			readPassword: 'secret',
			runnerTemporaryDirectory: directory
		});
		const stats = await stat(netrcFile);

		expect({
			contents: await readFile(netrcFile, 'utf8'),
			mode: stats.mode & 0o777
		}).toStrictEqual({
			contents: 'machine cache.example.test login ci password secret\n',
			mode: 0o600
		});
	});
});

describe('action input errors', () => {
	it('rejects an unsupported platform', () => {
		expect(() => assetNameFor('v1.2.3', 'sunos', 'sparc')).toThrow(
			UnsupportedPlatformError
		);
	});

	it.each([
		['read-user is supplied without read-password', { READ_USER: 'ci' }],
		[
			'read-password is supplied without read-user',
			{ READ_PASSWORD: 'secret' }
		],
		['cache-url is not an http(s) URL', { CACHE_URL: 'not a url' }]
	])('rejects when %s', async (_name, environment) => {
		await expect(setupAction(environment)).rejects.toThrow(InvalidInputError);
	});
});

describe('attestInputs', () => {
	const paths = '/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-foo';

	it('defaults the checksums file under RUNNER_TEMP when none is given', () => {
		const inputs = attestInputs({
			INPUT_PATHS: paths,
			INPUT_CHECKSUMS_FILE: '',
			RUNNER_TEMP: '/runner/temp'
		});

		expect(inputs).toStrictEqual({
			paths: [paths],
			checksumsFile: '/runner/temp/cupboard-attestations/subjects.txt'
		});
	});

	it('honours an explicit checksums file', () => {
		const inputs = attestInputs({
			INPUT_PATHS: paths,
			INPUT_CHECKSUMS_FILE: '/somewhere/subjects.txt',
			RUNNER_TEMP: '/runner/temp'
		});

		expect(inputs).toStrictEqual({
			paths: [paths],
			checksumsFile: '/somewhere/subjects.txt'
		});
	});

	it('requires at least one path', () => {
		expect(() =>
			attestInputs({ INPUT_PATHS: '', RUNNER_TEMP: '/runner/temp' })
		).toThrow(InvalidInputError);
	});

	it('does not require RUNNER_TEMP when the checksums file is explicit', () => {
		const inputs = attestInputs({
			INPUT_PATHS: paths,
			INPUT_CHECKSUMS_FILE: '/explicit/subjects.txt'
		});

		expect(inputs.checksumsFile).toBe('/explicit/subjects.txt');
	});
});

describe('setupInputs', () => {
	const baseEnvironment = {
		RUNNER_TEMP: '/runner/temp',
		GITHUB_ACTION_REPOSITORY: 'owner/cupboard'
	};

	const defaults = {
		version: 'latest',
		includePrereleases: true,
		githubToken: '',
		releaseRepository: 'owner/cupboard',
		installDirectory: '/runner/temp/cupboard-bin',
		addToPath: true,
		cacheUrl: '',
		cache: '',
		trustedPublicKey: '',
		readUser: '',
		readPassword: '',
		nixConfigFile: ''
	};

	it('applies defaults when optional inputs are absent', () => {
		expect(setupInputs(baseEnvironment)).toStrictEqual(defaults);
	});

	it('treats blank inputs as unset and applies the defaults', () => {
		const blanked = {
			...baseEnvironment,
			INPUT_CUPBOARD_VERSION: '  ',
			INPUT_INSTALL_DIR: '',
			INPUT_INCLUDE_PRERELEASES: '',
			INPUT_ADD_TO_PATH: ' '
		};

		expect(setupInputs(blanked)).toStrictEqual(defaults);
	});

	it('does not require RUNNER_TEMP when install-dir is explicit', () => {
		const inputs = setupInputs({
			GITHUB_ACTION_REPOSITORY: 'owner/cupboard',
			INPUT_INSTALL_DIR: '/opt/cupboard'
		});

		expect(inputs.installDirectory).toBe('/opt/cupboard');
	});
});

describe('pushInputs', () => {
	const url = 'https://cupboard.example/t/acme';
	const storePath = '/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-foo';

	const baseEnvironment = {
		INPUT_URL: url,
		INPUT_PATHS: storePath,
		GITHUB_REPOSITORY: 'owner/repo',
		GITHUB_REF_NAME: 'main',
		GITHUB_ACTION_REPOSITORY: 'owner/cupboard',
		RUNNER_TEMP: '/runner/temp'
	};

	const defaults = {
		version: 'latest',
		includePrereleases: true,
		githubToken: '',
		releaseRepository: 'owner/cupboard',
		installDirectory: '/runner/temp/cupboard-bin',
		url,
		paths: [storePath],
		cache: '',
		audience: url,
		root: 'github:owner/repo/main',
		ttl: '',
		wait: true,
		waitTimeout: '10m',
		attestations: []
	};

	it('applies defaults when optional inputs are absent', () => {
		expect(pushInputs(baseEnvironment)).toStrictEqual(defaults);
	});

	it('treats blank inputs as unset and applies the defaults', () => {
		const blanked = {
			...baseEnvironment,
			INPUT_AUDIENCE: '',
			INPUT_ROOT: ' ',
			INPUT_WAIT: '',
			INPUT_WAIT_TIMEOUT: '  '
		};

		expect(pushInputs(blanked)).toStrictEqual(defaults);
	});

	it('does not require git refs when root is explicit', () => {
		const inputs = pushInputs({
			INPUT_URL: url,
			INPUT_PATHS: storePath,
			INPUT_ROOT: 'github:explicit/root',
			GITHUB_ACTION_REPOSITORY: 'owner/cupboard',
			RUNNER_TEMP: '/runner/temp'
		});

		expect(inputs.root).toBe('github:explicit/root');
	});

	it.each([
		[
			'url is missing',
			{ INPUT_PATHS: storePath, RUNNER_TEMP: '/runner/temp' },
			MissingInputError
		],
		[
			'paths is empty',
			{ INPUT_URL: url, INPUT_PATHS: '  ', RUNNER_TEMP: '/runner/temp' },
			InvalidInputError
		]
	])('rejects when %s', (_name, environment, error) => {
		expect(() => pushInputs(environment)).toThrow(error);
	});
});

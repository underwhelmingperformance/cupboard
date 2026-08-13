import { spawnSync } from 'node:child_process';
import { createHash, createPublicKey } from 'node:crypto';
import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rename as renameFile,
	stat,
	writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createOctokitClient } from '@cupboard/shared/octokit';
import {
	AttestationPredicateTypeMismatchError,
	AttestationSubjectMismatchError,
	type VerifiedBundle
} from '@cupboard/shared/sigstore';
import { describe, expect, it } from 'vitest';

import {
	AttestationNotFoundError,
	AttestationSourceMismatchError,
	AttestationVerificationFailedError,
	InstalledReleaseVersionMismatchError,
	InvalidInputError,
	MalformedReleaseResponseError,
	NoReleaseFoundError,
	ReleaseCoordinateMismatchError,
	ReleaseInstallationIncompleteError,
	UnsupportedPlatformError
} from './errors.ts';
import {
	assertExpectedSourceCommit,
	assertInstalledReleaseVersion,
	assetNameFor,
	assetNamesFor,
	expectedSourceCommitFor,
	fetchRelease,
	normaliseVersion,
	parseChecksums,
	prepareReleaseExecutable,
	publishReleaseArchive,
	releaseAssetFor,
	releaseWorkflowIdentityRegex,
	splitRepository,
	verifyReleaseAttestation
} from './release-install.ts';

describe('normaliseVersion', () => {
	it.each([
		['latest', 'latest'],
		['1.2.3', '1.2.3'],
		['v1.2.3', 'v1.2.3'],
		['v1.2.3-rc.1', 'v1.2.3-rc.1'],
		[' v1.2.3 ', 'v1.2.3'],
		[' production ', 'production']
	])('normalises %s', (version, expected) => {
		expect(normaliseVersion(version)).toBe(expected);
	});

	it('rejects a blank selector', () => {
		expect(() => normaliseVersion('  ')).toThrow(InvalidInputError);
	});
});

describe('expectedSourceCommitFor', () => {
	it('normalises a full commit for an exact release', () => {
		expect(expectedSourceCommitFor('v1.2.3', 'A'.repeat(40))).toBe(
			'a'.repeat(40)
		);
	});

	it('allows an action without a release coordinate', () => {
		expect(expectedSourceCommitFor('latest', undefined)).toBeUndefined();
	});

	it('accepts an arbitrary exact tag from a canonical release coordinate', () => {
		expect(expectedSourceCommitFor('production', 'A'.repeat(40))).toBe(
			'a'.repeat(40)
		);
	});

	it.each([
		['latest', 'a'.repeat(40)],
		['v1.2.3', 'short']
	])('rejects version %s with commit %s', (version, commit) => {
		expect(() => expectedSourceCommitFor(version, commit)).toThrow(
			InvalidInputError
		);
	});
});

describe('prepareReleaseExecutable', () => {
	it('makes a regular archive member executable', async () => {
		const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-release-'));
		const candidate = path.join(directory, 'cupboard-hook-relay');
		await writeFile(candidate, 'helper');

		await prepareReleaseExecutable(candidate);
		const metadata = await stat(candidate);

		expect(metadata.mode & 0o777).toBe(0o755);
	});

	it('rejects an absent archive member as an incomplete release', async () => {
		await expect(
			prepareReleaseExecutable('/missing/cupboard-hook-relay')
		).rejects.toBeInstanceOf(ReleaseInstallationIncompleteError);
	});
});

async function releaseArchive(
	members: Readonly<Record<string, string>>
): Promise<string> {
	const directory = await mkdtemp(
		path.join(tmpdir(), 'cupboard-release-archive-')
	);
	const contents = path.join(directory, 'contents');
	const archive = path.join(directory, 'cupboard.tar.gz');

	await mkdir(contents);

	for (const [name, value] of Object.entries(members)) {
		const member = path.join(contents, name);

		await writeFile(member, value);
		await chmod(member, 0o755);
	}

	const result = spawnSync('tar', ['-czf', archive, '-C', contents, '.'], {
		encoding: 'utf8'
	});

	if (result.status !== 0) {
		throw new Error(`tar failed: ${result.stderr}`);
	}

	return archive;
}

describe('publishReleaseArchive', () => {
	it('replaces stale destination executables with a complete validated release', async () => {
		const installDirectory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-release-install-')
		);
		await writeFile(path.join(installDirectory, 'cupboard'), 'stale cupboard');
		await writeFile(
			path.join(installDirectory, 'cupboard-hook-relay'),
			'stale relay'
		);
		const archive = await releaseArchive({
			cupboard: "#!/bin/sh\nprintf 'v1.2.3\\n'\n",
			'cupboard-hook-relay': "#!/bin/sh\nprintf 'fresh-relay\\n'\n"
		});

		await publishReleaseArchive(archive, installDirectory, 'v1.2.3');
		const binary = await readFile(
			path.join(installDirectory, 'cupboard'),
			'utf8'
		);
		const helper = await readFile(
			path.join(installDirectory, 'cupboard-hook-relay'),
			'utf8'
		);
		const entries = await readdir(installDirectory);

		expect({ binary, helper, entries }).toStrictEqual({
			binary: "#!/bin/sh\nprintf 'v1.2.3\\n'\n",
			helper: "#!/bin/sh\nprintf 'fresh-relay\\n'\n",
			entries: ['cupboard', 'cupboard-hook-relay']
		});
	});

	it('passes one cancellation signal to archive and version subprocesses', async () => {
		const installDirectory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-release-install-')
		);
		const archive = await releaseArchive({
			cupboard: "#!/bin/sh\nprintf 'v1.2.3\\n'\n",
			'cupboard-hook-relay': "#!/bin/sh\nprintf 'fresh-relay\\n'\n"
		});
		const controller = new AbortController();
		const signals: (AbortSignal | undefined)[] = [];

		await publishReleaseArchive(archive, installDirectory, 'v1.2.3', {
			signal: controller.signal,
			runCommand: (command, arguments_, options) => {
				signals.push(options.signal);

				if (command !== 'tar') {
					return Promise.resolve({ stdout: 'v1.2.3\n' });
				}

				const result = spawnSync(command, [...arguments_]);
				if (result.status !== 0) {
					return Promise.reject(new Error('tar failed'));
				}

				return Promise.resolve({ stdout: '' });
			}
		});

		expect(signals).toStrictEqual([controller.signal, controller.signal]);
	});

	it('rejects an incomplete archive even when the destination has a stale helper', async () => {
		const installDirectory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-release-install-')
		);
		const staleHelper = path.join(installDirectory, 'cupboard-hook-relay');
		await writeFile(staleHelper, 'stale relay');
		const archive = await releaseArchive({
			cupboard: "#!/bin/sh\nprintf 'v1.2.3\\n'\n"
		});

		await expect(
			publishReleaseArchive(archive, installDirectory, 'v1.2.3')
		).rejects.toBeInstanceOf(ReleaseInstallationIncompleteError);
		const helper = await readFile(staleHelper, 'utf8');
		const entries = await readdir(installDirectory);

		expect({ helper, entries }).toStrictEqual({
			helper: 'stale relay',
			entries: ['cupboard-hook-relay']
		});
	});

	it('restores both stale executables when replacing the helper fails', async () => {
		const installDirectory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-release-install-')
		);
		const binaryPath = path.join(installDirectory, 'cupboard');
		const helperPath = path.join(installDirectory, 'cupboard-hook-relay');
		await writeFile(binaryPath, 'stale cupboard');
		await writeFile(helperPath, 'stale relay');
		const archive = await releaseArchive({
			cupboard: "#!/bin/sh\nprintf 'v1.2.3\\n'\n",
			'cupboard-hook-relay': "#!/bin/sh\nprintf 'fresh-relay\\n'\n"
		});
		const failure = new Error('helper replacement failed');

		await expect(
			publishReleaseArchive(archive, installDirectory, 'v1.2.3', {
				rename: async (source, destination) => {
					if (
						destination === helperPath &&
						path.basename(String(source)) === 'cupboard-hook-relay'
					) {
						throw failure;
					}

					await renameFile(source, destination);
				}
			})
		).rejects.toBe(failure);
		const [binary, helper, entries] = await Promise.all([
			readFile(binaryPath, 'utf8'),
			readFile(helperPath, 'utf8'),
			readdir(installDirectory)
		]);

		expect({ binary, helper, entries }).toStrictEqual({
			binary: 'stale cupboard',
			helper: 'stale relay',
			entries: ['cupboard', 'cupboard-hook-relay']
		});
	});
});

describe('assertExpectedSourceCommit', () => {
	it('accepts the release built from the expected workflow commit', () => {
		expect(() => {
			assertExpectedSourceCommit('v1.2.3', 'a'.repeat(40), 'a'.repeat(40));
		}).not.toThrow();
	});

	it('rejects a release built from another workflow commit', () => {
		expect(() => {
			assertExpectedSourceCommit('v1.2.3', 'b'.repeat(40), 'a'.repeat(40));
		}).toThrow(ReleaseCoordinateMismatchError);
	});
});

describe('assertInstalledReleaseVersion', () => {
	it('accepts the exact selected tag and rejects any other output', () => {
		expect(() => {
			assertInstalledReleaseVersion('v1.2.3', 'v1.2.3');
		}).not.toThrow();
		expect(() => {
			assertInstalledReleaseVersion('v1.2.3', '0.0.0');
		}).toThrow(InstalledReleaseVersionMismatchError);
	});
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
		['darwin', 'arm64', 'cupboard-macos-arm64.tar.gz'],
		['darwin', 'x64', 'cupboard-macos-x64.tar.gz'],
		['linux', 'arm64', 'cupboard-linux-arm64.tar.gz'],
		['linux', 'x64', 'cupboard-linux-x64.tar.gz']
	])(
		'builds the asset name for %s %s',
		(runtimePlatform, runtimeArchitecture, expected) => {
			expect(assetNameFor(runtimePlatform, runtimeArchitecture)).toBe(expected);
		}
	);

	it('rejects an unsupported platform', () => {
		expect(() => assetNameFor('sunos', 'sparc')).toThrow(
			UnsupportedPlatformError
		);
	});

	it('prefers the stable release-scoped name and retains the legacy tag name', () => {
		expect(assetNamesFor('channel/one', 'linux', 'x64')).toStrictEqual([
			'cupboard-linux-x64.tar.gz',
			'cupboard-channel/one-linux-x64.tar.gz'
		]);
	});
});

describe('releaseAssetFor', () => {
	it('prefers the stable platform asset when both naming generations exist', () => {
		expect(
			releaseAssetFor(
				{
					tagName: 'channel/one',
					assets: [
						{
							name: 'cupboard-channel/one-linux-x64.tar.gz',
							url: 'legacy'
						},
						{ name: 'cupboard-linux-x64.tar.gz', url: 'stable' }
					]
				},
				'linux',
				'x64'
			)
		).toStrictEqual({ name: 'cupboard-linux-x64.tar.gz', url: 'stable' });
	});

	it('falls back to a tag-named asset from an existing release', () => {
		expect(
			releaseAssetFor(
				{
					tagName: 'v1.2.3',
					assets: [
						{
							name: 'cupboard-v1.2.3-linux-x64.tar.gz',
							url: 'legacy'
						}
					]
				},
				'linux',
				'x64'
			)
		).toStrictEqual({
			name: 'cupboard-v1.2.3-linux-x64.tar.gz',
			url: 'legacy'
		});
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
		).resolves.toBe(attestationTagCommit);
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
		).resolves.toBe(attestationTagCommit);
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

	it('rejects a bundle that signs the archive alongside another subject', async () => {
		const archive = await writeArchive();
		const error = await rejectionOf(
			verifyReleaseAttestation(attestationOptions, archive.path, 'v1.0.0', {
				fetch: stubAttestationFetch([{ bundle: {} }]),
				verify: () =>
					Promise.resolve({
						...verifiedAs(archive.digest, attestationTagCommit),
						subjectDigests: [archive.digest, 'f'.repeat(64)]
					})
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

	it('prefers an existing literal unprefixed release tag', async () => {
		const requests: string[] = [];
		const release = await fetchRelease(
			octokitFor((url) => {
				requests.push(url.pathname);

				return { tag_name: '1.2.3', assets: [] };
			}),
			{ ...base, version: '1.2.3', includePrereleases: true }
		);

		expect({ release, requests }).toStrictEqual({
			release: { tagName: '1.2.3', assets: [] },
			requests: ['/repos/owner/repo/releases/tags/1.2.3']
		});
	});

	it('falls back from a missing unprefixed semver tag to its v-prefixed tag', async () => {
		const requests: string[] = [];
		const octokit = createOctokitClient({
			request: {
				fetch: (input: RequestInfo | URL) => {
					const url = new URL(attestationInputUrl(input));
					requests.push(url.pathname);

					if (url.pathname.endsWith('/tags/1.2.3')) {
						return Promise.resolve(new Response('not found', { status: 404 }));
					}

					return Promise.resolve(
						Response.json({ tag_name: 'v1.2.3', assets: [] })
					);
				}
			}
		});
		const release = await fetchRelease(octokit, {
			...base,
			version: '1.2.3',
			includePrereleases: true
		});

		expect({ release, requests }).toStrictEqual({
			release: { tagName: 'v1.2.3', assets: [] },
			requests: [
				'/repos/owner/repo/releases/tags/1.2.3',
				'/repos/owner/repo/releases/tags/v1.2.3'
			]
		});
	});

	it('installs an arbitrary explicit release tag', async () => {
		const release = await fetchRelease(
			octokitFor((url) => {
				expect(url.pathname).toBe('/repos/owner/repo/releases/tags/production');

				return { tag_name: 'production', assets: [] };
			}),
			{
				...base,
				version: 'production',
				includePrereleases: true
			}
		);

		expect(release.tagName).toBe('production');
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

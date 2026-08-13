import { createHash, createPublicKey } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
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
	UnsupportedPlatformError
} from './errors.ts';
import {
	assertExpectedSourceCommit,
	assertInstalledReleaseVersion,
	assetNameFor,
	expectedSourceCommitFor,
	fetchRelease,
	normaliseVersion,
	parseChecksums,
	releaseWorkflowIdentityRegex,
	splitRepository,
	verifyReleaseAttestation
} from './release-install.ts';

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

describe('expectedSourceCommitFor', () => {
	it('normalises a full commit for an exact release', () => {
		expect(expectedSourceCommitFor('v1.2.3', 'A'.repeat(40))).toBe(
			'a'.repeat(40)
		);
	});

	it('allows an action without a release coordinate', () => {
		expect(expectedSourceCommitFor('latest', undefined)).toBeUndefined();
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

	it('rejects an unsupported platform', () => {
		expect(() => assetNameFor('v1.2.3', 'sunos', 'sparc')).toThrow(
			UnsupportedPlatformError
		);
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

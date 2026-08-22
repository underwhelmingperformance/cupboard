import { spawn, spawnSync } from 'node:child_process';
import { createHash, createPublicKey } from 'node:crypto';
import {
	chmod,
	link,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	readlink,
	rename as renameFile,
	rm,
	stat,
	utimes,
	writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createGithubReporter } from '@cupboard/reporter';
import { createOctokitClient } from '@cupboard/shared/octokit';
import {
	AttestationPredicateTypeMismatchError,
	AttestationSubjectMismatchError,
	type VerifiedBundle
} from '@cupboard/shared/sigstore';
import { githubWorkflowBuildType } from '@cupboard/shared/slsa';
import { describe, expect, it } from 'vitest';

import {
	AttestationNotFoundError,
	AttestationSourceMismatchError,
	AttestationVerificationFailedError,
	ChecksumMismatchError,
	CupboardVersionInvalidError,
	DownloadAssetTooLargeError,
	ExactCupboardVersionRequiredError,
	ExpectedSourceCommitInvalidError,
	GithubApiError,
	InstalledReleaseVersionMismatchError,
	InvalidReleaseAssetUrlError,
	MalformedReleaseResponseError,
	NoReleaseFoundError,
	ReleaseAttestationBundleTooLargeError,
	ReleaseCompatibilityError,
	ReleaseCoordinateMismatchError,
	ReleaseInstallationIncompleteError,
	ReleaseInstallationIntegrityError,
	ReleaseInstallationLockLostError,
	ReleaseInstallationLockOwnerAliveError,
	ReleaseInstallationLockStateError,
	ReleaseInstallationProcessIdentityError,
	ReleaseInstallationStateError,
	ReleaseRepositoryInvalidError,
	UnsupportedPlatformError
} from './errors.ts';
import {
	assertExpectedSourceCommit,
	assertInstalledReleaseVersion,
	assertReleaseCompatible,
	assetNameFor,
	assetNamesFor,
	downloadAsset,
	expectedSourceCommitFor,
	fetchRelease,
	installCupboard,
	maximumReleaseAssetBytes,
	maximumReleaseAttestationCandidates,
	maximumReleaseAttestationPages,
	normaliseVersion,
	parseChecksums,
	prepareReleaseExecutable,
	publishReleaseArchive,
	releaseAssetFor,
	type ReleasePublicationStage,
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
		expect(() => normaliseVersion('  ')).toThrow(CupboardVersionInvalidError);
	});
});

describe('expectedSourceCommitFor', () => {
	it('normalises a full commit for an exact release', () => {
		expect(expectedSourceCommitFor('v1.2.3', 'A'.repeat(40))).toBe(
			'a'.repeat(40)
		);
	});

	it('allows latest when no expected source commit is supplied', () => {
		expect(expectedSourceCommitFor('latest', undefined)).toBeUndefined();
	});

	it('accepts an expected source commit with an arbitrary exact tag', () => {
		expect(expectedSourceCommitFor('production', 'A'.repeat(40))).toBe(
			'a'.repeat(40)
		);
	});

	it('requires an exact release when a source commit is supplied', () => {
		expect(() => expectedSourceCommitFor('latest', 'a'.repeat(40))).toThrow(
			ExactCupboardVersionRequiredError
		);
	});

	it('requires a full source commit', () => {
		expect(() => expectedSourceCommitFor('v1.2.3', 'short')).toThrow(
			ExpectedSourceCommitInvalidError
		);
	});
});

describe('assertReleaseCompatible', () => {
	it.each(['v0.0.1', 'v0.0.18', '0.0.18'])(
		'rejects helper-less historical release %s before acquisition',
		(tag) => {
			expect(() => {
				assertReleaseCompatible(tag);
			}).toThrow(ReleaseCompatibilityError);
		}
	);

	it.each(['v0.0.19', 'v1.0.0', 'production'])(
		'accepts compatible or arbitrary release %s',
		(tag) => {
			expect(() => {
				assertReleaseCompatible(tag);
			}).not.toThrow();
		}
	);
});

describe('installCupboard compatibility', () => {
	it('rejects a historical release before requesting an asset', async () => {
		const installDirectory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-release-install-')
		);
		const requests: string[] = [];
		const fetcher: typeof fetch = (input) => {
			const request = new Request(input);
			requests.push(request.url);

			return Promise.resolve(
				Response.json({
					tag_name: 'v0.0.18',
					assets: [
						{
							name: 'cupboard-linux-x64.tar.gz',
							url: 'https://assets.example.test/cupboard.tar.gz'
						},
						{
							name: 'checksums.txt',
							url: 'https://assets.example.test/checksums.txt'
						}
					]
				})
			);
		};

		await expect(
			installCupboard(
				{
					installDirectory,
					releaseRepository: 'owner/repo',
					version: 'v0.0.18',
					includePrereleases: true,
					githubToken: '',
					environment: {}
				},
				createGithubReporter(),
				{ fetch: fetcher }
			)
		).rejects.toBeInstanceOf(ReleaseCompatibilityError);

		expect(requests).toStrictEqual([
			expect.stringContaining('/repos/owner/repo/releases/tags/v0.0.18')
		]);
	});

	it('authenticates asset downloads against the configured GHES API origin', async () => {
		const installDirectory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-release-install-')
		);
		const archiveName = assetNameFor();
		const apiUrl = 'https://github.example.test/api/v3';
		const archiveUrl = `${apiUrl}/repos/owner/repo/releases/assets/1`;
		const checksumsUrl = `${apiUrl}/repos/owner/repo/releases/assets/2`;
		const assetRequests: {
			readonly url: string;
			readonly authorization: string | null;
		}[] = [];
		const fetcher: typeof fetch = (input, init) => {
			const request = new Request(input, init);

			if (request.url.endsWith('/releases/tags/v0.0.19')) {
				return Promise.resolve(
					Response.json({
						tag_name: 'v0.0.19',
						assets: [
							{ name: archiveName, url: archiveUrl },
							{ name: 'checksums.txt', url: checksumsUrl }
						]
					})
				);
			}

			assetRequests.push({
				url: request.url,
				authorization: request.headers.get('authorization')
			});

			return Promise.resolve(
				new Response(
					request.url === archiveUrl
						? 'archive'
						: `${'0'.repeat(64)}  ${archiveName}\n`
				)
			);
		};

		await expect(
			installCupboard(
				{
					installDirectory,
					releaseRepository: 'owner/repo',
					version: 'v0.0.19',
					includePrereleases: false,
					githubToken: 'secret-token',
					environment: { GITHUB_API_URL: apiUrl }
				},
				createGithubReporter(),
				{ fetch: fetcher }
			)
		).rejects.toBeInstanceOf(ChecksumMismatchError);
		expect(assetRequests).toStrictEqual([
			{ url: archiveUrl, authorization: 'Bearer secret-token' },
			{ url: checksumsUrl, authorization: 'Bearer secret-token' }
		]);
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

async function sha256File(filePath: string): Promise<string> {
	return createHash('sha256')
		.update(await readFile(filePath))
		.digest('hex');
}

describe('publishReleaseArchive', () => {
	it('reuses one verified generation for repeated identical installs', async () => {
		const installDirectory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-release-install-')
		);
		const archive = await releaseArchive({
			cupboard: "#!/bin/sh\nprintf 'v1.2.3\\n'\n",
			'cupboard-hook-relay': 'helper'
		});
		const digest = await sha256File(archive);

		await publishReleaseArchive(archive, installDirectory, 'v1.2.3');
		const generationBinary = path.join(
			installDirectory,
			'.cupboard-releases',
			'generations',
			`sha256-${digest}`,
			'cupboard'
		);
		const before = await lstat(generationBinary, { bigint: true });
		await publishReleaseArchive(archive, installDirectory, 'v1.2.3');
		const after = await lstat(generationBinary, { bigint: true });

		const generations = await readdir(
			path.join(installDirectory, '.cupboard-releases', 'generations')
		);
		const current = await readlink(
			path.join(installDirectory, '.cupboard-current')
		);

		expect({
			current,
			generations,
			generationIdentity: { dev: after.dev, ino: after.ino }
		}).toStrictEqual({
			current: `.cupboard-releases/generations/sha256-${digest}`,
			generations: [`sha256-${digest}`],
			generationIdentity: { dev: before.dev, ino: before.ino }
		});
	});

	it('serialises concurrent identical installs onto one generation', async () => {
		const installDirectory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-release-install-')
		);
		const archive = await releaseArchive({
			cupboard: "#!/bin/sh\nprintf 'v1.2.3\\n'\n",
			'cupboard-hook-relay': 'helper'
		});
		const digest = await sha256File(archive);
		const firstLocked = Promise.withResolvers<undefined>();
		const releaseFirst = Promise.withResolvers<undefined>();
		const first = publishReleaseArchive(archive, installDirectory, 'v1.2.3', {
			publicationHook: async (stage) => {
				if (stage !== 'locked') {
					return;
				}

				firstLocked.resolve(undefined);
				await releaseFirst.promise;
			}
		});

		await firstLocked.promise;
		const second = publishReleaseArchive(archive, installDirectory, 'v1.2.3');
		releaseFirst.resolve(undefined);
		await Promise.all([first, second]);

		await expect(
			readdir(path.join(installDirectory, '.cupboard-releases', 'generations'))
		).resolves.toStrictEqual([`sha256-${digest}`]);
	});

	it('replaces a corrupt orphan cached generation before activation', async () => {
		const installDirectory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-release-install-')
		);
		const archive = await releaseArchive({
			cupboard: "#!/bin/sh\nprintf 'v1.2.3\\n'\n",
			'cupboard-hook-relay': 'fresh helper'
		});
		const digest = await sha256File(archive);
		const generationDirectory = path.join(
			installDirectory,
			'.cupboard-releases',
			'generations',
			`sha256-${digest}`
		);
		await mkdir(generationDirectory, { recursive: true });
		await writeFile(
			path.join(generationDirectory, 'cupboard'),
			"#!/bin/sh\nprintf 'wrong-version\\n'\n",
			{ mode: 0o755 }
		);

		await publishReleaseArchive(archive, installDirectory, 'v1.2.3');

		expect({
			binary: await readFile(path.join(installDirectory, 'cupboard'), 'utf8'),
			helper: await readFile(
				path.join(installDirectory, 'cupboard-hook-relay'),
				'utf8'
			),
			generations: await readdir(
				path.join(installDirectory, '.cupboard-releases', 'generations')
			)
		}).toStrictEqual({
			binary: "#!/bin/sh\nprintf 'v1.2.3\\n'\n",
			helper: 'fresh helper',
			generations: [`sha256-${digest}`]
		});
	});

	it.each([
		[
			'cupboard with a version-preserving replacement',
			'cupboard',
			"#!/bin/sh\nprintf 'v1.2.3\\n'\n# altered\n"
		],
		['an altered hook relay', 'cupboard-hook-relay', 'altered helper']
	])(
		'rebuilds an unactivated generation containing %s',
		async (_name, member, replacement) => {
			const installDirectory = await mkdtemp(
				path.join(tmpdir(), 'cupboard-release-install-')
			);
			const expected = {
				cupboard: "#!/bin/sh\nprintf 'v1.2.3\\n'\n",
				'cupboard-hook-relay': 'fresh helper'
			};
			const archive = await releaseArchive(expected);
			const digest = await sha256File(archive);
			const generationDirectory = path.join(
				installDirectory,
				'.cupboard-releases',
				'generations',
				`sha256-${digest}`
			);

			await mkdir(generationDirectory, { recursive: true });
			for (const [name, contents] of Object.entries(expected)) {
				await writeFile(
					path.join(generationDirectory, name),
					name === member ? replacement : contents,
					{ mode: 0o755 }
				);
			}

			await publishReleaseArchive(archive, installDirectory, 'v1.2.3');

			expect({
				cupboard: await readFile(
					path.join(installDirectory, 'cupboard'),
					'utf8'
				),
				helper: await readFile(
					path.join(installDirectory, 'cupboard-hook-relay'),
					'utf8'
				)
			}).toStrictEqual({
				cupboard: expected.cupboard,
				helper: expected['cupboard-hook-relay']
			});
		}
	);

	it.each([
		[
			'cupboard with a version-preserving replacement',
			'cupboard',
			"#!/bin/sh\nprintf 'v1.2.3\\n'\n# altered\n"
		],
		['an altered hook relay', 'cupboard-hook-relay', 'altered helper']
	])(
		'rejects an activated generation containing %s',
		async (_name, member, replacement) => {
			const installDirectory = await mkdtemp(
				path.join(tmpdir(), 'cupboard-release-install-')
			);
			const archive = await releaseArchive({
				cupboard: "#!/bin/sh\nprintf 'v1.2.3\\n'\n",
				'cupboard-hook-relay': 'fresh helper'
			});
			const digest = await sha256File(archive);
			const generationDirectory = path.join(
				installDirectory,
				'.cupboard-releases',
				'generations',
				`sha256-${digest}`
			);

			await publishReleaseArchive(archive, installDirectory, 'v1.2.3');
			await writeFile(path.join(installDirectory, member), replacement, {
				mode: 0o755
			});
			const before = await lstat(path.join(generationDirectory, member), {
				bigint: true
			});

			await expect(
				publishReleaseArchive(archive, installDirectory, 'v1.2.3')
			).rejects.toStrictEqual(
				new ReleaseInstallationIntegrityError(generationDirectory, member)
			);
			const after = await lstat(path.join(generationDirectory, member), {
				bigint: true
			});

			expect({
				current: await readlink(
					path.join(installDirectory, '.cupboard-current')
				),
				generationIdentity: { dev: after.dev, ino: after.ino },
				memberContents: await readFile(
					path.join(generationDirectory, member),
					'utf8'
				)
			}).toStrictEqual({
				current: `.cupboard-releases/generations/sha256-${digest}`,
				generationIdentity: { dev: before.dev, ino: before.ino },
				memberContents: replacement
			});
		}
	);

	it('verifies a cached generation before executing its binary', async () => {
		const installDirectory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-release-install-')
		);
		const archive = await releaseArchive({
			cupboard: "#!/bin/sh\nprintf 'v1.2.3\\n'\n",
			'cupboard-hook-relay': 'fresh helper'
		});
		const commands: string[] = [];

		await publishReleaseArchive(archive, installDirectory, 'v1.2.3');
		await writeFile(
			path.join(installDirectory, 'cupboard'),
			"#!/bin/sh\nprintf 'v1.2.3\\n'\n# altered\n",
			{ mode: 0o755 }
		);

		await expect(
			publishReleaseArchive(archive, installDirectory, 'v1.2.3', {
				runCommand: (command, arguments_) => {
					commands.push(command);

					if (command !== 'tar') {
						return Promise.resolve({ stdout: 'v1.2.3\n' });
					}

					const result = spawnSync(command, [...arguments_]);
					if (result.status !== 0) {
						return Promise.reject(new Error('tar failed'));
					}

					return Promise.resolve({ stdout: '' });
				}
			})
		).rejects.toBeInstanceOf(ReleaseInstallationIntegrityError);

		expect(commands).toStrictEqual([
			'tar',
			expect.stringMatching(/\.staging-sha256-[a-f\d]{64}-.+\/cupboard$/u)
		]);
	});

	it('cleans only incomplete staging generations', async () => {
		const installDirectory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-release-install-')
		);
		const archive = await releaseArchive({
			cupboard: "#!/bin/sh\nprintf 'v1.2.3\\n'\n",
			'cupboard-hook-relay': 'helper'
		});
		const digest = await sha256File(archive);
		const generationsDirectory = path.join(
			installDirectory,
			'.cupboard-releases',
			'generations'
		);
		const incomplete = `.staging-sha256-${'a'.repeat(64)}-orphan`;
		const retained = `sha256-${'b'.repeat(64)}`;
		await mkdir(path.join(generationsDirectory, incomplete), {
			recursive: true
		});
		await mkdir(path.join(generationsDirectory, retained));

		await publishReleaseArchive(archive, installDirectory, 'v1.2.3');

		await expect(readdir(generationsDirectory)).resolves.toStrictEqual(
			[`sha256-${digest}`, retained].toSorted((left, right) =>
				left.localeCompare(right)
			)
		);
	});

	it('migrates legacy executables to a complete validated generation', async () => {
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
		const unsortedEntries = await readdir(installDirectory);
		const entries = unsortedEntries.toSorted((left, right) =>
			left.localeCompare(right)
		);
		const links = await Promise.all([
			readlink(path.join(installDirectory, 'cupboard')),
			readlink(path.join(installDirectory, 'cupboard-hook-relay'))
		]);
		const currentGeneration = await readlink(
			path.join(installDirectory, '.cupboard-current')
		);

		expect({ binary, helper, entries, links }).toStrictEqual({
			binary: "#!/bin/sh\nprintf 'v1.2.3\\n'\n",
			helper: "#!/bin/sh\nprintf 'fresh-relay\\n'\n",
			entries: [
				'.cupboard-current',
				'.cupboard-releases',
				'cupboard',
				'cupboard-hook-relay'
			],
			links: [
				'.cupboard-current/cupboard',
				'.cupboard-current/cupboard-hook-relay'
			]
		});
		expect(currentGeneration).toMatch(
			/^\.cupboard-releases\/generations\/sha256-[a-f\d]{64}$/u
		);
	});

	it('makes the generation directory entry durable before journalling it', async () => {
		const installDirectory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-release-install-')
		);
		const archive = await releaseArchive({
			cupboard: "#!/bin/sh\nprintf 'v1.2.3\\n'\n",
			'cupboard-hook-relay': 'helper'
		});
		const events: string[] = [];

		await publishReleaseArchive(archive, installDirectory, 'v1.2.3', {
			syncDirectory: (directory) => {
				events.push(`sync:${path.relative(installDirectory, directory)}`);
				return Promise.resolve();
			},
			publicationHook: (stage) => {
				events.push(stage);
				return Promise.resolve();
			}
		});

		expect(events.indexOf('sync:.cupboard-releases/generations')).toBeLessThan(
			events.indexOf('prepared')
		);
	});

	it('serialises concurrent publications for one install directory', async () => {
		const installDirectory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-release-install-')
		);
		const firstArchive = await releaseArchive({
			cupboard: "#!/bin/sh\nprintf 'v1.0.0\\n'\n",
			'cupboard-hook-relay': 'first helper'
		});
		const secondArchive = await releaseArchive({
			cupboard: "#!/bin/sh\nprintf 'v2.0.0\\n'\n",
			'cupboard-hook-relay': 'second helper'
		});
		const firstLocked = Promise.withResolvers<undefined>();
		const releaseFirst = Promise.withResolvers<undefined>();
		const secondContended = Promise.withResolvers<undefined>();
		let isSecondLocked = false;
		const firstPublication = publishReleaseArchive(
			firstArchive,
			installDirectory,
			'v1.0.0',
			{
				publicationHook: async (stage) => {
					if (stage !== 'locked') {
						return;
					}

					firstLocked.resolve(undefined);
					await releaseFirst.promise;
				}
			}
		);

		await firstLocked.promise;
		const secondPublication = publishReleaseArchive(
			secondArchive,
			installDirectory,
			'v2.0.0',
			{
				publicationHook: (stage) => {
					if (stage === 'contended') {
						secondContended.resolve(undefined);
					} else if (stage === 'locked') {
						isSecondLocked = true;
					}

					return Promise.resolve();
				}
			}
		);

		await secondContended.promise;
		expect(isSecondLocked).toBe(false);
		releaseFirst.resolve(undefined);
		await Promise.all([firstPublication, secondPublication]);

		const [binary, helper, generations] = await Promise.all([
			readFile(path.join(installDirectory, 'cupboard'), 'utf8'),
			readFile(path.join(installDirectory, 'cupboard-hook-relay'), 'utf8'),
			readdir(path.join(installDirectory, '.cupboard-releases', 'generations'))
		]);

		expect({ binary, helper, generations, isSecondLocked }).toStrictEqual({
			binary: "#!/bin/sh\nprintf 'v2.0.0\\n'\n",
			helper: 'second helper',
			generations: [
				expect.stringMatching(/^sha256-[a-f\d]{64}$/u),
				expect.stringMatching(/^sha256-[a-f\d]{64}$/u)
			],
			isSecondLocked: true
		});
	});

	it('refreshes a queued lease before publishing its lock', async () => {
		const installDirectory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-release-install-')
		);
		const archive = await releaseArchive({
			cupboard: "#!/bin/sh\nprintf 'v1.0.0\\n'\n",
			'cupboard-hook-relay': 'helper'
		});
		const firstLocked = Promise.withResolvers<undefined>();
		const releaseFirst = Promise.withResolvers<undefined>();
		const secondContended = Promise.withResolvers<undefined>();
		const secondLocked = Promise.withResolvers<undefined>();
		const releaseSecond = Promise.withResolvers<undefined>();
		const thirdObserved = Promise.withResolvers<ReleasePublicationStage>();
		const firstPublication = publishReleaseArchive(
			archive,
			installDirectory,
			'v1.0.0',
			{
				publicationHook: async (stage) => {
					if (stage !== 'locked') {
						return;
					}

					firstLocked.resolve(undefined);
					await releaseFirst.promise;
				}
			}
		);

		await firstLocked.promise;
		const secondPublication = publishReleaseArchive(
			archive,
			installDirectory,
			'v1.0.0',
			{
				publicationHook: async (stage) => {
					if (stage === 'contended') {
						secondContended.resolve(undefined);
						return;
					}

					if (stage !== 'locked') {
						return;
					}

					secondLocked.resolve(undefined);
					await releaseSecond.promise;
				}
			}
		);

		await secondContended.promise;
		const stateDirectory = path.join(installDirectory, '.cupboard-releases');
		const lockOwner = JSON.parse(
			await readFile(path.join(stateDirectory, 'install.lock'), 'utf8')
		) as { readonly leaseId: string };
		const stateEntries = await readdir(stateDirectory);
		const queuedLease = stateEntries.find(
			(entry) =>
				entry.startsWith('.lease-') && entry !== `.lease-${lockOwner.leaseId}`
		);

		if (queuedLease === undefined) {
			throw new Error('Expected the queued installer to own a lease');
		}

		await utimes(path.join(stateDirectory, queuedLease), 0, 0);
		releaseFirst.resolve(undefined);
		await secondLocked.promise;

		const thirdPublication = publishReleaseArchive(
			archive,
			installDirectory,
			'v1.0.0',
			{
				publicationHook: (stage) => {
					if (stage === 'contended' || stage === 'locked') {
						thirdObserved.resolve(stage);
					}

					return Promise.resolve();
				}
			}
		);

		const observedStage = await thirdObserved.promise;
		releaseSecond.resolve(undefined);
		const publications = await Promise.allSettled([
			firstPublication,
			secondPublication,
			thirdPublication
		]);

		expect({ observedStage, publications }).toStrictEqual({
			observedStage: 'contended',
			publications: [
				{ status: 'fulfilled', value: undefined },
				{ status: 'fulfilled', value: undefined },
				{ status: 'fulfilled', value: undefined }
			]
		});
	});

	it('preserves the exact cancellation reason while waiting for the install lock', async () => {
		const installDirectory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-release-install-')
		);
		const archive = await releaseArchive({
			cupboard: "#!/bin/sh\nprintf 'v1.0.0\\n'\n",
			'cupboard-hook-relay': 'helper'
		});
		const firstLocked = Promise.withResolvers<undefined>();
		const releaseFirst = Promise.withResolvers<undefined>();
		const secondContended = Promise.withResolvers<undefined>();
		const firstPublication = publishReleaseArchive(
			archive,
			installDirectory,
			'v1.0.0',
			{
				publicationHook: async (stage) => {
					if (stage !== 'locked') {
						return;
					}

					firstLocked.resolve(undefined);
					await releaseFirst.promise;
				}
			}
		);

		await firstLocked.promise;
		const controller = new AbortController();
		const reason = new Error('cancel queued release installation');
		const secondResult = rejectionOf(
			publishReleaseArchive(archive, installDirectory, 'v1.0.0', {
				signal: controller.signal,
				publicationHook: (stage) => {
					if (stage === 'contended') {
						secondContended.resolve(undefined);
					}

					return Promise.resolve();
				}
			})
		);

		await secondContended.promise;
		controller.abort(reason);
		const secondError = await secondResult;
		releaseFirst.resolve(undefined);
		await firstPublication;
		const stateEntries = await readdir(
			path.join(installDirectory, '.cupboard-releases')
		);

		expect({
			secondError,
			lockEntries: stateEntries.filter((entry) => isLockEntry(entry))
		}).toStrictEqual({
			secondError: reason,
			lockEntries: []
		});
	});

	it('reclaims an expired lease whose PID belongs to a replacement process', async () => {
		const installDirectory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-release-install-')
		);
		const stateDirectory = path.join(installDirectory, '.cupboard-releases');
		const leaseId = '00000000-0000-4000-8000-000000000001';
		const leasePath = path.join(stateDirectory, `.lease-${leaseId}`);
		await mkdir(stateDirectory);
		await writeFile(leasePath, 'lease\n');
		await utimes(leasePath, 0, 0);
		await writeFile(
			path.join(stateDirectory, 'install.lock'),
			`${JSON.stringify({
				pid: process.pid,
				instanceId: '00000000-0000-4000-8000-000000000000',
				leaseId,
				processStartedAt: 'former process start'
			})}\n`
		);
		const archive = await releaseArchive({
			cupboard: "#!/bin/sh\nprintf 'v1.0.0\\n'\n",
			'cupboard-hook-relay': 'helper'
		});

		await publishReleaseArchive(archive, installDirectory, 'v1.0.0', {
			processIdentity: () => Promise.resolve('replacement process start')
		});

		const stateEntries = await readdir(stateDirectory);
		expect({
			helper: await readFile(
				path.join(installDirectory, 'cupboard-hook-relay'),
				'utf8'
			),
			lockState: stateEntries.filter(
				(entry) => entry.includes('lock') || entry.startsWith('.lease-')
			)
		}).toStrictEqual({ helper: 'helper', lockState: [] });
	});

	it('refuses to acquire a lock without a process identity', async () => {
		const installDirectory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-release-install-')
		);
		const archive = await releaseArchive({
			cupboard: "#!/bin/sh\nprintf 'v1.0.0\\n'\n",
			'cupboard-hook-relay': 'helper'
		});

		await expect(
			publishReleaseArchive(archive, installDirectory, 'v1.0.0', {
				processIdentity: () => Promise.resolve(undefined)
			})
		).rejects.toBeInstanceOf(ReleaseInstallationProcessIdentityError);
		await expect(
			readdir(path.join(installDirectory, '.cupboard-releases'))
		).resolves.toStrictEqual(['generations']);
	});

	it('reads macOS process identity in a canonical environment', async () => {
		const installDirectory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-release-install-')
		);
		const archive = await releaseArchive({
			cupboard: "#!/bin/sh\nprintf 'v1.0.0\\n'\n",
			'cupboard-hook-relay': 'helper'
		});
		const processEnvironments: (NodeJS.ProcessEnv | undefined)[] = [];

		await publishReleaseArchive(archive, installDirectory, 'v1.0.0', {
			processPlatform: 'darwin',
			processCommandRunner: (_command, _arguments, options) => {
				processEnvironments.push(options.environment);

				return Promise.resolve({ stdout: 'Tue Aug 12 16:00:00 2026\n' });
			}
		});

		expect(processEnvironments).toStrictEqual([
			expect.objectContaining({ LC_ALL: 'C', TZ: 'UTC0' })
		]);
	});

	it('does not reclaim an expired lease from the same process identity', async () => {
		const installDirectory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-release-install-')
		);
		const stateDirectory = path.join(installDirectory, '.cupboard-releases');
		const leaseId = '00000000-0000-4000-8000-000000000001';
		const leasePath = path.join(stateDirectory, `.lease-${leaseId}`);
		await mkdir(stateDirectory);
		await writeFile(leasePath, 'lease\n');
		await utimes(leasePath, 0, 0);
		await writeFile(
			path.join(stateDirectory, 'install.lock'),
			`${JSON.stringify({
				pid: process.pid,
				instanceId: '00000000-0000-4000-8000-000000000000',
				leaseId,
				processStartedAt: 'current process start'
			})}\n`
		);
		const archive = await releaseArchive({
			cupboard: "#!/bin/sh\nprintf 'v1.0.0\\n'\n",
			'cupboard-hook-relay': 'helper'
		});

		await expect(
			publishReleaseArchive(archive, installDirectory, 'v1.0.0', {
				processIdentity: () => Promise.resolve('current process start')
			})
		).rejects.toBeInstanceOf(ReleaseInstallationLockOwnerAliveError);
		await expect(
			readFile(path.join(stateDirectory, 'install.lock'), 'utf8')
		).resolves.toContain('"processStartedAt":"current process start"');
	});

	it('reclaims an expired lease once its PID is provably absent', async () => {
		const installDirectory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-release-install-')
		);
		const stateDirectory = path.join(installDirectory, '.cupboard-releases');
		const leaseId = '00000000-0000-4000-8000-000000000001';
		const leasePath = path.join(stateDirectory, `.lease-${leaseId}`);
		await mkdir(stateDirectory);
		await writeFile(leasePath, 'lease\n');
		await utimes(leasePath, 0, 0);
		await writeFile(
			path.join(stateDirectory, 'install.lock'),
			`${JSON.stringify({
				pid: 999_999_999,
				instanceId: '00000000-0000-4000-8000-000000000000',
				leaseId,
				processStartedAt: 'former process start'
			})}\n`
		);
		const archive = await releaseArchive({
			cupboard: "#!/bin/sh\nprintf 'v1.0.0\\n'\n",
			'cupboard-hook-relay': 'helper'
		});

		await publishReleaseArchive(archive, installDirectory, 'v1.0.0');

		await expect(
			readFile(path.join(installDirectory, 'cupboard-hook-relay'), 'utf8')
		).resolves.toBe('helper');
	});

	it('keeps activation under one live installation lock', async () => {
		const installDirectory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-release-install-')
		);
		const stateDirectory = path.join(installDirectory, '.cupboard-releases');
		const lockPath = path.join(stateDirectory, 'install.lock');
		const currentLink = path.join(installDirectory, '.cupboard-current');
		const firstArchive = await releaseArchive({
			cupboard: "#!/bin/sh\nprintf 'v1.0.0\\n'\n",
			'cupboard-hook-relay': 'first helper'
		});
		const secondArchive = await releaseArchive({
			cupboard: "#!/bin/sh\nprintf 'v2.0.0\\n'\n",
			'cupboard-hook-relay': 'second helper'
		});
		const firstAtRename = Promise.withResolvers<undefined>();
		const resumeFirst = Promise.withResolvers<undefined>();
		const firstPublication = publishReleaseArchive(
			firstArchive,
			installDirectory,
			'v1.0.0',
			{
				rename: async (source, destination) => {
					if (destination === currentLink) {
						firstAtRename.resolve(undefined);
						await resumeFirst.promise;
					}

					await renameFile(source, destination);
				}
			}
		);

		await firstAtRename.promise;
		const owner = JSON.parse(await readFile(lockPath, 'utf8')) as {
			readonly leaseId: string;
		};
		await utimes(path.join(stateDirectory, `.lease-${owner.leaseId}`), 0, 0);

		await expect(
			publishReleaseArchive(secondArchive, installDirectory, 'v2.0.0')
		).rejects.toBeInstanceOf(ReleaseInstallationLockOwnerAliveError);
		await expect(
			readFile(path.join(stateDirectory, 'transaction.json'), 'utf8')
		).resolves.toContain('generationDirectory');

		resumeFirst.resolve(undefined);
		await firstPublication;
		await expect(
			readFile(path.join(installDirectory, 'cupboard'), 'utf8')
		).resolves.toContain('v1.0.0');
		await expect(
			readFile(path.join(stateDirectory, 'transaction.json'), 'utf8')
		).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('recovers an orphan reaper while reclaiming an expired lease', async () => {
		const installDirectory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-release-install-')
		);
		const stateDirectory = path.join(installDirectory, '.cupboard-releases');
		const lockPath = path.join(stateDirectory, 'install.lock');
		const leaseId = '00000000-0000-4000-8000-000000000001';
		const leasePath = path.join(stateDirectory, `.lease-${leaseId}`);
		await mkdir(stateDirectory);
		await writeFile(leasePath, 'lease\n');
		await utimes(leasePath, 0, 0);
		await writeFile(
			lockPath,
			`${JSON.stringify({
				pid: 999_999_999,
				instanceId: '00000000-0000-4000-8000-000000000000',
				leaseId,
				processStartedAt: 'former process start'
			})}\n`
		);
		await link(lockPath, `${lockPath}.reaper`);
		const archive = await releaseArchive({
			cupboard: "#!/bin/sh\nprintf 'v1.0.0\\n'\n",
			'cupboard-hook-relay': 'helper'
		});

		await publishReleaseArchive(archive, installDirectory, 'v1.0.0', {
			signal: AbortSignal.timeout(1000)
		});
		const stateEntries = await readdir(stateDirectory);

		expect(
			stateEntries.filter((entry) => entry.includes('.reaper'))
		).toStrictEqual([]);
	});

	it('does not unlink a replacement lock when releasing its own lock', async () => {
		const installDirectory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-release-install-')
		);
		const lockPath = path.join(
			installDirectory,
			'.cupboard-releases',
			'install.lock'
		);
		const replacement = `${JSON.stringify({
			pid: 1,
			instanceId: '00000000-0000-4000-8000-000000000001'
		})}\n`;
		const archive = await releaseArchive({
			cupboard: "#!/bin/sh\nprintf 'v1.0.0\\n'\n",
			'cupboard-hook-relay': 'helper'
		});

		await publishReleaseArchive(archive, installDirectory, 'v1.0.0', {
			publicationHook: async (stage) => {
				if (stage !== 'activated') {
					return;
				}

				await rm(lockPath);
				await writeFile(lockPath, replacement);
			}
		});

		await expect(readFile(lockPath, 'utf8')).resolves.toBe(replacement);
	});

	it.each([
		['empty', ''],
		['corrupt', '{not-json}\n'],
		[
			'prior schema',
			`${JSON.stringify({
				pid: 1,
				instanceId: '00000000-0000-4000-8000-000000000001'
			})}\n`
		],
		[
			'lease without a process identity',
			`${JSON.stringify({
				pid: 1,
				instanceId: '00000000-0000-4000-8000-000000000001',
				leaseId: '00000000-0000-4000-8000-000000000002'
			})}\n`
		]
	])('rejects a %s release lock without waiting', async (_kind, contents) => {
		const installDirectory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-release-install-')
		);
		const stateDirectory = path.join(installDirectory, '.cupboard-releases');
		await mkdir(stateDirectory);
		await writeFile(path.join(stateDirectory, 'install.lock'), contents);
		const archive = await releaseArchive({
			cupboard: "#!/bin/sh\nprintf 'v1.0.0\\n'\n",
			'cupboard-hook-relay': 'helper'
		});

		await expect(
			publishReleaseArchive(archive, installDirectory, 'v1.0.0')
		).rejects.toBeInstanceOf(ReleaseInstallationLockStateError);
	});

	it('does not roll back a successor transaction after losing the lock', async () => {
		const installDirectory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-release-install-')
		);
		const stateDirectory = path.join(installDirectory, '.cupboard-releases');
		const lockPath = path.join(stateDirectory, 'install.lock');
		const journalPath = path.join(stateDirectory, 'transaction.json');
		const successorJournal = 'successor transaction\n';
		const archive = await releaseArchive({
			cupboard: "#!/bin/sh\nprintf 'v1.0.0\\n'\n",
			'cupboard-hook-relay': 'helper'
		});

		await expect(
			publishReleaseArchive(archive, installDirectory, 'v1.0.0', {
				publicationHook: async (stage) => {
					if (stage !== 'prepared') {
						return;
					}

					await rm(lockPath);
					await writeFile(lockPath, 'successor lock\n');
					await writeFile(journalPath, successorJournal);
				}
			})
		).rejects.toBeInstanceOf(ReleaseInstallationLockLostError);
		await expect(readFile(journalPath, 'utf8')).resolves.toBe(successorJournal);
		const stateEntries = await readdir(stateDirectory);
		expect(
			stateEntries.filter((entry) => entry.startsWith('.current-'))
		).toStrictEqual([]);
	});

	it('recovers a prepared legacy migration before publishing the next release', async () => {
		const installDirectory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-release-install-')
		);
		await writeFile(path.join(installDirectory, 'cupboard'), 'legacy cupboard');
		await writeFile(
			path.join(installDirectory, 'cupboard-hook-relay'),
			'legacy helper'
		);
		const interruptedArchive = await releaseArchive({
			cupboard: "#!/bin/sh\nprintf 'v1.0.0\\n'\n",
			'cupboard-hook-relay': 'interrupted helper'
		});
		const nextArchive = await releaseArchive({
			cupboard: "#!/bin/sh\nprintf 'v2.0.0\\n'\n",
			'cupboard-hook-relay': 'next helper'
		});
		const simulatedCrash = new Error('stop after preparing publication');

		await expect(
			publishReleaseArchive(interruptedArchive, installDirectory, 'v1.0.0', {
				publicationHook: (stage) =>
					stage === 'prepared'
						? Promise.reject(simulatedCrash)
						: Promise.resolve()
			})
		).rejects.toBe(simulatedCrash);
		await expect(
			readFile(
				path.join(installDirectory, '.cupboard-releases', 'transaction.json'),
				'utf8'
			)
		).resolves.toContain('"version":2');
		const interruptedPublicEntries = await Promise.all([
			readFile(path.join(installDirectory, 'cupboard'), 'utf8'),
			readFile(path.join(installDirectory, 'cupboard-hook-relay'), 'utf8')
		]);

		expect(interruptedPublicEntries).toStrictEqual([
			'legacy cupboard',
			'legacy helper'
		]);

		await publishReleaseArchive(nextArchive, installDirectory, 'v2.0.0');
		const [binary, helper, generations, stateEntries] = await Promise.all([
			readFile(path.join(installDirectory, 'cupboard'), 'utf8'),
			readFile(path.join(installDirectory, 'cupboard-hook-relay'), 'utf8'),
			readdir(path.join(installDirectory, '.cupboard-releases', 'generations')),
			readdir(path.join(installDirectory, '.cupboard-releases'))
		]);

		expect({ binary, helper, generations, stateEntries }).toStrictEqual({
			binary: "#!/bin/sh\nprintf 'v2.0.0\\n'\n",
			helper: 'next helper',
			generations: [
				expect.stringMatching(/^sha256-[a-f\d]{64}$/u),
				expect.stringMatching(/^sha256-[a-f\d]{64}$/u)
			],
			stateEntries: ['generations']
		});
	});

	it('keeps stable entry links and prior generations across activation', async () => {
		const installDirectory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-release-install-')
		);
		const firstArchive = await releaseArchive({
			cupboard: "#!/bin/sh\nprintf 'v1.0.0\\n'\n",
			'cupboard-hook-relay': 'first helper'
		});
		const secondArchive = await releaseArchive({
			cupboard: "#!/bin/sh\nprintf 'v2.0.0\\n'\n",
			'cupboard-hook-relay': 'second helper'
		});

		await publishReleaseArchive(firstArchive, installDirectory, 'v1.0.0');
		const currentLink = path.join(installDirectory, '.cupboard-current');
		const firstGeneration = path.resolve(
			installDirectory,
			await readlink(currentLink)
		);
		const entryPaths = ['cupboard', 'cupboard-hook-relay'].map((name) =>
			path.join(installDirectory, name)
		);
		const before = await Promise.all(
			entryPaths.map((entry) => lstat(entry, { bigint: true }))
		);

		await publishReleaseArchive(secondArchive, installDirectory, 'v2.0.0');
		const after = await Promise.all(
			entryPaths.map((entry) => lstat(entry, { bigint: true }))
		);

		const generations = await readdir(
			path.join(installDirectory, '.cupboard-releases', 'generations')
		);

		expect({
			entryIdentities: after.map(({ dev, ino }) => ({ dev, ino })),
			beforeIdentities: before.map(({ dev, ino }) => ({ dev, ino })),
			generations,
			retainedHelper: await readFile(
				path.join(firstGeneration, 'cupboard-hook-relay'),
				'utf8'
			)
		}).toStrictEqual({
			entryIdentities: before.map(({ dev, ino }) => ({ dev, ino })),
			beforeIdentities: before.map(({ dev, ino }) => ({ dev, ino })),
			generations: [
				expect.stringMatching(/^sha256-[a-f\d]{64}$/u),
				expect.stringMatching(/^sha256-[a-f\d]{64}$/u)
			],
			retainedHelper: 'first helper'
		});
	});

	it('lets a running generation invoke its helper after a later activation', async () => {
		const installDirectory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-release-install-')
		);
		const firstArchive = await releaseArchive({
			cupboard:
				'#!/bin/sh\nif [ "$1" = --version ]; then printf \'v1.0.0\\n\'; exit; fi\nprintf \'ready\\n\'\nread -r _\ncat "$(dirname "$0")/cupboard-hook-relay"\n',
			'cupboard-hook-relay': 'first helper'
		});
		const secondArchive = await releaseArchive({
			cupboard: "#!/bin/sh\nprintf 'v2.0.0\\n'\n",
			'cupboard-hook-relay': 'second helper'
		});

		await publishReleaseArchive(firstArchive, installDirectory, 'v1.0.0');
		const firstGeneration = path.resolve(
			installDirectory,
			await readlink(path.join(installDirectory, '.cupboard-current'))
		);
		const child = spawn(path.join(firstGeneration, 'cupboard'), [], {
			stdio: ['pipe', 'pipe', 'pipe']
		});
		const ready = Promise.withResolvers<undefined>();
		let stdout = '';
		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => {
			stdout += chunk;
			if (stdout.includes('ready\n')) {
				ready.resolve(undefined);
			}
		});

		await ready.promise;
		await publishReleaseArchive(secondArchive, installDirectory, 'v2.0.0');
		child.stdin.end('continue\n');
		const closed = Promise.withResolvers<number | null>();
		child.on('close', (status) => {
			closed.resolve(status);
		});

		await expect(closed.promise).resolves.toBe(0);
		expect({
			stdout,
			generations: await readdir(
				path.join(installDirectory, '.cupboard-releases', 'generations')
			)
		}).toStrictEqual({
			stdout: 'ready\nfirst helper',
			generations: [
				expect.stringMatching(/^sha256-[a-f\d]{64}$/u),
				expect.stringMatching(/^sha256-[a-f\d]{64}$/u)
			]
		});
	});

	it('finishes activated cleanup before publishing the next release', async () => {
		const installDirectory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-release-install-')
		);
		const firstArchive = await releaseArchive({
			cupboard: "#!/bin/sh\nprintf 'v1.0.0\\n'\n",
			'cupboard-hook-relay': 'first helper'
		});
		const interruptedArchive = await releaseArchive({
			cupboard: "#!/bin/sh\nprintf 'v2.0.0\\n'\n",
			'cupboard-hook-relay': 'interrupted helper'
		});
		const nextArchive = await releaseArchive({
			cupboard: "#!/bin/sh\nprintf 'v3.0.0\\n'\n",
			'cupboard-hook-relay': 'next helper'
		});
		const simulatedCrash = new Error('stop after activating publication');

		await publishReleaseArchive(firstArchive, installDirectory, 'v1.0.0');
		await expect(
			publishReleaseArchive(interruptedArchive, installDirectory, 'v2.0.0', {
				publicationHook: (stage) =>
					stage === 'activated'
						? Promise.reject(simulatedCrash)
						: Promise.resolve()
			})
		).rejects.toBe(simulatedCrash);
		await expect(
			readFile(path.join(installDirectory, 'cupboard-hook-relay'), 'utf8')
		).resolves.toBe('interrupted helper');

		await publishReleaseArchive(nextArchive, installDirectory, 'v3.0.0');
		const [binary, helper, generations, stateEntries] = await Promise.all([
			readFile(path.join(installDirectory, 'cupboard'), 'utf8'),
			readFile(path.join(installDirectory, 'cupboard-hook-relay'), 'utf8'),
			readdir(path.join(installDirectory, '.cupboard-releases', 'generations')),
			readdir(path.join(installDirectory, '.cupboard-releases'))
		]);

		expect({ binary, helper, generations, stateEntries }).toStrictEqual({
			binary: "#!/bin/sh\nprintf 'v3.0.0\\n'\n",
			helper: 'next helper',
			generations: [
				expect.stringMatching(/^sha256-[a-f\d]{64}$/u),
				expect.stringMatching(/^sha256-[a-f\d]{64}$/u),
				expect.stringMatching(/^sha256-[a-f\d]{64}$/u)
			],
			stateEntries: ['generations']
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

	it.each(['generation-directory sync', 'prepared publication'])(
		'cancels before activation during %s',
		async (phase) => {
			const installDirectory = await mkdtemp(
				path.join(tmpdir(), 'cupboard-release-install-')
			);
			const binaryPath = path.join(installDirectory, 'cupboard');
			await writeFile(binaryPath, 'legacy cupboard');
			const archive = await releaseArchive({
				cupboard: "#!/bin/sh\nprintf 'v1.0.0\\n'\n",
				'cupboard-hook-relay': 'helper'
			});
			const controller = new AbortController();
			const reason = new Error(`cancel during ${phase}`);

			await expect(
				publishReleaseArchive(archive, installDirectory, 'v1.0.0', {
					signal: controller.signal,
					syncDirectory: (directory) => {
						if (
							phase === 'generation-directory sync' &&
							path.basename(directory) === 'generations'
						) {
							controller.abort(reason);
						}

						return Promise.resolve();
					},
					publicationHook: (stage) => {
						if (phase === 'prepared publication' && stage === 'prepared') {
							controller.abort(reason);
						}

						return Promise.resolve();
					}
				})
			).rejects.toBe(reason);
			await expect(readFile(binaryPath, 'utf8')).resolves.toBe(
				'legacy cupboard'
			);
			await expect(
				readFile(path.join(installDirectory, '.cupboard-current'), 'utf8')
			).rejects.toMatchObject({ code: 'ENOENT' });
			await expect(
				readdir(path.join(installDirectory, '.cupboard-releases'))
			).resolves.toStrictEqual(['generations']);
		}
	);

	it('rejects a transaction whose generation escapes the state directory', async () => {
		const installDirectory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-release-install-')
		);
		const stateDirectory = path.join(installDirectory, '.cupboard-releases');
		const sentinelDirectory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-release-sentinel-')
		);
		const sentinel = path.join(sentinelDirectory, 'keep');
		await mkdir(path.join(stateDirectory, 'generations'), { recursive: true });
		await writeFile(sentinel, 'keep');
		await writeFile(
			path.join(stateDirectory, 'transaction.json'),
			`${JSON.stringify({
				version: 2,
				generationDirectory: sentinelDirectory
			})}\n`
		);
		const archive = await releaseArchive({
			cupboard: "#!/bin/sh\nprintf 'v1.0.0\\n'\n",
			'cupboard-hook-relay': 'helper'
		});

		await expect(
			publishReleaseArchive(archive, installDirectory, 'v1.0.0')
		).rejects.toBeInstanceOf(ReleaseInstallationStateError);
		await expect(readFile(sentinel, 'utf8')).resolves.toBe('keep');
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
		const unsortedEntries = await readdir(installDirectory);
		const entries = unsortedEntries.toSorted((left, right) =>
			left.localeCompare(right)
		);

		expect({ helper, entries }).toStrictEqual({
			helper: 'stale relay',
			entries: ['.cupboard-releases', 'cupboard-hook-relay']
		});
	});

	it('restores both stale executables when activation fails', async () => {
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
						destination === path.join(installDirectory, '.cupboard-current')
					) {
						throw failure;
					}

					await renameFile(source, destination);
				}
			})
		).rejects.toBe(failure);
		const [binary, helper, unsortedEntries] = await Promise.all([
			readFile(binaryPath, 'utf8'),
			readFile(helperPath, 'utf8'),
			readdir(installDirectory)
		]);
		const entries = unsortedEntries.toSorted((left, right) =>
			left.localeCompare(right)
		);

		expect({ binary, helper, entries }).toStrictEqual({
			binary: 'stale cupboard',
			helper: 'stale relay',
			entries: ['.cupboard-releases', 'cupboard', 'cupboard-hook-relay']
		});
	});

	it('does not disturb legacy executables when activation fails', async () => {
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
		const publicationFailure = new Error('helper replacement failed');
		const error = await rejectionOf(
			publishReleaseArchive(archive, installDirectory, 'v1.2.3', {
				rename: async (source, destination) => {
					if (
						destination === path.join(installDirectory, '.cupboard-current')
					) {
						throw publicationFailure;
					}

					await renameFile(source, destination);
				}
			})
		);

		const [binary, helper] = await Promise.all([
			readFile(binaryPath, 'utf8'),
			readFile(helperPath, 'utf8')
		]);

		expect({
			error,
			binary,
			helper
		}).toStrictEqual({
			error: publicationFailure,
			binary: 'stale cupboard',
			helper: 'stale relay'
		});
	});
});

describe('downloadAsset', () => {
	it.each([
		['an off-origin URL', 'https://objects.example.test/cupboard'],
		['an HTTP URL', 'http://api.github.com/cupboard'],
		['an embedded username', 'https://user@api.github.com/cupboard'],
		['an embedded password', 'https://user:secret@api.github.com/cupboard'],
		['a fragment', 'https://api.github.com/cupboard#archive'],
		['a malformed URL', 'not a URL']
	])(
		'rejects %s before making an authenticated request',
		async (_name, url) => {
			const directory = await mkdtemp(
				path.join(tmpdir(), 'cupboard-download-')
			);
			const destination = path.join(directory, 'cupboard.tar.gz');
			let wasFetched = false;
			const error = await rejectionOf(
				downloadAsset(
					{ name: 'cupboard.tar.gz', url },
					destination,
					'secret-token',
					{
						fetch: () => {
							wasFetched = true;
							return Promise.resolve(new Response());
						}
					}
				)
			);

			expect(error).toMatchObject({
				name: 'InvalidReleaseAssetUrlError',
				assetName: 'cupboard.tar.gz'
			});
			expect(error).toBeInstanceOf(InvalidReleaseAssetUrlError);
			expect(wasFetched).toBe(false);
			await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
		}
	);

	it.each([
		{
			name: 'GitHub.com',
			assetUrl: 'https://api.github.com/repos/owner/repo/releases/assets/1',
			githubApiOrigin: 'https://api.github.com'
		},
		{
			name: 'GitHub Enterprise Server',
			assetUrl:
				'https://github.example.test/api/v3/repos/owner/repo/releases/assets/1',
			githubApiOrigin: 'https://github.example.test'
		}
	])(
		'authenticates a release asset on $name',
		async ({ assetUrl, githubApiOrigin }) => {
			const directory = await mkdtemp(
				path.join(tmpdir(), 'cupboard-download-')
			);
			const destination = path.join(directory, 'cupboard.tar.gz');
			let request: Request | undefined;

			await downloadAsset(
				{ name: 'cupboard.tar.gz', url: assetUrl },
				destination,
				'secret-token',
				{
					fetch: (input, init) => {
						request = new Request(input, init);
						return Promise.resolve(new Response('archive'));
					},
					githubApiOrigin
				}
			);

			expect({
				url: request?.url,
				authorization: request?.headers.get('authorization')
			}).toStrictEqual({
				url: assetUrl,
				authorization: 'Bearer secret-token'
			});
		}
	);

	it('cancels a non-success response body before reporting the failure', async () => {
		const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-download-'));
		const destination = path.join(directory, 'cupboard.tar.gz');
		let wasCancelled = false;
		const response = new Response(
			new ReadableStream<Uint8Array>({
				pull(controller) {
					controller.enqueue(Uint8Array.of(1));
				},
				cancel() {
					wasCancelled = true;
				}
			}),
			{ status: 404 }
		);

		await expect(
			downloadAsset(
				{ name: 'cupboard.tar.gz', url: 'https://api.github.com/cupboard' },
				destination,
				'',
				{ fetch: () => Promise.resolve(response) }
			)
		).rejects.toBeInstanceOf(GithubApiError);
		expect(wasCancelled).toBe(true);
		await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('streams the response to disk while hashing it', async () => {
		const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-download-'));
		const destination = path.join(directory, 'cupboard.tar.gz');
		const chunks = ['streamed ', 'release'];
		const response = new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					for (const chunk of chunks) {
						controller.enqueue(new TextEncoder().encode(chunk));
					}
					controller.close();
				}
			})
		);

		const result = await downloadAsset(
			{ name: 'cupboard.tar.gz', url: 'https://api.github.com/cupboard' },
			destination,
			'',
			{ fetch: () => Promise.resolve(response) }
		);

		expect({
			result,
			contents: await readFile(destination, 'utf8')
		}).toStrictEqual({
			result: {
				bytes: 16,
				sha256: createHash('sha256').update('streamed release').digest('hex')
			},
			contents: 'streamed release'
		});
	});

	it('rejects an oversized content length before writing the asset', async () => {
		const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-download-'));
		const destination = path.join(directory, 'cupboard.tar.gz');
		const response = new Response('small body', {
			headers: { 'content-length': String(maximumReleaseAssetBytes + 1) }
		});

		await expect(
			downloadAsset(
				{ name: 'cupboard.tar.gz', url: 'https://api.github.com/cupboard' },
				destination,
				'',
				{ fetch: () => Promise.resolve(response) }
			)
		).rejects.toBeInstanceOf(DownloadAssetTooLargeError);
		await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('enforces the byte ceiling while streaming without a content length', async () => {
		const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-download-'));
		const destination = path.join(directory, 'cupboard.tar.gz');
		const response = new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new Uint8Array(5));
					controller.enqueue(new Uint8Array(5));
					controller.close();
				}
			})
		);

		await expect(
			downloadAsset(
				{ name: 'cupboard.tar.gz', url: 'https://api.github.com/cupboard' },
				destination,
				'',
				{ fetch: () => Promise.resolve(response), maximumBytes: 8 }
			)
		).rejects.toBeInstanceOf(DownloadAssetTooLargeError);
		await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('preserves cancellation while waiting for the next response chunk', async () => {
		const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-download-'));
		const destination = path.join(directory, 'cupboard.tar.gz');
		const controller = new AbortController();
		const reason = new Error('cancel streamed release download');
		const firstChunk = Promise.withResolvers<undefined>();
		const response = new Response(
			new ReadableStream<Uint8Array>({
				start(streamController) {
					streamController.enqueue(new TextEncoder().encode('first'));
					firstChunk.resolve(undefined);
				}
			})
		);
		const pending = downloadAsset(
			{ name: 'cupboard.tar.gz', url: 'https://api.github.com/cupboard' },
			destination,
			'',
			{
				fetch: () => Promise.resolve(response),
				signal: controller.signal
			}
		);

		await firstChunk.promise;
		controller.abort(reason);

		await expect(pending).rejects.toBe(reason);
		await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('passes cancellation through the retrying fetch operation', async () => {
		const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-download-'));
		const destination = path.join(directory, 'cupboard.tar.gz');
		const controller = new AbortController();
		const reason = new Error('cancel release download');
		const started = Promise.withResolvers<undefined>();
		const fetcher: typeof fetch = (_input, init) =>
			new Promise((_resolve, reject) => {
				started.resolve(undefined);
				init?.signal?.addEventListener(
					'abort',
					() => {
						reject(reason);
					},
					{ once: true }
				);
			});
		const download = downloadAsset(
			{ name: 'cupboard.tar.gz', url: 'https://api.github.com/cupboard' },
			destination,
			'',
			{ fetch: fetcher, signal: controller.signal }
		);

		await started.promise;
		controller.abort(reason);

		await expect(download).rejects.toBe(reason);
	});
});

describe('assertExpectedSourceCommit', () => {
	it('accepts the expected source commit', () => {
		expect(() => {
			assertExpectedSourceCommit('v1.2.3', 'a'.repeat(40), 'a'.repeat(40));
		}).not.toThrow();
	});

	it('rejects a different source commit', () => {
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
		expect(() => splitRepository(repository)).toThrow(
			ReleaseRepositoryInvalidError
		);
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

	it('prefers the stable platform name and retains the legacy tag-qualified name', () => {
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

		if (url.includes('/commits/tags%2Fv1.0.0')) {
			return Promise.resolve(Response.json({ sha: attestationTagCommit }));
		}

		if (url.includes('/attestations/')) {
			return Promise.resolve(Response.json({ attestations }));
		}

		return Promise.resolve(new Response('not found', { status: 404 }));
	};
}

function snappyLiteral(value: unknown): ArrayBuffer {
	const json = new TextEncoder().encode(JSON.stringify(value));

	if (json.length >= 60) {
		throw new Error('test Snappy literal must use the one-byte length form');
	}

	return Uint8Array.of(json.length, (json.length - 1) << 2, ...json).buffer;
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
				buildType: githubWorkflowBuildType,
				resolvedDependencies: [
					{
						uri: 'git+https://github.com/owner/repo@refs/heads/main',
						digest: { gitCommit: commit }
					}
				]
			}
		},
		verifiedTimestampCount: 0,
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

function isLockEntry(entry: string): boolean {
	return entry === 'install.lock' || entry.startsWith('.lock-');
}

describe('verifyReleaseAttestation', () => {
	it('preserves cancellation while hashing the archive', async () => {
		const archive = await writeArchive();
		const controller = new AbortController();
		const reason = new Error('cancel release hashing');
		const started = Promise.withResolvers<undefined>();
		const verification = verifyReleaseAttestation(
			{ ...attestationOptions, signal: controller.signal },
			archive.path,
			'v1.0.0',
			{
				hashFile: (_filePath, signal) =>
					new Promise((_resolve, reject) => {
						started.resolve(undefined);
						signal?.addEventListener(
							'abort',
							() => {
								reject(reason);
							},
							{ once: true }
						);
					})
			}
		);

		await started.promise;
		controller.abort(reason);

		await expect(verification).rejects.toBe(reason);
	});

	it('preserves an in-flight GitHub abort without retrying it', async () => {
		const archive = await writeArchive();
		const controller = new AbortController();
		const reason = new Error('cancel GitHub request');
		const started = Promise.withResolvers<undefined>();
		let attempts = 0;
		const fetcher: typeof fetch = (_input, init) => {
			attempts += 1;

			return new Promise((_resolve, reject) => {
				const signal = init?.signal;

				if (signal === undefined || signal === null) {
					reject(new Error('expected a GitHub request signal'));
					return;
				}

				started.resolve(undefined);
				signal.addEventListener(
					'abort',
					() => {
						reject(reason);
					},
					{ once: true }
				);
			});
		};
		const verification = verifyReleaseAttestation(
			{ ...attestationOptions, signal: controller.signal },
			archive.path,
			'v1.0.0',
			{ fetch: fetcher }
		);

		await started.promise;
		controller.abort(reason);

		await expect(verification).rejects.toBe(reason);
		expect(attempts).toBe(1);
	});

	it('verifies against the tag when a branch has the same name', async () => {
		const archive = await writeArchive();
		const requests: string[] = [];
		const fetcher: typeof fetch = (input, init) => {
			const url = attestationInputUrl(input);
			requests.push(url);

			if (url.includes('/commits/v1.0.0')) {
				return Promise.resolve(Response.json({ sha: 'b'.repeat(40) }));
			}

			return stubAttestationFetch([{ bundle: {} }])(input, init);
		};

		await expect(
			verifyReleaseAttestation(attestationOptions, archive.path, 'v1.0.0', {
				fetch: fetcher,
				verify: () =>
					Promise.resolve(verifiedAs(archive.digest, attestationTagCommit))
			})
		).resolves.toBe(attestationTagCommit);
		expect(requests).toStrictEqual([
			expect.stringContaining('/attestations/sha256%3A'),
			'https://api.github.com/repos/owner/repo/commits/tags%2Fv1.0.0'
		]);
	});

	it('passes cancellation to every GitHub request', async () => {
		const archive = await writeArchive();
		const controller = new AbortController();
		const signals: (AbortSignal | null | undefined)[] = [];
		const fetcher: typeof fetch = (input, init) => {
			signals.push(init?.signal);

			return stubAttestationFetch([{ bundle: {} }])(input, init);
		};

		await verifyReleaseAttestation(
			{ ...attestationOptions, signal: controller.signal },
			archive.path,
			'v1.0.0',
			{
				fetch: fetcher,
				verify: () =>
					Promise.resolve(verifiedAs(archive.digest, attestationTagCommit))
			}
		);

		expect(signals).toStrictEqual([controller.signal, controller.signal]);
	});

	it('stops before trying another bundle when verification is cancelled', async () => {
		const archive = await writeArchive();
		const controller = new AbortController();
		const reason = new Error('cancel bundle verification');
		let calls = 0;

		await expect(
			verifyReleaseAttestation(
				{ ...attestationOptions, signal: controller.signal },
				archive.path,
				'v1.0.0',
				{
					fetch: stubAttestationFetch([
						{ bundle: { n: 1 } },
						{ bundle: { n: 2 } }
					]),
					verify: () => {
						calls += 1;
						controller.abort(reason);

						return Promise.reject(new Error('verification interrupted'));
					}
				}
			)
		).rejects.toBe(reason);
		expect(calls).toBe(1);
	});

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

	it('accepts a later bundle after an earlier bundle URL fails', async () => {
		const archive = await writeArchive();
		const firstBundleUrl =
			'https://api.github.com/repos/owner/repo/attestations/first';
		const secondBundleUrl =
			'https://api.github.com/repos/owner/repo/attestations/second';
		const bundleRequests: string[] = [];
		const cancelledBundleRequests: string[] = [];
		let verificationCalls = 0;
		const fetcher: typeof fetch = (input, init) => {
			const url = attestationInputUrl(input);

			if (url === firstBundleUrl) {
				bundleRequests.push(url);

				return Promise.resolve(
					new Response(
						new ReadableStream<Uint8Array>({
							pull(controller) {
								controller.enqueue(Uint8Array.of(1));
							},
							cancel() {
								cancelledBundleRequests.push(url);
							}
						}),
						{ status: 404 }
					)
				);
			}

			if (url === secondBundleUrl) {
				bundleRequests.push(url);

				return Promise.resolve(Response.json({ fetched: 'second' }));
			}

			return stubAttestationFetch([
				{ bundle_url: firstBundleUrl },
				{ bundle_url: secondBundleUrl }
			])(input, init);
		};

		await expect(
			verifyReleaseAttestation(attestationOptions, archive.path, 'v1.0.0', {
				fetch: fetcher,
				verify: () => {
					verificationCalls += 1;

					return Promise.resolve(
						verifiedAs(archive.digest, attestationTagCommit)
					);
				}
			})
		).resolves.toBe(attestationTagCommit);
		expect(bundleRequests).toStrictEqual([firstBundleUrl, secondBundleUrl]);
		expect(cancelledBundleRequests).toStrictEqual([firstBundleUrl]);
		expect(verificationCalls).toBe(1);
	});

	it('reports the last acquisition failure when no bundle can be fetched', async () => {
		const archive = await writeArchive();
		const firstBundleUrl =
			'https://api.github.com/repos/owner/repo/attestations/first';
		const secondBundleUrl =
			'https://api.github.com/repos/owner/repo/attestations/second';
		const fetcher: typeof fetch = (input, init) => {
			const url = attestationInputUrl(input);

			if (url === firstBundleUrl) {
				return Promise.resolve(new Response('not found', { status: 404 }));
			}

			if (url === secondBundleUrl) {
				return Promise.resolve(new Response('gone', { status: 410 }));
			}

			return stubAttestationFetch([
				{ bundle_url: firstBundleUrl },
				{ bundle_url: secondBundleUrl }
			])(input, init);
		};
		const error = await rejectionOf(
			verifyReleaseAttestation(attestationOptions, archive.path, 'v1.0.0', {
				fetch: fetcher
			})
		);

		expect(error).toBeInstanceOf(AttestationVerificationFailedError);

		if (!(error instanceof AttestationVerificationFailedError)) {
			throw error;
		}

		expect(error.attempts).toBe(2);
		expect(error.cause).toBeInstanceOf(GithubApiError);
		expect((error.cause as GithubApiError).status).toBe(410);
	});

	it('preserves cancellation while fetching an attestation candidate', async () => {
		const archive = await writeArchive();
		const controller = new AbortController();
		const reason = new Error('cancel candidate fetch');
		const firstBundleUrl =
			'https://api.github.com/repos/owner/repo/attestations/first';
		const secondBundleUrl =
			'https://api.github.com/repos/owner/repo/attestations/second';
		const started = Promise.withResolvers<undefined>();
		const bundleRequests: string[] = [];
		const fetcher: typeof fetch = (input, init) => {
			const url = attestationInputUrl(input);

			if (url === firstBundleUrl) {
				bundleRequests.push(url);
				started.resolve(undefined);

				return new Promise((_resolve, reject) => {
					init?.signal?.addEventListener(
						'abort',
						() => {
							reject(reason);
						},
						{ once: true }
					);
				});
			}

			if (url === secondBundleUrl) {
				bundleRequests.push(url);

				return Promise.resolve(Response.json({ fetched: 'second' }));
			}

			return stubAttestationFetch([
				{ bundle_url: firstBundleUrl },
				{ bundle_url: secondBundleUrl }
			])(input, init);
		};
		const verification = verifyReleaseAttestation(
			{ ...attestationOptions, signal: controller.signal },
			archive.path,
			'v1.0.0',
			{ fetch: fetcher }
		);

		await started.promise;
		controller.abort(reason);

		await expect(verification).rejects.toBe(reason);
		expect(bundleRequests).toStrictEqual([firstBundleUrl]);
	});

	it('searches a later cursor page for a valid bundle', async () => {
		const archive = await writeArchive();
		const requests: string[] = [];
		let verificationCalls = 0;
		const fetcher: typeof fetch = (input) => {
			const request = new Request(input);
			const url = new URL(request.url);
			requests.push(url.href);

			if (url.pathname.includes('/commits/tags%2Fv1.0.0')) {
				return Promise.resolve(Response.json({ sha: attestationTagCommit }));
			}

			if (url.searchParams.get('after') === 'next-page') {
				return Promise.resolve(
					Response.json({ attestations: [{ bundle: { page: 2 } }] })
				);
			}

			return Promise.resolve(
				Response.json(
					{ attestations: [{ bundle: { page: 1 } }] },
					{
						headers: {
							link: `<${url.href}&after=next-page>; rel="next"`
						}
					}
				)
			);
		};

		await expect(
			verifyReleaseAttestation(attestationOptions, archive.path, 'v1.0.0', {
				fetch: fetcher,
				verify: () => {
					verificationCalls += 1;

					return verificationCalls === 1
						? Promise.reject(new Error('untrusted first page'))
						: Promise.resolve(verifiedAs(archive.digest, attestationTagCommit));
				}
			})
		).resolves.toBe(attestationTagCommit);
		expect(
			requests.filter((request) => request.includes('/attestations/'))
		).toStrictEqual([
			expect.not.stringContaining('after=next-page'),
			expect.stringContaining('after=next-page')
		]);
	});

	it('rejects an attestation page that exceeds the candidate bound', async () => {
		const archive = await writeArchive();
		const attestations = Array.from(
			{ length: maximumReleaseAttestationCandidates + 1 },
			(_value, index) => ({ bundle: { index } })
		);
		const error = await rejectionOf(
			verifyReleaseAttestation(attestationOptions, archive.path, 'v1.0.0', {
				fetch: stubAttestationFetch(attestations),
				verify: () =>
					Promise.resolve(verifiedAs(archive.digest, attestationTagCommit))
			})
		);

		expect(error).toMatchObject({
			name: 'ReleaseAttestationSearchTooLargeError',
			maximumCandidates: maximumReleaseAttestationCandidates,
			maximumPages: maximumReleaseAttestationPages,
			observedCandidates: maximumReleaseAttestationCandidates + 1,
			observedPages: 1
		});
	});

	it('rejects an attestation search with another page beyond the page bound', async () => {
		const archive = await writeArchive();
		const attestationRequests: string[] = [];
		const fetcher: typeof fetch = (input) => {
			const url = new URL(attestationInputUrl(input));

			if (!url.pathname.includes('/attestations/')) {
				return Promise.resolve(Response.json({ sha: attestationTagCommit }));
			}

			attestationRequests.push(url.href);
			const page = attestationRequests.length;
			const headers =
				page <= maximumReleaseAttestationPages
					? {
							link: `<${url.origin}${url.pathname}?after=${String(page + 1)}>; rel="next"`
						}
					: undefined;

			return Promise.resolve(Response.json({ attestations: [] }, { headers }));
		};
		const error = await rejectionOf(
			verifyReleaseAttestation(attestationOptions, archive.path, 'v1.0.0', {
				fetch: fetcher
			})
		);

		expect(error).toMatchObject({
			name: 'ReleaseAttestationSearchTooLargeError',
			maximumCandidates: maximumReleaseAttestationCandidates,
			maximumPages: maximumReleaseAttestationPages,
			observedCandidates: 0,
			observedPages: maximumReleaseAttestationPages
		});
		expect(attestationRequests).toHaveLength(maximumReleaseAttestationPages);
	});

	it('fetches a same-origin bundle URL with authentication', async () => {
		const archive = await writeArchive();
		const bundleUrl = 'https://api.github.com/repos/owner/repo/attestations/1';
		const requests: {
			readonly url: string;
			readonly authorization: string | null;
		}[] = [];
		const fetcher: typeof fetch = (input, init) => {
			const request = new Request(input, init);
			requests.push({
				url: request.url,
				authorization: request.headers.get('authorization')
			});

			if (request.url === bundleUrl) {
				return Promise.resolve(Response.json({ fetched: true }));
			}

			return stubAttestationFetch([
				{
					bundle_url: bundleUrl,
					initiator: 'cupboard',
					repository_id: 123
				}
			])(input, init);
		};

		await expect(
			verifyReleaseAttestation(
				{ ...attestationOptions, githubToken: 'release-token' },
				archive.path,
				'v1.0.0',
				{
					fetch: fetcher,
					verify: () =>
						Promise.resolve(verifiedAs(archive.digest, attestationTagCommit))
				}
			)
		).resolves.toBe(attestationTagCommit);
		expect(
			requests.find((request) => request.url === bundleUrl)?.authorization
		).toBe('token release-token');
	});

	it('decompresses the Snappy bundle returned by the GitHub API', async () => {
		const archive = await writeArchive();
		const bundleUrl = 'https://api.github.com/repos/owner/repo/attestations/1';
		const bundle = { fetched: true };
		const fetchedBundles: unknown[] = [];
		const fetcher: typeof fetch = (input, init) => {
			const request = new Request(input, init);

			if (request.url === bundleUrl) {
				return Promise.resolve(
					new Response(snappyLiteral(bundle), {
						headers: { 'content-type': 'application/x-snappy' }
					})
				);
			}

			return stubAttestationFetch([{ bundle_url: bundleUrl }])(input, init);
		};

		await expect(
			verifyReleaseAttestation(attestationOptions, archive.path, 'v1.0.0', {
				fetch: fetcher,
				verify: (bytes) => {
					fetchedBundles.push(JSON.parse(new TextDecoder().decode(bytes)));

					return Promise.resolve(
						verifiedAs(archive.digest, attestationTagCommit)
					);
				}
			})
		).resolves.toBe(attestationTagCommit);
		expect(fetchedBundles).toStrictEqual([bundle]);
	});

	it('rejects an oversized Snappy bundle before reading its body', async () => {
		const archive = await writeArchive();
		const bundleUrl = 'https://api.github.com/repos/owner/repo/attestations/1';
		let wasCancelled = false;
		const fetcher: typeof fetch = (input, init) => {
			const request = new Request(input, init);

			if (request.url === bundleUrl) {
				return Promise.resolve(
					new Response(
						new ReadableStream<Uint8Array>({
							pull(controller) {
								controller.enqueue(Uint8Array.of(0));
							},
							cancel() {
								wasCancelled = true;
							}
						}),
						{
							headers: {
								'content-length': '9',
								'content-type': 'application/x-snappy'
							}
						}
					)
				);
			}

			return stubAttestationFetch([{ bundle_url: bundleUrl }])(input, init);
		};
		const error = await rejectionOf(
			verifyReleaseAttestation(attestationOptions, archive.path, 'v1.0.0', {
				fetch: fetcher,
				maximumBundleBytes: 8
			})
		);

		expect(error).toBeInstanceOf(AttestationVerificationFailedError);

		if (!(error instanceof AttestationVerificationFailedError)) {
			throw error;
		}

		expect(error.cause).toBeInstanceOf(ReleaseAttestationBundleTooLargeError);
		expect(wasCancelled).toBe(true);
	});

	it('bounds a streamed JSON bundle before parsing it', async () => {
		const archive = await writeArchive();
		const bundleUrl = 'https://api.github.com/repos/owner/repo/attestations/1';
		const fetcher: typeof fetch = (input, init) => {
			const request = new Request(input, init);

			if (request.url === bundleUrl) {
				return Promise.resolve(
					new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								const bytes = new TextEncoder().encode('{"a":1234}');
								controller.enqueue(bytes.slice(0, 5));
								controller.enqueue(bytes.slice(5));
								controller.close();
							}
						}),
						{ headers: { 'content-type': 'application/json' } }
					)
				);
			}

			return stubAttestationFetch([{ bundle_url: bundleUrl }])(input, init);
		};
		const error = await rejectionOf(
			verifyReleaseAttestation(attestationOptions, archive.path, 'v1.0.0', {
				fetch: fetcher,
				maximumBundleBytes: 8
			})
		);

		expect(error).toBeInstanceOf(AttestationVerificationFailedError);

		if (!(error instanceof AttestationVerificationFailedError)) {
			throw error;
		}

		expect(error.cause).toBeInstanceOf(ReleaseAttestationBundleTooLargeError);
	});

	it('rejects a malformed Snappy bundle before verification', async () => {
		const archive = await writeArchive();
		const bundleUrl = 'https://api.github.com/repos/owner/repo/attestations/1';
		let verificationCalls = 0;
		const fetcher: typeof fetch = (input, init) => {
			const request = new Request(input, init);

			if (request.url === bundleUrl) {
				return Promise.resolve(
					new Response(Uint8Array.of(0xff).buffer, {
						headers: { 'content-type': 'application/x-snappy' }
					})
				);
			}

			return stubAttestationFetch([{ bundle_url: bundleUrl }])(input, init);
		};
		const error = await rejectionOf(
			verifyReleaseAttestation(attestationOptions, archive.path, 'v1.0.0', {
				fetch: fetcher,
				verify: () => {
					verificationCalls += 1;

					return Promise.resolve(
						verifiedAs(archive.digest, attestationTagCommit)
					);
				}
			})
		);

		expect(error).toBeInstanceOf(AttestationVerificationFailedError);

		if (!(error instanceof AttestationVerificationFailedError)) {
			throw error;
		}

		expect(error.cause).toBeInstanceOf(MalformedReleaseResponseError);
		expect(verificationCalls).toBe(0);
	});

	it('does not send authentication to an off-origin bundle URL', async () => {
		const archive = await writeArchive();
		const bundleUrl =
			'https://results-receiver.actions.githubusercontent.com/attestations/1?sig=secret';
		let bundleAuthorization: string | null | undefined;
		const fetcher: typeof fetch = (input, init) => {
			const request = new Request(input, init);

			if (request.url === bundleUrl) {
				bundleAuthorization = request.headers.get('authorization');

				return Promise.resolve(Response.json({ fetched: true }));
			}

			return stubAttestationFetch([{ bundle_url: bundleUrl }])(input, init);
		};

		await expect(
			verifyReleaseAttestation(
				{ ...attestationOptions, githubToken: 'release-token' },
				archive.path,
				'v1.0.0',
				{
					fetch: fetcher,
					verify: () =>
						Promise.resolve(verifiedAs(archive.digest, attestationTagCommit))
				}
			)
		).resolves.toBe(attestationTagCommit);
		expect(bundleAuthorization).toBeNull();
	});

	it.each([
		'http://api.github.com/repos/owner/repo/attestations/1',
		'https://user@api.github.com/repos/owner/repo/attestations/1',
		'https://api.github.com/repos/owner/repo/attestations/1#fragment'
	])('rejects an unsafe bundle URL %s', async (bundleUrl) => {
		const archive = await writeArchive();
		const error = await rejectionOf(
			verifyReleaseAttestation(attestationOptions, archive.path, 'v1.0.0', {
				fetch: stubAttestationFetch([{ bundle_url: bundleUrl }])
			})
		);

		expect(error).toBeInstanceOf(AttestationVerificationFailedError);

		if (!(error instanceof AttestationVerificationFailedError)) {
			throw error;
		}

		expect(error.cause).toBeInstanceOf(MalformedReleaseResponseError);
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

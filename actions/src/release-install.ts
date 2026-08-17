import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
	access,
	chmod,
	constants,
	link,
	lstat,
	mkdir,
	mkdtemp,
	open,
	readdir,
	readFile,
	readlink,
	rename,
	rm,
	stat,
	symlink,
	utimes,
	writeFile
} from 'node:fs/promises';
import path from 'node:path';
import process, { arch, platform } from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

import type { Reporter } from '@cupboard/reporter';
import { createOctokitClient } from '@cupboard/shared/octokit';
import { retryingFetcher } from '@cupboard/shared/retry';
import {
	AttestationSubjectMismatchError,
	identityPolicy,
	resultFor,
	type VerifiedIdentityPolicy,
	verifyBundle
} from '@cupboard/shared/sigstore';
import { slsaSourceCommit } from '@cupboard/shared/slsa';
import { RequestError } from '@octokit/request-error';
import { StatusCodes } from 'http-status-codes';
import semverLt from 'semver/functions/lt.js';
import semverValid from 'semver/functions/valid.js';
import { uncompress as uncompressSnappy } from 'snappyjs';
import { z } from 'zod';

import {
	observeChildProcess,
	waitForAbortableChildProcess
} from './child-process.ts';
import {
	ArchiveSha256InvalidError,
	AttestationNotFoundError,
	AttestationSourceMismatchError,
	AttestationVerificationFailedError,
	ChecksumMismatchError,
	CommandFailedError,
	CupboardVersionInvalidError,
	DownloadAssetTooLargeError,
	ExactCupboardVersionRequiredError,
	ExactReleaseTagRequiredError,
	ExpectedSourceCommitInvalidError,
	GithubApiError,
	InstalledReleaseVersionMismatchError,
	InvalidChecksumLineError,
	InvalidReleaseAssetUrlError,
	MalformedReleaseResponseError,
	MissingChecksumError,
	NoReleaseFoundError,
	ReleaseAssetNotFoundError,
	ReleaseAttestationBundleTooLargeError,
	ReleaseAttestationSearchTooLargeError,
	ReleaseCompatibilityError,
	ReleaseCoordinateMismatchError,
	ReleaseInstallationIncompleteError,
	ReleaseInstallationIntegrityError,
	ReleaseInstallationLockLostError,
	ReleaseInstallationLockOwnerAliveError,
	ReleaseInstallationLockStateError,
	ReleaseInstallationProcessIdentityError,
	ReleaseInstallationRollbackError,
	ReleaseInstallationStateError,
	ReleaseRepositoryInvalidError,
	UnsupportedPlatformError
} from './errors.ts';
import { type Environment, parseLines } from './inputs.ts';

export interface ReleaseAsset {
	readonly name: string;
	readonly url: string;
}

export interface Release {
	readonly tagName: string;
	readonly assets: readonly ReleaseAsset[];
}

export interface InstallCupboardOptions {
	readonly installDirectory: string;
	readonly releaseRepository: string;
	readonly version: string;
	readonly includePrereleases: boolean;
	readonly githubToken: string;
	readonly environment: Environment;
	readonly expectedSourceCommit?: string;
	readonly signal?: AbortSignal;
}

export interface InstalledCupboard {
	readonly binaryPath: string;
	readonly version: string;
	readonly sourceCommit: string;
}

export const fallbackReleaseRepository = 'cupboard/cupboard';
export const minimumCompatibleRelease = 'v0.0.19';

const notFoundStatus: number = StatusCodes.NOT_FOUND;

const releasePlatforms = new Map([
	['darwin', 'macos'],
	['linux', 'linux']
]);

const releaseArchitectures = new Map([
	['arm64', 'arm64'],
	['x64', 'x64']
]);

const githubHeaders: Readonly<Record<string, string>> = {
	accept: 'application/vnd.github+json',
	'x-github-api-version': '2026-03-10',
	'user-agent': 'cupboard-action'
};

export function normaliseVersion(version: string): string {
	const trimmed = version.trim();

	if (trimmed === '') {
		throw new CupboardVersionInvalidError(version);
	}

	return trimmed;
}

export function expectedSourceCommitFor(
	version: string,
	expectedSourceCommit: string | undefined
): string | undefined {
	if (expectedSourceCommit === undefined) {
		return undefined;
	}

	if (exactResolvedReleaseTag(version) === 'latest') {
		throw new ExactCupboardVersionRequiredError();
	}

	const normalised = expectedSourceCommit.trim().toLowerCase();

	if (!/^[a-f\d]{40}$/u.test(normalised)) {
		throw new ExpectedSourceCommitInvalidError(expectedSourceCommit);
	}

	return normalised;
}

function exactResolvedReleaseTag(version: string): string {
	const tag = version.trim();

	if (tag === '') {
		throw new ExactReleaseTagRequiredError();
	}

	return tag;
}

export function assertExpectedSourceCommit(
	tagName: string,
	sourceCommit: string,
	expectedSourceCommit: string | undefined
): void {
	if (
		expectedSourceCommit !== undefined &&
		sourceCommit !== expectedSourceCommit
	) {
		throw new ReleaseCoordinateMismatchError(
			tagName,
			expectedSourceCommit,
			sourceCommit
		);
	}
}

/**
Reject known historical archive layouts before downloading their assets.
*/
export function assertReleaseCompatible(tagName: string): void {
	const version = semverValid(tagName);

	if (version === null || !semverLt(version, minimumCompatibleRelease)) {
		return;
	}

	throw new ReleaseCompatibilityError(tagName, minimumCompatibleRelease);
}

export function assetNameFor(
	runtimePlatform: string = platform,
	runtimeArchitecture: string = arch
): string {
	const releasePlatform = releasePlatforms.get(runtimePlatform);
	const releaseArchitecture = releaseArchitectures.get(runtimeArchitecture);

	if (releasePlatform === undefined || releaseArchitecture === undefined) {
		throw new UnsupportedPlatformError(runtimePlatform, runtimeArchitecture);
	}

	return `cupboard-${releasePlatform}-${releaseArchitecture}.tar.gz`;
}

/**
Prefer release-scoped names while retaining compatibility with old releases.
*/
export function assetNamesFor(
	tagName: string,
	runtimePlatform: string = platform,
	runtimeArchitecture: string = arch
): readonly string[] {
	const stableName = assetNameFor(runtimePlatform, runtimeArchitecture);
	const suffix = stableName.slice('cupboard-'.length);

	return [stableName, `cupboard-${tagName}-${suffix}`];
}

/**
Select the stable platform asset, falling back to a legacy tag-named asset.
*/
export function releaseAssetFor(
	release: Release,
	runtimePlatform: string = platform,
	runtimeArchitecture: string = arch
): ReleaseAsset {
	return findFirstReleaseAsset(
		release,
		assetNamesFor(release.tagName, runtimePlatform, runtimeArchitecture)
	);
}

export function parseChecksums(value: string): Map<string, string> {
	const checksums = new Map<string, string>();

	for (const line of parseLines(value)) {
		const match = /^(?<sha256>[a-f\d]{64})\s+\*?(?<name>.+)$/iu.exec(line);
		const sha256 = match?.groups?.sha256;
		const name = match?.groups?.name;

		if (sha256 === undefined || name === undefined) {
			throw new InvalidChecksumLineError(line);
		}

		checksums.set(name, sha256.toLowerCase());
	}

	return checksums;
}

const releaseAssetSchema = z.object({ name: z.string(), url: z.string() });

const releaseResponseSchema = z.looseObject({
	tag_name: z.string(),
	assets: z.array(releaseAssetSchema)
});

const provenancePredicateType = 'https://slsa.dev/provenance/v1';
const githubOidcIssuer = 'https://token.actions.githubusercontent.com';
const releaseWorkflowPath = '.github/workflows/release.yml';

type Octokit = ReturnType<typeof createOctokitClient>;

function buildOctokit(
	options: Pick<
		InstallCupboardOptions,
		'githubToken' | 'environment' | 'signal'
	>,
	fetcher?: typeof fetch
): Octokit {
	const request = {
		...(fetcher !== undefined && { fetch: fetcher }),
		...(options.signal !== undefined && {
			signal: options.signal,
			// Octokit's retry plugin treats an aborted fetch as a retryable status
			// 500. A cancellable action owns its retry policy so the exact signal
			// reason can escape immediately instead of being retried and wrapped.
			retries: 0
		})
	};

	return createOctokitClient({
		...(options.githubToken !== '' && { auth: options.githubToken }),
		apiVersion: '2026-03-10',
		...(options.environment.GITHUB_API_URL !== undefined && {
			baseUrl: options.environment.GITHUB_API_URL
		}),
		...(Object.keys(request).length > 0 && { request })
	});
}

async function githubRequest<Result>(
	signal: AbortSignal | undefined,
	run: () => Promise<Result>
): Promise<Result> {
	try {
		return await run();
	} catch (error) {
		signal?.throwIfAborted();
		throw error;
	}
}

interface VerifyReleaseDependencies {
	readonly fetch?: typeof fetch;
	readonly verify?: typeof verifyBundle;
	readonly subjectDigest?: string;
	readonly hashFile?: typeof sha256File;
	readonly maximumBundleBytes?: number;
}

interface InstallCupboardDependencies {
	readonly fetch?: typeof fetch;
}

type RenameFile = typeof rename;

interface PublishReleaseDependencies {
	readonly rename?: RenameFile;
	readonly runCommand?: ReleaseCommandRunner;
	readonly processCommandRunner?: ReleaseCommandRunner;
	readonly processPlatform?: NodeJS.Platform;
	readonly syncDirectory?: (directoryPath: string) => Promise<void>;
	readonly processIdentity?: ReleaseProcessIdentity;
	readonly signal?: AbortSignal;
	readonly publicationHook?: (stage: ReleasePublicationStage) => Promise<void>;
	/**
	Already verified archive digest; direct callers may omit it to hash locally.
	*/
	readonly archiveSha256?: string;
}

export type ReleasePublicationStage =
	'contended' | 'locked' | 'prepared' | 'activated';

/**
The dependencies injected while downloading a release asset.
*/
export interface DownloadAssetDependencies {
	readonly fetch?: typeof fetch;
	readonly githubApiOrigin?: string;
	readonly signal?: AbortSignal;
	readonly maximumBytes?: number;
}

export interface DownloadedAsset {
	readonly bytes: number;
	readonly sha256: string;
}

// A current SEA archive is tens of MiB. 256 MiB leaves ample room for runtime
// and embedded-worker growth while bounding an unauthenticated response well
// below a typical GitHub-hosted runner's memory and disk capacity.
export const maximumReleaseAssetBytes = 256 * 1024 * 1024;
const maximumAttestationBundleBytes = 16 * 1024 * 1024;

// Small pages bound the list response Octokit buffers before this code sees it;
// the total limits bound both retained candidates and a sparse cursor chain.
export const maximumReleaseAttestationCandidates = 100;
export const maximumReleaseAttestationPages = 10;
const releaseAttestationsPerPage = 10;

type ReleaseCommandRunner = (
	command: string,
	arguments_: readonly string[],
	options: {
		readonly captureStdout: boolean;
		readonly environment?: NodeJS.ProcessEnv;
		readonly quietStderr?: boolean;
		readonly signal?: AbortSignal;
	}
) => Promise<{ readonly stdout: string }>;

const defaultReleaseCommandRunner: ReleaseCommandRunner = async (
	command,
	arguments_,
	options
) => {
	options.signal?.throwIfAborted();

	const child = spawn(command, [...arguments_], {
		...(options.environment !== undefined && { env: options.environment }),
		stdio: options.captureStdout
			? ['ignore', 'pipe', options.quietStderr === true ? 'ignore' : 'inherit']
			: [
					'inherit',
					'inherit',
					options.quietStderr === true ? 'ignore' : 'inherit'
				]
	});
	const chunks: Buffer[] = [];

	if (options.captureStdout) {
		child.stdout?.on('data', (chunk: Buffer) => {
			chunks.push(chunk);
		});
	}

	const result = await waitForAbortableChildProcess(
		observeChildProcess(child),
		options.signal
	);

	if (result.error !== undefined || result.status !== 0) {
		throw new CommandFailedError(
			command,
			result.status,
			result.error?.message,
			{
				...(result.error !== undefined && { cause: result.error }),
				...(result.signal !== undefined && { signal: result.signal })
			}
		);
	}

	return { stdout: Buffer.concat(chunks).toString('utf8') };
};

/**
 * The Fulcio SAN a release attestation is signed under: the release workflow's
 * path in the release repository. A regex (anchored, with a trailing `@`) so it
 * matches whichever ref the workflow ran on, since the build runs on the
 * default branch before the tag exists.
 */
export function releaseWorkflowIdentityRegex(
	releaseRepository: string
): string {
	const identity = `https://github.com/${releaseRepository}/${releaseWorkflowPath}`;

	return `^${RegExp.escape(identity)}@`;
}

export async function installCupboard(
	options: InstallCupboardOptions,
	reporter: Reporter,
	dependencies: InstallCupboardDependencies = {}
): Promise<InstalledCupboard> {
	options.signal?.throwIfAborted();

	const expectedSourceCommit = expectedSourceCommitFor(
		options.version,
		options.expectedSourceCommit
	);
	const release = await reporter.phase(
		'Resolve cupboard release',
		async (phase) => {
			const resolved = await githubRequest(options.signal, () =>
				fetchRelease(buildOctokit(options, dependencies.fetch), options)
			);
			phase.fact('Version', resolved.tagName);

			return resolved;
		}
	);
	assertReleaseCompatible(release.tagName);

	const binaryPath = path.join(options.installDirectory, 'cupboard');
	const asset = releaseAssetFor(release);
	const assetName = asset.name;
	const checksumAsset = findReleaseAsset(release, 'checksums.txt');
	const downloadDirectory = await mkdtemp(
		path.join(options.installDirectory, '.cupboard-download-')
	);
	const archivePath = path.join(downloadDirectory, assetName);
	const checksumsPath = path.join(downloadDirectory, 'checksums.txt');

	try {
		const downloaded = await reporter.phase(
			`Download ${assetName}`,
			async () => {
				const downloadDependencies = {
					githubApiOrigin: githubApiOrigin(options.environment),
					...(dependencies.fetch !== undefined && {
						fetch: dependencies.fetch
					}),
					...(options.signal !== undefined && { signal: options.signal })
				};

				const archive = await downloadAsset(
					asset,
					archivePath,
					options.githubToken,
					downloadDependencies
				);
				await downloadAsset(
					checksumAsset,
					checksumsPath,
					options.githubToken,
					downloadDependencies
				);

				return archive;
			}
		);

		await reporter.phase('Verify checksum', async () => {
			const checksums = parseChecksums(await readFile(checksumsPath, 'utf8'));
			const expectedChecksum = checksums.get(assetName);

			if (expectedChecksum === undefined) {
				throw new MissingChecksumError(assetName);
			}

			verifyChecksum(assetName, downloaded.sha256, expectedChecksum);
		});

		const sourceCommit = await reporter.phase(
			'Verify release attestation',
			async (phase) => {
				const builtFrom = await verifyReleaseAttestation(
					options,
					archivePath,
					release.tagName,
					{ subjectDigest: downloaded.sha256 }
				);
				assertExpectedSourceCommit(
					release.tagName,
					builtFrom,
					expectedSourceCommit
				);
				phase.fact('Built from', builtFrom);

				return builtFrom;
			}
		);

		await reporter.phase('Install cupboard binary', () =>
			publishReleaseArchive(
				archivePath,
				options.installDirectory,
				release.tagName,
				{
					archiveSha256: downloaded.sha256,
					...(options.signal !== undefined && { signal: options.signal })
				}
			)
		);

		return {
			binaryPath,
			version: release.tagName,
			sourceCommit
		};
	} finally {
		await rm(downloadDirectory, { recursive: true, force: true });
	}
}

/**
Validate a release in isolation before replacing the installed executables.
*/
export async function publishReleaseArchive(
	archivePath: string,
	installDirectory: string,
	expectedVersion: string,
	dependencies: PublishReleaseDependencies = {}
): Promise<void> {
	dependencies.signal?.throwIfAborted();

	const move = dependencies.rename ?? rename;
	const runCommand = dependencies.runCommand ?? defaultReleaseCommandRunner;
	const syncInstallationDirectory = dependencies.syncDirectory ?? syncDirectory;
	const paths = releaseInstallationPaths(installDirectory);
	const archiveSha256 =
		dependencies.archiveSha256 ??
		(await sha256File(archivePath, dependencies.signal));

	assertArchiveSha256(archiveSha256);

	await mkdir(paths.generationsDirectory, { recursive: true });
	const releaseLock = await acquireReleaseInstallationLock(
		paths,
		dependencies.signal,
		() => dependencies.publicationHook?.('contended'),
		dependencies.processIdentity ??
			((pid, signal) =>
				releaseProcessIdentity(
					pid,
					signal,
					dependencies.processCommandRunner ?? defaultReleaseCommandRunner,
					dependencies.processPlatform ?? platform
				))
	);
	try {
		await releaseLock.assertOwned();
		await cleanupOrphanReleaseReapers(paths);
		await releaseLock.assertOwned();
		await recoverReleaseInstallation(paths, move);
		await releaseLock.assertOwned();
		await cleanupIncompleteReleaseGenerations(paths);
		await releaseLock.assertOwned();
		await dependencies.publicationHook?.('locked');

		const generationDirectory = path.join(
			paths.generationsDirectory,
			`sha256-${archiveSha256}`
		);
		const activeGeneration = await currentGenerationDirectory(paths);
		const stagingDirectory = await prepareReleaseGenerationCandidate(
			archivePath,
			generationDirectory,
			expectedVersion,
			runCommand,
			dependencies.signal
		);

		try {
			if (await isReleaseGenerationPresent(generationDirectory)) {
				try {
					await validateReleaseGenerationAgainstCandidate(
						generationDirectory,
						stagingDirectory,
						dependencies.signal
					);
				} catch (error) {
					if (
						activeGeneration === path.resolve(generationDirectory) ||
						(await wasReleaseGenerationActivated(generationDirectory))
					) {
						throw error;
					}

					await rm(generationDirectory, { recursive: true, force: true });
				}
			}

			if (!(await isReleaseGenerationPresent(generationDirectory))) {
				dependencies.signal?.throwIfAborted();
				await installReleaseGenerationCandidate(
					stagingDirectory,
					generationDirectory,
					syncInstallationDirectory
				);
			}

			if (activeGeneration === path.resolve(generationDirectory)) {
				await ensureReleaseEntryLinks(paths, move);
				await syncInstallationDirectory(paths.installDirectory);
				return;
			}

			await publishReleaseGeneration(
				paths,
				generationDirectory,
				move,
				dependencies,
				syncInstallationDirectory,
				releaseLock
			);
		} finally {
			await rm(stagingDirectory, { recursive: true, force: true });
		}
	} finally {
		await releaseLock.release();
	}
}

const releaseStateDirectoryName = '.cupboard-releases';
const releaseCurrentLinkName = '.cupboard-current';
const releaseJournalName = 'transaction.json';
const releaseLockName = 'install.lock';
const releaseActivatedMarkerName = '.activated';
const releaseExecutableNames = ['cupboard', 'cupboard-hook-relay'] as const;

interface ReleaseInstallationPaths {
	readonly installDirectory: string;
	readonly stateDirectory: string;
	readonly generationsDirectory: string;
	readonly currentLink: string;
	readonly journal: string;
	readonly lock: string;
}

interface ReleaseInstallationJournal {
	readonly version: 2;
	readonly generationDirectory: string;
	readonly previousGenerationDirectory?: string;
}

const releaseInstallationPathSchema = z.string().min(1);
const releaseInstallationJournalSchema = z.strictObject({
	version: z.literal(2),
	generationDirectory: releaseInstallationPathSchema,
	previousGenerationDirectory: releaseInstallationPathSchema.optional()
});

interface ReleaseLockOwner {
	readonly pid: number;
	readonly instanceId: string;
	readonly leaseId: string;
	readonly processStartedAt: string;
}

const releaseLockOwnerSchema = z.strictObject({
	pid: z.int().positive(),
	instanceId: z.uuid(),
	leaseId: z.uuid(),
	processStartedAt: z.string().min(1)
});

const releaseInstallerInstanceId = randomUUID();

function releaseInstallationPaths(
	installDirectory: string
): ReleaseInstallationPaths {
	const stateDirectory = path.join(installDirectory, releaseStateDirectoryName);

	return {
		installDirectory,
		stateDirectory,
		generationsDirectory: path.join(stateDirectory, 'generations'),
		currentLink: path.join(installDirectory, releaseCurrentLinkName),
		journal: path.join(stateDirectory, releaseJournalName),
		lock: path.join(stateDirectory, releaseLockName)
	};
}

function assertArchiveSha256(value: string): void {
	if (/^[a-f\d]{64}$/u.test(value)) {
		return;
	}

	throw new ArchiveSha256InvalidError(value);
}

async function isReleaseGenerationPresent(candidate: string): Promise<boolean> {
	try {
		await lstat(candidate);
		return true;
	} catch (error) {
		if (isMissingPathError(error)) {
			return false;
		}

		throw error;
	}
}

async function wasReleaseGenerationActivated(
	generationDirectory: string
): Promise<boolean> {
	return isReleaseGenerationPresent(
		path.join(generationDirectory, releaseActivatedMarkerName)
	);
}

async function validateReleaseGeneration(
	generationDirectory: string,
	expectedVersion: string,
	runCommand: ReleaseCommandRunner,
	signal?: AbortSignal
): Promise<void> {
	const directory = await lstat(generationDirectory);

	if (!directory.isDirectory()) {
		throw new ReleaseInstallationIncompleteError(generationDirectory);
	}

	const binaryPath = path.join(generationDirectory, 'cupboard');
	await Promise.all(
		releaseExecutableNames.map((name) =>
			validateReleaseExecutable(path.join(generationDirectory, name))
		)
	);
	assertInstalledReleaseVersion(
		expectedVersion,
		await readInstalledCupboardVersion(binaryPath, runCommand, signal)
	);
}

async function validateReleaseGenerationAgainstCandidate(
	generationDirectory: string,
	verifiedCandidateDirectory: string,
	signal?: AbortSignal
): Promise<void> {
	const generation = await lstat(generationDirectory);

	if (!generation.isDirectory()) {
		throw new ReleaseInstallationIncompleteError(generationDirectory);
	}

	for (const name of releaseExecutableNames) {
		const installedPath = path.join(generationDirectory, name);
		const verifiedPath = path.join(verifiedCandidateDirectory, name);

		await validateReleaseExecutable(installedPath);
		const [installedDigest, verifiedDigest] = await Promise.all([
			sha256File(installedPath, signal),
			sha256File(verifiedPath, signal)
		]);

		if (installedDigest !== verifiedDigest) {
			throw new ReleaseInstallationIntegrityError(generationDirectory, name);
		}
	}
}

async function prepareReleaseGenerationCandidate(
	archivePath: string,
	generationDirectory: string,
	expectedVersion: string,
	runCommand: ReleaseCommandRunner,
	signal?: AbortSignal
): Promise<string> {
	const stagingDirectory = await mkdtemp(
		path.join(
			path.dirname(generationDirectory),
			`.staging-${path.basename(generationDirectory)}-`
		)
	);

	try {
		await extractReleaseGeneration(
			archivePath,
			stagingDirectory,
			expectedVersion,
			runCommand,
			signal
		);

		return stagingDirectory;
	} catch (error) {
		await rm(stagingDirectory, { recursive: true, force: true });
		throw error;
	}
}

async function installReleaseGenerationCandidate(
	stagingDirectory: string,
	generationDirectory: string,
	syncInstallationDirectory: (directoryPath: string) => Promise<void>
): Promise<void> {
	await syncReleaseGeneration(stagingDirectory, syncInstallationDirectory);
	await rename(stagingDirectory, generationDirectory);
	await syncInstallationDirectory(path.dirname(generationDirectory));
}

async function extractReleaseGeneration(
	archivePath: string,
	destinationDirectory: string,
	expectedVersion: string,
	runCommand: ReleaseCommandRunner,
	signal?: AbortSignal
): Promise<void> {
	await runCommand('tar', ['-xzf', archivePath, '-C', destinationDirectory], {
		captureStdout: false,
		...(signal !== undefined && { signal })
	});
	await Promise.all(
		releaseExecutableNames.map((name) =>
			prepareReleaseExecutable(path.join(destinationDirectory, name))
		)
	);
	await validateReleaseGeneration(
		destinationDirectory,
		expectedVersion,
		runCommand,
		signal
	);
}

async function cleanupIncompleteReleaseGenerations(
	paths: ReleaseInstallationPaths
): Promise<void> {
	const entries = await readdir(paths.generationsDirectory);

	await Promise.all(
		entries
			.filter((entry) => entry.startsWith('.staging-sha256-'))
			.map((entry) =>
				rm(path.join(paths.generationsDirectory, entry), {
					recursive: true,
					force: true
				})
			)
	);
}

interface ReleaseInstallationLock {
	assertOwned(): Promise<void>;
	release(): Promise<void>;
}

type ReleaseProcessIdentity = (
	pid: number,
	signal?: AbortSignal
) => Promise<string | undefined>;

async function releaseProcessIdentity(
	pid: number,
	signal?: AbortSignal,
	runCommand: ReleaseCommandRunner = defaultReleaseCommandRunner,
	runtimePlatform: NodeJS.Platform = platform
): Promise<string | undefined> {
	signal?.throwIfAborted();

	if (runtimePlatform === 'linux') {
		try {
			const statContents = await readFile(`/proc/${String(pid)}/stat`, 'utf8');
			const commandEnd = statContents.lastIndexOf(')');
			const fields = statContents
				.slice(commandEnd + 1)
				.trim()
				.split(/\s+/u);
			// The tail starts at field 3 (state); process start time is field 22.
			const startedAt = fields[19];

			if (commandEnd === -1 || startedAt === undefined || startedAt === '') {
				throw new ReleaseInstallationProcessIdentityError(pid);
			}

			return `linux-start-ticks:${startedAt}`;
		} catch (error) {
			if (isMissingPathError(error)) {
				return undefined;
			}

			if (error instanceof ReleaseInstallationProcessIdentityError) {
				throw error;
			}

			throw new ReleaseInstallationProcessIdentityError(pid, { cause: error });
		}
	}

	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			const result = await runCommand(
				'/bin/ps',
				['-o', 'lstart=', '-p', String(pid)],
				{
					captureStdout: true,
					environment: {
						...process.env,
						LC_ALL: 'C',
						TZ: 'UTC0'
					},
					quietStderr: true,
					...(signal !== undefined && { signal })
				}
			);
			const startedAt = Date.parse(`${result.stdout.trim()} UTC`);

			if (!Number.isNaN(startedAt)) {
				return `unix-start-milliseconds:${String(startedAt)}`;
			}
		} catch (error) {
			signal?.throwIfAborted();

			if (!isReleaseProcessAlive(pid)) {
				return undefined;
			}

			if (attempt === 1) {
				throw new ReleaseInstallationProcessIdentityError(pid, {
					cause: error
				});
			}

			continue;
		}

		if (!isReleaseProcessAlive(pid)) {
			return undefined;
		}
	}

	throw new ReleaseInstallationProcessIdentityError(pid);
}

function isReleaseProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return !isPathError(error, 'ESRCH');
	}
}

const releaseLockRetryDelayMs = 25;
// Heartbeats are deliberately much more frequent than expiry so a normally
// scheduled installer has several opportunities to renew its ownership on
// both macOS and Linux before another process may reclaim the lock.
const releaseLockHeartbeatIntervalMs = 2000;
const releaseLockLeaseDurationMs = 30_000;

async function acquireReleaseInstallationLock(
	paths: ReleaseInstallationPaths,
	signal?: AbortSignal,
	onContention?: () => Promise<void> | undefined,
	processIdentity: ReleaseProcessIdentity = releaseProcessIdentity
): Promise<ReleaseInstallationLock> {
	const processStartedAt = await processIdentity(process.pid, signal);

	if (processStartedAt === undefined) {
		throw new ReleaseInstallationProcessIdentityError(process.pid);
	}

	const candidate = path.join(
		paths.stateDirectory,
		`.lock-${String(process.pid)}-${randomUUID()}`
	);
	const leaseId = randomUUID();
	const leasePath = path.join(paths.stateDirectory, `.lease-${leaseId}`);
	const owner: ReleaseLockOwner = {
		pid: process.pid,
		instanceId: releaseInstallerInstanceId,
		leaseId,
		processStartedAt
	};

	try {
		await writeFile(candidate, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
		await writeFile(leasePath, '', { mode: 0o600 });

		for (;;) {
			signal?.throwIfAborted();

			try {
				await utimes(leasePath, new Date(), new Date());
				await link(candidate, paths.lock);
				let heartbeatError: unknown;
				const heartbeat = setInterval(() => {
					void utimes(leasePath, new Date(), new Date()).catch(
						(error: unknown) => {
							heartbeatError = error;
						}
					);
				}, releaseLockHeartbeatIntervalMs);
				heartbeat.unref();

				return {
					async assertOwned() {
						if (heartbeatError !== undefined) {
							throw new ReleaseInstallationLockLostError(paths.lock, {
								cause: heartbeatError
							});
						}

						if (!(await arePathsSameInode(candidate, paths.lock))) {
							throw new ReleaseInstallationLockLostError(paths.lock);
						}
					},
					async release() {
						clearInterval(heartbeat);
						try {
							await didRemoveLockIfMatches(candidate, paths.lock);
						} finally {
							await Promise.all([
								rm(candidate, { force: true }),
								rm(leasePath, { force: true })
							]);
						}
					}
				};
			} catch (error) {
				if (!isPathError(error, 'EEXIST')) {
					throw error;
				}
			}

			if (
				await didRemoveStaleReleaseLock(paths.lock, processIdentity, signal)
			) {
				continue;
			}

			await onContention?.();

			try {
				await delay(releaseLockRetryDelayMs, undefined, { signal });
			} catch (error) {
				signal?.throwIfAborted();
				throw error;
			}
		}
	} catch (error) {
		await Promise.all([
			rm(candidate, { force: true }),
			rm(leasePath, { force: true })
		]);
		throw error;
	}
}

async function didRemoveStaleReleaseLock(
	lockPath: string,
	processIdentity: ReleaseProcessIdentity,
	signal?: AbortSignal
): Promise<boolean> {
	let contents: string;

	try {
		contents = await readFile(lockPath, 'utf8');
	} catch (error) {
		if (isMissingPathError(error)) {
			return true;
		}

		throw error;
	}

	const parsedOwner = releaseLockOwnerSchema.safeParse(parseJson(contents));

	if (!parsedOwner.success) {
		throw new ReleaseInstallationLockStateError(lockPath);
	}

	const owner = parsedOwner.data;
	const leasePath = path.join(
		path.dirname(lockPath),
		`.lease-${owner.leaseId}`
	);
	let lease;

	try {
		lease = await stat(leasePath);
	} catch (error) {
		if (!isMissingPathError(error)) {
			throw error;
		}
	}

	if (
		lease !== undefined &&
		Date.now() - lease.mtimeMs <= releaseLockLeaseDurationMs
	) {
		return false;
	}

	const reaperPath = `${lockPath}.reaper-${randomUUID()}`;

	try {
		await link(lockPath, reaperPath);
	} catch (error) {
		if (isMissingPathError(error)) {
			return true;
		}

		if (isPathError(error, 'EEXIST')) {
			return false;
		}

		throw error;
	}

	try {
		if (!(await arePathsSameInode(reaperPath, lockPath))) {
			return false;
		}

		const reaperContents = await readFile(reaperPath, 'utf8');
		const reaperOwner = releaseLockOwnerSchema.safeParse(
			parseJson(reaperContents)
		);

		if (
			!reaperOwner.success ||
			reaperOwner.data.pid !== owner.pid ||
			reaperOwner.data.instanceId !== owner.instanceId ||
			reaperOwner.data.leaseId !== owner.leaseId ||
			!(await hasReleaseLeaseExpired(leasePath))
		) {
			return false;
		}

		const currentProcessStartedAt = await processIdentity(owner.pid, signal);

		if (currentProcessStartedAt === owner.processStartedAt) {
			throw new ReleaseInstallationLockOwnerAliveError(lockPath, owner.pid);
		}

		const wasRemoved = await didRemoveLockIfMatches(reaperPath, lockPath);
		if (wasRemoved) {
			await rm(leasePath, { force: true });
		}

		return wasRemoved;
	} finally {
		await rm(reaperPath, { force: true });
	}
}

async function hasReleaseLeaseExpired(leasePath: string): Promise<boolean> {
	try {
		const lease = await stat(leasePath);
		return Date.now() - lease.mtimeMs > releaseLockLeaseDurationMs;
	} catch (error) {
		if (isMissingPathError(error)) {
			return true;
		}

		throw error;
	}
}

async function cleanupOrphanReleaseReapers(
	paths: ReleaseInstallationPaths
): Promise<void> {
	const entries = await readdir(paths.stateDirectory);
	await Promise.all(
		entries
			.filter(
				(entry) =>
					entry === `${releaseLockName}.reaper` ||
					entry.startsWith(`${releaseLockName}.reaper-`)
			)
			.map((entry) =>
				rm(path.join(paths.stateDirectory, entry), { force: true })
			)
	);
}

async function didRemoveLockIfMatches(
	referencePath: string,
	lockPath: string
): Promise<boolean> {
	if (!(await arePathsSameInode(referencePath, lockPath))) {
		return false;
	}

	try {
		await rm(lockPath);
		return true;
	} catch (error) {
		return isMissingPathError(error);
	}
}

async function arePathsSameInode(
	leftPath: string,
	rightPath: string
): Promise<boolean> {
	try {
		const [left, right] = await Promise.all([
			lstat(leftPath, { bigint: true }),
			lstat(rightPath, { bigint: true })
		]);

		return left.dev === right.dev && left.ino === right.ino;
	} catch (error) {
		if (isMissingPathError(error)) {
			return false;
		}

		throw error;
	}
}

function parseJson(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		return undefined;
	}
}

async function publishReleaseGeneration(
	paths: ReleaseInstallationPaths,
	generationDirectory: string,
	move: RenameFile,
	dependencies: PublishReleaseDependencies,
	syncInstallationDirectory: (directoryPath: string) => Promise<void>,
	releaseLock: ReleaseInstallationLock
): Promise<void> {
	const previousGenerationDirectory = await currentGenerationDirectory(paths);
	const journal: ReleaseInstallationJournal = {
		version: 2,
		generationDirectory,
		...(previousGenerationDirectory !== undefined && {
			previousGenerationDirectory
		})
	};

	await releaseLock.assertOwned();
	await writeDurableJournal(paths, journal);

	await dependencies.publicationHook?.('prepared');

	const nextLink = path.join(
		paths.stateDirectory,
		`.current-${path.basename(generationDirectory)}`
	);

	try {
		const generationTarget = path.relative(
			paths.installDirectory,
			generationDirectory
		);

		await symlink(generationTarget, nextLink);
		dependencies.signal?.throwIfAborted();
		await releaseLock.assertOwned();
		await move(nextLink, paths.currentLink);
		await syncInstallationDirectory(paths.installDirectory);
	} catch (publicationError) {
		if (publicationError instanceof ReleaseInstallationLockLostError) {
			throw publicationError;
		}

		await releaseLock.assertOwned();
		await rollbackReleaseInstallation(paths, journal, move, publicationError);
		throw publicationError;
	} finally {
		await rm(nextLink, { force: true });
	}

	await dependencies.publicationHook?.('activated');
	await ensureReleaseEntryLinks(paths, move);
	await syncInstallationDirectory(paths.installDirectory);
	await finishActivatedReleaseInstallation(paths);
}

async function currentGenerationDirectory(
	paths: ReleaseInstallationPaths
): Promise<string | undefined> {
	try {
		return path.resolve(
			path.dirname(paths.currentLink),
			await readlink(paths.currentLink)
		);
	} catch (error) {
		if (isMissingPathError(error) || isPathError(error, 'EINVAL')) {
			return undefined;
		}

		throw error;
	}
}

async function recoverReleaseInstallation(
	paths: ReleaseInstallationPaths,
	move: RenameFile
): Promise<void> {
	let journal: ReleaseInstallationJournal;

	try {
		journal = releaseInstallationJournalSchema.parse(
			JSON.parse(await readFile(paths.journal, 'utf8'))
		);
	} catch (error) {
		if (isMissingPathError(error)) {
			return;
		}

		throw new ReleaseInstallationStateError(paths.journal, { cause: error });
	}

	assertReleaseInstallationJournalTopology(paths, journal);

	const activeGeneration = await currentGenerationDirectory(paths);

	if (activeGeneration === path.resolve(journal.generationDirectory)) {
		await ensureReleaseEntryLinks(paths, move);
		await finishActivatedReleaseInstallation(paths);
		return;
	}

	await rollbackReleaseInstallation(paths, journal, move);
}

function assertReleaseInstallationJournalTopology(
	paths: ReleaseInstallationPaths,
	journal: ReleaseInstallationJournal
): void {
	const generationDirectory = path.resolve(journal.generationDirectory);
	const previousGenerationDirectory =
		journal.previousGenerationDirectory === undefined
			? undefined
			: path.resolve(journal.previousGenerationDirectory);

	if (
		!isReleaseGenerationDirectory(paths, generationDirectory) ||
		(previousGenerationDirectory !== undefined &&
			(previousGenerationDirectory === generationDirectory ||
				!isReleaseGenerationDirectory(paths, previousGenerationDirectory)))
	) {
		throw new ReleaseInstallationStateError(paths.journal);
	}
}

function isReleaseGenerationDirectory(
	paths: ReleaseInstallationPaths,
	candidate: string
): boolean {
	const name = path.basename(candidate);

	return (
		path.dirname(candidate) === path.resolve(paths.generationsDirectory) &&
		(name.startsWith('generation-') || /^sha256-[a-f\d]{64}$/u.test(name))
	);
}

async function ensureReleaseEntryLinks(
	paths: ReleaseInstallationPaths,
	move: RenameFile
): Promise<void> {
	for (const name of releaseExecutableNames) {
		const destination = path.join(paths.installDirectory, name);
		const expected = path.join(releaseCurrentLinkName, name);

		try {
			if ((await readlink(destination)) === expected) {
				continue;
			}
		} catch (error) {
			if (!isMissingPathError(error) && !isPathError(error, 'EINVAL')) {
				throw error;
			}
		}

		const replacement = path.join(
			paths.stateDirectory,
			`.entry-${name}-${randomUUID()}`
		);

		try {
			await symlink(expected, replacement);
			await move(replacement, destination);
		} finally {
			await rm(replacement, { force: true });
		}
	}
}

async function finishActivatedReleaseInstallation(
	paths: ReleaseInstallationPaths
): Promise<void> {
	const activeGeneration = await currentGenerationDirectory(paths);

	if (
		activeGeneration === undefined ||
		!isReleaseGenerationDirectory(paths, activeGeneration)
	) {
		throw new ReleaseInstallationStateError(paths.currentLink);
	}

	const marker = await open(
		path.join(activeGeneration, releaseActivatedMarkerName),
		'w',
		0o600
	);

	try {
		await marker.writeFile('activated\n');
		await marker.sync();
	} finally {
		await marker.close();
	}

	await syncDirectory(activeGeneration);
	await rm(paths.journal, { force: true });
	await Promise.all([
		syncDirectory(paths.stateDirectory),
		syncDirectory(paths.generationsDirectory)
	]);
}

async function rollbackReleaseInstallation(
	paths: ReleaseInstallationPaths,
	journal: ReleaseInstallationJournal,
	move: RenameFile,
	publicationError?: unknown
): Promise<void> {
	try {
		if (journal.previousGenerationDirectory === undefined) {
			await rm(paths.currentLink, { force: true });
		} else {
			const previousLink = path.join(paths.stateDirectory, '.previous-current');
			const previousTarget = path.relative(
				paths.installDirectory,
				journal.previousGenerationDirectory
			);

			await rm(previousLink, { force: true });
			await symlink(previousTarget, previousLink);
			await move(previousLink, paths.currentLink);
		}

		await syncDirectory(paths.installDirectory);
	} catch (error) {
		const failures =
			publicationError === undefined ? [error] : [publicationError, error];
		throw new ReleaseInstallationRollbackError(paths.journal, {
			cause: new AggregateError(
				failures,
				'Release publication and rollback both failed'
			)
		});
	}

	await rm(paths.journal, { force: true });
	await Promise.all([
		syncDirectory(paths.stateDirectory),
		syncDirectory(paths.generationsDirectory)
	]);
}

async function writeDurableJournal(
	paths: ReleaseInstallationPaths,
	journal: ReleaseInstallationJournal
): Promise<void> {
	const temporary = `${paths.journal}.new`;
	const handle = await open(temporary, 'w', 0o600);

	try {
		await handle.writeFile(`${JSON.stringify(journal)}\n`);
		await handle.sync();
	} finally {
		await handle.close();
	}

	await rename(temporary, paths.journal);
	await syncDirectory(paths.stateDirectory);
}

async function syncReleaseGeneration(
	generationDirectory: string,
	syncInstallationDirectory: (directoryPath: string) => Promise<void>
): Promise<void> {
	for (const name of releaseExecutableNames) {
		const handle = await open(path.join(generationDirectory, name), 'r');

		try {
			await handle.sync();
		} finally {
			await handle.close();
		}
	}

	await syncInstallationDirectory(generationDirectory);
}

async function syncDirectory(directoryPath: string): Promise<void> {
	const directory = await open(directoryPath, constants.O_RDONLY);

	try {
		await directory.sync();
	} finally {
		await directory.close();
	}
}

function isMissingPathError(error: unknown): boolean {
	return isPathError(error, 'ENOENT');
}

function isPathError(error: unknown, code: string): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		error.code === code
	);
}

/**
Require a release archive member to be a runnable regular file.
*/
export async function prepareReleaseExecutable(
	candidate: string
): Promise<void> {
	try {
		const metadata = await lstat(candidate);

		if (!metadata.isFile()) {
			throw new ReleaseInstallationIncompleteError(candidate);
		}

		await chmod(candidate, 0o755);
		await access(candidate, constants.X_OK);
	} catch (error) {
		if (error instanceof ReleaseInstallationIncompleteError) {
			throw error;
		}

		throw new ReleaseInstallationIncompleteError(candidate, { cause: error });
	}
}

async function validateReleaseExecutable(candidate: string): Promise<void> {
	try {
		const metadata = await lstat(candidate);

		if (!metadata.isFile()) {
			throw new ReleaseInstallationIncompleteError(candidate);
		}

		await access(candidate, constants.X_OK);
	} catch (error) {
		if (error instanceof ReleaseInstallationIncompleteError) {
			throw error;
		}

		throw new ReleaseInstallationIncompleteError(candidate, { cause: error });
	}
}

/**
Require a release executable to report the exact selected release tag.
*/
export function assertInstalledReleaseVersion(
	expected: string,
	actual: string
): void {
	if (actual === expected) {
		return;
	}

	throw new InstalledReleaseVersionMismatchError(expected, actual);
}

async function readInstalledCupboardVersion(
	binaryPath: string,
	runCommand: ReleaseCommandRunner,
	signal?: AbortSignal
): Promise<string> {
	const result = await runCommand(binaryPath, ['--version'], {
		captureStdout: true,
		...(signal !== undefined && { signal })
	});

	return result.stdout.trim();
}

export async function fetchRelease(
	octokit: Octokit,
	options: Pick<
		InstallCupboardOptions,
		| 'releaseRepository'
		| 'version'
		| 'includePrereleases'
		| 'expectedSourceCommit'
	>
): Promise<Release> {
	const [owner, repo] = splitRepository(options.releaseRepository);
	const version =
		options.expectedSourceCommit === undefined
			? normaliseVersion(options.version)
			: exactResolvedReleaseTag(options.version);

	if (version === 'latest' && options.includePrereleases) {
		return fetchNewestRelease(octokit, owner, repo);
	}

	const { data } =
		version === 'latest'
			? await octokit.rest.repos.getLatestRelease({ owner, repo })
			: await fetchReleaseByExplicitTag(
					octokit,
					owner,
					repo,
					version,
					options.expectedSourceCommit === undefined
				);
	const parsed = releaseResponseSchema.safeParse(data);

	if (!parsed.success) {
		throw new MalformedReleaseResponseError({ cause: parsed.error });
	}

	return releaseFromResponse(parsed.data);
}

async function fetchReleaseByExplicitTag(
	octokit: Octokit,
	owner: string,
	repo: string,
	tag: string,
	canUseLegacyPrefix: boolean
): ReturnType<Octokit['rest']['repos']['getReleaseByTag']> {
	try {
		return await octokit.rest.repos.getReleaseByTag({ owner, repo, tag });
	} catch (error) {
		const prefixedTag = legacyPrefixedTag(tag);

		if (
			!canUseLegacyPrefix ||
			prefixedTag === undefined ||
			!(error instanceof RequestError) ||
			error.status !== notFoundStatus
		) {
			throw error;
		}

		return octokit.rest.repos.getReleaseByTag({
			owner,
			repo,
			tag: prefixedTag
		});
	}
}

function legacyPrefixedTag(tag: string): string | undefined {
	if (tag.startsWith('v') || semverValid(tag) === null) {
		return undefined;
	}

	return `v${tag}`;
}

// `GET /releases/latest` only returns the latest stable release, so the newest
// prerelease is found by listing releases (newest first) and taking the first
// published one.
async function fetchNewestRelease(
	octokit: Octokit,
	owner: string,
	repo: string
): Promise<Release> {
	const { data } = await octokit.rest.repos.listReleases({
		owner,
		repo,
		per_page: 20
	});

	for (const item of data) {
		if (item.draft) {
			continue;
		}

		const parsed = releaseResponseSchema.safeParse(item);

		if (parsed.success) {
			return releaseFromResponse(parsed.data);
		}
	}

	throw new NoReleaseFoundError(`${owner}/${repo}`);
}

function releaseFromResponse(
	response: z.infer<typeof releaseResponseSchema>
): Release {
	return {
		tagName: response.tag_name,
		assets: response.assets.map((asset) => ({
			name: asset.name,
			url: asset.url
		}))
	};
}

function findReleaseAsset(release: Release, name: string): ReleaseAsset {
	const asset = release.assets.find((candidate) => candidate.name === name);

	if (asset === undefined) {
		throw new ReleaseAssetNotFoundError(release.tagName, name);
	}

	return asset;
}

function findFirstReleaseAsset(
	release: Release,
	names: readonly string[]
): ReleaseAsset {
	for (const name of names) {
		const asset = release.assets.find((candidate) => candidate.name === name);

		if (asset !== undefined) {
			return asset;
		}
	}

	throw new ReleaseAssetNotFoundError(release.tagName, names.join(' or '));
}

/**
Download one release asset while honouring the setup invocation's cancellation.
*/
export async function downloadAsset(
	asset: ReleaseAsset,
	destination: string,
	githubToken: string,
	dependencies: DownloadAssetDependencies = {}
): Promise<DownloadedAsset> {
	dependencies.signal?.throwIfAborted();
	const maximumBytes = dependencies.maximumBytes ?? maximumReleaseAssetBytes;
	const expectedOrigin = dependencies.githubApiOrigin ?? githubApiOrigin({});
	const url = authenticatedReleaseAssetUrl(asset, expectedOrigin);
	const response = await retryingFetcher(dependencies.fetch ?? fetch)(url, {
		headers: requestHeaders(url.origin === expectedOrigin ? githubToken : '', {
			accept: 'application/octet-stream'
		}),
		...(dependencies.signal !== undefined && { signal: dependencies.signal })
	});

	if (!response.ok) {
		await response.body?.cancel();
		throw new GithubApiError(`failed to download ${asset.name}`, {
			status: response.status
		});
	}

	const contentLength = response.headers.get('content-length');
	const declaredBytes =
		contentLength === null ? undefined : Number(contentLength);

	if (
		declaredBytes !== undefined &&
		Number.isFinite(declaredBytes) &&
		declaredBytes > maximumBytes
	) {
		await response.body?.cancel();
		throw new DownloadAssetTooLargeError(
			asset.name,
			maximumBytes,
			declaredBytes
		);
	}

	const body = response.body;
	if (body === null) {
		await writeFile(destination, '', { mode: 0o600 });
		return { bytes: 0, sha256: createHash('sha256').digest('hex') };
	}

	const reader = body.getReader();
	const handle = await open(destination, 'wx', 0o600);
	const digest = createHash('sha256');
	let bytes = 0;
	let downloadError: unknown;
	const abort = (): void => {
		void reader.cancel(dependencies.signal?.reason);
	};
	dependencies.signal?.addEventListener('abort', abort, { once: true });

	try {
		for (;;) {
			dependencies.signal?.throwIfAborted();
			const chunk = await reader.read();
			dependencies.signal?.throwIfAborted();

			if (chunk.done) {
				break;
			}

			bytes += chunk.value.byteLength;
			if (bytes > maximumBytes) {
				await reader.cancel();
				throw new DownloadAssetTooLargeError(asset.name, maximumBytes, bytes);
			}

			digest.update(chunk.value);
			let offset = 0;
			while (offset < chunk.value.byteLength) {
				const written = await handle.write(
					chunk.value,
					offset,
					chunk.value.byteLength - offset
				);
				offset += written.bytesWritten;
			}
		}
	} catch (error) {
		downloadError = error;
	} finally {
		dependencies.signal?.removeEventListener('abort', abort);
		await handle.close();
	}

	if (downloadError !== undefined) {
		await rm(destination, { force: true });
		dependencies.signal?.throwIfAborted();
		throw downloadError instanceof Error
			? downloadError
			: new Error(`failed to download ${asset.name}`, {
					cause: downloadError
				});
	}

	return { bytes, sha256: digest.digest('hex') };
}

function authenticatedReleaseAssetUrl(
	asset: ReleaseAsset,
	expectedOrigin: string
): URL {
	let url: URL;

	try {
		url = new URL(asset.url);
	} catch {
		throw new InvalidReleaseAssetUrlError(asset.name, expectedOrigin);
	}

	if (
		url.protocol !== 'https:' ||
		url.origin !== expectedOrigin ||
		url.username !== '' ||
		url.password !== '' ||
		url.hash !== ''
	) {
		throw new InvalidReleaseAssetUrlError(asset.name, expectedOrigin);
	}

	return url;
}

function verifyChecksum(
	assetName: string,
	actualChecksum: string,
	expectedChecksum: string
): void {
	if (actualChecksum !== expectedChecksum) {
		throw new ChecksumMismatchError(
			assetName,
			expectedChecksum,
			actualChecksum
		);
	}
}

/**
 * Verify that the downloaded archive was built by the release repository's
 * release workflow, and return the source commit the build came from (which
 * equals the commit the tag points at). Throws when no published attestation
 * verifies.
 */
export async function verifyReleaseAttestation(
	options: Omit<InstallCupboardOptions, 'installDirectory'>,
	archivePath: string,
	tagName: string,
	dependencies: VerifyReleaseDependencies = {}
): Promise<string> {
	options.signal?.throwIfAborted();

	const octokit = buildOctokit(options, dependencies.fetch);
	const verify = dependencies.verify ?? verifyBundle;
	const maximumBundleBytes =
		dependencies.maximumBundleBytes ?? maximumAttestationBundleBytes;
	const [owner, repo] = splitRepository(options.releaseRepository);
	const archiveName = path.basename(archivePath);
	const subjectDigest =
		dependencies.subjectDigest ??
		(await (dependencies.hashFile ?? sha256File)(archivePath, options.signal));
	const attestations = await githubRequest(options.signal, () =>
		listAttestations(octokit, owner, repo, subjectDigest)
	);

	if (attestations.length === 0) {
		throw new AttestationNotFoundError(archiveName);
	}

	const tagCommit = await githubRequest(options.signal, () =>
		fetchTagCommit(octokit, owner, repo, tagName)
	);
	const policy = identityPolicy({
		certificateIdentityRegex: releaseWorkflowIdentityRegex(
			options.releaseRepository
		),
		certificateOidcIssuer: githubOidcIssuer
	});
	let lastFailure: unknown;

	for (const attestation of attestations) {
		options.signal?.throwIfAborted();

		try {
			const bundle = await fetchAttestationBundle(
				dependencies.fetch ?? fetch,
				githubApiOrigin(options.environment),
				options.githubToken,
				attestation,
				maximumBundleBytes,
				options.signal
			);
			options.signal?.throwIfAborted();

			await verifyOneReleaseBundle({
				bundle,
				policy,
				verify,
				archiveName,
				subjectDigest,
				tagName,
				tagCommit,
				sourceRepository: options.releaseRepository,
				...(options.signal !== undefined && { signal: options.signal })
			});

			return tagCommit;
		} catch (error) {
			options.signal?.throwIfAborted();
			lastFailure = error;
		}
	}

	throw new AttestationVerificationFailedError(
		archiveName,
		attestations.length,
		{ cause: lastFailure }
	);
}

async function sha256File(
	filePath: string,
	signal?: AbortSignal
): Promise<string> {
	signal?.throwIfAborted();
	const digest = createHash('sha256');
	const stream = createReadStream(filePath, { signal });

	try {
		for await (const chunk of stream) {
			signal?.throwIfAborted();
			digest.update(chunk as Buffer);
		}
	} catch (error) {
		signal?.throwIfAborted();
		throw error;
	}

	return digest.digest('hex');
}

interface ReleaseBundleVerification {
	readonly bundle: Uint8Array;
	readonly policy: VerifiedIdentityPolicy;
	readonly verify: typeof verifyBundle;
	readonly archiveName: string;
	readonly subjectDigest: string;
	readonly tagName: string;
	readonly tagCommit: string;
	readonly sourceRepository: string;
	readonly signal?: AbortSignal;
}

async function verifyOneReleaseBundle(
	options: ReleaseBundleVerification
): Promise<void> {
	options.signal?.throwIfAborted();

	const verified = await options.verify(options.bundle, options.policy, {});
	options.signal?.throwIfAborted();

	if (
		verified.subjectDigests.length !== 1 ||
		verified.subjectDigests[0] !== options.subjectDigest
	) {
		throw new AttestationSubjectMismatchError(
			options.subjectDigest,
			verified.subjectDigests
		);
	}

	resultFor(
		options.archiveName,
		verified,
		options.subjectDigest,
		provenancePredicateType
	);

	const sourceCommit = slsaSourceCommit(
		verified.predicate,
		options.sourceRepository
	);

	if (sourceCommit !== options.tagCommit) {
		throw new AttestationSourceMismatchError(
			options.tagName,
			options.tagCommit,
			sourceCommit
		);
	}
}

const attestationSchema = z
	.strictObject({
		bundle: z.looseObject({}).optional(),
		bundle_url: z.url().optional(),
		initiator: z.string().optional(),
		repository_id: z.number().int().optional()
	})
	.refine(
		(attestation) =>
			attestation.bundle !== undefined || attestation.bundle_url !== undefined,
		{ message: 'must contain bundle or bundle_url' }
	);

const attestationPageSchema = z.strictObject({
	attestations: z.array(attestationSchema).optional()
});

type Attestation = z.infer<typeof attestationSchema>;

const attestationBundleSchema = z.looseObject({});

function attestationBundleBytes(value: unknown): Uint8Array | undefined {
	if (value instanceof ArrayBuffer) {
		return new Uint8Array(value);
	}

	if (ArrayBuffer.isView(value)) {
		return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
	}

	return undefined;
}

function encodeAttestationBundle(
	value: unknown,
	maximumBytes: number
): Uint8Array {
	const parsed = attestationBundleSchema.safeParse(value);

	if (!parsed.success) {
		throw new MalformedReleaseResponseError({ cause: parsed.error });
	}

	const encoded = new TextEncoder().encode(JSON.stringify(parsed.data));

	if (encoded.byteLength > maximumBytes) {
		throw new ReleaseAttestationBundleTooLargeError(
			maximumBytes,
			encoded.byteLength
		);
	}

	return encoded;
}

function decodeSnappyAttestationBundle(
	value: unknown,
	maximumBytes: number
): Uint8Array {
	const compressed = attestationBundleBytes(value);

	if (compressed === undefined) {
		throw new MalformedReleaseResponseError();
	}

	try {
		const uncompressed = uncompressSnappy(compressed, maximumBytes);
		const json = new TextDecoder('utf-8', { fatal: true }).decode(uncompressed);

		return encodeAttestationBundle(JSON.parse(json), maximumBytes);
	} catch (error) {
		if (error instanceof ReleaseAttestationBundleTooLargeError) {
			throw error;
		}

		throw new MalformedReleaseResponseError({ cause: error });
	}
}

function decodeJsonAttestationBundle(
	bytes: Uint8Array,
	maximumBytes: number
): Uint8Array {
	try {
		const json = new TextDecoder('utf-8', { fatal: true }).decode(bytes);

		return encodeAttestationBundle(JSON.parse(json), maximumBytes);
	} catch (error) {
		if (error instanceof ReleaseAttestationBundleTooLargeError) {
			throw error;
		}

		throw new MalformedReleaseResponseError({ cause: error });
	}
}

async function readBoundedAttestationBundle(
	response: Response,
	maximumBytes: number,
	signal?: AbortSignal
): Promise<Uint8Array> {
	const contentLength = response.headers.get('content-length');
	const declaredBytes =
		contentLength === null ? undefined : Number(contentLength);

	if (
		declaredBytes !== undefined &&
		Number.isFinite(declaredBytes) &&
		declaredBytes > maximumBytes
	) {
		await response.body?.cancel();
		throw new ReleaseAttestationBundleTooLargeError(
			maximumBytes,
			declaredBytes
		);
	}

	const body = response.body;
	if (body === null) {
		return new Uint8Array();
	}

	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let byteLength = 0;
	const abort = (): void => {
		void reader.cancel(signal?.reason);
	};
	signal?.addEventListener('abort', abort, { once: true });

	try {
		for (;;) {
			signal?.throwIfAborted();
			const chunk = await reader.read();
			signal?.throwIfAborted();

			if (chunk.done) {
				break;
			}

			byteLength += chunk.value.byteLength;
			if (byteLength > maximumBytes) {
				await reader.cancel();
				throw new ReleaseAttestationBundleTooLargeError(
					maximumBytes,
					byteLength
				);
			}

			chunks.push(chunk.value);
		}
	} finally {
		signal?.removeEventListener('abort', abort);
	}

	const bytes = new Uint8Array(byteLength);
	let offset = 0;

	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}

	return bytes;
}

async function listAttestations(
	octokit: Octokit,
	owner: string,
	repo: string,
	subjectDigest: string
): Promise<readonly Attestation[]> {
	let observedCandidates = 0;
	let observedPages = 0;

	try {
		const attestations = await octokit.paginate(
			octokit.rest.repos.listAttestations,
			{
				owner,
				repo,
				subject_digest: `sha256:${subjectDigest}`,
				predicate_type: provenancePredicateType,
				per_page: releaseAttestationsPerPage
			},
			(response) => {
				const parsed = attestationPageSchema.parse(response.data);
				const page = parsed.attestations ?? [];
				observedCandidates += page.length;
				observedPages += 1;
				const hasNextPage = /(?:^|,)\s*<[^>]+>;[^,]*\brel="next"/u.test(
					response.headers.link ?? ''
				);

				if (
					observedCandidates > maximumReleaseAttestationCandidates ||
					observedPages > maximumReleaseAttestationPages ||
					(hasNextPage && observedPages >= maximumReleaseAttestationPages)
				) {
					throw new ReleaseAttestationSearchTooLargeError(
						maximumReleaseAttestationCandidates,
						maximumReleaseAttestationPages,
						observedCandidates,
						observedPages
					);
				}

				return page;
			}
		);

		return attestations;
	} catch (error) {
		if (error instanceof ReleaseAttestationSearchTooLargeError) {
			throw error;
		}
		if (error instanceof RequestError && error.status === notFoundStatus) {
			return [];
		}
		if (error instanceof z.ZodError) {
			throw new MalformedReleaseResponseError({ cause: error });
		}

		throw new GithubApiError('failed to fetch attestations', {
			status: error instanceof RequestError ? error.status : undefined,
			cause: error
		});
	}
}

async function fetchAttestationBundle(
	fetcher: typeof fetch,
	githubApiOrigin: string,
	githubToken: string,
	attestation: Attestation,
	maximumBytes: number,
	signal?: AbortSignal
): Promise<Uint8Array> {
	if (attestation.bundle !== undefined) {
		return encodeAttestationBundle(attestation.bundle, maximumBytes);
	}

	const bundleUrl = attestation.bundle_url;
	if (bundleUrl === undefined) {
		throw new MalformedReleaseResponseError();
	}

	const url = new URL(bundleUrl);
	if (
		url.protocol !== 'https:' ||
		url.username !== '' ||
		url.password !== '' ||
		url.hash !== ''
	) {
		throw new MalformedReleaseResponseError();
	}

	const headers: Record<string, string> = { ...githubHeaders };
	if (githubToken !== '' && url.origin === githubApiOrigin) {
		headers.authorization = `token ${githubToken}`;
	}

	const response = await retryingFetcher(fetcher)(url, {
		headers,
		...(signal !== undefined && { signal })
	});

	if (!response.ok) {
		await response.body?.cancel();
		throw new GithubApiError('failed to fetch release attestation bundle', {
			status: response.status
		});
	}

	const contentType = response.headers
		.get('content-type')
		?.split(';', 1)[0]
		?.trim()
		.toLowerCase();
	const bytes = await readBoundedAttestationBundle(
		response,
		maximumBytes,
		signal
	);

	if (contentType === 'application/x-snappy') {
		return decodeSnappyAttestationBundle(bytes, maximumBytes);
	}

	return decodeJsonAttestationBundle(bytes, maximumBytes);
}

function githubApiOrigin(environment: Environment): string {
	return new URL(environment.GITHUB_API_URL ?? 'https://api.github.com').origin;
}

export async function fetchTagCommit(
	octokit: Octokit,
	owner: string,
	repo: string,
	tagName: string
): Promise<string> {
	try {
		const { data } = await octokit.rest.repos.getCommit({
			owner,
			repo,
			ref: `tags/${tagName}`
		});

		return data.sha;
	} catch (error) {
		throw new GithubApiError(
			`could not resolve the commit for tag ${tagName}`,
			{
				status: error instanceof RequestError ? error.status : undefined,
				cause: error
			}
		);
	}
}

const repositoryPattern = /^([\w.-]+)\/([\w.-]+)$/u;

export function splitRepository(
	releaseRepository: string
): readonly [string, string] {
	const match = repositoryPattern.exec(releaseRepository);
	const owner = match?.[1];
	const name = match?.[2];

	if (owner === undefined || name === undefined) {
		throw new ReleaseRepositoryInvalidError(releaseRepository);
	}

	return [owner, name];
}

function requestHeaders(
	githubToken: string,
	overrides: Readonly<Record<string, string>> = {}
): Record<string, string> {
	const headers = { ...githubHeaders, ...overrides };

	if (githubToken !== '') {
		headers.authorization = `Bearer ${githubToken}`;
	}

	return headers;
}

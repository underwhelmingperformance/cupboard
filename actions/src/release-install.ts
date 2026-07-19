import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { arch, platform } from 'node:process';

import type { Reporter } from '@cupboard/reporter';
import { createOctokitClient, RequestError } from '@cupboard/shared/octokit';
import { retryingFetcher } from '@cupboard/shared/retry';
import {
	identityPolicy,
	resultFor,
	type VerifiedIdentityPolicy,
	verifyBundle
} from '@cupboard/shared/sigstore';
import { slsaSourceCommit } from '@cupboard/shared/slsa';
import semverValid from 'semver/functions/valid.js';
import { z } from 'zod';

import {
	AttestationNotFoundError,
	AttestationSourceMismatchError,
	AttestationVerificationFailedError,
	ChecksumMismatchError,
	CommandFailedError,
	GithubApiError,
	InvalidChecksumLineError,
	InvalidInputError,
	MalformedReleaseResponseError,
	MissingChecksumError,
	NoReleaseFoundError,
	ReleaseAssetNotFoundError,
	UnsupportedPlatformError
} from './errors.ts';
import { type Environment, parseLines } from './inputs.ts';

interface ReleaseAsset {
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
}

export interface InstalledCupboard {
	readonly binaryPath: string;
	readonly version: string;
}

export const fallbackReleaseRepository = 'cupboard/cupboard';

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

	if (trimmed === 'latest') {
		return 'latest';
	}

	const normalised = trimmed.startsWith('v') ? trimmed : `v${trimmed}`;

	if (semverValid(normalised) === null) {
		throw new InvalidInputError(
			'cupboard-version',
			`cupboard-version must be 'latest' or a release tag like v1.2.3, got '${version}'`
		);
	}

	return normalised;
}

export function assetNameFor(
	tagName: string,
	runtimePlatform: string = platform,
	runtimeArchitecture: string = arch
): string {
	const releasePlatform = releasePlatforms.get(runtimePlatform);
	const releaseArchitecture = releaseArchitectures.get(runtimeArchitecture);

	if (releasePlatform === undefined || releaseArchitecture === undefined) {
		throw new UnsupportedPlatformError(runtimePlatform, runtimeArchitecture);
	}

	return `cupboard-${tagName}-${releasePlatform}-${releaseArchitecture}.tar.gz`;
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
	options: Pick<InstallCupboardOptions, 'githubToken' | 'environment'>,
	fetcher?: typeof fetch
): Octokit {
	return createOctokitClient({
		...(options.githubToken !== '' && { auth: options.githubToken }),
		...(options.environment.GITHUB_API_URL !== undefined && {
			baseUrl: options.environment.GITHUB_API_URL
		}),
		...(fetcher !== undefined && { request: { fetch: fetcher } })
	});
}

interface VerifyReleaseDependencies {
	readonly fetch?: typeof fetch;
	readonly verify?: typeof verifyBundle;
}

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
	reporter: Reporter
): Promise<InstalledCupboard> {
	const release = await reporter.phase(
		'Resolve cupboard release',
		async (phase) => {
			const resolved = await fetchRelease(buildOctokit(options), options);
			phase.fact('Version', resolved.tagName);

			return resolved;
		}
	);

	const assetName = assetNameFor(release.tagName);
	const binaryPath = path.join(options.installDirectory, 'cupboard');
	const asset = findReleaseAsset(release, assetName);
	const checksumAsset = findReleaseAsset(release, 'checksums.txt');
	const archivePath = path.join(options.installDirectory, assetName);
	const checksumsPath = path.join(options.installDirectory, 'checksums.txt');

	await reporter.phase(`Download ${assetName}`, async () => {
		await downloadAsset(asset, archivePath, options.githubToken);
		await downloadAsset(checksumAsset, checksumsPath, options.githubToken);
	});

	await reporter.phase('Verify checksum', async () => {
		const checksums = parseChecksums(await readFile(checksumsPath, 'utf8'));
		const expectedChecksum = checksums.get(assetName);

		if (expectedChecksum === undefined) {
			throw new MissingChecksumError(assetName);
		}

		await verifyChecksum(archivePath, expectedChecksum);
	});

	await reporter.phase('Verify release attestation', async (phase) => {
		const builtFrom = await verifyReleaseAttestation(
			options,
			archivePath,
			release.tagName
		);
		phase.fact('Built from', builtFrom);
	});

	await reporter.phase('Install cupboard binary', async () => {
		run('tar', ['-xzf', archivePath, '-C', options.installDirectory]);
		await chmod(binaryPath, 0o755);
		run(binaryPath, ['--version']);
	});

	return {
		binaryPath,
		version: release.tagName
	};
}

export async function fetchRelease(
	octokit: Octokit,
	options: Pick<
		InstallCupboardOptions,
		'releaseRepository' | 'version' | 'includePrereleases'
	>
): Promise<Release> {
	const [owner, repo] = splitRepository(options.releaseRepository);
	const version = normaliseVersion(options.version);

	if (version === 'latest' && options.includePrereleases) {
		return fetchNewestRelease(octokit, owner, repo);
	}

	const { data } =
		version === 'latest'
			? await octokit.rest.repos.getLatestRelease({ owner, repo })
			: await octokit.rest.repos.getReleaseByTag({ owner, repo, tag: version });
	const parsed = releaseResponseSchema.safeParse(data);

	if (!parsed.success) {
		throw new MalformedReleaseResponseError({ cause: parsed.error });
	}

	return releaseFromResponse(parsed.data);
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

async function downloadAsset(
	asset: ReleaseAsset,
	destination: string,
	githubToken: string
): Promise<void> {
	const response = await retryingFetcher(fetch)(asset.url, {
		headers: requestHeaders(githubToken, {
			accept: 'application/octet-stream'
		})
	});

	if (!response.ok) {
		throw new GithubApiError(`failed to download ${asset.name}`, {
			status: response.status
		});
	}

	const bytes = Buffer.from(await response.arrayBuffer());
	await writeFile(destination, bytes);
}

async function verifyChecksum(
	checksumPath: string,
	expectedChecksum: string
): Promise<void> {
	const actualChecksum = createHash('sha256')
		.update(await readFile(checksumPath))
		.digest('hex');

	if (actualChecksum !== expectedChecksum) {
		throw new ChecksumMismatchError(
			path.basename(checksumPath),
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
	const octokit = buildOctokit(options, dependencies.fetch);
	const verify = dependencies.verify ?? verifyBundle;
	const [owner, repo] = splitRepository(options.releaseRepository);
	const archiveName = path.basename(archivePath);
	const subjectDigest = createHash('sha256')
		.update(await readFile(archivePath))
		.digest('hex');
	const bundles = await fetchAttestationBundles(
		octokit,
		owner,
		repo,
		subjectDigest
	);

	if (bundles.length === 0) {
		throw new AttestationNotFoundError(archiveName);
	}

	const tagCommit = await fetchTagCommit(octokit, owner, repo, tagName);
	const policy = identityPolicy({
		certificateIdentityRegex: releaseWorkflowIdentityRegex(
			options.releaseRepository
		),
		certificateOidcIssuer: githubOidcIssuer
	});
	let lastFailure: unknown;

	for (const bundle of bundles) {
		try {
			await verifyOneReleaseBundle({
				bundle,
				policy,
				verify,
				archiveName,
				subjectDigest,
				tagName,
				tagCommit,
				sourceRepository: options.releaseRepository
			});

			return tagCommit;
		} catch (error) {
			lastFailure = error;
		}
	}

	throw new AttestationVerificationFailedError(archiveName, bundles.length, {
		cause: lastFailure
	});
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
}

async function verifyOneReleaseBundle(
	options: ReleaseBundleVerification
): Promise<void> {
	const verified = await options.verify(options.bundle, options.policy, {});

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

async function fetchAttestationBundles(
	octokit: Octokit,
	owner: string,
	repo: string,
	subjectDigest: string
): Promise<Uint8Array[]> {
	const attestations = await listAttestations(
		octokit,
		owner,
		repo,
		subjectDigest
	);
	const encoder = new TextEncoder();
	const bundles: Uint8Array[] = [];

	for (const attestation of attestations) {
		if (attestation.bundle !== undefined) {
			bundles.push(encoder.encode(JSON.stringify(attestation.bundle)));
		}
	}

	return bundles;
}

async function listAttestations(
	octokit: Octokit,
	owner: string,
	repo: string,
	subjectDigest: string
): Promise<readonly { readonly bundle?: unknown }[]> {
	try {
		const { data } = await octokit.rest.repos.listAttestations({
			owner,
			repo,
			subject_digest: `sha256:${subjectDigest}`,
			predicate_type: provenancePredicateType
		});

		return data.attestations ?? [];
	} catch (error) {
		if (error instanceof RequestError && error.status === 404) {
			return [];
		}

		throw new GithubApiError('failed to fetch attestations', {
			status: error instanceof RequestError ? error.status : undefined,
			cause: error
		});
	}
}

async function fetchTagCommit(
	octokit: Octokit,
	owner: string,
	repo: string,
	tagName: string
): Promise<string> {
	try {
		const { data } = await octokit.rest.repos.getCommit({
			owner,
			repo,
			ref: tagName
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
		throw new InvalidInputError(
			'release-repository',
			`release-repository must be <owner>/<name>, got '${releaseRepository}'`
		);
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

function run(command: string, arguments_: readonly string[]): void {
	const result = spawnSync(command, [...arguments_], { stdio: 'inherit' });

	if (result.error !== undefined) {
		throw new CommandFailedError(command, result.status, result.error.message, {
			cause: result.error
		});
	}

	if (result.status === 0) {
		return;
	}

	throw new CommandFailedError(command, result.status);
}

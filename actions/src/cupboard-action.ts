import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
	appendFile,
	chmod,
	mkdir,
	readFile,
	writeFile
} from 'node:fs/promises';
import path from 'node:path';
import { arch, env, platform } from 'node:process';

import { createOctokitClient } from '@cupboard/shared/octokit';
import {
	identityPolicy,
	resultFor,
	type VerifiedIdentityPolicy,
	verifyBundle
} from '@cupboard/shared/sigstore';
import { slsaSourceCommit } from '@cupboard/shared/slsa';
import semverValid from 'semver/functions/valid.js';

import * as annotations from './annotations.ts';
import {
	AttestationError,
	CachePublicKeyError,
	ChecksumError,
	CommandFailedError,
	GithubApiError,
	InvalidInputError,
	MalformedReleaseResponseError,
	MissingInputError,
	NixError,
	NoReleaseFoundError,
	ReleaseAssetNotFoundError,
	UnknownCommandError,
	UnsupportedPlatformError
} from './errors.ts';

type Environment = Readonly<Record<string, string | undefined>>;

interface ReleaseAsset {
	readonly name: string;
	readonly url: string;
}

interface Release {
	readonly tagName: string;
	readonly assets: readonly ReleaseAsset[];
}

interface SetupInputs {
	readonly version: string;
	readonly includePrereleases: boolean;
	readonly githubToken: string;
	readonly releaseRepository: string;
	readonly installDirectory: string;
	readonly addToPath: boolean;
	readonly cacheUrl: string;
	readonly cache: string;
	readonly trustedPublicKey: string;
	readonly readUser: string;
	readonly readPassword: string;
	readonly nixConfigFile: string;
}

interface PushInputs {
	readonly version: string;
	readonly includePrereleases: boolean;
	readonly githubToken: string;
	readonly releaseRepository: string;
	readonly installDirectory: string;
	readonly url: string;
	readonly paths: readonly string[];
	readonly cache: string;
	readonly audience: string;
	readonly root: string;
	readonly ttl: string;
	readonly wait: boolean;
	readonly waitTimeout: string;
	readonly attestations: readonly string[];
}

interface AttestInputs {
	readonly paths: readonly string[];
	readonly checksumsFile: string;
}

interface StorePathDigest {
	readonly storePath: string;
	readonly sha256: string;
}

interface NixPathInfo {
	readonly storePath: string;
	readonly narHash: string;
}

interface InstallCupboardOptions {
	readonly installDirectory: string;
	readonly releaseRepository: string;
	readonly version: string;
	readonly includePrereleases: boolean;
	readonly githubToken: string;
	readonly environment: Environment;
}

interface InstalledCupboard {
	readonly binaryPath: string;
	readonly version: string;
}

interface ConfigureNixInputs extends SetupInputs {
	readonly environment: Environment;
}

interface NixConfigOptions {
	readonly substituter: string;
	readonly trustedPublicKey: string;
	readonly netrcFile?: string;
}

interface PushArgumentsOptions {
	readonly url: string;
	readonly paths: readonly string[];
	readonly audience: string;
	readonly root: string;
	readonly cache: string;
	readonly ttl: string;
	readonly wait: boolean;
	readonly waitTimeout: string;
	readonly attestations: readonly string[];
}

interface WriteNetrcOptions {
	readonly cacheUrl: string;
	readonly readUser: string;
	readonly readPassword: string;
	readonly runnerTemporaryDirectory: string;
}

const fallbackReleaseRepository = 'cupboard/cupboard';

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

const cacheHeaders: Readonly<Record<string, string>> = {
	accept: 'text/plain',
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

export function parseLines(value: string): string[] {
	return value
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

export function parseChecksums(value: string): Map<string, string> {
	const checksums = new Map<string, string>();

	for (const line of parseLines(value)) {
		const match = /^(?<sha256>[a-f\d]{64})\s+\*?(?<name>.+)$/iu.exec(line);
		const sha256 = match?.groups?.sha256;
		const name = match?.groups?.name;

		if (sha256 === undefined || name === undefined) {
			throw new ChecksumError(`invalid checksum line: ${line}`);
		}

		checksums.set(name, sha256.toLowerCase());
	}

	return checksums;
}

export function cacheUrlFor(baseUrl: string, cache: string): string {
	const trimmedBaseUrl = baseUrl.replace(/\/+$/u, '');

	if (cache.trim() === '') {
		return trimmedBaseUrl;
	}

	return `${trimmedBaseUrl}/cache/${encodeURIComponent(cache.trim())}`;
}

/**
 * The cache's signing-key URL for a cache base URL. The base URL carries the
 * tenant path (`/t/<slug>`), so the key path is appended to the whole URL to
 * keep that path.
 */
export function cachePublicKeyUrl(cacheUrl: string): string {
	return `${cacheUrl.replace(/\/+$/u, '')}/pubkey`;
}

function isHttpUrl(value: string): boolean {
	try {
		const url = new URL(value);

		return url.protocol === 'http:' || url.protocol === 'https:';
	} catch {
		return false;
	}
}

export function renderNixConfig(options: NixConfigOptions): string {
	const lines = [
		`substituters = ${options.substituter}`,
		`trusted-public-keys = ${normaliseTrustedPublicKeys(options.trustedPublicKey)}`
	];

	if (options.netrcFile !== undefined) {
		lines.push(`netrc-file = ${options.netrcFile}`);
	}

	return `${lines.join('\n')}\n`;
}

export function normaliseTrustedPublicKeys(publicKey: string): string {
	return publicKey.split(/\s+/).filter(Boolean).join(' ');
}

export function cachePublicKeyRequestHeaders(): Readonly<
	Record<string, string>
> {
	return cacheHeaders;
}

export function buildPushArguments(
	options: PushArgumentsOptions
): readonly string[] {
	const arguments_ = [
		'--no-colour',
		'push',
		options.url,
		...options.paths,
		'--github-oidc'
	];
	const audience = options[options.audience === '' ? 'url' : 'audience'];

	arguments_.push('--audience', audience);

	if (options.root !== '') {
		arguments_.push('--root', options.root);
	}

	if (options.cache !== '') {
		arguments_.push('--cache', options.cache);
	}

	if (options.ttl !== '') {
		arguments_.push('--ttl', options.ttl);
	}

	if (!options.wait) {
		arguments_.push('--no-wait');
	}

	if (options.waitTimeout !== '') {
		arguments_.push('--wait-timeout', options.waitTimeout);
	}

	for (const attestation of options.attestations) {
		arguments_.push('--attestation', attestation);
	}

	return arguments_;
}

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

export async function setupAction(
	environment: Environment = env
): Promise<void> {
	const inputs = setupInputs(environment);
	const installDirectory = path.resolve(inputs.installDirectory);

	await mkdir(installDirectory, { recursive: true });

	const installedCupboard = await installCupboard({
		installDirectory,
		releaseRepository: inputs.releaseRepository,
		version: inputs.version,
		includePrereleases: inputs.includePrereleases,
		githubToken: inputs.githubToken,
		environment
	});

	if (inputs.addToPath) {
		await appendEnvironmentFile(
			environment.GITHUB_PATH,
			`${installDirectory}\n`
		);
	}

	await setOutput(environment, 'cupboard-path', installedCupboard.binaryPath);
	await setOutput(environment, 'cupboard-version', installedCupboard.version);

	if (inputs.cacheUrl === '') {
		return;
	}

	await configureNix({ ...inputs, environment });
}

export async function pushAction(
	environment: Environment = env
): Promise<void> {
	const inputs = pushInputs(environment);
	const installDirectory = path.resolve(inputs.installDirectory);

	await mkdir(installDirectory, { recursive: true });

	const installedCupboard = await installCupboard({
		installDirectory,
		releaseRepository: inputs.releaseRepository,
		version: inputs.version,
		includePrereleases: inputs.includePrereleases,
		githubToken: inputs.githubToken,
		environment
	});

	const paths = resolveStorePaths(inputs.paths);
	const arguments_ = buildPushArguments({
		url: inputs.url,
		paths,
		audience: inputs.audience,
		root: inputs.root,
		cache: inputs.cache,
		ttl: inputs.ttl,
		wait: inputs.wait,
		waitTimeout: inputs.waitTimeout,
		attestations: inputs.attestations
	});

	await setOutput(environment, 'cupboard-path', installedCupboard.binaryPath);
	await setOutput(environment, 'cupboard-version', installedCupboard.version);
	run(installedCupboard.binaryPath, arguments_);
}

async function installCupboard(
	options: InstallCupboardOptions
): Promise<InstalledCupboard> {
	const release = await fetchRelease(buildOctokit(options), options);
	const assetName = assetNameFor(release.tagName);
	const binaryPath = path.join(options.installDirectory, 'cupboard');

	const asset = findReleaseAsset(release, assetName);
	const checksumAsset = findReleaseAsset(release, 'checksums.txt');
	const archivePath = path.join(options.installDirectory, assetName);
	const checksumsPath = path.join(options.installDirectory, 'checksums.txt');

	await downloadAsset(asset, archivePath, options.githubToken);
	await downloadAsset(checksumAsset, checksumsPath, options.githubToken);

	const checksums = parseChecksums(await readFile(checksumsPath, 'utf8'));
	const expectedChecksum = checksums.get(assetName);

	if (expectedChecksum === undefined) {
		throw new ChecksumError(`checksums.txt does not contain ${assetName}`);
	}

	await verifyChecksum(archivePath, expectedChecksum);
	await verifyReleaseAttestation(options, archivePath, release.tagName);
	run('tar', ['-xzf', archivePath, '-C', options.installDirectory]);
	await chmod(binaryPath, 0o755);
	run(binaryPath, ['--version']);

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

	if (!isReleaseResponse(data)) {
		throw new MalformedReleaseResponseError();
	}

	return releaseFromResponse(data);
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
	const release = data.find((item) => !item.draft && isReleaseResponse(item));

	if (release === undefined) {
		throw new NoReleaseFoundError(`${owner}/${repo}`);
	}

	return releaseFromResponse(release);
}

function releaseFromResponse(response: {
	readonly tag_name: string;
	readonly assets: readonly ReleaseAsset[];
}): Release {
	return {
		tagName: response.tag_name,
		assets: response.assets.map((asset) => ({
			name: asset.name,
			url: asset.url
		}))
	};
}

function isReleaseResponse(value: unknown): value is {
	readonly tag_name: string;
	readonly assets: readonly ReleaseAsset[];
} {
	if (!isRecord(value) || typeof value.tag_name !== 'string') {
		return false;
	}

	if (!Array.isArray(value.assets)) {
		return false;
	}

	return value.assets.every(
		(asset) =>
			isRecord(asset) &&
			typeof asset.name === 'string' &&
			typeof asset.url === 'string'
	);
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
	const response = await fetch(asset.url, {
		headers: requestHeaders(githubToken, {
			accept: 'application/octet-stream'
		})
	});

	if (!response.ok) {
		throw new GithubApiError(
			`failed to download ${asset.name}: ${String(response.status)}`
		);
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
		throw new ChecksumError(
			`checksum mismatch for ${path.basename(checksumPath)}: expected ${expectedChecksum}, got ${actualChecksum}`
		);
	}
}

export async function verifyReleaseAttestation(
	options: Omit<InstallCupboardOptions, 'installDirectory'>,
	archivePath: string,
	tagName: string,
	dependencies: VerifyReleaseDependencies = {}
): Promise<void> {
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
		throw new AttestationError(`no attestation was found for ${archiveName}`);
	}

	const tagCommit = await fetchTagCommit(octokit, owner, repo, tagName);
	const policy = identityPolicy({
		certificateIdentityRegex: releaseWorkflowIdentityRegex(
			options.releaseRepository
		),
		certificateOidcIssuer: githubOidcIssuer
	});
	const failures: string[] = [];

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

			annotations.notice(
				`Verified ${archiveName}: built by the ${options.releaseRepository} release workflow from ${tagCommit}.`
			);

			return;
		} catch (error) {
			failures.push(error instanceof Error ? error.message : String(error));
		}
	}

	throw new AttestationError(
		`could not verify the attestation for ${archiveName}: ${failures.join('; ')}`
	);
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
		throw new AttestationError(
			`built from ${String(sourceCommit)}, but tag ${options.tagName} points at ${options.tagCommit}`
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
			subject_digest: `sha256:${subjectDigest}`
		});

		return data.attestations ?? [];
	} catch (error) {
		if (isStatus(error, 404)) {
			return [];
		}

		throw new GithubApiError(
			`failed to fetch attestations: ${errorStatusText(error)}`
		);
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
			`could not resolve the commit for tag ${tagName}: ${errorStatusText(error)}`
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

function isStatus(error: unknown, status: number): boolean {
	return isRecord(error) && error.status === status;
}

function errorStatusText(error: unknown): string {
	return isRecord(error) && typeof error.status === 'number'
		? String(error.status)
		: 'an unknown error';
}

async function configureNix(inputs: ConfigureNixInputs): Promise<void> {
	const trustedPublicKey =
		inputs.trustedPublicKey === ''
			? await fetchTrustedPublicKey(inputs)
			: inputs.trustedPublicKey;
	const substituter = cacheUrlFor(inputs.cacheUrl, inputs.cache);
	const runnerTemporaryDirectory = requireInput(
		inputs.environment.RUNNER_TEMP,
		'RUNNER_TEMP'
	);
	const netrcFile =
		inputs.readPassword === ''
			? undefined
			: await writeNetrc({
					cacheUrl: inputs.cacheUrl,
					readUser: inputs.readUser,
					readPassword: inputs.readPassword,
					runnerTemporaryDirectory
				});
	const nixConfig = renderNixConfig({
		substituter,
		trustedPublicKey,
		...(netrcFile !== undefined && { netrcFile })
	});
	const generatedConfigFile = path.join(
		runnerTemporaryDirectory,
		'cupboard-nix.conf'
	);

	await writeFile(generatedConfigFile, nixConfig, { mode: 0o600 });
	await appendEnvironmentFile(
		inputs.environment.GITHUB_ENV,
		environmentFileBlock('NIX_CONFIG', nixConfig)
	);
	await setOutput(inputs.environment, 'nix-config-file', generatedConfigFile);

	if (inputs.nixConfigFile !== '') {
		await appendEnvironmentFile(inputs.nixConfigFile, nixConfig);
	}
}

function environmentFileBlock(name: string, value: string): string {
	let delimiter: string;

	do {
		delimiter = `${name}_${randomUUID().replaceAll('-', '_')}`;
	} while (value.includes(delimiter));

	return `${name}<<${delimiter}\n${value}${delimiter}\n`;
}

async function fetchTrustedPublicKey(
	inputs: ConfigureNixInputs
): Promise<string> {
	const response = await fetch(cachePublicKeyUrl(inputs.cacheUrl), {
		headers: cachePublicKeyRequestHeaders()
	});

	if (!response.ok) {
		throw new CachePublicKeyError(
			`failed to fetch cache public key: ${String(response.status)}`
		);
	}

	const publicKey = await response.text();
	const trimmedPublicKey = publicKey.trim();

	if (trimmedPublicKey === '') {
		throw new CachePublicKeyError('cache public key response was empty');
	}

	annotations.warning(
		'No trusted-public-key was supplied; trusting the cache signing key from /pubkey for this run.'
	);

	return trimmedPublicKey;
}

export async function writeNetrc(options: WriteNetrcOptions): Promise<string> {
	const cacheUrl = new URL(options.cacheUrl);
	const host = cacheUrl.host;
	const netrcFile = path.join(
		options.runnerTemporaryDirectory,
		'cupboard-netrc'
	);

	await writeFile(
		netrcFile,
		`machine ${host} login ${options.readUser} password ${options.readPassword}\n`,
		{ mode: 0o600 }
	);
	await chmod(netrcFile, 0o600);

	return netrcFile;
}

function pathInfoEntries(parsed: unknown): readonly unknown[] {
	if (Array.isArray(parsed)) {
		return parsed;
	}

	if (isRecord(parsed)) {
		return Object.entries(parsed).map(([storePath, info]) => ({
			path: storePath,
			...(isRecord(info) && info)
		}));
	}

	return [];
}

function nixPathInfo(storePath: string): NixPathInfo {
	const result = spawnSync(
		'nix',
		['path-info', '--json', '--json-format', '1', storePath],
		{ encoding: 'utf8' }
	);

	if (result.error !== undefined) {
		throw new NixError(
			`nix path-info could not run for ${storePath}: ${result.error.message}`
		);
	}

	if (result.status !== 0) {
		const detail = result.stderr.trim();

		throw new NixError(
			`nix path-info failed for ${storePath}${detail === '' ? '' : `: ${detail}`}`
		);
	}

	const [entry, ...rest] = pathInfoEntries(parseJson(result.stdout));

	if (entry === undefined || rest.length > 0) {
		throw new NixError(
			`nix path-info did not resolve exactly one path for ${storePath}`
		);
	}

	if (
		!isRecord(entry) ||
		typeof entry.path !== 'string' ||
		typeof entry.narHash !== 'string'
	) {
		throw new NixError(`nix path-info gave no NAR hash for ${storePath}`);
	}

	return { storePath: entry.path, narHash: entry.narHash };
}

function resolveStorePaths(paths: readonly string[]): string[] {
	return paths.map((storePath) => nixPathInfo(storePath).storePath);
}

export function narHashToHex(narHash: string): string {
	const sri = /^sha256-(?<base64>[A-Za-z0-9+/=]+)$/u.exec(narHash);
	const base64 = sri?.groups?.base64;

	if (base64 === undefined) {
		throw new NixError(
			`expected an SRI sha256 NAR hash (sha256-<base64>), got ${narHash}`
		);
	}

	const bytes = Buffer.from(base64, 'base64');

	if (bytes.byteLength !== 32) {
		throw new NixError(`NAR hash did not decode to 32 bytes: ${narHash}`);
	}

	return bytes.toString('hex');
}

function resolveStorePathDigests(paths: readonly string[]): StorePathDigest[] {
	return paths.map((storePath) => {
		const info = nixPathInfo(storePath);

		return { storePath: info.storePath, sha256: narHashToHex(info.narHash) };
	});
}

export function renderChecksums(digests: readonly StorePathDigest[]): string {
	return digests
		.map((digest) => `${digest.sha256}  ${path.basename(digest.storePath)}`)
		.join('\n')
		.concat('\n');
}

export function attestInputs(environment: Environment): AttestInputs {
	const paths = parseLines(input(environment, 'PATHS'));

	if (paths.length === 0) {
		throw new InvalidInputError(
			'paths',
			'paths is required and must contain at least one path'
		);
	}

	const checksumsFile = input(environment, 'CHECKSUMS_FILE', () =>
		path.join(
			requireInput(environment.RUNNER_TEMP, 'RUNNER_TEMP'),
			'cupboard-attestations',
			'subjects.txt'
		)
	);

	return { paths, checksumsFile };
}

export async function attestAction(
	environment: Environment = env
): Promise<void> {
	const inputs = attestInputs(environment);
	const digests = resolveStorePathDigests(inputs.paths);
	const checksumsFile = path.resolve(inputs.checksumsFile);

	await mkdir(path.dirname(checksumsFile), { recursive: true });
	await writeFile(checksumsFile, renderChecksums(digests));

	await setOutput(environment, 'checksums-file', checksumsFile);
	await setOutput(environment, 'subject-count', String(digests.length));
}

export function setupInputs(environment: Environment): SetupInputs {
	const readUser = input(environment, 'READ_USER');
	const readPassword = input(environment, 'READ_PASSWORD');

	if (readUser !== '' && readPassword === '') {
		throw new InvalidInputError(
			'read-password',
			'read-password is required when read-user is supplied'
		);
	}

	if (readPassword !== '' && readUser === '') {
		throw new InvalidInputError(
			'read-user',
			'read-user is required when read-password is supplied'
		);
	}

	const cacheUrl = input(environment, 'CACHE_URL');

	if (cacheUrl !== '' && !isHttpUrl(cacheUrl)) {
		throw new InvalidInputError(
			'cache-url',
			`cache-url must be an http(s) URL, got '${cacheUrl}'`
		);
	}

	return {
		version: normaliseVersion(input(environment, 'CUPBOARD_VERSION', 'latest')),
		includePrereleases: isInputEnabled(
			environment,
			'INCLUDE_PRERELEASES',
			true
		),
		githubToken: input(environment, 'GITHUB_TOKEN'),
		releaseRepository: input(
			environment,
			'RELEASE_REPOSITORY',
			environment.GITHUB_ACTION_REPOSITORY ??
				environment.GITHUB_REPOSITORY ??
				fallbackReleaseRepository
		),
		installDirectory: input(environment, 'INSTALL_DIR', () =>
			path.join(
				requireInput(environment.RUNNER_TEMP, 'RUNNER_TEMP'),
				'cupboard-bin'
			)
		),
		addToPath: isInputEnabled(environment, 'ADD_TO_PATH', true),
		cacheUrl,
		cache: input(environment, 'CACHE'),
		trustedPublicKey: input(environment, 'TRUSTED_PUBLIC_KEY'),
		readUser,
		readPassword,
		nixConfigFile: input(environment, 'NIX_CONFIG_FILE')
	};
}

export function pushInputs(environment: Environment): PushInputs {
	const url = input(environment, 'URL');

	if (url === '') {
		throw new MissingInputError('url');
	}

	const paths = parseLines(input(environment, 'PATHS'));

	if (paths.length === 0) {
		throw new InvalidInputError(
			'paths',
			'paths is required and must contain at least one path'
		);
	}

	return {
		version: normaliseVersion(input(environment, 'CUPBOARD_VERSION', 'latest')),
		includePrereleases: isInputEnabled(
			environment,
			'INCLUDE_PRERELEASES',
			true
		),
		githubToken: input(environment, 'GITHUB_TOKEN'),
		releaseRepository: input(
			environment,
			'RELEASE_REPOSITORY',
			environment.GITHUB_ACTION_REPOSITORY ??
				environment.GITHUB_REPOSITORY ??
				fallbackReleaseRepository
		),
		installDirectory: input(environment, 'INSTALL_DIR', () =>
			path.join(
				requireInput(environment.RUNNER_TEMP, 'RUNNER_TEMP'),
				'cupboard-bin'
			)
		),
		url,
		paths,
		cache: input(environment, 'CACHE'),
		audience: input(environment, 'AUDIENCE', url),
		root: input(
			environment,
			'ROOT',
			() =>
				`github:${requireInput(environment.GITHUB_REPOSITORY, 'GITHUB_REPOSITORY')}/${requireInput(environment.GITHUB_REF_NAME, 'GITHUB_REF_NAME')}`
		),
		ttl: input(environment, 'TTL'),
		wait: isInputEnabled(environment, 'WAIT', true),
		waitTimeout: input(environment, 'WAIT_TIMEOUT', '10m'),
		attestations: parseLines(input(environment, 'ATTESTATIONS'))
	};
}

type InputFallback = string | (() => string);

function input(
	environment: Environment,
	name: string,
	fallback: InputFallback = ''
): string {
	const prefixedName = 'INPUT_' + name;
	const value = (environment[prefixedName] ?? environment[name] ?? '').trim();

	if (value !== '') {
		return value;
	}

	return typeof fallback === 'function' ? fallback() : fallback;
}

function isInputEnabled(
	environment: Environment,
	name: string,
	isEnabledByDefault: boolean
): boolean {
	const value = input(
		environment,
		name,
		isEnabledByDefault ? 'true' : 'false'
	).toLowerCase();

	if (value === 'true') {
		return true;
	}

	if (value === 'false') {
		return false;
	}

	throw new InvalidInputError(
		name.toLowerCase().replaceAll('_', '-'),
		`${name.toLowerCase().replaceAll('_', '-')} must be true or false`
	);
}

function requireInput(value: string | undefined, name: string): string {
	if (value === undefined || value === '') {
		throw new MissingInputError(name);
	}

	return value;
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

async function appendEnvironmentFile(
	filePath: string | undefined,
	value: string
): Promise<void> {
	if (filePath === undefined || filePath === '') {
		return;
	}

	await appendFile(filePath, value);
}

async function setOutput(
	environment: Environment,
	name: string,
	value: string
): Promise<void> {
	await appendEnvironmentFile(environment.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function run(command: string, arguments_: readonly string[]): void {
	const result = spawnSync(command, [...arguments_], { stdio: 'inherit' });

	if (result.error !== undefined) {
		throw new CommandFailedError(command, result.status, result.error.message);
	}

	if (result.status === 0) {
		return;
	}

	throw new CommandFailedError(command, result.status);
}

export async function dispatch(
	command: string | undefined,
	environment: Environment = env
): Promise<void> {
	if (command === 'setup') {
		return setupAction(environment);
	}

	if (command === 'push') {
		return pushAction(environment);
	}

	if (command === 'attest') {
		return attestAction(environment);
	}

	throw new UnknownCommandError(command ?? '');
}

function parseJson(value: string): unknown {
	return JSON.parse(value) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

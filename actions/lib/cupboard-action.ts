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
import { pathToFileURL } from 'node:url';

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

interface InstallCupboardOptions {
	readonly installDirectory: string;
	readonly releaseRepository: string;
	readonly version: string;
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

	if (trimmed === '') {
		throw new Error('cupboard-version must not be empty');
	}

	if (trimmed === 'latest') {
		return 'latest';
	}

	return trimmed.startsWith('v') ? trimmed : `v${trimmed}`;
}

export function releaseApiPath(repository: string, version: string): string {
	const normalised = normaliseVersion(version);

	if (normalised === 'latest') {
		return `/repos/${repository}/releases/latest`;
	}

	return `/repos/${repository}/releases/tags/${normalised}`;
}

export function assetNameFor(
	tagName: string,
	runtimePlatform: string = platform,
	runtimeArchitecture: string = arch
): string {
	const releasePlatform = releasePlatforms.get(runtimePlatform);
	const releaseArchitecture = releaseArchitectures.get(runtimeArchitecture);

	if (releasePlatform === undefined || releaseArchitecture === undefined) {
		throw new Error(
			`unsupported release platform: ${runtimePlatform}-${runtimeArchitecture}`
		);
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

		if (match?.groups === undefined) {
			throw new Error(`invalid checksum line: ${line}`);
		}

		checksums.set(match.groups.name, match.groups.sha256.toLowerCase());
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

export function buildAttestationVerifyArguments(
	archivePath: string,
	releaseRepository: string,
	tagName: string
): readonly string[] {
	return [
		'attestation',
		'verify',
		archivePath,
		'--repo',
		releaseRepository,
		'--source-ref',
		`refs/tags/${tagName}`
	];
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
	const release = await fetchRelease({
		releaseRepository: options.releaseRepository,
		version: options.version,
		githubToken: options.githubToken,
		environment: options.environment
	});
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
		throw new Error(`checksums.txt does not contain ${assetName}`);
	}

	await verifyChecksum(archivePath, expectedChecksum);
	verifyArtifactAttestation(
		archivePath,
		options.releaseRepository,
		release.tagName,
		options.githubToken
	);
	run('tar', ['-xzf', archivePath, '-C', options.installDirectory]);
	await chmod(binaryPath, 0o755);
	run(binaryPath, ['--version']);

	return {
		binaryPath,
		version: release.tagName
	};
}

async function fetchRelease(options: InstallCupboardOptions): Promise<Release> {
	const apiUrl = new URL(
		releaseApiPath(options.releaseRepository, options.version),
		`${options.environment.GITHUB_API_URL ?? 'https://api.github.com'}/`
	);
	const response = await fetchJson(apiUrl, options.githubToken);

	if (!isReleaseResponse(response)) {
		throw new Error('GitHub release response had an unexpected shape');
	}

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
		throw new Error(`GitHub release ${release.tagName} has no ${name} asset`);
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
		throw new Error(
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
		throw new Error(
			`checksum mismatch for ${path.basename(checksumPath)}: expected ${expectedChecksum}, got ${actualChecksum}`
		);
	}
}

function verifyArtifactAttestation(
	archivePath: string,
	releaseRepository: string,
	tagName: string,
	githubToken: string
): void {
	const result = spawnSync(
		'gh',
		buildAttestationVerifyArguments(archivePath, releaseRepository, tagName),
		{
			env: {
				...env,
				...(githubToken !== '' && { GH_TOKEN: githubToken })
			},
			stdio: 'inherit'
		}
	);

	if (result.status === 0) {
		return;
	}

	throw new Error(
		`gh attestation verify failed with status ${String(result.status)}`
	);
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
	const pubkeyUrl = new URL('/pubkey', inputs.cacheUrl);
	const response = await fetch(pubkeyUrl, {
		headers: cachePublicKeyRequestHeaders()
	});

	if (!response.ok) {
		throw new Error(
			`failed to fetch cache public key: ${String(response.status)}`
		);
	}

	const publicKey = await response.text();
	const trimmedPublicKey = publicKey.trim();

	if (trimmedPublicKey === '') {
		throw new Error('cache public key response was empty');
	}

	console.warn(
		'No trusted-public-key was supplied; trusting the cache signing key from /pubkey for this run.'
	);

	return trimmedPublicKey;
}

async function writeNetrc(options: WriteNetrcOptions): Promise<string> {
	if (options.readUser === '') {
		throw new Error('read-user is required when read-password is supplied');
	}

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

function resolveStorePaths(paths: readonly string[]): string[] {
	const resolved = [];

	for (const storePath of paths) {
		const result = spawnSync('nix', ['path-info', '--json', storePath], {
			encoding: 'utf8'
		});

		if (result.status !== 0) {
			throw new Error(`nix path-info failed for ${storePath}`);
		}

		const parsed = parseJson(result.stdout);
		const storePaths = Array.isArray(parsed)
			? parsed
			: isRecord(parsed)
				? Object.keys(parsed)
				: [];

		if (storePaths.length !== 1 || typeof storePaths[0] !== 'string') {
			throw new Error(
				`nix path-info did not resolve exactly one path for ${storePath}`
			);
		}

		resolved.push(storePaths[0]);
	}

	return resolved;
}

export function narHashToHex(narHash: string): string {
	const sri = /^sha256-(?<base64>[A-Za-z0-9+/=]+)$/u.exec(narHash);
	const base64 = sri?.groups?.base64;

	if (base64 === undefined) {
		throw new Error(
			`expected an SRI sha256 NAR hash (sha256-<base64>), got ${narHash}`
		);
	}

	const bytes = Buffer.from(base64, 'base64');

	if (bytes.byteLength !== 32) {
		throw new Error(`NAR hash did not decode to 32 bytes: ${narHash}`);
	}

	return bytes.toString('hex');
}

function pathInfoJson(storePath: string): unknown {
	const result = spawnSync('nix', ['path-info', '--json', storePath], {
		encoding: 'utf8'
	});

	if (result.status !== 0) {
		throw new Error(`nix path-info failed for ${storePath}`);
	}

	return parseJson(result.stdout);
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
	return Array.isArray(value);
}

function pathInfoEntries(parsed: unknown): readonly unknown[] {
	if (isUnknownArray(parsed)) {
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

function resolveStorePathDigests(paths: readonly string[]): StorePathDigest[] {
	const resolved: StorePathDigest[] = [];

	for (const storePath of paths) {
		const entries = pathInfoEntries(pathInfoJson(storePath));

		if (entries.length !== 1) {
			throw new Error(
				`nix path-info did not resolve exactly one path for ${storePath}`
			);
		}

		const entry = entries[0];

		if (
			!isRecord(entry) ||
			typeof entry.path !== 'string' ||
			typeof entry.narHash !== 'string'
		) {
			throw new Error(`nix path-info gave no NAR hash for ${storePath}`);
		}

		resolved.push({
			storePath: entry.path,
			sha256: narHashToHex(entry.narHash)
		});
	}

	return resolved;
}

export function renderChecksums(digests: readonly StorePathDigest[]): string {
	return digests
		.map((digest) => `${digest.sha256}  ${path.basename(digest.storePath)}`)
		.join('\n')
		.concat('\n');
}

function attestInputs(environment: Environment): AttestInputs {
	const paths = parseLines(input(environment, 'PATHS'));

	if (paths.length === 0) {
		throw new Error('paths is required and must contain at least one path');
	}

	const checksumsFile = input(
		environment,
		'CHECKSUMS_FILE',
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

function setupInputs(environment: Environment): SetupInputs {
	const readUser = input(environment, 'READ_USER');
	const readPassword = input(environment, 'READ_PASSWORD');

	if (readUser !== '' && readPassword === '') {
		throw new Error('read-password is required when read-user is supplied');
	}

	return {
		version: normaliseVersion(input(environment, 'CUPBOARD_VERSION', 'latest')),
		githubToken: input(environment, 'GITHUB_TOKEN'),
		releaseRepository: input(
			environment,
			'RELEASE_REPOSITORY',
			environment.GITHUB_ACTION_REPOSITORY ??
				environment.GITHUB_REPOSITORY ??
				fallbackReleaseRepository
		),
		installDirectory: input(
			environment,
			'INSTALL_DIR',
			path.join(
				requireInput(environment.RUNNER_TEMP, 'RUNNER_TEMP'),
				'cupboard-bin'
			)
		),
		addToPath: isInputEnabled(environment, 'ADD_TO_PATH', true),
		cacheUrl: input(environment, 'CACHE_URL'),
		cache: input(environment, 'CACHE'),
		trustedPublicKey: input(environment, 'TRUSTED_PUBLIC_KEY'),
		readUser,
		readPassword,
		nixConfigFile: input(environment, 'NIX_CONFIG_FILE')
	};
}

function pushInputs(environment: Environment): PushInputs {
	const url = input(environment, 'URL');

	if (url === '') {
		throw new Error('url is required');
	}

	const paths = parseLines(input(environment, 'PATHS'));

	if (paths.length === 0) {
		throw new Error('paths is required and must contain at least one path');
	}

	return {
		version: normaliseVersion(input(environment, 'CUPBOARD_VERSION', 'latest')),
		githubToken: input(environment, 'GITHUB_TOKEN'),
		releaseRepository: input(
			environment,
			'RELEASE_REPOSITORY',
			environment.GITHUB_ACTION_REPOSITORY ??
				environment.GITHUB_REPOSITORY ??
				fallbackReleaseRepository
		),
		installDirectory: input(
			environment,
			'INSTALL_DIR',
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
			`github:${requireInput(environment.GITHUB_REPOSITORY, 'GITHUB_REPOSITORY')}/${requireInput(environment.GITHUB_REF_NAME, 'GITHUB_REF_NAME')}`
		),
		ttl: input(environment, 'TTL'),
		wait: isInputEnabled(environment, 'WAIT', true),
		waitTimeout: input(environment, 'WAIT_TIMEOUT', '10m'),
		attestations: parseLines(input(environment, 'ATTESTATIONS'))
	};
}

function input(environment: Environment, name: string, fallback = ''): string {
	const prefixedName = 'INPUT_' + name;
	const value = environment[prefixedName] ?? environment[name] ?? fallback;

	return value.trim();
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

	throw new Error(
		`${name.toLowerCase().replaceAll('_', '-')} must be true or false`
	);
}

function requireInput(value: string | undefined, name: string): string {
	if (value === undefined || value === '') {
		throw new Error(`${name} is required`);
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

async function fetchJson(url: URL, githubToken: string): Promise<unknown> {
	const response = await fetch(url, {
		headers: requestHeaders(githubToken)
	});

	if (!response.ok) {
		throw new Error(`GitHub API request failed: ${String(response.status)}`);
	}

	return response.json();
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

	if (result.status === 0) {
		return;
	}

	throw new Error(`${command} failed with status ${String(result.status)}`);
}

async function main(): Promise<void> {
	const command = process.argv[2];

	if (command === 'setup') {
		await setupAction();
		return;
	}

	if (command === 'push') {
		await pushAction();
		return;
	}

	if (command === 'attest') {
		await attestAction();
		return;
	}

	throw new Error('expected setup, push or attest');
}

function parseJson(value: string): unknown {
	return JSON.parse(value) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

if (
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	await main();
}

import { createHash } from 'node:crypto';
import { appendFile, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from 'node:process';
import { pathToFileURL } from 'node:url';

import { cacheUrl, publicKeyUrl } from '@cupboard/nix-store/cache-url';
import { type CacheName, cacheNameSchema } from '@cupboard/nix-store/scalars';
import { canonicalHref, parseBaseUrl } from '@cupboard/nix-store/url';
import {
	CodedError,
	genericExitCode,
	UsageError
} from '@cupboard/shared/errors';
import { createOctokitClient } from '@cupboard/shared/octokit';

type Environment = Readonly<Record<string, string | undefined>>;

type Octokit = ReturnType<typeof createOctokitClient>;

interface AssetSummary {
	readonly id: number;
	readonly name: string;
}

interface ReleaseSummary {
	readonly id: number;
	readonly tagName: string;
	readonly draft: boolean;
	readonly uploadUrl: string;
	readonly htmlUrl: string;
	readonly assets: readonly AssetSummary[];
}

interface DraftReleaseSelection {
	readonly existing: ReleaseSummary | undefined;
	readonly duplicates: readonly ReleaseSummary[];
	readonly published: ReleaseSummary | undefined;
}

interface ChecksumEntry {
	readonly name: string;
	readonly sha256: string;
}

interface CreateDraftBody {
	readonly tag_name: string;
	readonly target_commitish: string;
	readonly name: string;
	readonly body: string;
	readonly draft: true;
	readonly generate_release_notes: true;
}

interface UpdateDraftBody {
	readonly target_commitish: string;
	readonly name: string;
	readonly draft: true;
}

interface CreateDraftOptions {
	readonly version: string;
	readonly commitish: string;
	readonly name: string;
	readonly body: string;
}

interface UpdateDraftOptions {
	readonly commitish: string;
	readonly name: string;
}

interface Repository {
	readonly owner: string;
	readonly repo: string;
}

interface PublishInputs {
	readonly version: string;
	/**
	The cache the release's builds are pushed to, named after the tag.
	*/
	readonly cache: CacheName;
	readonly githubToken: string;
	readonly repository: Repository;
	readonly commitish: string;
	readonly name: string;
	readonly directory: string;
	readonly baseUrl: URL;
}

const fallbackReleaseRepository = 'cupboard/cupboard';
const fallbackCacheUrl = 'https://cupboard.supply/t/cupboard';
const canonicalVersionPattern =
	/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;

export class MissingInputError extends UsageError {
	constructor(public readonly input: string) {
		super(`${input} is required`);
		this.name = 'MissingInputError';
	}
}

export class NonCanonicalVersionError extends UsageError {
	constructor(public readonly version: string) {
		super(
			`version must be canonical (v<major>.<minor>.<patch>), got '${version}'`
		);
		this.name = 'NonCanonicalVersionError';
	}
}

class MalformedRepositoryError extends UsageError {
	constructor(public readonly value: string) {
		super(`repository must be <owner>/<name>, got '${value}'`);
		this.name = 'MalformedRepositoryError';
	}
}

// The diagnostic names the input only, never the value, which may hold a
// credential the workflow meant to keep out of the log.
class MalformedCacheUrlError extends UsageError {
	constructor() {
		super(
			'CACHE_URL must be an http(s) URL without credentials, a query, or a fragment'
		);
		this.name = 'MalformedCacheUrlError';
	}
}

class UnknownCommandError extends UsageError {
	constructor(public readonly command: string) {
		super(`expected 'checksums' or 'publish', got '${command}'`);
		this.name = 'UnknownCommandError';
	}
}

class PublishedReleaseExistsError extends CodedError {
	constructor(public readonly version: string) {
		super(`a published release for ${version} already exists`);
		this.name = 'PublishedReleaseExistsError';
	}
}

export class PublicKeyFetchError extends CodedError {
	constructor(
		public readonly url: string,
		public readonly status: number
	) {
		super(`fetching ${url} failed with status ${String(status)}`);
		this.name = 'PublicKeyFetchError';
	}
}

/**
 * Assert a version is already in the canonical `v<major>.<minor>.<patch>` form
 * the build step resolves it to, returning it unchanged. Canonicalisation lives
 * in the build script alone; the rest of the pipeline only checks the shape.
 */
export function assertCanonicalVersion(version: string): string {
	if (version === '') {
		throw new MissingInputError('version');
	}

	if (!canonicalVersionPattern.test(version)) {
		throw new NonCanonicalVersionError(version);
	}

	return version;
}

export function selectDraftRelease(
	releases: readonly ReleaseSummary[],
	version: string
): DraftReleaseSelection {
	const drafts = releases.filter(
		(release) => release.draft && release.tagName === version
	);

	return {
		existing: drafts[0],
		duplicates: drafts.slice(1),
		published: releases.find(
			(release) => !release.draft && release.tagName === version
		)
	};
}

export function createDraftBody(options: CreateDraftOptions): CreateDraftBody {
	return {
		tag_name: options.version,
		target_commitish: options.commitish,
		name: options.name,
		body: options.body,
		draft: true,
		generate_release_notes: true
	};
}

type FetchLike = (
	url: string
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/**
The cache signing key the deployment serves at `/pubkey`.
*/
export async function fetchCachePublicKey(
	baseUrl: URL,
	fetchLike: FetchLike = fetch
): Promise<string> {
	const url = canonicalHref(publicKeyUrl(baseUrl));
	const response = await fetchLike(url);

	if (!response.ok) {
		throw new PublicKeyFetchError(url, response.status);
	}

	const key = await response.text();

	return key.trim();
}

/**
 * The release-notes section pointing readers at the release's binary cache.
 * GitHub appends the generated notes after this body, so the draft carries the
 * section from the start; publishing the release fires the release-cache
 * workflow, which fills the cache the section names.
 */
export function substituterSection(options: {
	readonly baseUrl: URL;
	readonly cache: CacheName;
	readonly publicKey: string;
}): string {
	return [
		'## Substitute from the release cache',
		'',
		'This release is in a Nix binary cache. Add these lines to nix.conf to',
		'fetch it instead of building:',
		'',
		'```',
		// A substituter is matched by exact string, so the URL is rendered in its
		// one canonical form.
		`extra-substituters = ${canonicalHref(cacheUrl(options.baseUrl, options.cache))}`,
		`extra-trusted-public-keys = ${options.publicKey}`,
		'```'
	].join('\n');
}

export function updateDraftBody(options: UpdateDraftOptions): UpdateDraftBody {
	return {
		target_commitish: options.commitish,
		name: options.name,
		draft: true
	};
}

export function assetContentType(assetName: string): string {
	if (assetName.endsWith('.tar.gz')) {
		return 'application/gzip';
	}

	if (assetName.endsWith('.txt')) {
		return 'text/plain; charset=utf-8';
	}

	return 'application/octet-stream';
}

export function checksumTargets(fileNames: readonly string[]): string[] {
	return fileNames
		.filter((name) => name.endsWith('.tar.gz'))
		.toSorted(compareStrings);
}

function compareStrings(a: string, b: string): number {
	if (a < b) {
		return -1;
	}

	return a > b ? 1 : 0;
}

export function renderChecksums(entries: readonly ChecksumEntry[]): string {
	return entries
		.map((entry) => `${entry.sha256}  ${entry.name}`)
		.join('\n')
		.concat('\n');
}

export async function checksumsAction(
	environment: Environment = env
): Promise<void> {
	const directory = path.resolve(
		requireInput(input(environment, 'DIRECTORY'), 'directory')
	);
	const checksumsFile = path.join(directory, 'checksums.txt');
	const targets = checksumTargets(await readdir(directory));
	const entries: ChecksumEntry[] = [];

	for (const name of targets) {
		const sha256 = createHash('sha256')
			.update(await readFile(path.join(directory, name)))
			.digest('hex');

		entries.push({ name, sha256 });
	}

	await writeFile(checksumsFile, renderChecksums(entries));
	await setOutput(environment, 'checksums-file', checksumsFile);

	log(`Wrote checksums for ${String(entries.length)} archive(s)`);
}

export async function publishAction(
	environment: Environment = env
): Promise<void> {
	const inputs = publishInputs(environment);
	const octokit = createOctokitClient(
		inputs.githubToken === '' ? {} : { auth: inputs.githubToken }
	);

	log(
		`Publishing ${inputs.version} to ${inputs.repository.owner}/${inputs.repository.repo}`
	);

	const selection = selectDraftRelease(
		await listReleases(octokit, inputs.repository),
		inputs.version
	);

	if (selection.published !== undefined) {
		throw new PublishedReleaseExistsError(inputs.version);
	}

	for (const duplicate of selection.duplicates) {
		log(`Removing duplicate draft release #${String(duplicate.id)}`);
		await octokit.rest.repos.deleteRelease({
			...inputs.repository,
			release_id: duplicate.id
		});
	}

	const body = substituterSection({
		baseUrl: inputs.baseUrl,
		cache: inputs.cache,
		publicKey: await fetchCachePublicKey(inputs.baseUrl)
	});

	const release = await upsertDraft(octokit, inputs, body, selection.existing);
	const assetFiles = await readdir(inputs.directory);
	const assetNames = assetFiles.toSorted(compareStrings);

	for (const assetName of assetNames) {
		await uploadReleaseAsset(octokit, inputs, release, assetName);
	}

	await setOutput(environment, 'release-id', String(release.id));
	await setOutput(environment, 'release-url', release.htmlUrl);

	log(`Draft release ready: ${release.htmlUrl}`);
}

async function listReleases(
	octokit: Octokit,
	repository: Repository
): Promise<ReleaseSummary[]> {
	const { data } = await octokit.rest.repos.listReleases({
		...repository,
		per_page: 100
	});

	return data.map((release) => toReleaseSummary(release));
}

async function upsertDraft(
	octokit: Octokit,
	inputs: PublishInputs,
	body: string,
	existing: ReleaseSummary | undefined
): Promise<ReleaseSummary> {
	if (existing === undefined) {
		log(`Creating draft release ${inputs.version}`);
		const { data } = await octokit.rest.repos.createRelease({
			...inputs.repository,
			...createDraftBody({
				version: inputs.version,
				commitish: inputs.commitish,
				name: inputs.name,
				body
			})
		});

		return toReleaseSummary(data);
	}

	log(`Updating draft release ${inputs.version} (#${String(existing.id)})`);
	const { data } = await octokit.rest.repos.updateRelease({
		...inputs.repository,
		release_id: existing.id,
		...updateDraftBody({ commitish: inputs.commitish, name: inputs.name })
	});

	return toReleaseSummary(data);
}

async function uploadReleaseAsset(
	octokit: Octokit,
	inputs: PublishInputs,
	release: ReleaseSummary,
	assetName: string
): Promise<void> {
	const existingAsset = release.assets.find(
		(asset) => asset.name === assetName
	);

	if (existingAsset !== undefined) {
		await octokit.rest.repos.deleteReleaseAsset({
			...inputs.repository,
			asset_id: existingAsset.id
		});
	}

	log(
		`${existingAsset === undefined ? 'Uploading' : 'Replacing'} ${assetName}`
	);

	const data = await readFile(path.join(inputs.directory, assetName));

	await octokit.request(`POST ${release.uploadUrl}`, {
		name: assetName,
		data,
		headers: { 'content-type': assetContentType(assetName) }
	});
}

function toReleaseSummary(release: {
	readonly id: number;
	readonly tag_name: string;
	readonly draft: boolean;
	readonly upload_url: string;
	readonly html_url: string;
	readonly assets: readonly { readonly id: number; readonly name: string }[];
}): ReleaseSummary {
	return {
		id: release.id,
		tagName: release.tag_name,
		draft: release.draft,
		uploadUrl: release.upload_url,
		htmlUrl: release.html_url,
		assets: release.assets.map((asset) => ({ id: asset.id, name: asset.name }))
	};
}

function publishInputs(environment: Environment): PublishInputs {
	const version = assertCanonicalVersion(input(environment, 'VERSION'));

	return {
		version,
		cache: releaseCache(version),
		githubToken: input(environment, 'GITHUB_TOKEN'),
		repository: parseRepository(
			input(
				environment,
				'RELEASE_REPOSITORY',
				environment.GITHUB_REPOSITORY ?? fallbackReleaseRepository
			)
		),
		commitish: requireInput(
			input(environment, 'COMMITISH', environment.GITHUB_SHA ?? ''),
			'commitish'
		),
		name: input(environment, 'NAME', version),
		directory: path.resolve(
			requireInput(input(environment, 'DIRECTORY'), 'directory')
		),
		baseUrl: parseCacheUrl(input(environment, 'CACHE_URL', fallbackCacheUrl))
	};
}

// The release-cache workflow names the cache after the tag, so a tag that
// cannot name a cache would point readers at a substituter no deployment can
// serve.
function releaseCache(version: string): CacheName {
	const parsed = cacheNameSchema.safeParse(version);

	if (!parsed.success) {
		throw new NonCanonicalVersionError(version);
	}

	return parsed.data;
}

// Every release URL derives from this base's origin and path alone, so it is
// checked once here and the builders take the result on trust.
function parseCacheUrl(value: string): URL {
	try {
		return parseBaseUrl(new URL(value));
	} catch {
		throw new MalformedCacheUrlError();
	}
}

function parseRepository(value: string): Repository {
	const slash = value.indexOf('/');

	if (slash <= 0 || slash === value.length - 1) {
		throw new MalformedRepositoryError(value);
	}

	return { owner: value.slice(0, slash), repo: value.slice(slash + 1) };
}

function input(environment: Environment, name: string, fallback = ''): string {
	const value = environment['INPUT_' + name] ?? environment[name] ?? fallback;

	return value.trim();
}

function requireInput(value: string, name: string): string {
	if (value === '') {
		throw new MissingInputError(name);
	}

	return value;
}

async function setOutput(
	environment: Environment,
	name: string,
	value: string
): Promise<void> {
	const filePath = environment.GITHUB_OUTPUT;

	if (filePath === undefined || filePath === '') {
		return;
	}

	await appendFile(filePath, `${name}=${value}\n`);
}

function log(message: string): void {
	console.log(message);
}

async function main(): Promise<void> {
	const command = process.argv[2];

	if (command === 'checksums') {
		await checksumsAction();
		return;
	}

	if (command === 'publish') {
		await publishAction();
		return;
	}

	throw new UnknownCommandError(command ?? '');
}

if (
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	try {
		await main();
	} catch (error: unknown) {
		if (error instanceof CodedError) {
			console.error(error.message);
			process.exitCode = error.exitCode;
		} else {
			console.error(error);
			process.exitCode = genericExitCode;
		}
	}
}

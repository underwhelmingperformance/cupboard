import { createHash } from 'node:crypto';
import { appendFile, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { cacheUrl, publicKeyUrl } from '@cupboard/nix-store/cache-url';
import { NixConfig } from '@cupboard/nix-store/nix-config';
import {
	type NixPublicKey,
	parsePublishedNixPublicKeys
} from '@cupboard/nix-store/public-key';
import { cacheNameSchema } from '@cupboard/nix-store/scalars';
import { canonicalHref, parseBaseUrl } from '@cupboard/nix-store/url';
import { discardResponseBody } from '@cupboard/shared/cleanup';
import {
	CodedError,
	genericExitCode,
	UsageError
} from '@cupboard/shared/errors';
import {
	createOctokitClient,
	filterGithubReleases
} from '@cupboard/shared/octokit';
import { readResponseText } from '@cupboard/shared/response-body';
import { type Document, isMap, parseDocument } from 'yaml';

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
	readonly body: string;
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
	readonly body: string;
	readonly draft: true;
}

interface CreateDraftOptions {
	readonly version: string;
	readonly repository: Repository;
	readonly commitish: string;
	readonly name: string;
	readonly body: string;
}

interface UpdateDraftOptions {
	readonly commitish: string;
	readonly name: string;
	readonly version: string;
	readonly repository: Repository;
	readonly body: string;
}

interface Repository {
	readonly owner: string;
	readonly repo: string;
}

interface PublishInputs {
	readonly version: string;
	readonly githubToken: string;
	readonly repository: Repository;
	readonly commitish: string;
	readonly name: string;
	readonly directory: string;
	readonly baseUrl: URL;
}

const fallbackReleaseRepository = 'cupboard/cupboard';
const fallbackCacheUrl = 'https://cupboard.supply/t/cupboard';
const releaseCacheName = cacheNameSchema.parse('releases');
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
		super(
			`expected 'prepare', 'check-preparation', 'checksums' or 'publish', got '${command}'`
		);
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

export interface ReleaseSources {
	readonly workflow: string;
	readonly upgradeNotes: string;
}

export class ReleasePreparationError extends UsageError {
	constructor(detail: string) {
		super(`Release preparation failed: ${detail}`);
		this.name = 'ReleasePreparationError';
	}
}

const releaseWorkflow =
	'underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml';
const releaseUsesPath = ['jobs', 'publish', 'uses'];
const releaseOverridePath = ['jobs', 'publish', 'with', 'cupboard-version'];
const pendingReleaseHeading = /^## Next release(?=[\t ]*\r?$)/gmu;

/**
Prepares and checks the source references for one canonical release tag.
*/
export class ReleasePreparation {
	readonly version: string;
	readonly workflowReference: string;
	readonly trustWorkflowReference: string;

	constructor(version: string) {
		this.version = assertCanonicalVersion(version);
		this.workflowReference = `${releaseWorkflow}@${this.version}`;
		this.trustWorkflowReference = `${releaseWorkflow}@refs/tags/${this.version}`;
	}

	prepare(sources: ReleaseSources): ReleaseSources {
		const document = releaseWorkflowDocument(sources.workflow);
		const pending = sources.upgradeNotes
			.matchAll(pendingReleaseHeading)
			.toArray();
		if (pending.length > 1) {
			throw new ReleasePreparationError(
				'upgrade notes contain several Next release headings'
			);
		}
		if (
			pending.length > 0 &&
			sources.upgradeNotes
				.split(/\r?\n/u)
				.some((line) => line.trimEnd() === `## ${this.version}`)
		) {
			throw new ReleasePreparationError(
				`upgrade notes already contain ${this.version}`
			);
		}
		document.setIn(releaseUsesPath, this.workflowReference);
		document.deleteIn(releaseOverridePath);
		const prepared = {
			workflow: document.toString({
				lineWidth: 0,
				flowCollectionPadding: false
			}),
			upgradeNotes: sources.upgradeNotes.replaceAll(
				pendingReleaseHeading,
				() => `## ${this.version}`
			)
		};
		this.check(prepared);
		return prepared;
	}

	check(sources: ReleaseSources): void {
		const document = releaseWorkflowDocument(sources.workflow);
		if (document.getIn(releaseUsesPath) !== this.workflowReference) {
			throw new ReleasePreparationError(
				`release-cache.yml must call ${this.workflowReference}; run release.ts prepare with VERSION=${this.version} and commit the preparation`
			);
		}
		if (document.hasIn(releaseOverridePath)) {
			throw new ReleasePreparationError(
				'release-cache.yml must omit cupboard-version so the CLI uses the called workflow revision'
			);
		}
		if (!sources.upgradeNotes.matchAll(pendingReleaseHeading).next().done) {
			throw new ReleasePreparationError(
				'version the Next release upgrade notes before releasing'
			);
		}
	}
}

function releaseWorkflowDocument(workflow: string): Document {
	const document = parseDocument(workflow, { uniqueKeys: true });
	const reference = document.getIn(releaseUsesPath);
	if (
		typeof reference !== 'string' ||
		document.errors.length > 0 ||
		!isMap(document.getIn(['jobs', 'publish', 'with'])) ||
		!reference.startsWith(`${releaseWorkflow}@`)
	) {
		throw new ReleasePreparationError(
			'release-cache.yml must contain the Cupboard publish job and its inputs in valid YAML'
		);
	}
	return document;
}

interface ReleaseFiles {
	readonly workflowPath: string;
	readonly upgradeNotesPath: string;
	readonly sources: ReleaseSources;
}

async function readReleaseFiles(
	environment: Environment
): Promise<ReleaseFiles> {
	const scriptDirectory = fileURLToPath(new URL('..', import.meta.url));
	const directory = path.resolve(
		input(environment, 'REPOSITORY_DIRECTORY', scriptDirectory)
	);
	const workflowPath = path.join(
		directory,
		'.github/workflows/release-cache.yml'
	);
	const upgradeNotesPath = path.join(
		directory,
		'docs/operator/upgrade-notes.md'
	);
	const [workflow, upgradeNotes] = await Promise.all([
		readFile(workflowPath, 'utf8'),
		readFile(upgradeNotesPath, 'utf8')
	]);
	return {
		workflowPath,
		upgradeNotesPath,
		sources: { workflow, upgradeNotes }
	};
}

export async function prepareAction(
	environment: Environment = env
): Promise<void> {
	const preparation = new ReleasePreparation(input(environment, 'VERSION'));
	const files = await readReleaseFiles(environment);
	const sources = preparation.prepare(files.sources);
	await writeFile(files.workflowPath, sources.workflow);
	await writeFile(files.upgradeNotesPath, sources.upgradeNotes);
	log(
		`Prepared ${preparation.version}. Commit the release workflow and upgrade notes before dispatching the release.`
	);
	log(
		`Release trust rule job_workflow_ref: ${preparation.trustWorkflowReference}`
	);
	log(
		'Add a reviewed replacement release trust rule with this selector before disabling the preceding release rule. Preserve its other claims and grants.'
	);
}

export async function checkPreparationAction(
	environment: Environment = env
): Promise<void> {
	const preparation = new ReleasePreparation(input(environment, 'VERSION'));
	const files = await readReleaseFiles(environment);
	preparation.check(files.sources);
	log(`Release preparation matches ${preparation.version}.`);
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
		body: withUpgradeNotes(options),
		draft: true,
		generate_release_notes: true
	};
}

type FetchLike = (url: string) => Promise<Response>;

const maximumPublishedKeyBytes = 64 * 1024;

/**
 * Fetches all public keys published by the release cache at `/pubkey`. During a
 * key rotation the endpoint lists more than one key. A client's
 * `trusted-public-keys` must list all of them, because a path may be signed
 * with any of them.
 */
export async function fetchCachePublicKeys(
	baseUrl: URL,
	fetchLike: FetchLike = fetch
): Promise<readonly NixPublicKey[]> {
	const url = canonicalHref(publicKeyUrl(baseUrl));
	const response = await fetchLike(url);

	if (!response.ok) {
		await discardResponseBody(response);
		throw new PublicKeyFetchError(url, response.status);
	}

	const key = await readResponseText(response, {
		description: 'cache public key',
		maximumBytes: maximumPublishedKeyBytes
	});

	return parsePublishedNixPublicKeys(key);
}

export function substituterSection(options: {
	readonly baseUrl: URL;
	readonly publicKeys: readonly NixPublicKey[];
}): string {
	const nixConfig = new NixConfig(
		cacheUrl(options.baseUrl, { kind: 'named', name: releaseCacheName }),
		options.publicKeys.map((publicKey) => publicKey.value).join(' ')
	);

	return [
		'## Substitute from the release cache',
		'',
		'Cupboard publishes every versioned release to one Nix binary cache.',
		'Configure it once in nix.conf to fetch releases instead of building:',
		'',
		'```',
		nixConfig.render().trimEnd(),
		'```'
	].join('\n');
}

export function updateDraftBody(options: UpdateDraftOptions): UpdateDraftBody {
	return {
		target_commitish: options.commitish,
		name: options.name,
		body: withUpgradeNotes(options),
		draft: true
	};
}

function withUpgradeNotes(options: {
	readonly body: string;
	readonly version: string;
	readonly repository: Repository;
}): string {
	const { owner, repo } = options.repository;
	const url = `https://github.com/${owner}/${repo}/blob/${options.version}/docs/operator/upgrade-notes.md`;

	if (options.body.includes(url)) {
		return options.body;
	}

	const reference = `cupboard-upgrade-notes-${options.version}`;
	const separator = options.body === '' ? '' : '\n\n';

	return (
		`${options.body}${separator}` +
		`Before upgrading an existing deployment, read the [${options.version} upgrade notes][${reference}].\n\n` +
		`[${reference}]: ${url}`
	);
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
	const files = await readReleaseFiles(environment);
	new ReleasePreparation(inputs.version).check(files.sources);
	const octokit = createOctokitClient(
		inputs.githubToken === '' ? {} : { auth: inputs.githubToken }
	);

	log(
		`Publishing ${inputs.version} to ${inputs.repository.owner}/${inputs.repository.repo}`
	);

	const selection = selectDraftRelease(
		await listReleases(octokit, inputs.repository, inputs.version),
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
		publicKeys: await fetchCachePublicKeys(inputs.baseUrl)
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
	repository: Repository,
	version: string
): Promise<ReleaseSummary[]> {
	const releases = await filterGithubReleases(
		octokit,
		repository,
		(release) => release.tag_name === version
	);

	return releases.map((release) => toReleaseSummary(release));
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
				repository: inputs.repository,
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
		...updateDraftBody({
			commitish: inputs.commitish,
			name: inputs.name,
			version: inputs.version,
			repository: inputs.repository,
			body: existing.body
		})
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
	readonly body?: string | null;
	readonly assets: readonly { readonly id: number; readonly name: string }[];
}): ReleaseSummary {
	return {
		id: release.id,
		tagName: release.tag_name,
		draft: release.draft,
		uploadUrl: release.upload_url,
		htmlUrl: release.html_url,
		body: release.body ?? '',
		assets: release.assets.map((asset) => ({ id: asset.id, name: asset.name }))
	};
}

function publishInputs(environment: Environment): PublishInputs {
	const version = assertCanonicalVersion(input(environment, 'VERSION'));

	return {
		version,
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

	if (command === 'prepare') {
		await prepareAction();
		return;
	}

	if (command === 'check-preparation') {
		await checkPreparationAction();
		return;
	}

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

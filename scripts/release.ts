import { createHash } from 'node:crypto';
import { appendFile, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from 'node:process';
import { pathToFileURL } from 'node:url';

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
	readonly githubToken: string;
	readonly repository: Repository;
	readonly commitish: string;
	readonly name: string;
	readonly directory: string;
}

const fallbackReleaseRepository = 'cupboard/cupboard';

export function normaliseVersion(version: string): string {
	const trimmed = version.trim();

	if (trimmed === '') {
		throw new Error('version must not be empty');
	}

	return trimmed.startsWith('v') ? trimmed : `v${trimmed}`;
}

export function selectDraftRelease(
	releases: readonly ReleaseSummary[],
	version: string
): DraftReleaseSelection {
	const normalised = normaliseVersion(version);
	const drafts = releases.filter(
		(release) => release.draft && release.tagName === normalised
	);

	return {
		existing: drafts[0],
		duplicates: drafts.slice(1),
		published: releases.find(
			(release) => !release.draft && release.tagName === normalised
		)
	};
}

export function createDraftBody(options: CreateDraftOptions): CreateDraftBody {
	return {
		tag_name: normaliseVersion(options.version),
		target_commitish: options.commitish,
		name: options.name,
		draft: true,
		generate_release_notes: true
	};
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
}

export async function publishAction(
	environment: Environment = env
): Promise<void> {
	const inputs = publishInputs(environment);
	const octokit = createOctokitClient(
		inputs.githubToken === '' ? {} : { auth: inputs.githubToken }
	);
	const selection = selectDraftRelease(
		await listReleases(octokit, inputs.repository),
		inputs.version
	);

	if (selection.published !== undefined) {
		throw new Error(`a published release for ${inputs.version} already exists`);
	}

	for (const duplicate of selection.duplicates) {
		await octokit.rest.repos.deleteRelease({
			...inputs.repository,
			release_id: duplicate.id
		});
	}

	const release = await upsertDraft(octokit, inputs, selection.existing);
	const assetFiles = await readdir(inputs.directory);
	const assetNames = assetFiles.toSorted(compareStrings);

	for (const assetName of assetNames) {
		await uploadReleaseAsset(octokit, inputs, release, assetName);
	}

	await setOutput(environment, 'release-id', String(release.id));
	await setOutput(environment, 'release-url', release.htmlUrl);
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
	existing: ReleaseSummary | undefined
): Promise<ReleaseSummary> {
	if (existing === undefined) {
		const { data } = await octokit.rest.repos.createRelease({
			...inputs.repository,
			...createDraftBody({
				version: inputs.version,
				commitish: inputs.commitish,
				name: inputs.name
			})
		});

		return toReleaseSummary(data);
	}

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
	const version = normaliseVersion(
		requireInput(input(environment, 'VERSION'), 'version')
	);

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
		)
	};
}

function parseRepository(value: string): Repository {
	const slash = value.indexOf('/');

	if (slash <= 0 || slash === value.length - 1) {
		throw new Error(`repository must be <owner>/<name>, got '${value}'`);
	}

	return { owner: value.slice(0, slash), repo: value.slice(slash + 1) };
}

function input(environment: Environment, name: string, fallback = ''): string {
	const value = environment['INPUT_' + name] ?? environment[name] ?? fallback;

	return value.trim();
}

function requireInput(value: string, name: string): string {
	if (value === '') {
		throw new Error(`${name} is required`);
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

	throw new Error('expected checksums or publish');
}

if (
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	await main();
}

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from 'node:process';

import { withReadAuthentication } from '@cupboard/nix';
import type { NixSha256Hash } from '@cupboard/nix-store/hash';
import { NarInfo } from '@cupboard/nix-store/narinfo';
import {
	type CacheScope,
	storePathBasenameSchema,
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { canonicalHref } from '@cupboard/nix-store/url';
import {
	type BuildReceipt,
	buildReceiptSchema,
	type BuildSubjectV3Input
} from '@cupboard/protocol/build';
import { scaiPredicateType } from '@cupboard/protocol/scai';
import { createGithubReporter, type Reporter } from '@cupboard/reporter';
import { discardResponseBody } from '@cupboard/shared/cleanup';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';
import {
	basicAuthHeader,
	type BasicCredential,
	type ReadUser
} from '@cupboard/shared/http';
import { fetchWithProbeRetries } from '@cupboard/shared/paging';
import { readResponseText } from '@cupboard/shared/response-body';
import { retryingFetcher } from '@cupboard/shared/retry';
import type { Command } from 'commander';
import { StatusCodes } from 'http-status-codes';

import type {
	AttestationSubject,
	DestinationAccess
} from '../attestation-signing.ts';
import {
	AttestationSubjectNotAcceptedError,
	CacheAccessProbeError,
	CommittedSubjectInvalidError,
	CommittedSubjectUnavailableError,
	MissingInputError,
	ReadPasswordRequiredError,
	ReadUserRequiredError,
	SubjectNarHashMovedError
} from '../errors.ts';
import { type Environment, requireEnvironment, setOutput } from '../inputs.ts';
import {
	provided,
	providedCacheSelection,
	providedReadUser,
	providedUrl
} from '../options.ts';
import {
	type ReproducedSubject,
	reproductionReport
} from '../reproduction-report.ts';
import { cacheUrlFor } from '../substituters.ts';

interface StorePathDigest {
	readonly storePath: string;
	readonly sha256: string;
}

export interface AttestationDestinationOptions {
	readonly url?: string;
	readonly cache?: string;
	readonly readUser?: string;
	readonly readPassword?: string;
}

export interface AttestationDestination {
	readonly url: URL;
	readonly cache: CacheScope;
	readonly readUser: ReadUser | '';
	readonly readPassword: string;
}

export interface AttestOptions extends AttestationDestinationOptions {
	readonly receiptFile?: string;
	readonly checksumsFile?: string;
	readonly builtChecksumsFile?: string;
	readonly predicateFile?: string;
}

export interface AttestInputs extends AttestationDestination {
	readonly receiptFile: string;
	readonly checksumsFile: string;
	readonly builtChecksumsFile: string;
	readonly predicateFile: string;
}

interface CommittedPathInfo {
	readonly storePath: StorePathString;
	readonly narHash: NixSha256Hash;
}

interface AttestationSubjects {
	readonly subjects: readonly StorePathDigest[];
	readonly built: readonly StorePathDigest[];
	readonly reproduced: readonly ReproducedSubject[];
	readonly skipped: readonly string[];
}

export async function cacheAccess(
	fetcher: typeof fetch,
	cacheUrl: URL
): Promise<DestinationAccess> {
	const target = `${canonicalHref(cacheUrl)}/nix-cache-info`;

	return fetchWithProbeRetries(fetcher, target, undefined, async (response) => {
		await discardResponseBody(response);
		const status: StatusCodes = response.status;

		if (status === StatusCodes.OK) {
			return 'public';
		}

		if (status === StatusCodes.UNAUTHORIZED) {
			return 'private';
		}

		throw new CacheAccessProbeError(target, response.status);
	});
}

/**
Build provenance describes executions supervised on the coordinating runner,
including verification rebuilds, not remote or store-attributed builds.
*/
function isRunnerLocalBuild(
	subject: BuildSubjectV3Input
): subject is Extract<BuildSubjectV3Input, { origin: 'built' }> {
	return (
		subject.origin === 'built' &&
		subject.verification === 'local' &&
		(subject.machine ?? '') === ''
	);
}

function requireMatchingNarHash(
	info: CommittedPathInfo,
	narHash: string
): void {
	const held = info.narHash.digestHex();

	if (held !== narHash) {
		throw new SubjectNarHashMovedError(info.storePath, narHash, held);
	}
}

export function renderChecksums(digests: readonly StorePathDigest[]): string {
	return digests
		.map((digest) => `${digest.sha256}  ${path.basename(digest.storePath)}`)
		.join('\n')
		.concat('\n');
}

export function registerAttestCommand(
	program: Command,
	environment: Environment = env
): void {
	program
		.command('attest')
		.description(
			'Resolve attestation subjects from a current-run build receipt and identify the paths built by this run.'
		)
		.requiredOption(
			'--receipt-file <path>',
			'Resolve the subjects from a current-run receipt produced by the build action.'
		)
		.option(
			'--checksums-file <path>',
			'Write candidate checksums for all named receipt subjects here. Defaults to a unique directory under RUNNER_TEMP.'
		)
		.option(
			'--built-checksums-file <path>',
			'Write the checksums for the accepted subjects this run built here. Defaults to a file beside the checksums file.'
		)
		.option(
			'--predicate-file <path>',
			'Write the SCAI attribute report for reproduced subjects here. Defaults to a file beside the checksums file.'
		)
		.requiredOption(
			'--url <url>',
			'Identify the destination tenant for signing policy defaults.'
		)
		.option(
			'--cache <name>',
			'Check the subjects against a named destination cache.'
		)
		.option(
			'--read-user <user>',
			'Username for reading the destination cache. Requires --read-password.'
		)
		.option(
			'--read-password <password>',
			'Password for reading the destination cache. Requires --read-user.'
		)
		.action((options: AttestOptions) => attestAction(options, environment));
}

export function resolveAttestInputs(
	options: AttestOptions,
	environment: Environment
): AttestInputs {
	const receiptFile = provided(options.receiptFile);
	if (receiptFile === undefined) {
		throw new MissingInputError('receipt-file');
	}
	const destination = resolveAttestationDestination(options, environment);

	const checksumsFile =
		provided(options.checksumsFile) ??
		path.join(
			requireEnvironment(environment, 'RUNNER_TEMP'),
			'cupboard-attestations',
			randomUUID(),
			'subjects.txt'
		);

	return {
		receiptFile,
		...destination,
		checksumsFile,
		builtChecksumsFile:
			provided(options.builtChecksumsFile) ??
			path.join(path.dirname(checksumsFile), 'built-subjects.txt'),
		predicateFile:
			provided(options.predicateFile) ??
			path.join(path.dirname(checksumsFile), 'attribute-report.json')
	};
}

export function resolveAttestationDestination(
	options: AttestationDestinationOptions,
	environment: Environment
): AttestationDestination {
	const url = providedUrl('url', options.url);

	if (url === undefined) {
		throw new MissingInputError('url');
	}

	const readUser = providedReadUser(options.readUser);
	const readPassword = options.readPassword ?? environment.READ_PASSWORD ?? '';

	if (readUser !== '' && readPassword === '') {
		throw new ReadPasswordRequiredError();
	}

	if (readPassword !== '' && readUser === '') {
		throw new ReadUserRequiredError();
	}

	return {
		url,
		cache: providedCacheSelection(options.cache),
		readUser,
		readPassword
	};
}

export interface AttestDependencies {
	readonly fetch?: typeof fetch;
}

function readCredential(
	inputs: AttestationDestination
): BasicCredential | undefined {
	return inputs.readUser === ''
		? undefined
		: { user: inputs.readUser, password: inputs.readPassword };
}

/**
Receipt identities remain candidates for custom statements. Destination reads
belong to signing, once the actual statement subjects have been selected.
Version 2 has no identity for path-only entries, so those entries stay skipped.
*/
export function receiptCandidates(receipt: BuildReceipt): AttestationSubjects {
	const paths = new Set(receipt.paths);
	const names = new Set<string>();
	const invalid: string[] = [];
	if (paths.size !== receipt.paths.length) {
		invalid.push(...receipt.paths);
	}
	for (const subject of receipt.subjects) {
		const name = path.basename(subject.storePath);
		if (!paths.has(subject.storePath) || names.has(name)) {
			invalid.push(subject.storePath);
		}
		names.add(name);
	}
	if (invalid.length > 0) {
		throw new AttestationSubjectNotAcceptedError(invalid);
	}
	const subjects = receipt.subjects.map((subject) => ({
		storePath: subject.storePath,
		sha256: subject.narHash
	}));
	const namedPaths = new Set(
		receipt.subjects.map((subject) => subject.storePath)
	);
	const skipped = receipt.paths.filter(
		(storePath) => !namedPaths.has(storePath)
	);
	if (receipt.version === 2) {
		return { subjects, built: subjects, reproduced: [], skipped };
	}
	const built: StorePathDigest[] = [];
	const reproduced: ReproducedSubject[] = [];
	for (const subject of receipt.subjects) {
		if (!isRunnerLocalBuild(subject)) {
			continue;
		}
		const digest = { storePath: subject.storePath, sha256: subject.narHash };
		built.push(digest);
		if (subject.reproduced === true) {
			reproduced.push({ ...digest, derivation: subject.derivation });
		}
	}
	return { subjects, built, reproduced, skipped };
}

/**
Only actual statement subjects are checked. Without a receipt, legacy checksum
files identify basenames but not store directories: read the selected narinfo
and require its basename and NAR hash instead of guessing a store directory.
*/
export async function validateDestinationSubjects(
	subjects: readonly AttestationSubject[],
	inputs: AttestationDestination,
	dependencies: AttestDependencies,
	reporter: Reporter,
	receipt?: BuildReceipt
): Promise<void> {
	if (subjects.length === 0) {
		return;
	}
	const paths = new Map(
		receipt?.subjects.map((subject) => [
			path.basename(subject.storePath),
			subject.storePath
		])
	);
	// Validate all names before starting reads.
	for (const subject of subjects) {
		storePathBasenameSchema.parse(subject.name);
	}
	const fetcher = retryingFetcher(
		withReadAuthentication(dependencies.fetch ?? fetch, {
			tenantUrl: inputs.url
		}),
		'replay-safe',
		{ trustedOrigin: inputs.url.origin }
	);
	const base = canonicalHref(cacheUrlFor(inputs.url, inputs.cache));
	await reporter.progress(
		'Checking published attestation subjects',
		{ total: subjects.length },
		(progress) =>
			mapWithConcurrency(
				subjects,
				committedPathConcurrency,
				async (subject) => {
					const info = await fetchCommittedPathInfo(
						fetcher,
						base,
						subject.name,
						readCredential(inputs),
						paths.get(subject.name)
					);
					requireMatchingNarHash(info, subject.sha256);
					progress.advance();
				}
			)
	);
}

const committedPathConcurrency = 6;
const maximumNarInfoBytes = 1024 * 1024;

async function fetchCommittedPathInfo(
	fetcher: typeof fetch,
	base: string,
	name: string,
	credential: BasicCredential | undefined,
	expectedPath?: StorePathString
): Promise<CommittedPathInfo> {
	const storePath = expectedPath ?? name;
	const target = `${base}/${storePathBasenameSchema.parse(name).slice(0, 32)}.narinfo`;
	const source = await fetchWithProbeRetries(
		fetcher,
		target,
		{
			headers: {
				accept: 'text/x-nix-narinfo',
				...(credential !== undefined && basicAuthHeader(credential))
			}
		},
		async (response) => {
			if (!response.ok) {
				await discardResponseBody(response);
				throw new CommittedSubjectUnavailableError(storePath, response.status);
			}

			return readResponseText(response, {
				description: `narinfo for ${storePath}`,
				maximumBytes: maximumNarInfoBytes
			});
		}
	);
	let narInfo: NarInfo;

	try {
		narInfo = NarInfo.parse(source);
	} catch (error) {
		throw new CommittedSubjectInvalidError(storePath, error);
	}

	if (
		narInfo.storePath.basename !== name ||
		(expectedPath !== undefined && narInfo.storePath.value !== expectedPath)
	) {
		throw new CommittedSubjectInvalidError(
			storePath,
			new Error(`narinfo names ${narInfo.storePath.value}`)
		);
	}

	return {
		storePath: storePathSchema.parse(narInfo.storePath.value),
		narHash: narInfo.narHash
	};
}

export async function attestAction(
	options: AttestOptions,
	environment: Environment = env,
	reporter: Reporter = createGithubReporter(),
	dependencies: AttestDependencies = {}
): Promise<void> {
	const inputs = resolveAttestInputs(options, environment);
	const receipt = buildReceiptSchema.parse(
		JSON.parse(await readFile(inputs.receiptFile, 'utf8'))
	);
	const { subjects, built, reproduced, skipped } = receiptCandidates(receipt);
	const fetcher = dependencies.fetch ?? fetch;
	const destinationAccess = await cacheAccess(
		retryingFetcher(fetcher, 'replay-safe', {
			trustedOrigin: new URL(inputs.url).origin
		}),
		cacheUrlFor(inputs.url, inputs.cache)
	);

	for (const storePath of skipped) {
		reporter.warn(
			`Not attesting ${storePath}: the receipt records no origin for it`
		);
	}

	const checksumsFile = path.resolve(inputs.checksumsFile);
	const builtChecksumsFile = path.resolve(inputs.builtChecksumsFile);
	const predicateFile = path.resolve(inputs.predicateFile);
	const report =
		reproduced.length === 0
			? undefined
			: reproductionReport(reproduced, subjects.length === 1);

	await mkdir(path.dirname(checksumsFile), { recursive: true });
	await writeFile(checksumsFile, renderChecksums(subjects));
	await mkdir(path.dirname(builtChecksumsFile), { recursive: true });
	await writeFile(builtChecksumsFile, renderChecksums(built));

	if (report !== undefined) {
		await mkdir(path.dirname(predicateFile), { recursive: true });
		await writeFile(predicateFile, `${JSON.stringify(report)}\n`);
	}

	await setOutput(environment, 'checksums-file', checksumsFile);
	await setOutput(environment, 'subject-count', String(subjects.length));
	await setOutput(environment, 'built-checksums-file', builtChecksumsFile);
	await setOutput(environment, 'built-subject-count', String(built.length));
	await setOutput(
		environment,
		'predicate-file',
		report === undefined ? '' : predicateFile
	);
	await setOutput(
		environment,
		'predicate-type',
		report === undefined ? '' : scaiPredicateType
	);
	await setOutput(environment, 'destination-access', destinationAccess);
}

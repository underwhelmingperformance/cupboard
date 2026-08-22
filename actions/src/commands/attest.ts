import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from 'node:process';

import { NixSha256Hash } from '@cupboard/nix-store/hash';
import { NarInfo } from '@cupboard/nix-store/narinfo';
import {
	type StoredCache,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import { canonicalHref } from '@cupboard/nix-store/url';
import {
	buildReceiptSchema,
	type BuildReceiptV2,
	type BuildReceiptV3,
	type BuildSubjectV3,
	type ParsedBuildReceipt
} from '@cupboard/protocol/build';
import {
	buildOriginPredicateSchema,
	buildOriginPredicateType,
	type BuildOriginSubject,
	type ParsedBuildOriginPredicate
} from '@cupboard/protocol/build-origin';
import { createGithubReporter, type Reporter } from '@cupboard/reporter';
import { discardResponseBody } from '@cupboard/shared/cleanup';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';
import {
	basicAuthHeader,
	type BasicCredential,
	type ReadUser
} from '@cupboard/shared/http';
import { retryingFetcher } from '@cupboard/shared/retry';
import type { Command } from 'commander';

import { fetchWithProbeDeadline } from '../cache-probe.ts';
import {
	CommittedSubjectInvalidError,
	CommittedSubjectUnavailableError,
	MissingInputError,
	ReadPasswordRequiredError,
	ReadUserRequiredError,
	SubjectDeriverMovedError,
	SubjectNarHashMovedError,
	SubjectNotHeldError
} from '../errors.ts';
import { type Environment, requireEnvironment, setOutput } from '../inputs.ts';
import {
	provided,
	providedCache,
	providedReadUser,
	providedUrl
} from '../options.ts';
import { cacheUrlFor } from '../substituters.ts';

interface StorePathDigest {
	readonly storePath: string;
	readonly sha256: string;
}

export interface AttestOptions {
	readonly receiptFile?: string;
	readonly checksumsFile?: string;
	readonly builtChecksumsFile?: string;
	readonly predicateFile?: string;
	readonly url?: string;
	readonly cache?: string;
	readonly readUser?: string;
	readonly readPassword?: string;
}

export interface AttestInputs {
	readonly receiptFile: string;
	readonly checksumsFile: string;
	readonly builtChecksumsFile: string;
	readonly predicateFile: string;
	readonly url: URL;
	readonly cache: StoredCache;
	readonly readUser: ReadUser | '';
	readonly readPassword: string;
}

export interface CommittedPathInfo {
	readonly storePath: StorePathString;
	readonly narHash: NixSha256Hash;
	readonly deriver?: string;
}

interface AttestationSubjects {
	readonly subjects: readonly StorePathDigest[];
	readonly built: readonly StorePathDigest[];
	readonly skipped: readonly string[];
}

/**
 * For a version 2 receipt, treats every accepted subject as built by this run.
 * Version 2 did not distinguish other origins.
 */
export function attestationSubjects(
	infos: readonly CommittedPathInfo[],
	receipt: BuildReceiptV2
): AttestationSubjects {
	const subjects: StorePathDigest[] = [];
	const receiptSubjects = new Map(
		receipt.subjects.map((subject) => [subject.storePath, subject])
	);
	const skipped = receipt.paths.filter(
		(storePath) => !receiptSubjects.has(storePath)
	);

	for (const info of infos) {
		const built = receiptSubjects.get(info.storePath);
		if (built === undefined) {
			continue;
		}
		requireUnmoved(info, built.narHash, built.derivation);

		subjects.push({
			storePath: info.storePath,
			sha256: info.narHash.digestHex()
		});
	}

	return { subjects, built: subjects, skipped };
}

export type SelectedPathInfos = ReadonlyMap<string, CommittedPathInfo>;

/**
 * A subject is signed under this repository's identity, so the destination
 * cache must have committed narinfo for every subject. The narinfo must contain
 * the NAR hash and any deriver recorded in the receipt. An absent path fails
 * the run, as does one whose hash or deriver has changed since the receipt was
 * written.
 *
 * The build store may have garbage-collected the path since the build, so
 * the check reads the committed metadata from the destination cache rather
 * than from the build store.
 */
export function provenancedSubjects(
	receipt: BuildReceiptV3,
	held: SelectedPathInfos
): AttestationSubjects {
	const subjects: StorePathDigest[] = [];
	const built: StorePathDigest[] = [];
	const named = new Set(receipt.subjects.map((subject) => subject.storePath));
	const skipped = receipt.paths.filter((storePath) => !named.has(storePath));

	for (const subject of receipt.subjects) {
		requireBacked(subject, held.get(subject.storePath));

		const digest = {
			storePath: subject.storePath,
			sha256: subject.narHash
		};

		subjects.push(digest);

		if (subject.origin === 'built') {
			built.push(digest);
		}
	}

	return { subjects, built, skipped };
}

function requireBacked(
	subject: BuildSubjectV3,
	info: CommittedPathInfo | undefined
): void {
	if (info === undefined) {
		throw new SubjectNotHeldError(subject.storePath, subject.origin);
	}

	requireUnmoved(info, subject.narHash, subject.derivation);
}

// A subject with no recorded deriver leaves the destination deriver unchecked
// because there is no receipt value to compare it with.
function requireUnmoved(
	info: CommittedPathInfo,
	narHash: string,
	derivation: string | undefined
): void {
	const held = info.narHash.digestHex();

	if (held !== narHash) {
		throw new SubjectNarHashMovedError(info.storePath, narHash, held);
	}

	if (derivation !== undefined && info.deriver !== derivation) {
		throw new SubjectDeriverMovedError(
			info.storePath,
			derivation,
			info.deriver
		);
	}
}

// Attempt fields belong to run-local attribution. Rebuild a `built` subject
// without them before writing the durable build-origin statement.
function originSubject(subject: BuildSubjectV3): BuildOriginSubject {
	if (subject.origin === 'built') {
		return {
			origin: 'built',
			storePath: subject.storePath,
			narHash: subject.narHash,
			derivation: subject.derivation,
			buildStore: subject.buildStore,
			...(subject.machine !== undefined && { machine: subject.machine }),
			verification: subject.verification
		};
	}

	return subject;
}

/**
 * Version 2 receipts record no origin, so they produce no predicate. A version
 * 3 receipt also produces no predicate when the run accepted no subjects.
 * Otherwise, the predicate includes the recorded origin of every accepted
 * subject.
 */
export function buildOriginPredicateFor(
	receipt: ParsedBuildReceipt,
	subjects: readonly StorePathDigest[]
): ParsedBuildOriginPredicate | undefined {
	if (receipt.version !== 3) {
		return undefined;
	}

	const accepted = new Set(subjects.map((subject) => subject.storePath));
	const origins: BuildOriginSubject[] = receipt.subjects
		.filter((subject) => accepted.has(subject.storePath))
		.map((subject) => originSubject(subject));

	if (origins.length === 0) {
		return undefined;
	}

	// The statement is signed under this repository's identity, so its contents
	// are checked against the schema before the file is written.
	return buildOriginPredicateSchema.parse({ subjects: origins });
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
			'current-run receipt produced by the build action'
		)
		.option(
			'--checksums-file <path>',
			'where to write checksums for all accepted receipt subjects'
		)
		.option(
			'--built-checksums-file <path>',
			'where to write checksums for accepted subjects built by this run'
		)
		.option(
			'--predicate-file <path>',
			'where to write the build-origin predicate'
		)
		.requiredOption('--url <url>', 'destination cupboard tenant URL')
		.option('--cache <name>', 'destination named cache')
		.option(
			'--read-user <user>',
			'username for private destination-cache reads'
		)
		.option(
			'--read-password <password>',
			'password for private destination-cache reads'
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
	const url = providedUrl('url', options.url);

	if (url === undefined) {
		throw new MissingInputError('url');
	}

	const readUser = providedReadUser(options.readUser);
	const readPassword = options.readPassword ?? '';

	if (readUser !== '' && readPassword === '') {
		throw new ReadPasswordRequiredError();
	}

	if (readPassword !== '' && readUser === '') {
		throw new ReadUserRequiredError();
	}

	const checksumsFile =
		provided(options.checksumsFile) ??
		path.join(
			requireEnvironment(environment, 'RUNNER_TEMP'),
			'cupboard-attestations',
			'subjects.txt'
		);

	return {
		receiptFile,
		url,
		cache: providedCache(options.cache),
		readUser,
		readPassword,
		checksumsFile,
		builtChecksumsFile:
			provided(options.builtChecksumsFile) ??
			path.join(path.dirname(checksumsFile), 'built-subjects.txt'),
		predicateFile:
			provided(options.predicateFile) ??
			path.join(path.dirname(checksumsFile), 'build-origin.json')
	};
}

export interface AttestDependencies {
	readonly fetch?: typeof fetch;
}

function readCredential(inputs: AttestInputs): BasicCredential | undefined {
	return inputs.readUser === ''
		? undefined
		: { user: inputs.readUser, password: inputs.readPassword };
}

async function resolveAttestation(
	receipt: ParsedBuildReceipt,
	inputs: AttestInputs,
	dependencies: AttestDependencies
): Promise<AttestationSubjects> {
	const paths =
		receipt.version === 3
			? receipt.subjects.map((subject) => subject.storePath)
			: receipt.paths;
	const infos = await committedPathInfos(paths, inputs, dependencies);

	if (receipt.version === 3) {
		return provenancedSubjects(
			receipt,
			new Map(infos.map((info) => [info.storePath, info]))
		);
	}

	return attestationSubjects(infos, receipt);
}

const committedPathConcurrency = 6;

async function committedPathInfos(
	paths: readonly StorePathString[],
	inputs: AttestInputs,
	dependencies: AttestDependencies
): Promise<readonly CommittedPathInfo[]> {
	const fetcher = retryingFetcher(dependencies.fetch ?? fetch);
	const base = canonicalHref(cacheUrlFor(inputs.url, inputs.cache));
	const credential = readCredential(inputs);

	return mapWithConcurrency(paths, committedPathConcurrency, (storePath) =>
		fetchCommittedPathInfo(fetcher, base, storePath, credential)
	);
}

async function fetchCommittedPathInfo(
	fetcher: typeof fetch,
	base: string,
	storePath: StorePathString,
	credential: BasicCredential | undefined
): Promise<CommittedPathInfo> {
	const target = `${base}/${StorePath.hash(storePath)}.narinfo`;
	const source = await fetchWithProbeDeadline(
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

			return response.text();
		}
	);
	let narInfo: NarInfo;

	try {
		narInfo = NarInfo.parse(source);
	} catch (error) {
		throw new CommittedSubjectInvalidError(storePath, error);
	}

	if (narInfo.storePath.value !== storePath) {
		throw new CommittedSubjectInvalidError(
			storePath,
			new Error(`narinfo names ${narInfo.storePath.value}`)
		);
	}

	return {
		storePath,
		narHash: narInfo.narHash,
		...(narInfo.deriver !== undefined && {
			deriver: `${narInfo.storePath.storeDirectory}/${narInfo.deriver}`
		})
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
	const { subjects, built, skipped } = await resolveAttestation(
		receipt,
		inputs,
		dependencies
	);

	for (const storePath of skipped) {
		reporter.warn(
			`Not attesting ${storePath}: the receipt records no origin for it`
		);
	}

	const checksumsFile = path.resolve(inputs.checksumsFile);
	const builtChecksumsFile = path.resolve(inputs.builtChecksumsFile);

	await mkdir(path.dirname(checksumsFile), { recursive: true });
	await writeFile(checksumsFile, renderChecksums(subjects));
	await mkdir(path.dirname(builtChecksumsFile), { recursive: true });
	await writeFile(builtChecksumsFile, renderChecksums(built));

	const predicate = buildOriginPredicateFor(receipt, subjects);
	const predicateFile =
		predicate === undefined ? '' : path.resolve(inputs.predicateFile);

	if (predicate !== undefined) {
		await mkdir(path.dirname(predicateFile), { recursive: true });
		await writeFile(
			predicateFile,
			`${JSON.stringify(predicate, undefined, 2)}\n`
		);
	}

	await setOutput(environment, 'checksums-file', checksumsFile);
	await setOutput(environment, 'subject-count', String(subjects.length));
	await setOutput(environment, 'built-checksums-file', builtChecksumsFile);
	await setOutput(environment, 'built-subject-count', String(built.length));
	await setOutput(environment, 'predicate-file', predicateFile);
	await setOutput(environment, 'predicate-type', buildOriginPredicateType);
}

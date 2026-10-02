import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from 'node:process';

import { withReadAuthentication } from '@cupboard/nix';
import { NixSha256Hash } from '@cupboard/nix-store/hash';
import { NarInfo } from '@cupboard/nix-store/narinfo';
import {
	type CacheScope,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import { canonicalHref } from '@cupboard/nix-store/url';
import {
	type BuildReceipt,
	buildReceiptSchema,
	type BuildReceiptV2Input,
	type BuildReceiptV3Input,
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
import { readResponseText } from '@cupboard/shared/response-body';
import { retryingFetcher } from '@cupboard/shared/retry';
import type { Command } from 'commander';
import { StatusCodes } from 'http-status-codes';

import type { DestinationAccess } from '../attestation-signing.ts';
import { fetchWithProbeDeadline } from '../cache-probe.ts';
import {
	CacheAccessProbeError,
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
	readonly cache: CacheScope;
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
	readonly reproduced: readonly ReproducedSubject[];
	readonly skipped: readonly string[];
}

export async function cacheAccess(
	fetcher: typeof fetch,
	cacheUrl: URL
): Promise<DestinationAccess> {
	const target = `${canonicalHref(cacheUrl)}/nix-cache-info`;

	return fetchWithProbeDeadline(
		fetcher,
		target,
		undefined,
		async (response) => {
			await discardResponseBody(response);
			const status: StatusCodes = response.status;

			if (status === StatusCodes.OK) {
				return 'public';
			}

			if (status === StatusCodes.UNAUTHORIZED) {
				return 'private';
			}

			throw new CacheAccessProbeError(target, response.status);
		}
	);
}

/**
 * For a version 2 receipt, treats every accepted subject as built by this run.
 * Version 2 did not distinguish other origins.
 */
export function attestationSubjects(
	infos: readonly CommittedPathInfo[],
	receipt: BuildReceiptV2Input
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

	return { subjects, built: subjects, reproduced: [], skipped };
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
	receipt: BuildReceiptV3Input,
	held: SelectedPathInfos
): AttestationSubjects {
	const subjects: StorePathDigest[] = [];
	const built: StorePathDigest[] = [];
	const reproduced: ReproducedSubject[] = [];
	const named = new Set(receipt.subjects.map((subject) => subject.storePath));
	const skipped = receipt.paths.filter((storePath) => !named.has(storePath));

	for (const subject of receipt.subjects) {
		requireBacked(subject, held.get(subject.storePath));

		const digest = {
			storePath: subject.storePath,
			sha256: subject.narHash
		};

		subjects.push(digest);

		// Build provenance covers the executions this run supervised on the
		// coordinating machine. A verification rebuild counts: the run
		// re-executed the derivation here and Nix matched the stored output.
		// A remote builder's execution and a path attributed to the store's
		// records describe builds this run cannot report on.
		if (!(
			subject.origin === 'built' &&
			subject.verification === 'local' &&
			(subject.machine ?? '') === ''
		)) {
			continue;
		}

		built.push(digest);

		if (subject.reproduced === true) {
			reproduced.push({ ...digest, derivation: subject.derivation });
		}
	}

	return { subjects, built, reproduced, skipped };
}

function requireBacked(
	subject: BuildSubjectV3Input,
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
			'Write the checksums for all accepted receipt subjects here. Defaults to a unique directory under RUNNER_TEMP.'
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
			'Check every subject against the narinfos this cupboard tenant has committed.'
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
			randomUUID(),
			'subjects.txt'
		);

	return {
		receiptFile,
		url,
		cache: providedCacheSelection(options.cache),
		readUser,
		readPassword,
		checksumsFile,
		builtChecksumsFile:
			provided(options.builtChecksumsFile) ??
			path.join(path.dirname(checksumsFile), 'built-subjects.txt'),
		predicateFile:
			provided(options.predicateFile) ??
			path.join(path.dirname(checksumsFile), 'attribute-report.json')
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
	receipt: BuildReceipt,
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
const maximumNarInfoBytes = 1024 * 1024;

async function committedPathInfos(
	paths: readonly StorePathString[],
	inputs: AttestInputs,
	dependencies: AttestDependencies
): Promise<readonly CommittedPathInfo[]> {
	const fetcher = retryingFetcher(
		withReadAuthentication(dependencies.fetch ?? fetch, {
			tenantUrl: inputs.url
		}),
		'replay-safe'
	);
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
	const fetcher = dependencies.fetch ?? fetch;
	const destinationAccess = await cacheAccess(
		retryingFetcher(fetcher, 'replay-safe'),
		cacheUrlFor(inputs.url, inputs.cache)
	);
	const { subjects, built, reproduced, skipped } = await resolveAttestation(
		receipt,
		inputs,
		{ ...dependencies, fetch: fetcher }
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

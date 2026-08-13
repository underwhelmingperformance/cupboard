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
import { createGithubReporter, type Reporter } from '@cupboard/reporter';
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
	InvalidInputError,
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
	readonly url?: string;
	readonly cache?: string;
	readonly readUser?: string;
	readonly readPassword?: string;
}

export interface AttestInputs {
	readonly receiptFile: string;
	readonly checksumsFile: string;
	readonly url: URL;
	readonly cache: StoredCache;
	readonly readUser: ReadUser | '';
	readonly readPassword: string;
}

/** Live metadata read from a committed destination narinfo. */
export interface CommittedPathInfo {
	readonly storePath: StorePathString;
	readonly narHash: NixSha256Hash;
	readonly deriver?: string;
}

interface AttestationSubjects {
	readonly subjects: readonly StorePathDigest[];
	readonly skipped: readonly string[];
}

/**
 * Attestation candidates from a receipt, divided into eligible subjects,
 * published paths without build evidence, and unverified subjects.
 */
export interface ResolvedAttestation extends AttestationSubjects {
	readonly refused: readonly RefusedSubject[];
}

/**
 * A subject excluded from the attestation, including its build machine when
 * known.
 */
export interface RefusedSubject {
	readonly storePath: string;
	readonly machine?: string;
}

/** Partition path infos according to a current-run build receipt. */
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

	return { subjects, skipped };
}

/**
 * Committed destination metadata for receipt subjects, keyed by store path.
 * An uncommitted path has no entry.
 */
export type SelectedPathInfos = ReadonlyMap<string, CommittedPathInfo>;

/**
 * Selects the receipt subjects this run can attest.
 *
 * A subject is signed under this repository's identity, so the destination
 * cache must serve every verified subject under the NAR hash and deriver the
 * receipt recorded. An absent path fails the run, as does one whose hash or
 * deriver has moved since the receipt was written.
 *
 * The build store may already have collected the path, so verification uses
 * the committed destination metadata. A subject produced on an unverified
 * machine is excluded.
 */
export function provenancedSubjects(
	receipt: BuildReceiptV3,
	held: SelectedPathInfos
): ResolvedAttestation {
	const subjects: StorePathDigest[] = [];
	const refused: RefusedSubject[] = [];
	const named = new Set(receipt.subjects.map((subject) => subject.storePath));
	const skipped = receipt.paths.filter((storePath) => !named.has(storePath));

	for (const subject of receipt.subjects) {
		if (subject.verification === 'unverified') {
			refused.push({
				storePath: subject.storePath,
				...(subject.machine !== undefined && { machine: subject.machine })
			});
			continue;
		}

		requireBacked(subject, held.get(subject.storePath));

		subjects.push({ storePath: subject.storePath, sha256: subject.narHash });
	}

	return { subjects, skipped, refused };
}

// Verify each checksum against committed destination metadata. The receipt does
// not provide the bytes to sign.
function requireBacked(
	subject: BuildSubjectV3,
	info: CommittedPathInfo | undefined
): void {
	if (info === undefined) {
		throw new SubjectNotHeldError(subject.storePath, subject.verification);
	}

	requireUnmoved(info, subject.narHash, subject.derivation);
}

// Check the destination metadata before signing under the repository's identity.
function requireUnmoved(
	info: CommittedPathInfo,
	narHash: string,
	derivation: string
): void {
	const held = info.narHash.digestHex();

	if (held !== narHash) {
		throw new SubjectNarHashMovedError(info.storePath, narHash, held);
	}

	if (info.deriver !== derivation) {
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
			'Resolve the provenance subjects established by a current-run build receipt.'
		)
		.requiredOption(
			'--receipt-file <path>',
			'current-run receipt produced by the build action'
		)
		.option(
			'--checksums-file <path>',
			'where to write the generated subject checksums file'
		)
		.requiredOption('--url <url>', 'destination cupboard tenant URL')
		.option('--cache <name>', 'destination named cache')
		.option('--read-user <user>', 'private-read username')
		.option('--read-password <password>', 'private-read password')
		.action((options: AttestOptions) => attestAction(options, environment));
}

export function resolveAttestInputs(
	options: AttestOptions,
	environment: Environment
): AttestInputs {
	const receiptFile = provided(options.receiptFile);
	if (receiptFile === undefined) {
		throw new InvalidInputError('receipt-file', 'receipt-file is required');
	}
	const url = providedUrl('url', options.url);

	if (url === undefined) {
		throw new InvalidInputError('url', 'url is required');
	}

	const readUser = providedReadUser(options.readUser);
	const readPassword = options.readPassword ?? '';

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

	return {
		receiptFile,
		url,
		cache: providedCache(options.cache),
		readUser,
		readPassword,
		checksumsFile:
			provided(options.checksumsFile) ??
			path.join(
				requireEnvironment(environment, 'RUNNER_TEMP'),
				'cupboard-attestations',
				'subjects.txt'
			)
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

// What the receipt at hand lets this run attest is checked exclusively against
// the destination's committed narinfos. The build store may already have
// collected every output; the receipt alone is never a source of bytes to sign.
async function resolveAttestation(
	receipt: ParsedBuildReceipt,
	inputs: AttestInputs,
	dependencies: AttestDependencies
): Promise<ResolvedAttestation> {
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

	return { ...attestationSubjects(infos, receipt), refused: [] };
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
				await response.body?.cancel();
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
	const { subjects, skipped, refused } = await resolveAttestation(
		receipt,
		inputs,
		dependencies
	);

	for (const storePath of skipped) {
		reporter.warn(
			`Not attesting ${storePath}: this workflow run did not build it`
		);
	}

	for (const subject of refused) {
		reporter.warn(
			`Not attesting ${subject.storePath}: it was built on ${subject.machine ?? 'another machine'}, which this run did not verify`
		);
	}

	const checksumsFile = path.resolve(inputs.checksumsFile);

	await mkdir(path.dirname(checksumsFile), { recursive: true });
	await writeFile(checksumsFile, renderChecksums(subjects));

	await setOutput(environment, 'checksums-file', checksumsFile);
	await setOutput(environment, 'subject-count', String(subjects.length));
}

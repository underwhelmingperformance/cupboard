import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from 'node:process';

import { Nix, type NixValidPathInfo } from '@cupboard/nix';
import {
	buildReceiptSchema,
	type BuildReceiptV2,
	type BuildReceiptV3,
	type BuildSubjectV3,
	type ParsedBuildReceipt,
	type SubjectVerification
} from '@cupboard/protocol/build';
import { createGithubReporter, type Reporter } from '@cupboard/reporter';
import type { Command } from 'commander';

import {
	InvalidInputError,
	SubjectDeriverMovedError,
	SubjectNarHashMovedError,
	SubjectNotHeldError
} from '../errors.ts';
import { type Environment, requireEnvironment, setOutput } from '../inputs.ts';
import { provided } from '../options.ts';

interface StorePathDigest {
	readonly storePath: string;
	readonly sha256: string;
}

export interface AttestOptions {
	readonly receiptFile?: string;
	readonly checksumsFile?: string;
}

export interface AttestInputs {
	readonly receiptFile: string;
	readonly checksumsFile: string;
}

interface AttestationSubjects {
	readonly subjects: readonly StorePathDigest[];
	readonly skipped: readonly string[];
}

/**
 * What a receipt lets this run attest: the subjects it may claim, the published
 * paths it did not build, and the subjects it refuses because they were
 * produced somewhere nothing verified.
 */
export interface ResolvedAttestation extends AttestationSubjects {
	readonly refused: readonly RefusedSubject[];
}

/**
 * One subject an attestation will not carry, with the machine that produced it
 * when the receipt named one.
 */
export interface RefusedSubject {
	readonly storePath: string;
	readonly machine?: string;
}

/** Partition path infos according to a current-run build receipt. */
export function attestationSubjects(
	infos: readonly NixValidPathInfo[],
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
		const digest = info.narHash.digestHex();
		if (digest !== built.narHash) {
			throw new Error(
				`NAR hash for ${info.storePath} changed after the build receipt was written`
			);
		}
		if (info.deriver !== built.derivation) {
			throw new Error(
				`Deriver for ${info.storePath} changed after the build receipt was written`
			);
		}

		subjects.push({
			storePath: info.storePath,
			sha256: digest
		});
	}

	return { subjects, skipped };
}

/**
 * What this run holds for each subject a receipt names, keyed by store path. A
 * path this machine does not hold has no entry.
 */
export type LocalPathInfos = ReadonlyMap<string, NixValidPathInfo>;

/**
 * What a receipt carrying provenance lets this run attest.
 *
 * A subject is signed under this repository's identity, so what this machine
 * can check for itself, it checks. A subject this run built or reproduced must
 * be in this store, under the NAR hash and deriver the receipt recorded: an
 * absent path fails the run, as does one whose hash or deriver has moved since
 * the receipt was written.
 *
 * A subject the selected build store realised is on that store, so this store
 * may hold it or not. Held, it is checked the same way; absent, its checksum
 * comes from the receipt, which is what the run established about it. A subject
 * nothing verified is refused, because it was produced on a machine the run
 * never established anything about.
 */
export function provenancedSubjects(
	receipt: BuildReceiptV3,
	held: LocalPathInfos
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

// Which verifications name a build this machine ran, whose output its own
// store therefore holds. A path the selected build store realised lives on
// that store, and an unverified path was produced somewhere this run never
// looked.
const realisedHere: Record<SubjectVerification, boolean> = {
	local: true,
	'verified-rebuild': true,
	'build-store': false,
	unverified: false
};

// What a subject's checksum rests on must be in front of the run: the path
// itself where this machine realised it, and the receipt where a build store
// did.
function requireBacked(
	subject: BuildSubjectV3,
	info: NixValidPathInfo | undefined
): void {
	if (info !== undefined) {
		requireUnmoved(info, subject.narHash, subject.derivation);
		return;
	}

	if (realisedHere[subject.verification]) {
		throw new SubjectNotHeldError(subject.storePath, subject.verification);
	}
}

// A subject whose path this store holds is one this run can check for itself,
// and a checksum signed under this repository's identity is worth the read.
function requireUnmoved(
	info: NixValidPathInfo,
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
			'Resolve the attestation subjects for the given store paths this machine built.'
		)
		.requiredOption(
			'--receipt-file <path>',
			'current-run receipt produced by the build action'
		)
		.option(
			'--checksums-file <path>',
			'where to write the generated subject checksums file'
		)
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

	return {
		receiptFile,
		checksumsFile:
			provided(options.checksumsFile) ??
			path.join(
				requireEnvironment(environment, 'RUNNER_TEMP'),
				'cupboard-attestations',
				'subjects.txt'
			)
	};
}

// What the receipt at hand lets this run attest. Both shapes are checked
// against the local store: a receipt whose subjects carry no provenance is a
// record of paths this machine built, and one that carries provenance may name
// paths this machine built alongside paths another store did.
async function resolveAttestation(
	receipt: ParsedBuildReceipt
): Promise<ResolvedAttestation> {
	const nix = Nix.open();

	if (receipt.version === 3) {
		return provenancedSubjects(receipt, await heldLocally(nix, receipt));
	}

	const infos = await Promise.all(
		receipt.paths.map((storePath) => nix.queryPathInfo(storePath))
	);

	return { ...attestationSubjects(infos, receipt), refused: [] };
}

// The subjects this machine holds, which are the ones it can check. A subject
// realised elsewhere is simply absent.
async function heldLocally(
	nix: Nix,
	receipt: BuildReceiptV3
): Promise<LocalPathInfos> {
	const infos = await nix.queryValidPathsInfo(
		receipt.subjects.map((subject) => subject.storePath)
	);

	return new Map(infos.map((info) => [info.storePath, info]));
}

export async function attestAction(
	options: AttestOptions,
	environment: Environment = env,
	reporter: Reporter = createGithubReporter()
): Promise<void> {
	const inputs = resolveAttestInputs(options, environment);
	const receipt = buildReceiptSchema.parse(
		JSON.parse(await readFile(inputs.receiptFile, 'utf8'))
	);
	const { subjects, skipped, refused } = await resolveAttestation(receipt);

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

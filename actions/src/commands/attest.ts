import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from 'node:process';

import { Nix, type NixValidPathInfo } from '@cupboard/nix';
import {
	buildReceiptSchema,
	type BuildReceiptV2,
	type BuildReceiptV3,
	type ParsedBuildReceipt
} from '@cupboard/protocol/build';
import { createGithubReporter, type Reporter } from '@cupboard/reporter';
import type { Command } from 'commander';

import { InvalidInputError } from '../errors.ts';
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
 * What a receipt carrying provenance lets this run attest. Each subject records
 * its own NAR hash as the store that realised it reported, so the checksums come
 * straight from the receipt and no store is opened here: a path a remote store
 * built is not on this machine to query. A subject nothing verified is refused,
 * because it was produced on a machine the run never established anything about.
 */
export function provenancedSubjects(
	receipt: BuildReceiptV3
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

		subjects.push({ storePath: subject.storePath, sha256: subject.narHash });
	}

	return { subjects, skipped, refused };
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

// What the receipt at hand lets this run attest. A receipt whose subjects carry
// no provenance is a record of paths this machine built, so the local store is
// re-read and each subject is checked against what it holds now.
async function resolveAttestation(
	receipt: ParsedBuildReceipt
): Promise<ResolvedAttestation> {
	if (receipt.version === 3) {
		return provenancedSubjects(receipt);
	}

	const nix = Nix.open();
	const infos = await Promise.all(
		receipt.paths.map((storePath) => nix.queryPathInfo(storePath))
	);

	return { ...attestationSubjects(infos, receipt), refused: [] };
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

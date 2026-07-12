import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from 'node:process';

import { Nix, type NixValidPathInfo } from '@cupboard/nix';
import { createGithubReporter, type Reporter } from '@cupboard/reporter';
import type { Command } from 'commander';

import { type BuildReceipt, buildReceiptSchema } from '../build-receipt.ts';
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

/** Partition path infos according to a current-run build receipt. */
export function attestationSubjects(
	infos: readonly NixValidPathInfo[],
	receipt: BuildReceipt
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

export async function attestAction(
	options: AttestOptions,
	environment: Environment = env,
	reporter: Reporter = createGithubReporter()
): Promise<void> {
	const inputs = resolveAttestInputs(options, environment);
	const receipt = buildReceiptSchema.parse(
		JSON.parse(await readFile(inputs.receiptFile, 'utf8'))
	);
	const nix = Nix.open();
	const infos = await Promise.all(
		receipt.paths.map((storePath) => nix.queryPathInfo(storePath))
	);
	const { subjects, skipped } = attestationSubjects(infos, receipt);

	for (const storePath of skipped) {
		reporter.warn(
			`Not attesting ${storePath}: this workflow run did not build it`
		);
	}

	const checksumsFile = path.resolve(inputs.checksumsFile);

	await mkdir(path.dirname(checksumsFile), { recursive: true });
	await writeFile(checksumsFile, renderChecksums(subjects));

	await setOutput(environment, 'checksums-file', checksumsFile);
	await setOutput(environment, 'subject-count', String(subjects.length));
}

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from 'node:process';

import { buildReceiptSchema } from '@cupboard/protocol/build';
import { createGithubReporter, type Reporter } from '@cupboard/reporter';
import type { Command } from 'commander';

import {
	type AttestationDestination,
	type AttestationDestinationDependencies,
	type AttestationDestinationOptions,
	type PublishedSubject,
	requirePublishedSubjects,
	resolveAttestationDestination
} from '../attestation-destination.ts';
import {
	AttestationSubjectNotAcceptedError,
	MissingInputError
} from '../errors.ts';
import { type Environment, setOutput } from '../inputs.ts';
import { provided } from '../options.ts';
import { parseChecksums } from '../release-install.ts';

import { renderChecksums } from './attest.ts';

export interface AttestCheckOptions extends AttestationDestinationOptions {
	readonly receiptFile?: string;
	readonly checksumsFile?: string;
	readonly verifiedChecksumsFile?: string;
}

export interface AttestCheckInputs {
	readonly receiptFile: string;
	readonly checksumsFile: string;
	readonly verifiedChecksumsFile: string;
	readonly destination: AttestationDestination;
}

export function registerAttestCheckCommand(
	program: Command,
	environment: Environment = env
): void {
	program
		.command('attest-check')
		.description(
			'Check the subjects to be signed against the destination cache and record the verified subjects for attest-sign.'
		)
		.requiredOption(
			'--receipt-file <path>',
			'Take the store path of each subject from this current-run receipt.'
		)
		.requiredOption(
			'--checksums-file <path>',
			'Check the subjects listed in this checksums file.'
		)
		.option(
			'--verified-checksums-file <path>',
			'Write the verified subjects here. Defaults to a file beside the checksums file.'
		)
		.requiredOption(
			'--url <url>',
			'Tenant URL of the destination. Check every subject against the narinfo in the destination cache.'
		)
		.option('--cache <name>', 'Named destination cache.')
		.option(
			'--read-user <user>',
			'Username for reading the destination cache. Requires --read-password.'
		)
		.option(
			'--read-password <password>',
			'Password for reading the destination cache. Defaults to READ_PASSWORD. Requires --read-user.'
		)
		.action((options: AttestCheckOptions) =>
			attestCheckAction(options, environment)
		);
}

export function resolveAttestCheckInputs(
	options: AttestCheckOptions,
	environment: Environment
): AttestCheckInputs {
	const receiptFile = provided(options.receiptFile);

	if (receiptFile === undefined) {
		throw new MissingInputError('receipt-file');
	}

	const checksumsFile = provided(options.checksumsFile);

	if (checksumsFile === undefined) {
		throw new MissingInputError('checksums-file');
	}

	return {
		receiptFile,
		checksumsFile,
		verifiedChecksumsFile:
			provided(options.verifiedChecksumsFile) ??
			path.join(path.dirname(checksumsFile), 'verified-subjects.txt'),
		destination: resolveAttestationDestination(options, environment)
	};
}

/**
Checks each subject in the checksums file against the destination cache. A
subject must be a receipt subject with the same NAR hash, and the receipt
supplies its store path. The verified checksums file is written only after
every subject passes, and attest-sign refuses a statement with any subject
outside it.
*/
export async function attestCheckAction(
	options: AttestCheckOptions,
	environment: Environment = env,
	reporter: Reporter = createGithubReporter(),
	dependencies: AttestationDestinationDependencies = {}
): Promise<void> {
	const inputs = resolveAttestCheckInputs(options, environment);
	const receipt = buildReceiptSchema.parse(
		JSON.parse(await readFile(inputs.receiptFile, 'utf8'))
	);
	const receiptSubjects = new Map(
		receipt.subjects.map((subject) => [
			path.basename(subject.storePath),
			subject
		])
	);
	const checksums = parseChecksums(
		await readFile(inputs.checksumsFile, 'utf8')
	);
	const subjects: PublishedSubject[] = [];
	const unaccepted: string[] = [];

	for (const [name, sha256] of checksums) {
		const subject = receiptSubjects.get(name);

		if (subject?.narHash !== sha256) {
			unaccepted.push(name);
			continue;
		}

		subjects.push({ storePath: subject.storePath, sha256 });
	}

	if (unaccepted.length > 0) {
		throw new AttestationSubjectNotAcceptedError(unaccepted);
	}

	await requirePublishedSubjects(
		subjects,
		inputs.destination,
		reporter,
		dependencies
	);

	const verifiedChecksumsFile = path.resolve(inputs.verifiedChecksumsFile);

	await mkdir(path.dirname(verifiedChecksumsFile), { recursive: true });
	await writeFile(
		verifiedChecksumsFile,
		subjects.length === 0 ? '' : renderChecksums(subjects)
	);
	await setOutput(
		environment,
		'verified-checksums-file',
		verifiedChecksumsFile
	);
}

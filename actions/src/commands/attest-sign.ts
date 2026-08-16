import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from 'node:process';

import { createGithubReporter, type Reporter } from '@cupboard/reporter';
import type { Command } from 'commander';
import { z } from 'zod';

import {
	type AttestationStatement,
	type AttestationSubject,
	githubStatementSigner,
	type SignedAttestation,
	type SigningDependencies,
	signStatement,
	slsaProvenanceStatement,
	type StatementSigner
} from '../attestation-signing.ts';
import {
	AttestationPredicateFileError,
	InvalidInputError,
	MissingInputError
} from '../errors.ts';
import { type Environment, setOutput } from '../inputs.ts';
import { provided } from '../options.ts';
import { parseChecksums } from '../release-install.ts';

export interface AttestSignOptions {
	readonly checksumsFile?: string;
	readonly predicateFile?: string;
	readonly predicateType?: string;
	readonly bundleFile?: string;
	readonly originBundleFile?: string;
	readonly githubToken?: string;
}

export interface AttestSignInputs {
	readonly checksumsFile: string;
	/**
	 * Path to the build-origin predicate. An empty path signs the provenance
	 * alone.
	 */
	readonly predicateFile: string;
	readonly predicateType: string;
	readonly bundleFile: string;
	readonly originBundleFile: string;
	readonly githubToken: string;
}

export interface AttestSignDependencies extends SigningDependencies {
	/**
	 * Builds the signer for the run's subjects. Defaults to
	 * {@link githubStatementSigner}.
	 */
	readonly signerFor?: (
		subjects: readonly AttestationSubject[],
		githubToken: string
	) => StatementSigner;
	/** Produces this run's SLSA build provenance statement. */
	readonly provenanceStatement?: () => Promise<AttestationStatement>;
}

// The `attest` command validates the build-origin predicate against its schema
// before it writes the file, so this command signs the document as it stands.
// The only check here is that the document is a JSON object, because that is
// what the predicate field of an in-toto statement takes.
const predicateDocumentSchema = z.looseObject({});

export function registerAttestSignCommand(
	program: Command,
	environment: Environment = env
): void {
	program
		.command('attest-sign')
		.description(
			'Sign the resolved attestation subjects into Sigstore bundles.'
		)
		.requiredOption(
			'--checksums-file <path>',
			'subject checksums written by the attest command'
		)
		.option(
			'--predicate-file <path>',
			'build-origin predicate to sign as a second statement'
		)
		.option(
			'--predicate-type <type>',
			'in-toto predicate type of the build-origin predicate'
		)
		.option(
			'--bundle-file <path>',
			'where to write the SLSA build-provenance bundle'
		)
		.option(
			'--origin-bundle-file <path>',
			'where to write the build-origin bundle'
		)
		.option('--github-token <token>', 'GitHub token for the attestation store')
		.action((options: AttestSignOptions) =>
			attestSignAction(options, environment)
		);
}

export function resolveAttestSignInputs(
	options: AttestSignOptions
): AttestSignInputs {
	const checksumsFile = provided(options.checksumsFile);

	if (checksumsFile === undefined) {
		throw new MissingInputError('checksums-file');
	}

	const githubToken = provided(options.githubToken);

	if (githubToken === undefined) {
		throw new MissingInputError('github-token');
	}

	const predicateFile = provided(options.predicateFile) ?? '';
	const predicateType = provided(options.predicateType) ?? '';

	if (predicateFile !== '' && predicateType === '') {
		throw new InvalidInputError(
			'predicate-type',
			'predicate-type is required when predicate-file is supplied'
		);
	}

	// Both bundles default to the directory of the checksums file, so a caller
	// that chose its own checksums path gets the bundles beside it.
	const bundleDirectory = path.dirname(path.resolve(checksumsFile));

	return {
		checksumsFile,
		predicateFile,
		predicateType,
		githubToken,
		bundleFile:
			provided(options.bundleFile) ??
			path.join(bundleDirectory, 'provenance.sigstore.json'),
		originBundleFile:
			provided(options.originBundleFile) ??
			path.join(bundleDirectory, 'build-origin.sigstore.json')
	};
}

async function readSubjects(
	checksumsFile: string
): Promise<readonly AttestationSubject[]> {
	const checksums = parseChecksums(await readFile(checksumsFile, 'utf8'));

	return [...checksums].map(([name, sha256]) => ({ name, sha256 }));
}

async function readPredicate(predicateFile: string): Promise<object> {
	const source = await readFile(predicateFile, 'utf8');
	let document: unknown;

	try {
		document = JSON.parse(source);
	} catch (error) {
		throw new AttestationPredicateFileError(predicateFile, { cause: error });
	}

	const parsed = predicateDocumentSchema.safeParse(document);

	if (!parsed.success) {
		throw new AttestationPredicateFileError(predicateFile, {
			cause: parsed.error
		});
	}

	return parsed.data;
}

async function writeBundle(
	bundleFile: string,
	signed: SignedAttestation
): Promise<void> {
	await mkdir(path.dirname(bundleFile), { recursive: true });
	await writeFile(bundleFile, signed.bundle);
}

/**
 * Signs the subjects that the `attest` command resolved. The first bundle
 * carries GitHub's SLSA build provenance. When the run recorded an origin for
 * those subjects, a second bundle carries cupboard's build-origin statement.
 * Both bundles cover the same subjects.
 */
export async function attestSignAction(
	options: AttestSignOptions,
	environment: Environment = env,
	reporter: Reporter = createGithubReporter(),
	dependencies: AttestSignDependencies = {}
): Promise<void> {
	const inputs = resolveAttestSignInputs(options);
	const subjects = await readSubjects(inputs.checksumsFile);

	if (subjects.length === 0) {
		throw new InvalidInputError(
			'checksums-file',
			`${inputs.checksumsFile} lists no subject to sign`
		);
	}

	const signerFor =
		dependencies.signerFor ??
		((forSubjects, githubToken) =>
			githubStatementSigner({ subjects: forSubjects, githubToken }));
	const sign = signerFor(subjects, inputs.githubToken);
	const provenanceStatement =
		dependencies.provenanceStatement ?? slsaProvenanceStatement;
	const signing: SigningDependencies =
		dependencies.delay === undefined ? {} : { delay: dependencies.delay };
	// Read the build-origin predicate before signing anything. Reading it later
	// would record a provenance attestation on the repository for a run that
	// then fails on an unreadable file.
	const originPredicate =
		inputs.predicateFile === ''
			? undefined
			: await readPredicate(inputs.predicateFile);

	const provenance = await signStatement(
		await provenanceStatement(),
		sign,
		reporter,
		signing
	);

	await writeBundle(inputs.bundleFile, provenance);
	await setOutput(environment, 'bundle-path', inputs.bundleFile);

	if (originPredicate === undefined) {
		await setOutput(environment, 'origin-bundle-path', '');

		return;
	}

	const origin = await signStatement(
		{ predicateType: inputs.predicateType, predicate: originPredicate },
		sign,
		reporter,
		signing
	);

	await writeBundle(inputs.originBundleFile, origin);
	await setOutput(environment, 'origin-bundle-path', inputs.originBundleFile);
}

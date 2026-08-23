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
	AttestationSubjectsMissingError,
	MissingInputError,
	PredicateTypeRequiredError
} from '../errors.ts';
import { type Environment, setOutput } from '../inputs.ts';
import { provided } from '../options.ts';
import { parseChecksums } from '../release-install.ts';

export interface AttestSignOptions {
	readonly checksumsFile?: string;
	readonly builtChecksumsFile?: string;
	readonly predicateFile?: string;
	readonly predicateType?: string;
	readonly bundleFile?: string;
	readonly originBundleFile?: string;
	readonly githubToken?: string;
}

export interface AttestSignInputs {
	readonly checksumsFile: string;
	readonly builtChecksumsFile: string;
	readonly predicateFile: string;
	readonly predicateType: string;
	readonly bundleFile: string;
	readonly originBundleFile: string;
	readonly githubToken: string;
}

export interface AttestSignDependencies extends SigningDependencies {
	/**
	 * Defaults to {@link githubStatementSigner}.
	 */
	readonly signerFor?: (
		subjects: readonly AttestationSubject[],
		githubToken: string
	) => StatementSigner;
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
			'Sign build provenance and build-origin statements for the resolved subjects.'
		)
		.requiredOption(
			'--checksums-file <path>',
			'checksums for all accepted receipt subjects'
		)
		.requiredOption(
			'--built-checksums-file <path>',
			'checksums for accepted subjects built by this run'
		)
		.option('--predicate-file <path>', 'optional build-origin predicate')
		.option(
			'--predicate-type <type>',
			'in-toto predicate type of the build-origin predicate'
		)
		.option('--bundle-file <path>', 'path for the SLSA build-provenance bundle')
		.option('--origin-bundle-file <path>', 'path for the build-origin bundle')
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

	const builtChecksumsFile = provided(options.builtChecksumsFile);

	if (builtChecksumsFile === undefined) {
		throw new MissingInputError('built-checksums-file');
	}

	const githubToken = provided(options.githubToken);

	if (githubToken === undefined) {
		throw new MissingInputError('github-token');
	}

	const predicateFile = provided(options.predicateFile) ?? '';
	const predicateType = provided(options.predicateType) ?? '';

	if (predicateFile !== '' && predicateType === '') {
		throw new PredicateTypeRequiredError();
	}

	const bundleDirectory = path.dirname(path.resolve(checksumsFile));

	return {
		checksumsFile,
		builtChecksumsFile,
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
 * The two statements cover different subjects. Build provenance claims that
 * this workflow produced its subjects, so it covers only paths built by this
 * run. The action signs no build provenance when this run built none of the
 * published paths. The build-origin statement covers every accepted receipt
 * subject.
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
		throw new AttestationSubjectsMissingError(inputs.checksumsFile);
	}

	const builtSubjects = await readSubjects(inputs.builtChecksumsFile);
	const signerFor =
		dependencies.signerFor ??
		((forSubjects, githubToken) =>
			githubStatementSigner({ subjects: forSubjects, githubToken }));
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

	await setOutput(
		environment,
		'bundle-path',
		builtSubjects.length === 0
			? ''
			: await signProvenance(inputs, {
					sign: signerFor(builtSubjects, inputs.githubToken),
					statement: provenanceStatement,
					reporter,
					signing
				})
	);

	if (originPredicate === undefined) {
		await setOutput(environment, 'origin-bundle-path', '');

		return;
	}

	const origin = await signStatement(
		{ predicateType: inputs.predicateType, predicate: originPredicate },
		signerFor(subjects, inputs.githubToken),
		reporter,
		signing
	);

	await writeBundle(inputs.originBundleFile, origin);
	await setOutput(environment, 'origin-bundle-path', inputs.originBundleFile);
}

interface ProvenanceSigning {
	readonly sign: StatementSigner;
	readonly statement: () => Promise<AttestationStatement>;
	readonly reporter: Reporter;
	readonly signing: SigningDependencies;
}

async function signProvenance(
	inputs: AttestSignInputs,
	options: ProvenanceSigning
): Promise<string> {
	const provenance = await signStatement(
		await options.statement(),
		options.sign,
		options.reporter,
		options.signing
	);

	await writeBundle(inputs.bundleFile, provenance);

	return inputs.bundleFile;
}

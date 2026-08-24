import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { setOutput as setGithubOutput } from '@actions/core';
import { createGithubReporter, type Reporter } from '@cupboard/reporter';
import { chunk } from '@cupboard/shared/collections';
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

/**
 * File operations used while signing and saving attestation bundles.
 */
export interface AttestSignIo {
	readonly readText: (filePath: string) => Promise<string>;
	readonly writeBundle: (
		filePath: string,
		signed: SignedAttestation
	) => Promise<void>;
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
	/**
	 * Defaults to {@link setGithubOutput}.
	 */
	readonly setOutput?: (name: string, value: string) => Promise<void> | void;
	readonly io?: AttestSignIo;
}

// The `attest` command validates the build-origin predicate against its schema
// before it writes the file, so this command signs the document as it stands.
// The only check here is that the document is a JSON object, because that is
// what the predicate field of an in-toto statement takes.
const predicateDocumentSchema = z.looseObject({});
const maximumGithubAttestationSubjects = 1024;

export function registerAttestSignCommand(
	program: Command,
	dependencies: AttestSignDependencies = {}
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
		.option(
			'--bundle-file <path>',
			'base path for the SLSA build-provenance bundles'
		)
		.option(
			'--origin-bundle-file <path>',
			'base path for the build-origin bundles'
		)
		.option('--github-token <token>', 'GitHub token for the attestation store')
		.action((options: AttestSignOptions) =>
			attestSignAction(options, createGithubReporter(), dependencies)
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
	checksumsFile: string,
	io: AttestSignIo
): Promise<readonly AttestationSubject[]> {
	const checksums = parseChecksums(await io.readText(checksumsFile));

	return [...checksums].map(([name, sha256]) => ({ name, sha256 }));
}

async function readPredicate(
	predicateFile: string,
	io: AttestSignIo
): Promise<object> {
	const source = await io.readText(predicateFile);
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

const nodeAttestSignIo: AttestSignIo = {
	readText: (filePath) => readFile(filePath, 'utf8'),
	async writeBundle(filePath, signed) {
		await mkdir(path.dirname(filePath), { recursive: true });
		await writeFile(filePath, signed.bundle);
	}
};

/**
 * Build provenance covers only paths built by this run. The action signs no
 * build provenance when this run built none of the published paths.
 * Build-origin attestations cover every accepted receipt subject.
 */
export async function attestSignAction(
	options: AttestSignOptions,
	reporter: Reporter = createGithubReporter(),
	dependencies: AttestSignDependencies = {}
): Promise<void> {
	const inputs = resolveAttestSignInputs(options);
	const io = dependencies.io ?? nodeAttestSignIo;
	const subjects = await readSubjects(inputs.checksumsFile, io);

	if (subjects.length === 0) {
		throw new AttestationSubjectsMissingError(inputs.checksumsFile);
	}

	const builtSubjects = await readSubjects(inputs.builtChecksumsFile, io);
	const signerFor =
		dependencies.signerFor ??
		((forSubjects, githubToken) =>
			githubStatementSigner({ subjects: forSubjects, githubToken }));
	const provenanceStatement =
		dependencies.provenanceStatement ?? slsaProvenanceStatement;
	const signing: SigningDependencies =
		dependencies.delay === undefined ? {} : { delay: dependencies.delay };
	const setOutput = dependencies.setOutput ?? setGithubOutput;
	// Read the build-origin predicate before signing anything. Reading it later
	// would record a provenance attestation on the repository for a run that
	// then fails on an unreadable file.
	const originPredicate =
		inputs.predicateFile === ''
			? undefined
			: await readPredicate(inputs.predicateFile, io);

	const provenanceBundles =
		builtSubjects.length === 0
			? []
			: await signSubjectBatches({
					subjects: builtSubjects,
					statement: await provenanceStatement(),
					bundleFile: inputs.bundleFile,
					githubToken: inputs.githubToken,
					signerFor,
					reporter,
					signing,
					io
				});

	await setOutput('bundle-path', provenanceBundles.join('\n'));

	if (originPredicate === undefined) {
		await setOutput('origin-bundle-path', '');

		return;
	}

	const originBundles = await signSubjectBatches({
		subjects,
		statement: {
			predicateType: inputs.predicateType,
			predicate: originPredicate
		},
		bundleFile: inputs.originBundleFile,
		githubToken: inputs.githubToken,
		signerFor,
		reporter,
		signing,
		io
	});

	await setOutput('origin-bundle-path', originBundles.join('\n'));
}

interface SubjectBatchSigning {
	readonly subjects: readonly AttestationSubject[];
	readonly statement: AttestationStatement;
	readonly bundleFile: string;
	readonly githubToken: string;
	readonly signerFor: (
		subjects: readonly AttestationSubject[],
		githubToken: string
	) => StatementSigner;
	readonly reporter: Reporter;
	readonly signing: SigningDependencies;
	readonly io: AttestSignIo;
}

async function signSubjectBatches(
	options: SubjectBatchSigning
): Promise<readonly string[]> {
	const bundleFiles: string[] = [];
	const subjectBatches = chunk(
		options.subjects,
		maximumGithubAttestationSubjects
	);

	for (const [index, subjects] of subjectBatches.entries()) {
		const signed = await signStatement(
			options.statement,
			options.signerFor(subjects, options.githubToken),
			options.reporter,
			options.signing
		);
		const bundleFile = bundleFileForBatch(options.bundleFile, index);

		await options.io.writeBundle(bundleFile, signed);
		bundleFiles.push(bundleFile);
	}

	return bundleFiles;
}

function bundleFileForBatch(bundleFile: string, index: number): string {
	if (index === 0) {
		return bundleFile;
	}

	const extension = path.extname(bundleFile);

	if (extension === '') {
		return `${bundleFile}.${String(index + 1)}`;
	}

	const stem = bundleFile.slice(0, -extension.length);

	return `${stem}.${String(index + 1)}${extension}`;
}

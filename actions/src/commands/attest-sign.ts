import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { setOutput as setGithubOutput } from '@actions/core';
import {
	buildOriginPredicateSchema,
	buildOriginPredicateType,
	type ParsedBuildOriginPredicate
} from '@cupboard/protocol/build-origin';
import { createGithubReporter, type Reporter } from '@cupboard/reporter';
import { chunk } from '@cupboard/shared/collections';
import type { Command } from 'commander';
import { z } from 'zod';

import {
	type AttestationStatement,
	type AttestationSubject,
	defaultSigningPolicy,
	destinationVisibilities,
	disclosureLines,
	type GithubSignerOptions,
	githubStatementSigner,
	type ProducedEvidence,
	producedLines,
	type SignedAttestation,
	type SigningDependencies,
	signingDisclosure,
	type SigningPolicy,
	signingProfiles,
	signStatement,
	slsaProvenanceStatement,
	type StatementSigner,
	subjectGroupings,
	subjectsPerStatement
} from '../attestation-signing.ts';
import {
	AttestationPredicateFileError,
	AttestationSubjectsMissingError,
	BuildOriginSubjectMissingError,
	MissingInputError,
	PredicateGroupingUnsupportedError,
	PredicateTypeRequiredError
} from '../errors.ts';
import { isEnabled, provided, providedChoice } from '../options.ts';
import { parseChecksums } from '../release-install.ts';

export interface AttestSignOptions {
	readonly checksumsFile?: string;
	readonly builtChecksumsFile?: string;
	readonly predicateFile?: string;
	readonly predicateType?: string;
	readonly bundleFile?: string;
	readonly originBundleFile?: string;
	readonly githubToken?: string;
	readonly destinationVisibility?: string;
	readonly signingProfile?: string;
	readonly uploadToGithub?: string;
	readonly subjectGrouping?: string;
}

export interface AttestSignInputs {
	readonly checksumsFile: string;
	readonly builtChecksumsFile: string;
	readonly predicateFile: string;
	readonly predicateType: string;
	readonly bundleFile: string;
	readonly originBundleFile: string;
	readonly githubToken: string;
	readonly policy: SigningPolicy;
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
	readonly signerFor?: (options: GithubSignerOptions) => StatementSigner;
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
			'Read the accepted receipt subjects from this checksums file. The build-origin statements cover them.'
		)
		.requiredOption(
			'--built-checksums-file <path>',
			'Read the subjects this run built from this checksums file. The build-provenance statements cover them.'
		)
		.option(
			'--predicate-file <path>',
			'Sign this build-origin predicate. Requires --predicate-type. Without it the run signs build provenance alone.'
		)
		.option(
			'--predicate-type <type>',
			'In-toto predicate type of the build-origin predicate. Required with --predicate-file.'
		)
		.option(
			'--bundle-file <path>',
			'Write the SLSA build-provenance bundles under this base path. Defaults to a file beside the checksums file.'
		)
		.option(
			'--origin-bundle-file <path>',
			'Write the build-origin bundles under this base path. Defaults to a file beside the checksums file.'
		)
		.option(
			'--github-token <token>',
			"Record the bundles in the repository's attestation store with this token."
		)
		.option(
			'--destination-visibility <visibility>',
			'Take the signing defaults from the visibility of the destination cache. Accepts public or private, and defaults to private, whose defaults publish nothing.'
		)
		.option(
			'--signing-profile <profile>',
			"Select the Sigstore instance that signs the statements. sigstore-default leaves the choice to the repository's visibility, tsa-only signs with GitHub's instance and creates no Rekor entry, and rekor-and-tsa signs with the public-good instance and records the signature in Rekor. Defaults to the profile the destination visibility implies."
		)
		.option(
			'--upload-to-github <boolean>',
			"Record each bundle in the repository's attestation store when true. Defaults to the value the destination visibility implies."
		)
		.option(
			'--subject-grouping <grouping>',
			'Select how many subjects one statement covers. run signs one statement that covers all accepted subjects, up to the per-statement limit; individual signs one statement per subject, so no bundle names another subject. Defaults to the grouping the destination visibility implies.'
		)
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
		policy: resolveSigningPolicy(options),
		bundleFile:
			provided(options.bundleFile) ??
			path.join(bundleDirectory, 'provenance.sigstore.json'),
		originBundleFile:
			provided(options.originBundleFile) ??
			path.join(bundleDirectory, 'build-origin.sigstore.json')
	};
}

/**
 * The signing policy for this run. The destination's visibility supplies the
 * defaults and each input overrides one of them, so an explicit input is the
 * caller's own decision to disclose.
 *
 * An absent visibility resolves to `private`, whose defaults publish nothing.
 * Treating it as public instead would publish a private cache's NAR hashes
 * whenever a caller failed to pass the value, and no later step can retract
 * them.
 */
function resolveSigningPolicy(options: AttestSignOptions): SigningPolicy {
	const defaults = defaultSigningPolicy(
		providedChoice(
			'destination-visibility',
			options.destinationVisibility,
			destinationVisibilities,
			'private'
		)
	);

	return {
		profile: providedChoice(
			'signing-profile',
			options.signingProfile,
			signingProfiles,
			defaults.profile
		),
		uploadToGithub: isEnabled(
			'upload-to-github',
			options.uploadToGithub,
			defaults.uploadToGithub
		),
		grouping: providedChoice(
			'subject-grouping',
			options.subjectGrouping,
			subjectGroupings,
			defaults.grouping
		)
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
	const signerFor = dependencies.signerFor ?? githubStatementSigner;
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

	const originStatement =
		originPredicate === undefined
			? undefined
			: originStatementFor(inputs, originPredicate, subjects);
	const disclosed = disclosureLines(
		signingDisclosure(inputs.policy, subjects.length)
	);

	for (const line of disclosed) {
		reporter.info(line);
	}

	const provenanceBundles =
		builtSubjects.length === 0
			? []
			: await signSubjectBatches({
					subjects: builtSubjects,
					statementFor: runStatement(await provenanceStatement()),
					bundleFile: inputs.bundleFile,
					githubToken: inputs.githubToken,
					policy: inputs.policy,
					signerFor,
					reporter,
					signing,
					io
				});

	await setOutput('bundle-path', bundlePaths(provenanceBundles));

	const originBundles =
		originStatement === undefined
			? []
			: await signSubjectBatches({
					subjects,
					statementFor: originStatement,
					bundleFile: inputs.originBundleFile,
					githubToken: inputs.githubToken,
					policy: inputs.policy,
					signerFor,
					reporter,
					signing,
					io
				});

	await setOutput('origin-bundle-path', bundlePaths(originBundles));

	const produced = producedLines(
		producedEvidence([...provenanceBundles, ...originBundles])
	);

	for (const line of produced) {
		reporter.info(line);
	}
}

interface SignedBundle {
	readonly file: string;
	readonly signed: SignedAttestation;
}

function bundlePaths(bundles: readonly SignedBundle[]): string {
	return bundles.map((bundle) => bundle.file).join('\n');
}

function producedEvidence(bundles: readonly SignedBundle[]): ProducedEvidence {
	let tlogEntryCount = 0;
	let timestampCount = 0;
	let uploadedCount = 0;

	for (const { signed } of bundles) {
		tlogEntryCount += signed.evidence.tlogEntryCount;
		timestampCount += signed.evidence.timestampCount;

		if (signed.attestationId !== undefined) {
			uploadedCount += 1;
		}
	}

	return {
		bundleCount: bundles.length,
		tlogEntryCount,
		timestampCount,
		uploadedCount
	};
}

/**
 * The statement to sign for one group of subjects. Run grouping signs the same
 * statement for every group; individual grouping builds one that names only
 * the subject it covers.
 */
type StatementFor = (
	subjects: readonly AttestationSubject[]
) => AttestationStatement;

function runStatement(statement: AttestationStatement): StatementFor {
	return () => statement;
}

/**
 * The build-origin statement for one group of subjects. Under individual
 * grouping the predicate keeps only the entries the group covers, because the
 * run-level document lists every accepted subject and signing it beside one
 * subject would name the others.
 */
function originStatementFor(
	inputs: AttestSignInputs,
	predicate: object,
	subjects: readonly AttestationSubject[]
): StatementFor {
	if (inputs.policy.grouping === 'run') {
		return runStatement({
			predicateType: inputs.predicateType,
			predicate
		});
	}

	if (inputs.predicateType !== buildOriginPredicateType) {
		throw new PredicateGroupingUnsupportedError(inputs.predicateType);
	}

	const parsed = buildOriginPredicateSchema.parse(predicate);

	// Project every subject now. A subject the predicate does not record has to
	// fail the run before the first statement is signed, because signing records
	// an attestation on the repository that the failure cannot withdraw.
	for (const subject of subjects) {
		soleSubjectPredicate(parsed, [subject]);
	}

	return (group) => ({
		predicateType: inputs.predicateType,
		predicate: soleSubjectPredicate(parsed, group)
	});
}

function soleSubjectPredicate(
	predicate: ParsedBuildOriginPredicate,
	subjects: readonly AttestationSubject[]
): ParsedBuildOriginPredicate {
	const kept = predicate.subjects.filter((predicateSubject) =>
		subjects.some(
			(subject) =>
				subject.sha256 === predicateSubject.narHash &&
				subject.name === path.basename(predicateSubject.storePath)
		)
	);

	if (kept.length === 0) {
		throw new BuildOriginSubjectMissingError(
			subjects.map((subject) => subject.name)
		);
	}

	return { subjects: kept };
}

interface SubjectBatchSigning {
	readonly subjects: readonly AttestationSubject[];
	readonly statementFor: StatementFor;
	readonly bundleFile: string;
	readonly githubToken: string;
	readonly policy: SigningPolicy;
	readonly signerFor: (options: GithubSignerOptions) => StatementSigner;
	readonly reporter: Reporter;
	readonly signing: SigningDependencies;
	readonly io: AttestSignIo;
}

async function signSubjectBatches(
	options: SubjectBatchSigning
): Promise<readonly SignedBundle[]> {
	const bundles: SignedBundle[] = [];
	const subjectBatches = chunk(
		options.subjects,
		subjectsPerStatement(
			options.policy.grouping,
			maximumGithubAttestationSubjects
		)
	);

	for (const [index, subjects] of subjectBatches.entries()) {
		const signed = await signStatement(
			options.statementFor(subjects),
			options.signerFor({
				subjects,
				githubToken: options.githubToken,
				policy: options.policy
			}),
			options.reporter,
			options.signing
		);
		const file = bundleFileForBatch(options.bundleFile, index);

		await options.io.writeBundle(file, signed);
		bundles.push({ file, signed });
	}

	return bundles;
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

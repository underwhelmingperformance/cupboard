import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { setOutput as setGithubOutput } from '@actions/core';
import {
	type BuildOriginPredicate,
	buildOriginPredicateSchema,
	buildOriginPredicateType
} from '@cupboard/protocol/build-origin';
import { createGithubReporter, type Reporter } from '@cupboard/reporter';
import { chunk } from '@cupboard/shared/collections';
import type { Command } from 'commander';
import { z } from 'zod';

import {
	type AttestationStatement,
	type AttestationSubject,
	defaultSigningPolicy,
	destinationAccesses,
	disclosureLines,
	type GithubSignerOptions,
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
import {
	type SigstoreSignerDependencies,
	statementSignerFor
} from '../sigstore-signing.ts';

export interface AttestSignOptions {
	readonly checksumsFile?: string;
	readonly builtChecksumsFile?: string;
	readonly predicateFile?: string;
	readonly predicateType?: string;
	readonly bundleFile?: string;
	readonly originBundleFile?: string;
	readonly githubToken?: string;
	readonly destinationAccess?: string;
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
	 * Defaults to {@link statementSignerFor}.
	 */
	readonly signerFor?: (
		options: GithubSignerOptions,
		signing?: SigstoreSignerDependencies
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
			'--destination-access <access>',
			'Take the signing defaults from the destination cache access. Accepts public or private. If omitted, use the private defaults, which do not publish a bundle.'
		)
		.option(
			'--signing-profile <profile>',
			"Select the evidence in each signed bundle. sigstore-default selects the Sigstore instance according to the repository's visibility. tsa-only uses the public-good trust domain and adds an RFC 3161 timestamp without a Rekor entry. rekor-and-tsa uses the same trust domain and adds both. The default depends on the destination access."
		)
		.option(
			'--upload-to-github <boolean>',
			"When true, record each bundle in the repository's attestation store. The default depends on the destination access."
		)
		.option(
			'--subject-grouping <grouping>',
			'Select how many subjects each statement covers. run signs one statement for all accepted subjects, up to the per-statement limit. individual signs a separate statement for each subject, so each bundle contains one subject. The default depends on the destination access.'
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
 * Resolves the signing policy for this run. The destination access supplies
 * the defaults, and each explicit policy input overrides its corresponding
 * default. An override for a private destination can publish information that
 * the defaults keep off public services.
 *
 * An absent access value uses the private defaults, which do not publish a
 * bundle. If it used the public defaults, an omitted value could publish a
 * destination cache's NAR hashes. No later step can retract them.
 */
function resolveSigningPolicy(options: AttestSignOptions): SigningPolicy {
	const defaults = defaultSigningPolicy(
		providedChoice(
			'destination-access',
			options.destinationAccess,
			destinationAccesses,
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
 * Build provenance covers only paths built by this run. The action does not
 * sign build provenance when this run built none of the published paths.
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
	const signerFor = dependencies.signerFor ?? statementSignerFor;
	const provenanceStatement =
		dependencies.provenanceStatement ?? slsaProvenanceStatement;
	const signing: SigningDependencies =
		dependencies.delay === undefined ? {} : { delay: dependencies.delay };
	const setOutput = dependencies.setOutput ?? setGithubOutput;
	// Read the build-origin predicate before signing. If this read happened
	// later, an unreadable file could fail the run after the action had already
	// recorded a provenance attestation in the repository.
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
		inputs.policy.profile,
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

type StatementFor = (
	subjects: readonly AttestationSubject[]
) => AttestationStatement;

function runStatement(statement: AttestationStatement): StatementFor {
	return () => statement;
}

/**
 * Returns the build-origin statement for a group of subjects. With individual
 * grouping, the predicate contains only the entries for the current subject.
 * The source predicate contains every accepted subject, so signing it unchanged
 * would disclose the other subjects in each bundle.
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

	// Validate every subject before signing begins. Otherwise a missing subject
	// could fail the run after an earlier bundle had already been recorded in the
	// repository's attestation store, where it cannot be withdrawn.
	for (const subject of subjects) {
		soleSubjectPredicate(parsed, [subject]);
	}

	return (group) => ({
		predicateType: inputs.predicateType,
		predicate: soleSubjectPredicate(parsed, group)
	});
}

function soleSubjectPredicate(
	predicate: BuildOriginPredicate,
	subjects: readonly AttestationSubject[]
): BuildOriginPredicate {
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

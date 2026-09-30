import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { setOutput as setGithubOutput } from '@actions/core';
import { maxAttestationBundleBytes } from '@cupboard/protocol/attestations';
import {
	type BuildReceipt,
	buildReceiptSchema
} from '@cupboard/protocol/build';
import {
	type BuildOriginPredicate,
	buildOriginPredicateSchema,
	buildOriginPredicateType
} from '@cupboard/protocol/build-origin';
import {
	type ScaiAttributeReport,
	scaiAttributeReportSchema,
	scaiPredicateType
} from '@cupboard/protocol/scai';
import { createGithubReporter, type Reporter } from '@cupboard/reporter';
import { chunk } from '@cupboard/shared/collections';
import type { Command } from 'commander';
import { z } from 'zod';

import {
	type AttestationStatement,
	type AttestationSubject,
	defaultSigningPolicy,
	destinationAccessModes,
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
	AttestationBundleTooLargeForSubjectError,
	AttestationPredicateFileError,
	AttestationSubjectNotAcceptedError,
	AttestationSubjectsMissingError,
	BuildOriginSubjectMissingError,
	MissingInputError,
	PredicateGroupingUnsupportedError,
	PredicateSourceConflictError,
	PredicateTypeRequiredError
} from '../errors.ts';
import { isEnabled, provided, providedChoice } from '../options.ts';
import { parseChecksums } from '../release-install.ts';
import {
	reproducedSubjects,
	reproductionReport
} from '../reproduction-report.ts';
import {
	inTotoStatement,
	type SigstoreSignerDependencies,
	statementSignerFor
} from '../sigstore-signing.ts';

export interface AttestSignOptions {
	readonly receiptFile?: string;
	readonly inlineBundles?: string;
	readonly checksumsFile?: string;
	readonly builtChecksumsFile?: string;
	readonly predicateFile?: string;
	readonly predicateType?: string;
	readonly bundleFile?: string;
	readonly originBundleFile?: string;
	readonly bundlesFile?: string;
	readonly githubToken?: string;
	readonly destinationAccess?: string;
	readonly signingProfile?: string;
	readonly uploadToGithub?: string;
	readonly subjectGrouping?: string;
}

export interface AttestSignInputs {
	readonly receiptFile: string;
	readonly shouldEmitInlineBundles: boolean;
	readonly checksumsFile: string;
	readonly signedChecksumsFile: string;
	readonly builtChecksumsFile: string;
	readonly predicateFile: string;
	readonly predicateType: string;
	readonly bundleFile: string;
	readonly originBundleFile: string;
	readonly bundlesFile: string;
	readonly githubToken: string;
	readonly policy: SigningPolicy;
}

/**
 * File operations used while signing and saving attestation bundles.
 */
export interface AttestSignIo {
	readonly readText: (filePath: string) => Promise<string>;
	readonly writeText: (filePath: string, contents: string) => Promise<void>;
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

const predicateDocumentSchema = z.looseObject({});
const maximumGithubAttestationSubjects = 1024;
// Base64 expands the statement payload, and the certificate and witnesses add
// bytes. Check the signed bundle below because witness sizes can vary.
const maximumStatementPayloadBytes = Math.floor(
	((maxAttestationBundleBytes - 64 * 1024) * 3) / 4
);

export function registerAttestSignCommand(
	program: Command,
	dependencies: AttestSignDependencies = {}
): void {
	program
		.command('attest-sign')
		.description(
			'Sign build provenance and an optional custom predicate for the resolved subjects.'
		)
		.requiredOption(
			'--checksums-file <path>',
			'Read accepted receipt subjects from this checksums file.'
		)
		.requiredOption(
			'--built-checksums-file <path>',
			'Read the subjects this run built from this checksums file. The build-provenance statements cover them.'
		)
		.option(
			'--receipt-file <path>',
			'Generate reproduction assertions from this validated build receipt. Cannot be combined with --predicate-file.'
		)
		.option(
			'--predicate-file <path>',
			'Read an optional custom predicate from this file. Requires --predicate-type.'
		)
		.option(
			'--predicate-type <type>',
			'In-toto predicate type of the custom predicate. Required with --predicate-file.'
		)
		.option(
			'--bundle-file <path>',
			'Write the SLSA build-provenance bundles under this base path. Defaults to a file beside the checksums file.'
		)
		.option(
			'--origin-bundle-file <path>',
			'Write custom predicate bundles under this base path. Defaults to a file beside the checksums file.'
		)
		.option(
			'--bundles-file <path>',
			'Write generated bundle paths to this file, one per line.'
		)
		.option(
			'--inline-bundles <boolean>',
			'Control how bundle lists are returned. true writes inline bundle outputs as well as files; false returns files without inline bundle outputs.'
		)
		.option(
			'--github-token <token>',
			"Record the bundles in the repository's attestation store with this token."
		)
		.option(
			'--destination-access <access>',
			"Take the signing defaults from the destination cache's access. Accepts public or private. If omitted, use the private defaults, which skip uploads to Rekor and GitHub."
		)
		.option(
			'--signing-profile <profile>',
			"Select the evidence in each signed bundle. sigstore-default selects the Sigstore instance according to the repository's visibility. tsa-only uses the public-good trust domain and adds an RFC 3161 timestamp without a Rekor entry. rekor-and-tsa uses the same trust domain and adds both. The default depends on the destination cache's access."
		)
		.option(
			'--upload-to-github <boolean>',
			"When true, record each bundle in the repository's attestation store. The default depends on the destination cache's access."
		)
		.option(
			'--subject-grouping <grouping>',
			"Select how subjects are grouped within each statement type. run signs batches of up to 1024 subjects. individual signs a separate statement for each subject. The default depends on the destination cache's access."
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
	const receiptFile = provided(options.receiptFile) ?? '';

	if (receiptFile !== '' && predicateFile !== '') {
		throw new PredicateSourceConflictError();
	}

	if (predicateFile !== '' && predicateType === '') {
		throw new PredicateTypeRequiredError();
	}

	const bundleDirectory = path.dirname(path.resolve(checksumsFile));
	const shouldEmitInlineBundles = isEnabled(
		'inline-bundles',
		options.inlineBundles,
		true
	);

	return {
		receiptFile,
		shouldEmitInlineBundles,
		checksumsFile,
		signedChecksumsFile: path.join(bundleDirectory, 'signed-subjects.txt'),
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
			path.join(bundleDirectory, 'build-origin.sigstore.json'),
		bundlesFile:
			provided(options.bundlesFile) ??
			(shouldEmitInlineBundles ? '' : path.join(bundleDirectory, 'bundles.txt'))
	};
}

function resolveSigningPolicy(options: AttestSignOptions): SigningPolicy {
	const defaults = defaultSigningPolicy(
		providedChoice(
			'destination-access',
			options.destinationAccess,
			destinationAccessModes,
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
	async writeText(filePath, contents) {
		await mkdir(path.dirname(filePath), { recursive: true });
		await writeFile(filePath, contents);
	},
	async writeBundle(filePath, signed) {
		await mkdir(path.dirname(filePath), { recursive: true });
		await writeFile(filePath, signed.bundle);
	}
};

/**
 * Build provenance covers paths built by this run. An explicit custom predicate
 * applies to the explicitly selected subjects. Generated reproduction reports
 * cover only the subjects with locally observed successful verification checks.
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
	requireAcceptedSubjects(builtSubjects, subjects);
	const signerFor = dependencies.signerFor ?? statementSignerFor;
	const provenanceStatement =
		dependencies.provenanceStatement ?? slsaProvenanceStatement;
	const signing: SigningDependencies =
		dependencies.delay === undefined ? {} : { delay: dependencies.delay };
	const setOutput = dependencies.setOutput ?? setGithubOutput;
	const custom = await resolveCustomStatement(inputs, io, subjects);
	const signedSubjects =
		custom === undefined
			? builtSubjects
			: coveredSubjects(subjects, [
					...builtSubjects.map((subject) => subject.name),
					...custom.subjects.map((subject) => subject.name)
				]);
	const disclosed = disclosureLines(
		signingDisclosure(inputs.policy, {
			built: builtSubjects.length,
			custom: custom === undefined ? 0 : custom.subjects.length
		})
	);

	if (signedSubjects.length > 0) {
		for (const line of disclosed) {
			reporter.info(line);
		}
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

	const customBundles =
		custom === undefined
			? []
			: await signSubjectBatches({
					subjects: custom.subjects,
					statementFor: custom.statementFor,
					canSplitSubjects: custom.canSplitSubjects,
					bundleFile: inputs.originBundleFile,
					githubToken: inputs.githubToken,
					policy: inputs.policy,
					signerFor,
					reporter,
					signing,
					io
				});

	const bundles = [...provenanceBundles, ...customBundles];
	const bundleList = bundlePaths(bundles);
	const bundlesFile = inputs.bundlesFile;
	if (inputs.shouldEmitInlineBundles) {
		await setOutput('bundle-path', bundlePaths(provenanceBundles));
		await setOutput('origin-bundle-path', bundlePaths(customBundles));
		await setOutput('bundles', bundleList);
	}
	if (bundlesFile !== '') {
		await io.writeText(
			bundlesFile,
			bundleList.concat(bundles.length === 0 ? '' : '\n')
		);
		await setOutput('bundles-file', bundles.length === 0 ? '' : bundlesFile);
	}
	await io.writeText(
		inputs.signedChecksumsFile,
		signedSubjects
			.map((subject) => `${subject.sha256}  ${subject.name}`)
			.join('\n')
			.concat(signedSubjects.length === 0 ? '' : '\n')
	);
	await setOutput('checksums-file', inputs.signedChecksumsFile);

	const produced = producedLines(
		inputs.policy.profile,
		producedEvidence(bundles)
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

interface CustomStatement {
	readonly subjects: readonly AttestationSubject[];
	readonly statementFor: StatementFor;
	readonly canSplitSubjects?: boolean;
}

// The subjects listed in the signed-checksums file: everything a signed
// statement covers, in the accepted order.
function coveredSubjects(
	accepted: readonly AttestationSubject[],
	covered: readonly string[]
): readonly AttestationSubject[] {
	const names = new Set(covered);

	return accepted.filter((subject) => names.has(subject.name));
}

function requireAcceptedSubjects(
	selected: readonly AttestationSubject[],
	accepted: readonly AttestationSubject[]
): void {
	const acceptedByName = new Map(
		accepted.map((subject) => [subject.name, subject.sha256])
	);
	const mismatched = selected.filter(
		(subject) => acceptedByName.get(subject.name) !== subject.sha256
	);

	if (mismatched.length > 0) {
		throw new AttestationSubjectNotAcceptedError(
			mismatched.map((subject) => subject.name)
		);
	}
}

function runStatement(statement: AttestationStatement): StatementFor {
	return () => statement;
}

function customStatementFor(
	inputs: AttestSignInputs,
	predicate: object,
	subjects: readonly AttestationSubject[]
): CustomStatement {
	if (inputs.predicateType === scaiPredicateType) {
		return scaiStatementFor(inputs, predicate, subjects);
	}

	return originStatementFor(inputs, predicate, subjects);
}

async function resolveCustomStatement(
	inputs: AttestSignInputs,
	io: AttestSignIo,
	subjects: readonly AttestationSubject[]
): Promise<CustomStatement | undefined> {
	if (inputs.receiptFile !== '') {
		const source = await io.readText(inputs.receiptFile);
		const document: unknown = JSON.parse(source);
		return reproductionStatementFor(
			buildReceiptSchema.parse(document),
			subjects
		);
	}

	if (inputs.predicateFile === '') {
		return undefined;
	}
	const predicate = await readPredicate(inputs.predicateFile, io);
	return customStatementFor(inputs, predicate, subjects);
}

function scaiStatementFor(
	inputs: AttestSignInputs,
	predicate: object,
	subjects: readonly AttestationSubject[]
): CustomStatement {
	const report = scaiAttributeReportSchema.parse(predicate);

	if (
		subjects.length > 1 &&
		(inputs.policy.grouping === 'individual' ||
			subjects.length > maximumGithubAttestationSubjects ||
			Buffer.byteLength(
				JSON.stringify(
					inTotoStatement(subjects, {
						predicateType: scaiPredicateType,
						predicate: report
					})
				)
			) > maximumStatementPayloadBytes)
	) {
		throw new PredicateGroupingUnsupportedError(scaiPredicateType);
	}

	return {
		subjects,
		statementFor: runStatement({
			predicateType: scaiPredicateType,
			predicate: report
		}),
		canSplitSubjects: false
	};
}

function reproductionStatementFor(
	receipt: BuildReceipt,
	accepted: readonly AttestationSubject[]
): CustomStatement | undefined {
	const reproduced = reproducedSubjects(receipt);
	if (reproduced.length === 0) {
		return undefined;
	}

	const selected = reproduced.map((subject) => ({
		name: path.basename(subject.storePath),
		sha256: subject.sha256
	}));
	requireAcceptedSubjects(selected, accepted);
	const reproducedByDigest = Map.groupBy(
		reproduced,
		(subject) => subject.sha256
	);
	const subjects = accepted.filter((subject) =>
		reproducedByDigest.has(subject.sha256)
	);

	return {
		subjects,
		statementFor: (group) => {
			const digests = new Set(group.map((subject) => subject.sha256));
			const assertions = digests
				.values()
				.flatMap((digest) => reproducedByDigest.get(digest) ?? [])
				.toArray();

			return {
				predicateType: scaiPredicateType,
				predicate: reproductionReport(assertions, group.length === 1)
			};
		}
	};
}

function originStatementFor(
	inputs: AttestSignInputs,
	predicate: object,
	subjects: readonly AttestationSubject[]
): CustomStatement {
	if (inputs.policy.grouping === 'run') {
		return {
			subjects,
			statementFor: runStatement({
				predicateType: inputs.predicateType,
				predicate
			})
		};
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

	return {
		subjects,
		statementFor: (group) => ({
			predicateType: inputs.predicateType,
			predicate: soleSubjectPredicate(parsed, group)
		})
	};
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
	readonly canSplitSubjects?: boolean;
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

	for (const subjects of subjectBatches) {
		const signedBatches = await signFittingBatch(options, subjects);
		for (const signed of signedBatches) {
			const file = bundleFileForBatch(options.bundleFile, bundles.length);

			await options.io.writeBundle(file, signed);
			bundles.push({ file, signed });
		}
	}

	return bundles;
}

async function signFittingBatch(
	options: SubjectBatchSigning,
	subjects: readonly AttestationSubject[]
): Promise<readonly SignedAttestation[]> {
	const statement = options.statementFor(subjects);
	const payloadBytes = Buffer.byteLength(
		JSON.stringify(inTotoStatement(subjects, statement))
	);

	if (payloadBytes > maximumStatementPayloadBytes) {
		const split = await splitFittingBatch(options, subjects, statement);
		if (split !== undefined) {
			return split;
		}
	}

	const signed = await signStatement(
		statement,
		options.signerFor({
			subjects,
			githubToken: options.githubToken,
			policy: options.policy
		}),
		options.reporter,
		options.signing
	);
	const bundleBytes = Buffer.byteLength(signed.bundle);

	if (bundleBytes <= maxAttestationBundleBytes) {
		return [signed];
	}

	const split = await splitFittingBatch(options, subjects, statement);
	if (split !== undefined) {
		return split;
	}

	const [subject] = subjects;
	if (subject === undefined) {
		throw new AttestationSubjectsMissingError(options.bundleFile);
	}

	throw new AttestationBundleTooLargeForSubjectError(
		subject.name,
		bundleBytes,
		maxAttestationBundleBytes
	);
}

async function splitFittingBatch(
	options: SubjectBatchSigning,
	subjects: readonly AttestationSubject[],
	statement: AttestationStatement
): Promise<readonly SignedAttestation[] | undefined> {
	if (subjects.length > 1) {
		if (options.canSplitSubjects === false) {
			throw new PredicateGroupingUnsupportedError(statement.predicateType);
		}
		return signSplitBatch(options, subjects);
	}

	if (statement.predicateType !== scaiPredicateType) {
		return undefined;
	}
	const report: ScaiAttributeReport = scaiAttributeReportSchema.parse(
		statement.predicate
	);
	if (report.attributes.length < 2) {
		return undefined;
	}

	const midpoint = Math.floor(report.attributes.length / 2);
	const partitions = [
		report.attributes.slice(0, midpoint),
		report.attributes.slice(midpoint)
	];
	const signed: SignedAttestation[] = [];
	for (const attributes of partitions) {
		signed.push(
			...(await signFittingBatch(
				{
					...options,
					statementFor: runStatement({
						...statement,
						predicate: { ...report, attributes }
					})
				},
				subjects
			))
		);
	}
	return signed;
}

async function signSplitBatch(
	options: SubjectBatchSigning,
	subjects: readonly AttestationSubject[]
): Promise<readonly SignedAttestation[]> {
	const midpoint = Math.floor(subjects.length / 2);
	const first = await signFittingBatch(options, subjects.slice(0, midpoint));
	const second = await signFittingBatch(options, subjects.slice(midpoint));

	return [...first, ...second];
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

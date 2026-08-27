import process from 'node:process';

import { createOctokitClient } from '@cupboard/shared/octokit';
import {
	type VerifiedBundle,
	type VerifiedIdentityPolicy,
	verifyBundle
} from '@cupboard/shared/sigstore';
import { bundleToJSON } from '@sigstore/bundle';
import {
	type BundleBuilder,
	CIContextProvider,
	DSSEBundleBuilder,
	FulcioSigner,
	RekorWitness,
	TSAWitness,
	type Witness
} from '@sigstore/sign';
import { z } from 'zod';

import {
	type AttestationStatement,
	type AttestationSubject,
	type BundleEvidence,
	type GithubSignerOptions,
	githubStatementSigner,
	type SignedAttestation,
	type SigningProfile,
	type StatementSigner
} from './attestation-signing.ts';
import {
	AttestationBundleUnverifiedError,
	AttestationEvidenceShapeError,
	AttestationStoreWriteError,
	MissingInputError
} from './errors.ts';
import type { Environment } from './inputs.ts';

/**
 * A profile for which the action signs with a Sigstore client directly instead
 * of delegating to `@actions/attest`. Both client-signed profiles use the
 * public-good trust domain and differ only in the witnesses they use.
 */
export type ClientSignedProfile = Exclude<SigningProfile, 'sigstore-default'>;

export function isClientSignedProfile(
	profile: SigningProfile
): profile is ClientSignedProfile {
	return profile !== 'sigstore-default';
}

/**
 * The public-good service endpoints. `@actions/attest` uses these Fulcio and
 * Rekor endpoints when it selects the public-good instance. The public-good
 * trusted root lists this timestamp authority, so a verifier can use the
 * certificate chain from that trusted root to verify its timestamps.
 */
export const publicGoodFulcioUrl = 'https://fulcio.sigstore.dev';
export const publicGoodRekorUrl = 'https://rekor.sigstore.dev';
export const publicGoodTimestampUrl =
	'https://timestamp.sigstore.dev/api/v1/timestamp';

/**
 * The services used by each signing profile. `tsa-only` omits the Rekor URL and
 * uses an RFC 3161 timestamp as its only signed time evidence. The signature is
 * therefore not submitted to a public transparency log.
 */
export interface SigstoreComposition {
	readonly fulcioUrl: string;
	readonly rekorUrl?: string;
	readonly timestampUrl: string;
}

export function sigstoreComposition(
	profile: ClientSignedProfile
): SigstoreComposition {
	if (profile === 'tsa-only') {
		return {
			fulcioUrl: publicGoodFulcioUrl,
			timestampUrl: publicGoodTimestampUrl
		};
	}

	return {
		fulcioUrl: publicGoodFulcioUrl,
		rekorUrl: publicGoodRekorUrl,
		timestampUrl: publicGoodTimestampUrl
	};
}

export const signingTimeoutMilliseconds = 10_000;
export const signingServiceRetries = 3;

const oidcAudience = 'sigstore';

export type BundleBuilderFor = (
	composition: SigstoreComposition
) => BundleBuilder;

/**
 * Assembles the Sigstore client for one composition: a Fulcio signer that
 * exchanges the job's OIDC token for a signing certificate, and one witness for
 * each configured service. The builder produces version 0.3 DSSE bundles.
 */
export function bundleBuilderFor(
	composition: SigstoreComposition
): BundleBuilder {
	const fetchOptions = {
		timeout: signingTimeoutMilliseconds,
		retry: signingServiceRetries
	};
	const witnesses: Witness[] = [];

	if (composition.rekorUrl !== undefined) {
		witnesses.push(
			new RekorWitness({
				rekorBaseURL: composition.rekorUrl,
				fetchOnConflict: true,
				...fetchOptions
			})
		);
	}

	witnesses.push(
		new TSAWitness({ tsaBaseURL: composition.timestampUrl, ...fetchOptions })
	);

	return new DSSEBundleBuilder({
		signer: new FulcioSigner({
			identityProvider: new CIContextProvider(oidcAudience),
			fulcioBaseURL: composition.fulcioUrl,
			...fetchOptions
		}),
		witnesses
	});
}

const inTotoStatementType = 'https://in-toto.io/Statement/v1';
const inTotoPayloadType = 'application/vnd.in-toto+json';

export function inTotoStatement(
	subjects: readonly AttestationSubject[],
	statement: AttestationStatement
): object {
	return {
		_type: inTotoStatementType,
		subject: subjects.map((subject) => ({
			name: subject.name,
			digest: { sha256: subject.sha256 }
		})),
		predicateType: statement.predicateType,
		predicate: statement.predicate
	};
}

/**
 * The evidence required by each profile. `tsa-only` promises signed time
 * without a public record of the signature. A transparency-log entry in one of
 * its bundles would violate that promise.
 */
export interface ExpectedEvidence {
	readonly tlogEntries: 'none' | 'at-least-one';
	readonly timestamps: 'at-least-one';
}

export function expectedEvidence(
	profile: ClientSignedProfile
): ExpectedEvidence {
	return {
		tlogEntries: profile === 'tsa-only' ? 'none' : 'at-least-one',
		timestamps: 'at-least-one'
	};
}

function hasExpectedCount(
	count: number,
	expectation: 'none' | 'at-least-one'
): boolean {
	return expectation === 'none' ? count === 0 : count > 0;
}

function describeExpectation(expected: ExpectedEvidence): string {
	const entries =
		expected.tlogEntries === 'none'
			? 'no Rekor entry'
			: 'at least one Rekor entry';

	return `${entries} and at least one RFC 3161 timestamp`;
}

/**
 * Fails when a produced bundle carries evidence the profile did not promise.
 * For rekor-and-tsa, Rekor records its entry while the bundle is assembled, so
 * this check cannot withdraw that entry; it stops the run before the bundle is
 * written to files or recorded in the repository's attestation store.
 */
export function checkEvidenceShape(
	profile: ClientSignedProfile,
	evidence: BundleEvidence
): void {
	const expected = expectedEvidence(profile);

	if (
		hasExpectedCount(evidence.tlogEntryCount, expected.tlogEntries) &&
		hasExpectedCount(evidence.timestampCount, expected.timestamps)
	) {
		return;
	}

	throw new AttestationEvidenceShapeError(
		profile,
		describeExpectation(expected),
		evidence.tlogEntryCount,
		evidence.timestampCount
	);
}

const githubServerUrl = 'https://github.com';

/**
 * The identity policy that the signing certificate must satisfy. GitHub's OIDC
 * issuer depends on the GitHub server's host. Fulcio records the job's workflow
 * reference as a URI under the same server. This policy confirms that the
 * public-good Fulcio certified a workload from the configured GitHub server.
 * It does not restrict the workflow identity; consumers decide which workflows
 * to trust.
 */
export function actionsIdentityPolicy(
	environment: Environment
): VerifiedIdentityPolicy {
	const server = new URL(environment.GITHUB_SERVER_URL ?? githubServerUrl);
	const host =
		server.hostname === 'github.com'
			? 'githubusercontent.com'
			: server.hostname;

	return {
		identity: new RegExp(`^${RegExp.escape(server.origin)}/`, 'u'),
		issuer: `https://token.actions.${host}`
	};
}

/**
 * The number of transparency-log entries the verifier must find. A `tsa-only`
 * bundle carries none by design, so its verification rests on the timestamp
 * alone.
 */
function tlogThresholdFor(profile: ClientSignedProfile): number {
	return profile === 'tsa-only' ? 0 : 1;
}

export interface CheckedBundle {
	readonly profile: ClientSignedProfile;
	readonly statement: AttestationStatement;
	readonly subjects: readonly AttestationSubject[];
	readonly bundle: string;
	readonly evidence: BundleEvidence;
}

export type BundleSelfCheck = (checked: CheckedBundle) => Promise<void>;

export interface SelfCheckDependencies {
	readonly environment?: Environment;
	/**
	 * Defaults to the shared verifier, which reads the public-good trusted root.
	 */
	readonly verify?: typeof verifyBundle;
}

async function verifiedBundle(
	checked: CheckedBundle,
	dependencies: SelfCheckDependencies
): Promise<VerifiedBundle> {
	const verify = dependencies.verify ?? verifyBundle;

	try {
		return await verify(
			new TextEncoder().encode(checked.bundle),
			actionsIdentityPolicy(dependencies.environment ?? process.env),
			{
				tlogThreshold: tlogThresholdFor(checked.profile),
				timestampThreshold: 1
			}
		);
	} catch (error) {
		throw new AttestationBundleUnverifiedError(
			'did not verify against the public-good trusted root',
			{ cause: error }
		);
	}
}

function sortedDigests(digests: readonly string[]): string {
	return digests
		.toSorted((first, second) => first.localeCompare(second))
		.join(' ');
}

/**
 * Checks a bundle before the action attaches or uploads it. Under the
 * `rekor-and-tsa` profile, Rekor has already recorded its entry while the
 * signer built the bundle.
 *
 * The check confirms that the bundle contains the evidence required by the
 * profile. It verifies the signature, signing certificate, timestamp and any
 * log entry against the public-good trusted root. It also compares the signed
 * predicate type and subject digests with the requested statement. The check
 * does not compare subject names or predicate contents.
 */
export async function selfCheckBundle(
	checked: CheckedBundle,
	dependencies: SelfCheckDependencies = {}
): Promise<void> {
	checkEvidenceShape(checked.profile, checked.evidence);

	const verified = await verifiedBundle(checked, dependencies);

	if (verified.predicateType !== checked.statement.predicateType) {
		throw new AttestationBundleUnverifiedError(
			`has predicate type ${verified.predicateType}; expected ${checked.statement.predicateType}`
		);
	}

	const signed = sortedDigests(verified.subjectDigests);
	const intended = sortedDigests(
		checked.subjects.map((subject) => subject.sha256)
	);

	if (signed !== intended) {
		throw new AttestationBundleUnverifiedError(
			`has subject digests that differ from the ${String(checked.subjects.length)} requested subjects`
		);
	}
}

const repositoryPattern = /^([\w.-]+)\/([\w.-]+)$/u;
const attestationStoreResponseSchema = z.looseObject({
	id: z.union([z.number(), z.string()])
});
// The attestation-store endpoint accepts these three members. The loose schema
// preserves every other member of the bundle document.
const attestationBundleSchema = z.looseObject({
	mediaType: z.string().optional(),
	verificationMaterial: z.looseObject({}).optional(),
	dsseEnvelope: z.looseObject({}).optional()
});

export interface AttestationStoreWrite {
	readonly bundle: string;
	readonly githubToken: string;
	readonly environment: Environment;
}

export type AttestationStoreWriter = (
	write: AttestationStoreWrite
) => Promise<string>;

function repositoryFrom(environment: Environment): readonly [string, string] {
	const value = environment.GITHUB_REPOSITORY;

	if (value === undefined || value === '') {
		throw new MissingInputError('GITHUB_REPOSITORY');
	}

	const match = repositoryPattern.exec(value);
	const owner = match?.[1];
	const repo = match?.[2];

	if (owner === undefined || repo === undefined) {
		throw new AttestationStoreWriteError(value);
	}

	return [owner, repo];
}

/**
 * Records one bundle in the repository's attestation store. `gh attestation
 * verify` reads bundles from this store. `@actions/attest` writes to the same
 * endpoint for the profile it signs.
 */
export async function writeToAttestationStore(
	write: AttestationStoreWrite
): Promise<string> {
	const [owner, repo] = repositoryFrom(write.environment);
	const octokit = createOctokitClient({
		replaySafety: 'replay-safe',
		auth: write.githubToken,
		...(write.environment.GITHUB_API_URL !== undefined && {
			baseUrl: write.environment.GITHUB_API_URL
		})
	});

	const document = attestationBundleSchema.parse(JSON.parse(write.bundle));

	try {
		const response = await octokit.request(
			'POST /repos/{owner}/{repo}/attestations',
			{ owner, repo, bundle: document }
		);

		return String(attestationStoreResponseSchema.parse(response.data).id);
	} catch (error) {
		throw new AttestationStoreWriteError(`${owner}/${repo}`, { cause: error });
	}
}

export interface SigstoreSignerOptions {
	readonly subjects: readonly AttestationSubject[];
	readonly profile: ClientSignedProfile;
	readonly githubToken: string;
	readonly uploadToGithub: boolean;
}

export interface SigstoreSignerDependencies {
	readonly builderFor?: BundleBuilderFor;
	readonly selfCheck?: BundleSelfCheck;
	readonly writeAttestation?: AttestationStoreWriter;
	readonly environment?: Environment;
}

/**
 * Signs statements with the Fulcio and witness configuration for the selected
 * profile. The selected witnesses determine which evidence the bundle
 * contains. The action checks every bundle before writing it to a file or the
 * repository's attestation store.
 */
export function sigstoreStatementSigner(
	options: SigstoreSignerOptions,
	dependencies: SigstoreSignerDependencies = {}
): StatementSigner {
	const builderFor = dependencies.builderFor ?? bundleBuilderFor;
	const selfCheck = dependencies.selfCheck ?? selfCheckBundle;
	const writeAttestation =
		dependencies.writeAttestation ?? writeToAttestationStore;
	const environment = dependencies.environment ?? process.env;

	return async (statement) => {
		const builder = builderFor(sigstoreComposition(options.profile));
		const payload = JSON.stringify(
			inTotoStatement(options.subjects, statement)
		);
		const built = await builder.create({
			data: Buffer.from(payload),
			type: inTotoPayloadType
		});
		const material = built.verificationMaterial;
		const bundle = `${JSON.stringify(bundleToJSON(built))}\n`;
		const evidence: BundleEvidence = {
			tlogEntryCount: material.tlogEntries.length,
			timestampCount:
				material.timestampVerificationData?.rfc3161Timestamps.length ?? 0
		};

		await selfCheck({
			profile: options.profile,
			statement,
			subjects: options.subjects,
			bundle,
			evidence
		});

		const signed: SignedAttestation = { bundle, evidence };

		if (!options.uploadToGithub) {
			return signed;
		}

		return {
			...signed,
			attestationId: await writeAttestation({
				bundle,
				githubToken: options.githubToken,
				environment
			})
		};
	};
}

/**
 * The signer for a policy. `sigstore-default` delegates to `@actions/attest`,
 * which selects an instance from the repository's visibility. The other
 * profiles select an explicit set of witnesses, so the action constructs the
 * Sigstore client itself.
 */
export function statementSignerFor(
	options: GithubSignerOptions,
	dependencies: SigstoreSignerDependencies = {}
): StatementSigner {
	const { profile } = options.policy;

	if (!isClientSignedProfile(profile)) {
		return githubStatementSigner(options);
	}

	return sigstoreStatementSigner(
		{
			subjects: options.subjects,
			profile,
			githubToken: options.githubToken,
			uploadToGithub: options.policy.uploadToGithub
		},
		dependencies
	);
}

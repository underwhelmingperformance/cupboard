import { attest, buildSLSAProvenancePredicate } from '@actions/attest';
import type { Reporter } from '@cupboard/reporter';
import { backoffDelay } from '@cupboard/shared/retry';
import type { InternalError } from '@sigstore/sign';
import { StatusCodes } from 'http-status-codes';
import { z } from 'zod';

import {
	AttestationSelfCheckError,
	AttestationSigningError
} from './errors.ts';

export interface AttestationSubject {
	readonly name: string;
	readonly sha256: string;
}

export interface AttestationStatement {
	readonly predicateType: string;
	readonly predicate: object;
}

/**
 * Evidence that records when a bundle was signed. A Rekor entry is a permanent
 * public record of the signature. An RFC 3161 timestamp supplies signed time
 * evidence but does not by itself publish the signature to a public log.
 */
export interface BundleEvidence {
	readonly tlogEntryCount: number;
	readonly timestampCount: number;
}

const serialisedEvidenceEntriesSchema = z.array(z.unknown());

const serialisedBundleEvidenceSchema = z.object({
	tlogEntries: serialisedEvidenceEntriesSchema.default([]),
	timestampVerificationData: z
		.object({
			rfc3161Timestamps: serialisedEvidenceEntriesSchema.default([])
		})
		.optional()
});

function serialisedBundleEvidence(material: unknown): BundleEvidence {
	const evidence = serialisedBundleEvidenceSchema.parse(material);

	return {
		tlogEntryCount: evidence.tlogEntries.length,
		timestampCount:
			evidence.timestampVerificationData?.rfc3161Timestamps.length ?? 0
	};
}

export interface SignedAttestation {
	readonly bundle: string;
	readonly evidence: BundleEvidence;
	readonly attestationId?: string;
}

export type StatementSigner = (
	statement: AttestationStatement
) => Promise<SignedAttestation>;

/**
 * `@sigstore/sign` does not export its stage-code union. Derive it from the
 * exported error class so this type stays aligned with the installed package.
 */
export type SigningStageCode = InternalError['code'];

/**
 * Retry only stages that call Fulcio or a witness. The identity codes
 * (`IDENTITY_TOKEN_READ_ERROR`, `IDENTITY_TOKEN_PARSE_ERROR`) are left out,
 * because an OIDC token the job cannot read or decode is no more readable a few
 * seconds later.
 */
const serviceCallCodes = [
	'CA_CREATE_SIGNING_CERTIFICATE_ERROR',
	'TLOG_CREATE_ENTRY_ERROR',
	'TLOG_FETCH_ENTRY_ERROR',
	'TSA_CREATE_TIMESTAMP_ERROR'
] as const satisfies readonly SigningStageCode[];

/**
 * Retry only statuses that can reflect a temporary service failure. Fulcio may
 * use another 4xx status to refuse a certificate, and Rekor may use one to
 * reject an entry. Repeating those requests would get the same refusal, so
 * every status outside this set fails the step at once.
 */
const retryableSigningStatuses = new Set<number>([
	StatusCodes.REQUEST_TIMEOUT,
	StatusCodes.TOO_MANY_REQUESTS,
	StatusCodes.INTERNAL_SERVER_ERROR,
	StatusCodes.BAD_GATEWAY,
	StatusCodes.SERVICE_UNAVAILABLE,
	StatusCodes.GATEWAY_TIMEOUT
]);

const signingFailureSchema = z.object({
	code: z.enum(serviceCallCodes),
	cause: z.unknown()
});

const httpFailureSchema = z.object({ statusCode: z.number() });

/**
 * Retries a recognised Fulcio or witness call when it received no response or
 * one of {@link retryableSigningStatuses}. Everything else is final, including
 * a failure with no recognised stage code.
 */
export function isTransientSigningFailure(error: unknown): boolean {
	const failure = signingFailureSchema.safeParse(error);

	if (!failure.success) {
		return false;
	}

	const http = httpFailureSchema.safeParse(failure.data.cause);

	// A cause without a status code means the request received no response: a
	// DNS failure, a refused connection or a timed-out socket.
	if (!http.success) {
		return true;
	}

	return retryableSigningStatuses.has(http.data.statusCode);
}

export const maxSigningAttempts = 4;

export interface SigningDependencies {
	readonly delay?: (attempt: number) => Promise<void>;
}

/**
 * Signs one statement, attempting again after a transient Fulcio or witness
 * failure and backing off between attempts. Each attempt signs from the
 * beginning and gets its own key, certificate and log entry. A later attempt
 * therefore does not depend on any log entry created during a failed attempt.
 * When the failure is final, or the attempts run out, the caller gets an
 * {@link AttestationSigningError} and the step fails.
 */
export async function signStatement(
	statement: AttestationStatement,
	sign: StatementSigner,
	reporter: Reporter,
	dependencies: SigningDependencies = {}
): Promise<SignedAttestation> {
	const delay = dependencies.delay ?? backoffDelay;

	for (let attempt = 1; ; attempt += 1) {
		try {
			return await sign(statement);
		} catch (error) {
			// Propagate a self-check failure unchanged. It describes the bundle
			// produced by this attempt, and another signing attempt cannot repair it.
			if (error instanceof AttestationSelfCheckError) {
				throw error;
			}

			if (attempt >= maxSigningAttempts || !isTransientSigningFailure(error)) {
				throw new AttestationSigningError(statement.predicateType, attempt, {
					cause: error
				});
			}

			reporter.warn(
				`Could not sign the ${statement.predicateType} attestation; starting attempt ${String(attempt + 1)} of ${String(maxSigningAttempts)}`
			);
			await delay(attempt);
		}
	}
}

export const signingProfiles = [
	'sigstore-default',
	'tsa-only',
	'rekor-and-tsa'
] as const;
export type SigningProfile = (typeof signingProfiles)[number];

export const subjectGroupings = ['run', 'individual'] as const;
export type SubjectGrouping = (typeof subjectGroupings)[number];

export const destinationVisibilities = ['public', 'private'] as const;
export type DestinationVisibility = (typeof destinationVisibilities)[number];

export type SigstoreInstance = 'public-good' | 'github';

export interface SigningPolicy {
	readonly profile: SigningProfile;
	readonly uploadToGithub: boolean;
	readonly grouping: SubjectGrouping;
}

/**
 * How many subjects each statement covers. `individual` signs one statement
 * per subject. Each bundle reveals only that subject and does not attest to the
 * complete run. `run` signs one statement for a batch of subjects, up to the
 * limit accepted by the attestation store.
 */
export function subjectsPerStatement(
	grouping: SubjectGrouping,
	runBatchSize: number
): number {
	return grouping === 'individual' ? 1 : runBatchSize;
}

/**
 * The default signing policy for each destination visibility. The in-toto
 * subject digest of every statement is the NAR hash, and
 * Rekor and the repository's attestation store are append-only, so a
 * published bundle permanently reveals that each subject path exists and
 * identifies its contents to anyone holding a matching copy. The private
 * defaults omit Rekor and the GitHub attestation upload. They also sign one
 * statement per subject, which prevents a reader of one bundle from
 * enumerating the other subjects in the run.
 */
export function defaultSigningPolicy(
	visibility: DestinationVisibility
): SigningPolicy {
	if (visibility === 'private') {
		return {
			profile: 'tsa-only',
			uploadToGithub: false,
			grouping: 'individual'
		};
	}

	return {
		profile: 'sigstore-default',
		uploadToGithub: true,
		grouping: 'run'
	};
}

/**
 * The Sigstore instance selected by a profile. `tsa-only` and
 * `rekor-and-tsa` both sign in the public-good trust domain. The action
 * constructs their Sigstore clients and uses the public-good timestamp
 * authority. `sigstore-default` returns `undefined` because `@actions/attest`
 * selects an instance from the repository's visibility.
 */
export function sigstoreInstanceFor(
	profile: SigningProfile
): SigstoreInstance | undefined {
	return profile === 'sigstore-default' ? undefined : 'public-good';
}

export const disclosedServices = [
	'oidc-and-fulcio',
	'certificate-transparency',
	'rfc-3161-tsa',
	'rekor'
] as const;
export type DisclosedService = (typeof disclosedServices)[number];

export const publicationDestinations = [
	'rekor',
	'github-attestation-store',
	'bundle-files'
] as const;
export type PublicationDestination = (typeof publicationDestinations)[number];

export interface SigningDisclosure {
	/**
	 * The instances the run may use. This list contains both instances when
	 * `@actions/attest` selects one from the repository's visibility. In that
	 * case, `services` and `publications` cover both possible instances.
	 */
	readonly instances: readonly SigstoreInstance[];
	readonly services: readonly DisclosedService[];
	readonly publications: readonly PublicationDestination[];
	readonly grouping: SubjectGrouping;
	readonly subjectCount: number;
}

/**
 * The services each profile can contact. For `sigstore-default`, the set
 * includes every service used by either the public-good instance or the GitHub
 * instance because `@actions/attest` selects between them at runtime.
 */
const profileServices = {
	'sigstore-default': [
		'oidc-and-fulcio',
		'certificate-transparency',
		'rfc-3161-tsa',
		'rekor'
	],
	'tsa-only': ['oidc-and-fulcio', 'certificate-transparency', 'rfc-3161-tsa'],
	'rekor-and-tsa': [
		'oidc-and-fulcio',
		'certificate-transparency',
		'rfc-3161-tsa',
		'rekor'
	]
} as const satisfies Record<SigningProfile, readonly DisclosedService[]>;

/**
 * The external services a policy may contact and the destinations to which it
 * may publish a complete bundle. The action displays this information before
 * signing begins.
 */
export function signingDisclosure(
	policy: SigningPolicy,
	subjectCount: number
): SigningDisclosure {
	const instance = sigstoreInstanceFor(policy.profile);
	const instances: readonly SigstoreInstance[] =
		instance === undefined ? ['public-good', 'github'] : [instance];
	const contacted = new Set<DisclosedService>(profileServices[policy.profile]);
	const willPublishToRekor = contacted.has('rekor');

	return {
		instances,
		grouping: policy.grouping,
		subjectCount,
		services: disclosedServices.filter((service) => contacted.has(service)),
		publications: publicationDestinations.filter((destination) => {
			if (destination === 'rekor') {
				return willPublishToRekor;
			}

			return destination === 'bundle-files' || policy.uploadToGithub;
		})
	};
}

const instanceDescription = {
	'public-good': 'the public-good Sigstore instance',
	github: 'the GitHub Sigstore instance'
} as const satisfies Record<SigstoreInstance, string>;

const serviceDisclosure = {
	'oidc-and-fulcio':
		'OIDC and Fulcio receive the workload identity and an ephemeral public key.',
	'certificate-transparency':
		'Certificate transparency receives the signing certificate and the identity it certifies.',
	'rfc-3161-tsa':
		'An RFC 3161 timestamp authority receives the signature imprint and returns a signed timestamp.',
	rekor: 'Rekor receives the signature metadata and the certified identity.'
} as const satisfies Record<DisclosedService, string>;

const publicationDisclosure = {
	rekor:
		'Rekor stores a permanent public record of the signature, and that record remains after the cache drops the path.',
	'github-attestation-store':
		"The action writes the complete bundle to the repository's attestation store, where every reader of the repository can read it.",
	'bundle-files':
		'The action writes the complete bundle to files on the runner. Attaching one to the destination cache makes it readable under the read policy of that cache.'
} as const satisfies Record<PublicationDestination, string>;

/**
 * Renders a disclosure for the run log. Each subject digest in a statement is
 * a NAR hash, so a reader of a published bundle can fetch the NARs it names
 * from any cache that serves them.
 */
export function disclosureLines(
	disclosure: SigningDisclosure
): readonly string[] {
	const [soleInstance] = disclosure.instances;
	const heading =
		soleInstance !== undefined && disclosure.instances.length === 1
			? `Signing with ${instanceDescription[soleInstance]}.`
			: "The repository's visibility selects the Sigstore instance: the public-good instance for a public repository, the GitHub instance otherwise. The lines below cover both.";

	return [
		heading,
		groupingLine(disclosure),
		'Signing can contact the following external services.',
		...disclosure.services.map((service) => `  ${serviceDisclosure[service]}`),
		'Signing publishes evidence or complete bundles to the following destinations.',
		...disclosure.publications.map(
			(destination) => `  ${publicationDisclosure[destination]}`
		)
	];
}

function groupingLine(disclosure: SigningDisclosure): string {
	const subjects = counted(
		disclosure.subjectCount,
		'accepted subject',
		'accepted subjects'
	);

	return disclosure.grouping === 'individual'
		? `Signing one statement for each of the ${subjects}. Each bundle will contain one subject.`
		: `Signing one statement for all ${subjects}. Each bundle will contain the name and digest of every subject.`;
}

function counted(count: number, singular: string, plural: string): string {
	return `${String(count)} ${agreeing(count, singular, plural)}`;
}

function agreeing(count: number, singular: string, plural: string): string {
	return count === 1 ? singular : plural;
}

export interface ProducedEvidence extends BundleEvidence {
	readonly bundleCount: number;
	readonly uploadedCount: number;
}

/**
 * The instance that produced a set of bundles. A directly signed profile
 * selects its trust domain, so the report does not infer the instance from the
 * bundle evidence. Under `sigstore-default`, the repository's visibility
 * selects the instance. The evidence then distinguishes the two instances:
 * the public-good instance records every signature in Rekor, while the GitHub
 * instance adds an RFC 3161 timestamp.
 */
export function producedInstance(
	profile: SigningProfile,
	evidence: BundleEvidence
): SigstoreInstance | undefined {
	const selected = sigstoreInstanceFor(profile);

	if (selected !== undefined) {
		return selected;
	}

	if (evidence.tlogEntryCount > 0) {
		return 'public-good';
	}

	return evidence.timestampCount > 0 ? 'github' : undefined;
}

export function producedLines(
	profile: SigningProfile,
	produced: ProducedEvidence
): readonly string[] {
	if (produced.bundleCount === 0) {
		return ['This run signed no statement.'];
	}

	const instance = producedInstance(profile, produced);
	const bundles = counted(produced.bundleCount, 'bundle', 'bundles');

	return [
		instance === undefined
			? `${agreeing(produced.bundleCount, 'The bundle carries', 'The bundles carry')} no Rekor entry and no RFC 3161 timestamp.`
			: `${agreeing(produced.bundleCount, 'The bundle is', 'The bundles are')} in the trust domain of ${instanceDescription[instance]}.`,
		`The action signed ${bundles} that ${agreeing(produced.bundleCount, 'carries', 'carry')} ${counted(produced.tlogEntryCount, 'Rekor entry', 'Rekor entries')} and ${counted(produced.timestampCount, 'RFC 3161 timestamp', 'RFC 3161 timestamps')}.`,
		produced.uploadedCount === 0
			? "The action recorded no bundle in the repository's attestation store."
			: `The action recorded ${String(produced.uploadedCount)} of ${bundles} in the repository's attestation store.`
	];
}

export interface GithubSignerOptions {
	readonly subjects: readonly AttestationSubject[];
	readonly githubToken: string;
	readonly policy: SigningPolicy;
}

/**
 * Signs statements through `@actions/attest`, which selects the Sigstore
 * instance from the repository's visibility. This is the signer for the
 * `sigstore-default` profile. The `tsa-only` and `rekor-and-tsa` profiles use a
 * directly constructed Sigstore client instead. `upload-to-github` decides whether
 * `@actions/attest` writes the signed bundle to the repository's attestation
 * store, where `gh attestation verify` finds it.
 */
export function githubStatementSigner(
	options: GithubSignerOptions
): StatementSigner {
	const subjects = options.subjects.map((subject) => ({
		name: subject.name,
		digest: { sha256: subject.sha256 }
	}));

	return async (statement) => {
		const attestation = await attest({
			subjects,
			predicateType: statement.predicateType,
			predicate: statement.predicate,
			token: options.githubToken,
			skipWrite: !options.policy.uploadToGithub
		});

		return {
			bundle: `${JSON.stringify(attestation.bundle)}\n`,
			evidence: serialisedBundleEvidence(
				attestation.bundle.verificationMaterial
			),
			...(attestation.attestationID !== undefined && {
				attestationId: attestation.attestationID
			})
		};
	};
}

/**
 * Uses the same OIDC-derived SLSA predicate as
 * `actions/attest-build-provenance`.
 */
export async function slsaProvenanceStatement(): Promise<AttestationStatement> {
	const predicate = await buildSLSAProvenancePredicate();

	return { predicateType: predicate.type, predicate: predicate.params };
}

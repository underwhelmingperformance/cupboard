import { attest, buildSLSAProvenancePredicate } from '@actions/attest';
import { isPrivateCache, type StoredCache } from '@cupboard/nix-store/scalars';
import type { Reporter } from '@cupboard/reporter';
import { backoffDelay } from '@cupboard/shared/retry';
import type { InternalError } from '@sigstore/sign';
import { StatusCodes } from 'http-status-codes';
import { z } from 'zod';

import { AttestationSigningError } from './errors.ts';

export interface AttestationSubject {
	readonly name: string;
	readonly sha256: string;
}

export interface AttestationStatement {
	readonly predicateType: string;
	readonly predicate: object;
}

/**
 * The evidence of signing time a produced bundle carries. A Rekor entry is a
 * permanent public record of the signature. An RFC 3161 timestamp supplies
 * signed time evidence but does not by itself publish the signature to a
 * public log.
 */
export interface BundleEvidence {
	readonly tlogEntryCount: number;
	readonly timestampCount: number;
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
 * beginning and gets its own key, certificate and log entry, so a later attempt
 * never depends on the log entry a failed one created. When the failure is
 * final, or the attempts run out, the caller gets an
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
 * How many subjects one statement covers. `individual` signs one statement per
 * subject so that a reader of one bundle learns no other subject; it makes no
 * claim about the complete run. `run` signs one statement for a batch of
 * subjects, up to the limit the attestation store accepts.
 */
export function subjectsPerStatement(
	grouping: SubjectGrouping,
	runBatchSize: number
): number {
	return grouping === 'individual' ? 1 : runBatchSize;
}

export function cacheVisibility(cache: StoredCache): DestinationVisibility {
	return isPrivateCache(cache) ? 'private' : 'public';
}

/**
 * The policy a destination's visibility implies when the workflow selects
 * none. The in-toto subject digest of every statement is the NAR hash, and
 * Rekor and the repository's attestation store are append-only, so a
 * published bundle permanently reveals that each subject path exists and
 * identifies its contents to anyone holding a matching copy. A private
 * destination therefore defaults to evidence that reaches neither, and to
 * one statement per subject so that a reader of one bundle cannot enumerate
 * the others.
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
 * The Sigstore instance a profile selects. `tsa-only` selects the GitHub
 * instance because GitHub's private Fulcio and RFC 3161 timestamp authority
 * are the only delegated signing path that creates no Rekor entry; the bundle
 * it produces is in the GitHub trust domain rather than the public-good one.
 * `sigstore-default` selects nothing and leaves the choice to
 * `@actions/attest`, which reads the repository's visibility.
 */
export function sigstoreInstanceFor(
	profile: SigningProfile
): SigstoreInstance | undefined {
	if (profile === 'tsa-only') {
		return 'github';
	}

	if (profile === 'rekor-and-tsa') {
		return 'public-good';
	}

	return undefined;
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
	 * The instances the run may use. It holds both when the profile leaves the
	 * choice to the repository's visibility, and the services and publications
	 * then cover both.
	 */
	readonly instances: readonly SigstoreInstance[];
	readonly services: readonly DisclosedService[];
	readonly publications: readonly PublicationDestination[];
	readonly grouping: SubjectGrouping;
	readonly subjectCount: number;
}

const instanceServices = {
	'public-good': ['oidc-and-fulcio', 'certificate-transparency', 'rekor'],
	github: ['oidc-and-fulcio', 'rfc-3161-tsa']
} as const satisfies Record<SigstoreInstance, readonly DisclosedService[]>;

/**
 * What a selected policy will contact and where the complete bundle will end
 * up, so a workflow author reads the disclosure before signing rather than
 * after.
 */
export function signingDisclosure(
	policy: SigningPolicy,
	subjectCount: number
): SigningDisclosure {
	const instance = sigstoreInstanceFor(policy.profile);
	const instances: readonly SigstoreInstance[] =
		instance === undefined ? ['public-good', 'github'] : [instance];
	const contacted = new Set(
		instances.flatMap((selected) => instanceServices[selected])
	);
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
	'public-good':
		'the public-good Sigstore instance (the public Fulcio and Rekor)',
	github:
		"the GitHub Sigstore instance (GitHub's private Fulcio and its RFC 3161 timestamp authority)"
} as const satisfies Record<SigstoreInstance, string>;

const serviceDisclosure = {
	'oidc-and-fulcio':
		'OIDC and Fulcio receive the workload identity and an ephemeral public key.',
	'certificate-transparency':
		'Certificate transparency receives the signing certificate and the identity it certifies.',
	'rfc-3161-tsa':
		'An RFC 3161 timestamp authority receives the signature imprint and the time of the request.',
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
	const [only] = disclosure.instances;
	const heading =
		only !== undefined && disclosure.instances.length === 1
			? `Signing with ${instanceDescription[only]}.`
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
	const count = String(disclosure.subjectCount);

	return disclosure.grouping === 'individual'
		? `Signing one statement for each of the ${count} accepted subjects, so no bundle names another subject.`
		: `Signing one statement for all ${count} accepted subjects, so a reader of one bundle learns the name and digest of every one of them.`;
}

export interface ProducedEvidence extends BundleEvidence {
	readonly bundleCount: number;
	readonly uploadedCount: number;
}

/**
 * The instance that produced a set of bundles. The public-good instance
 * records every signature in Rekor and the GitHub instance timestamps it with
 * an RFC 3161 authority, so the evidence the bundles carry identifies the
 * trust domain even when the profile left the instance to `@actions/attest`.
 */
export function producedInstance(
	evidence: BundleEvidence
): SigstoreInstance | undefined {
	if (evidence.tlogEntryCount > 0) {
		return 'public-good';
	}

	if (evidence.timestampCount > 0) {
		return 'github';
	}

	return undefined;
}

export function producedLines(produced: ProducedEvidence): readonly string[] {
	if (produced.bundleCount === 0) {
		return ['This run signed no statement.'];
	}

	const instance = producedInstance(produced);

	return [
		instance === undefined
			? 'The bundles carry no Rekor entry and no RFC 3161 timestamp.'
			: `The bundles are in the trust domain of ${instanceDescription[instance]}.`,
		`The action signed ${String(produced.bundleCount)} bundles that carry ${String(produced.tlogEntryCount)} Rekor entries and ${String(produced.timestampCount)} RFC 3161 timestamps.`,
		produced.uploadedCount === 0
			? "The action recorded no bundle in the repository's attestation store."
			: `The action recorded ${String(produced.uploadedCount)} of ${String(produced.bundleCount)} bundles in the repository's attestation store.`
	];
}

export interface GithubSignerOptions {
	readonly subjects: readonly AttestationSubject[];
	readonly githubToken: string;
	readonly policy: SigningPolicy;
}

/**
 * Signs statements through `@actions/attest` under the given policy. The
 * profile selects the Sigstore instance, and `upload-to-github` decides
 * whether the signed bundle is written to the repository's attestation store,
 * where `gh attestation verify` finds it.
 */
export function githubStatementSigner(
	options: GithubSignerOptions
): StatementSigner {
	const subjects = options.subjects.map((subject) => ({
		name: subject.name,
		digest: { sha256: subject.sha256 }
	}));
	const instance = sigstoreInstanceFor(options.policy.profile);

	return async (statement) => {
		const attestation = await attest({
			subjects,
			predicateType: statement.predicateType,
			predicate: statement.predicate,
			token: options.githubToken,
			skipWrite: !options.policy.uploadToGithub,
			...(instance !== undefined && { sigstore: instance })
		});
		const material = attestation.bundle.verificationMaterial;

		return {
			bundle: `${JSON.stringify(attestation.bundle)}\n`,
			evidence: {
				tlogEntryCount: material.tlogEntries.length,
				timestampCount:
					material.timestampVerificationData?.rfc3161Timestamps.length ?? 0
			},
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

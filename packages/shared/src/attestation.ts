import { readFile as nodeReadFile } from 'node:fs/promises';

import { bundleFromJSON, isBundleWithDsseEnvelope } from '@sigstore/bundle';
import { TrustedRoot } from '@sigstore/protobuf-specs';
import { getTrustedRoot } from '@sigstore/tuf';
import type {
	Signer,
	VerificationPolicy,
	VerifierOptions
} from '@sigstore/verify';
import { toSignedEntity, toTrustMaterial, Verifier } from '@sigstore/verify';
import { z } from 'zod';

const inTotoPayloadType = 'application/vnd.in-toto+json';
const inTotoStatementType = 'https://in-toto.io/Statement/v1';

const inTotoDigestSchema = z.object({
	sha256: z.string().regex(/^[0-9a-f]{64}$/)
});

const inTotoSubjectSchema = z.object({
	digest: inTotoDigestSchema
});

const inTotoStatementSchema = z.object({
	_type: z.literal(inTotoStatementType),
	subject: z.array(inTotoSubjectSchema),
	predicateType: z.string(),
	predicate: z.unknown()
});

const slsaDependencySchema = z.object({
	digest: z.object({ gitCommit: z.string().optional() }).optional()
});

const slsaProvenanceSchema = z.object({
	buildDefinition: z
		.object({ resolvedDependencies: z.array(slsaDependencySchema).optional() })
		.optional()
});

/**
 * The git commit a SLSA provenance predicate was built from, taken from the
 * first resolved dependency that records one. Returns undefined when the
 * predicate is not SLSA provenance or records no commit.
 */
export function slsaSourceCommit(predicate: unknown): string | undefined {
	const parsed = slsaProvenanceSchema.safeParse(predicate);

	if (!parsed.success) {
		return undefined;
	}

	const dependencies = parsed.data.buildDefinition?.resolvedDependencies ?? [];

	for (const dependency of dependencies) {
		if (dependency.digest?.gitCommit !== undefined) {
			return dependency.digest.gitCommit;
		}
	}

	return undefined;
}

export interface IdentityPolicyOptions {
	readonly certificateIdentity?: string;
	readonly certificateIdentityRegex?: string;
	readonly certificateOidcIssuer?: string;
	readonly certificateOidcIssuerRegex?: string;
}

export interface AttestationPolicyOptions extends IdentityPolicyOptions {
	readonly predicateType: string;
	readonly trustedRoot?: string;
	readonly tlogThreshold?: number;
	readonly ctlogThreshold?: number;
	readonly timestampThreshold?: number;
}

export interface VerifyResult {
	readonly bundle: string;
	readonly predicateType: string;
	readonly subjectDigest: string;
	readonly signerIdentity?: string;
	readonly signerIssuer?: string;
}

/**
 * A resolved signer-identity policy. A string term is matched exactly; a
 * regular expression is matched as a pattern.
 */
export interface VerifiedIdentityPolicy {
	readonly identity: string | RegExp;
	readonly issuer: string | RegExp;
}

export interface VerifiedBundle {
	readonly signer: Signer;
	readonly predicateType: string;
	readonly subjectDigests: readonly string[];
	readonly predicate?: unknown;
}

export interface BundleVerifyOptions extends VerifierOptions {
	readonly trustedRoot?: string;
}

export class CertificateIdentityModeError extends Error {
	constructor(public readonly identityModes: readonly string[]) {
		super(
			'Pass exactly one of --certificate-identity or --certificate-identity-regex'
		);
		this.name = 'CertificateIdentityModeError';
	}
}

export class CertificateIssuerModeError extends Error {
	constructor(public readonly issuerModes: readonly string[]) {
		super(
			'Pass exactly one of --certificate-oidc-issuer or --certificate-oidc-issuer-regex'
		);
		this.name = 'CertificateIssuerModeError';
	}
}

export class AttestationSubjectMismatchError extends Error {
	constructor(
		public readonly expectedSubjectDigest: string,
		public readonly subjectDigests: readonly string[]
	) {
		super('Verified attestation subject does not match the expected digest');
		this.name = 'AttestationSubjectMismatchError';
	}
}

export class AttestationPredicateTypeMismatchError extends Error {
	constructor(
		public readonly expectedPredicateType: string,
		public readonly actualPredicateType: string
	) {
		super('Verified attestation predicate type does not match policy');
		this.name = 'AttestationPredicateTypeMismatchError';
	}
}

export class AttestationBundleShapeError extends Error {
	constructor(public readonly detail: string) {
		super(`Attestation bundle ${detail}`);
		this.name = 'AttestationBundleShapeError';
	}
}

function resolveCertificateTerm(
	exact: string | undefined,
	pattern: string | undefined,
	modeError: (modes: readonly string[]) => never
): string | RegExp {
	if (exact !== undefined && pattern !== undefined) {
		modeError(['exact', 'regex']);
	}

	if (exact !== undefined) {
		return exact;
	}

	if (pattern !== undefined) {
		return new RegExp(pattern);
	}

	return modeError([]);
}

/**
 * Resolve identity-policy inputs into a signer-identity policy. Exactly one of
 * the exact or regex form must be given for the identity and for the issuer;
 * the two terms may use different forms.
 */
export function identityPolicy(
	options: IdentityPolicyOptions
): VerifiedIdentityPolicy {
	return {
		identity: resolveCertificateTerm(
			options.certificateIdentity,
			options.certificateIdentityRegex,
			(modes) => {
				throw new CertificateIdentityModeError(modes);
			}
		),
		issuer: resolveCertificateTerm(
			options.certificateOidcIssuer,
			options.certificateOidcIssuerRegex,
			(modes) => {
				throw new CertificateIssuerModeError(modes);
			}
		)
	};
}

/**
 * Express an identity policy as a Sigstore verification policy. An exact term
 * is anchored and escaped so the verifier's regex match on the subject
 * alternative name becomes an exact comparison; a regex issuer is omitted
 * because the verifier matches certificate extensions by exact value only.
 */
export function verificationPolicy(
	policy: VerifiedIdentityPolicy
): VerificationPolicy {
	return {
		subjectAlternativeName:
			typeof policy.identity === 'string'
				? `^${RegExp.escape(policy.identity)}$`
				: policy.identity.source,
		...(typeof policy.issuer === 'string' && {
			extensions: { issuer: policy.issuer }
		})
	};
}

/**
 * Verify a Sigstore DSSE bundle against the trusted root and an identity
 * policy, returning the signer, the in-toto predicate type and subject digests,
 * and the raw predicate.
 */
export async function verifyBundle(
	bytes: Uint8Array,
	policy: VerifiedIdentityPolicy,
	options: BundleVerifyOptions
): Promise<VerifiedBundle> {
	const parsed = parseBundle(bytes);
	const trustMaterial = toTrustMaterial(await trustedRoot(options));
	const verifier = new Verifier(trustMaterial, verifierOptions(options));
	const signer = verifier.verify(
		toSignedEntity(parsed.bundle),
		verificationPolicy(policy)
	);

	// The verifier matches certificate extensions by exact value, so a regex
	// issuer cannot be expressed as a policy and is enforced here.
	if (policy.issuer instanceof RegExp) {
		const signerIssuer = signer.identity?.extensions?.issuer;

		if (signerIssuer === undefined || !policy.issuer.test(signerIssuer)) {
			throw new AttestationBundleShapeError(
				'signer issuer did not match policy'
			);
		}
	}

	return {
		signer,
		predicateType: parsed.predicateType,
		subjectDigests: parsed.subjectDigests,
		predicate: parsed.predicate
	};
}

/**
 * Check a verified bundle against an expected subject digest and predicate
 * type, returning a flattened result.
 */
export function resultFor(
	bundle: string,
	verified: VerifiedBundle,
	expectedSubject: string,
	expectedPredicateType: string
): VerifyResult {
	if (!verified.subjectDigests.includes(expectedSubject)) {
		throw new AttestationSubjectMismatchError(
			expectedSubject,
			verified.subjectDigests
		);
	}

	if (verified.predicateType !== expectedPredicateType) {
		throw new AttestationPredicateTypeMismatchError(
			expectedPredicateType,
			verified.predicateType
		);
	}

	return {
		bundle,
		predicateType: verified.predicateType,
		subjectDigest: expectedSubject,
		signerIdentity: verified.signer.identity?.subjectAlternativeName,
		signerIssuer: verified.signer.identity?.extensions?.issuer
	};
}

export function bundleVerifyOptions(
	options: AttestationPolicyOptions
): BundleVerifyOptions {
	return {
		...(options.trustedRoot !== undefined && {
			trustedRoot: options.trustedRoot
		}),
		...(options.tlogThreshold !== undefined && {
			tlogThreshold: options.tlogThreshold
		}),
		...(options.ctlogThreshold !== undefined && {
			ctlogThreshold: options.ctlogThreshold
		}),
		...(options.timestampThreshold !== undefined && {
			timestampThreshold: options.timestampThreshold
		})
	};
}

function verifierOptions(options: BundleVerifyOptions): VerifierOptions {
	const thresholds: VerifierOptions = {};

	if (options.tlogThreshold !== undefined) {
		thresholds.tlogThreshold = options.tlogThreshold;
	}

	if (options.ctlogThreshold !== undefined) {
		thresholds.ctlogThreshold = options.ctlogThreshold;
	}

	if (options.timestampThreshold !== undefined) {
		thresholds.timestampThreshold = options.timestampThreshold;
	}

	return thresholds;
}

async function trustedRoot(options: BundleVerifyOptions): Promise<TrustedRoot> {
	if (options.trustedRoot === undefined) {
		return getTrustedRoot();
	}

	return TrustedRoot.fromJSON(
		JSON.parse(await nodeReadFile(options.trustedRoot, 'utf8'))
	);
}

function parseBundle(bytes: Uint8Array): Omit<VerifiedBundle, 'signer'> & {
	readonly bundle: ReturnType<typeof bundleFromJSON>;
} {
	const decoder = new TextDecoder();
	const bundle = bundleFromJSON(JSON.parse(decoder.decode(bytes)));

	if (!isBundleWithDsseEnvelope(bundle)) {
		throw new AttestationBundleShapeError('is not a Sigstore DSSE bundle');
	}

	const envelope = bundle.content.dsseEnvelope;

	if (envelope.payloadType !== inTotoPayloadType) {
		throw new AttestationBundleShapeError('DSSE payload is not in-toto');
	}

	const statement = inTotoStatementSchema.parse(
		JSON.parse(Buffer.from(envelope.payload).toString('utf8'))
	);

	return {
		bundle,
		predicateType: statement.predicateType,
		subjectDigests: statement.subject.map((subject) => subject.digest.sha256),
		predicate: statement.predicate
	};
}

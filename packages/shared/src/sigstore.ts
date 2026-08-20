import { readFile as nodeReadFile } from 'node:fs/promises';

import { TrustedRoot } from '@sigstore/protobuf-specs';
import { getTrustedRoot } from '@sigstore/tuf';
import type {
	Signer,
	VerificationPolicy,
	VerifierOptions
} from '@sigstore/verify';
import { toSignedEntity, toTrustMaterial, Verifier } from '@sigstore/verify';

import {
	decodeDsseStatement,
	defaultInTotoLeaves,
	DsseDecodeError,
	inTotoStatementSchema
} from './in-toto.ts';
import {
	isSlsaProvenanceType,
	type SlsaProvenanceSummary,
	slsaProvenanceSummary
} from './slsa.ts';

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

/**
A Rekor transparency-log entry a verified bundle was recorded in.
*/
export interface VerifyTlogEntry {
	readonly logIndex: string;
	readonly integratedTime?: string;
}

/**
 * The trust evidence that Sigstore used to verify a bundle. This records the
 * signing time, matching transparency-log entries, and the number of verified
 * signed timestamps. The verifier enforces the configured thresholds.
 */
export interface VerifyTrust {
	readonly signedAt?: string;
	readonly tlogEntries: readonly VerifyTlogEntry[];
	readonly timestampCount: number;
}

export interface VerifyResult {
	readonly bundle: string;
	readonly predicateType: string;
	readonly subjectDigest: string;
	readonly signerIdentity?: string;
	readonly signerIssuer?: string;
	readonly provenance?: SlsaProvenanceSummary;
	/**
	 * The Statement predicate, if present. Callers can interpret predicates they
	 * recognise. This package additionally parses SLSA provenance.
	 */
	readonly predicate?: unknown;
	readonly trust: VerifyTrust;
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
	readonly signedTimestampCount: number;
	readonly tlogEntries: readonly VerifyTlogEntry[];
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
 * Converts an identity policy to Sigstore's verification policy. Exact
 * identities become anchored, escaped regular expressions because Sigstore
 * matches subject alternative names with a regular expression. Regex issuers
 * are omitted here because Sigstore compares certificate issuer extensions by
 * exact value.
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
	const signedEntity = toSignedEntity(parsed.bundle);
	const signer = verifier.verify(signedEntity, verificationPolicy(policy));

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
		predicate: parsed.predicate,
		signedTimestampCount: signedEntity.timestamps.length,
		tlogEntries: signedEntity.tlogEntries.map((entry) => {
			const integratedTime = isoFromUnixSeconds(entry.integratedTime);

			return {
				logIndex: entry.logIndex,
				...(integratedTime !== undefined && { integratedTime })
			};
		})
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

	const provenance = isSlsaProvenanceType(verified.predicateType)
		? slsaProvenanceSummary(verified.predicate)
		: undefined;

	return {
		bundle,
		predicateType: verified.predicateType,
		subjectDigest: expectedSubject,
		signerIdentity: verified.signer.identity?.subjectAlternativeName,
		signerIssuer: verified.signer.identity?.extensions?.issuer,
		...(provenance !== undefined && { provenance }),
		...(verified.predicate !== undefined && { predicate: verified.predicate }),
		trust: trustFor(verified)
	};
}

function trustFor(verified: VerifiedBundle): VerifyTrust {
	let signedAt: string | undefined;

	for (const entry of verified.tlogEntries) {
		if (entry.integratedTime === undefined) {
			continue;
		}

		if (signedAt === undefined || entry.integratedTime < signedAt) {
			signedAt = entry.integratedTime;
		}
	}

	return {
		tlogEntries: verified.tlogEntries,
		timestampCount: verified.signedTimestampCount,
		...(signedAt !== undefined && { signedAt })
	};
}

/**
 * A Rekor integrated time, a UNIX-seconds string, as an ISO 8601 instant.
 * Returns undefined when the value is not a positive finite number, so an
 * absent or malformed time is simply not shown.
 */
function isoFromUnixSeconds(seconds: string): string | undefined {
	const value = Number(seconds);

	if (!Number.isFinite(value) || value <= 0) {
		return undefined;
	}

	return new Date(value * 1000).toISOString();
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

const bundleStatementSchema = inTotoStatementSchema(
	defaultInTotoLeaves
).transform((statement) => ({
	predicateType: statement.predicateType,
	subjectDigests: statement.subject.map((subject) => subject.digest.sha256),
	predicate: statement.predicate
}));

function parseBundle(bytes: Uint8Array) {
	try {
		const { bundle, statement } = decodeDsseStatement(
			bytes,
			bundleStatementSchema
		);

		return { bundle, ...statement };
	} catch (error) {
		if (error instanceof DsseDecodeError) {
			throw new AttestationBundleShapeError(error.detail);
		}

		throw error;
	}
}

import { readFile as nodeReadFile } from 'node:fs/promises';

import { TrustedRoot } from '@sigstore/protobuf-specs';
import { getTrustedRoot } from '@sigstore/tuf';
import type {
	Signer,
	VerificationPolicy,
	VerifierOptions
} from '@sigstore/verify';
import {
	type SignedEntity,
	toSignedEntity,
	toTrustMaterial,
	Verifier
} from '@sigstore/verify';

import {
	decodeDsseStatement,
	defaultInTotoLeaves,
	DsseDecodeError,
	inTotoStatementSchema
} from './in-toto.ts';
import {
	isoFromUnixSeconds,
	verifiedTimestampCount
} from './sigstore-evidence.ts';
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

export interface VerifyTlogEntry {
	readonly logIndex: string;
	readonly integratedTime?: string;
}

/**
 * Evidence extracted after Sigstore verifies a bundle. `integratedAt` is the
 * earliest Rekor integration time, not the time when the signature was
 * created. `timestampCount` counts verified signed timestamps.
 */
export interface VerifyTrust {
	readonly integratedAt?: string;
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
	readonly verifiedTimestampCount: number;
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

/**
 * The `--trusted-root` file is neither one JSON document nor JSON Lines of
 * them, as `gh attestation trusted-root` prints.
 */
export class TrustedRootFormatError extends Error {
	constructor(
		public readonly file: string,
		public readonly detail: string
	) {
		super(
			`Trusted root ${file} is neither a JSON document nor JSON Lines: ${detail}`
		);
		this.name = 'TrustedRootFormatError';
	}
}

/**
 * A bundle verified against none of several trusted roots. Each root's own
 * failure is kept, in file order, and the first is the cause.
 */
export class TrustedRootsRejectedError extends Error {
	constructor(public readonly failures: readonly unknown[]) {
		super(
			`The bundle did not verify against any of the ${String(failures.length)} ` +
				`trusted roots: ${failures.map((failure) => failureMessage(failure)).join('; ')}`,
			{ cause: failures[0] }
		);
		this.name = 'TrustedRootsRejectedError';
	}
}

function failureMessage(failure: unknown): string {
	return failure instanceof Error ? failure.message : String(failure);
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
 * and the raw predicate. A `trustedRoot` file holding several roots, as JSON
 * Lines, verifies the bundle if any one of them does.
 */
export async function verifyBundle(
	bytes: Uint8Array,
	policy: VerifiedIdentityPolicy,
	options: BundleVerifyOptions
): Promise<VerifiedBundle> {
	const parsed = parseBundle(bytes);
	const signedEntity = toSignedEntity(parsed.bundle);
	const signer = verifyAgainstAnyRoot(
		await trustedRoots(options),
		signedEntity,
		verificationPolicy(policy),
		verifierOptions(options)
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
		predicate: parsed.predicate,
		verifiedTimestampCount: verifiedTimestampCount(signedEntity.timestamps),
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
 * Requires the expected subject digest and predicate type, then returns the
 * verified identity, predicate, provenance summary, and trust evidence.
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
	let integratedAt: string | undefined;

	for (const entry of verified.tlogEntries) {
		if (entry.integratedTime === undefined) {
			continue;
		}

		if (integratedAt === undefined || entry.integratedTime < integratedAt) {
			integratedAt = entry.integratedTime;
		}
	}

	return {
		tlogEntries: verified.tlogEntries,
		timestampCount: verified.verifiedTimestampCount,
		...(integratedAt !== undefined && { integratedAt })
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
	return {
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

/**
 * Sigstore's verifier takes one trusted root, so each root is tried in turn and
 * the first that verifies the bundle wins. One root rethrows its own failure
 * unchanged; several report every root's failure.
 */
function verifyAgainstAnyRoot(
	roots: readonly TrustedRoot[],
	signedEntity: SignedEntity,
	policy: VerificationPolicy,
	options: VerifierOptions
): Signer {
	const failures: unknown[] = [];

	for (const root of roots) {
		try {
			return new Verifier(toTrustMaterial(root), options).verify(
				signedEntity,
				policy
			);
		} catch (error) {
			failures.push(error);
		}
	}

	if (failures.length === 1) {
		throw failures[0];
	}

	throw new TrustedRootsRejectedError(failures);
}

async function trustedRoots(
	options: BundleVerifyOptions
): Promise<readonly TrustedRoot[]> {
	if (options.trustedRoot === undefined) {
		return [await getTrustedRoot()];
	}

	return parseTrustedRoots(
		options.trustedRoot,
		await nodeReadFile(options.trustedRoot, 'utf8')
	).map((document) => TrustedRoot.fromJSON(document));
}

/**
 * Reads a trusted-root file as one JSON document, which may span lines, or
 * else as JSON Lines with one root per non-blank line, the form
 * `gh attestation trusted-root` prints.
 */
function parseTrustedRoots(file: string, text: string): readonly unknown[] {
	const document = parseJson(text);

	if (document.ok) {
		return [document.value];
	}

	const documents: unknown[] = [];

	for (const [index, line] of text.split('\n').entries()) {
		if (line.trim() === '') {
			continue;
		}

		const parsed = parseJson(line);

		if (!parsed.ok) {
			throw new TrustedRootFormatError(
				file,
				`line ${String(index + 1)}: ${parsed.message}`
			);
		}

		documents.push(parsed.value);
	}

	if (documents.length === 0) {
		throw new TrustedRootFormatError(file, 'the file is empty');
	}

	return documents;
}

type JsonParse =
	| { readonly ok: true; readonly value: unknown }
	| { readonly ok: false; readonly message: string };

function parseJson(text: string): JsonParse {
	try {
		return { ok: true, value: JSON.parse(text) as unknown };
	} catch (error) {
		return { ok: false, message: failureMessage(error) };
	}
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

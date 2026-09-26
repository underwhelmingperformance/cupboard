import { readFile as nodeReadFile } from 'node:fs/promises';

import { TrustedRoot } from '@sigstore/protobuf-specs';
import { getTrustedRoot } from '@sigstore/tuf';
import type {
	Signer,
	VerificationPolicy,
	VerifierOptions
} from '@sigstore/verify';
import {
	PolicyError,
	type SignedEntity,
	toSignedEntity,
	toTrustMaterial,
	type TrustMaterial,
	Verifier
} from '@sigstore/verify';

import { UsageError } from './errors.ts';
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
 * The trusted root against which the bundle verified: the public-good Sigstore
 * root, or a root from a trusted-root file, as its 1-based position among the
 * `count` trusted roots in that file.
 */
export type AcceptingRoot =
	| { readonly kind: 'public-good' }
	| {
			readonly kind: 'file';
			readonly position: number;
			readonly count: number;
	  };

/**
 * The certificate-transparency evidence for a bundle signed with a
 * certificate: the number of signed certificate timestamps that the verifier
 * checked, and the minimum that applied to the accepting root. A bundle signed
 * with a public key has no certificate, and the verifier checks no signed
 * certificate timestamp.
 */
export interface CertificateTransparency {
	readonly signedCertificateTimestamps: number;
	readonly threshold: number;
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
	readonly acceptingRoot: AcceptingRoot;
	readonly certificateTransparency?: CertificateTransparency;
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
	readonly acceptingRoot: AcceptingRoot;
	readonly certificateTransparency?: CertificateTransparency;
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

export type TrustedRootFormatReason =
	| { readonly kind: 'empty' }
	| { readonly kind: 'malformed-document' }
	| { readonly kind: 'malformed-line'; readonly line: number }
	| { readonly kind: 'not-a-trusted-root' }
	| { readonly kind: 'not-a-trusted-root-line'; readonly line: number }
	| { readonly kind: 'unusable-root' }
	| { readonly kind: 'unusable-root-line'; readonly line: number };

/**
 * The trusted-root file is neither one Sigstore trusted root nor JSON Lines of
 * trusted roots (the form that `gh attestation trusted-root` prints), or one
 * of its roots contains a certificate or key that the verifier cannot load.
 */
export class TrustedRootFormatError extends UsageError {
	constructor(
		public readonly file: string,
		public readonly reason: TrustedRootFormatReason,
		detail?: string
	) {
		super(
			`Trusted-root file ${file} ${trustedRootFormatProblem(reason)}` +
				(detail === undefined ? '' : `: ${detail}`)
		);
		this.name = 'TrustedRootFormatError';
	}
}

function trustedRootFormatProblem(reason: TrustedRootFormatReason): string {
	switch (reason.kind) {
		case 'empty': {
			return 'is empty';
		}
		case 'malformed-document': {
			return 'is not a JSON object or JSON Lines';
		}
		case 'malformed-line': {
			return `is JSON Lines, but line ${String(reason.line)} is not a JSON object`;
		}
		case 'not-a-trusted-root': {
			return 'is not a Sigstore trusted root';
		}
		case 'not-a-trusted-root-line': {
			return `is JSON Lines, but line ${String(reason.line)} is not a Sigstore trusted root`;
		}
		case 'unusable-root': {
			return 'contains a certificate or key that cannot be loaded';
		}
		case 'unusable-root-line': {
			return `is JSON Lines, but the trusted root on line ${String(reason.line)} contains a certificate or key that cannot be loaded`;
		}
	}
}

/**
 * The caller set `--ctlog-threshold 0`, but every trusted root lists a
 * certificate-transparency log. A zero applies only to a root that lists no
 * such log, so it would have no effect. `trustedRoot` is the trusted-root file,
 * or undefined for the public-good Sigstore root.
 */
export class IneffectiveCtlogThresholdError extends UsageError {
	constructor(public readonly trustedRoot: string | undefined) {
		super(
			trustedRoot === undefined
				? '--ctlog-threshold 0 has no effect without --trusted-root: the public-good Sigstore root lists a certificate-transparency log, so it still requires a signed certificate timestamp'
				: `--ctlog-threshold 0 has no effect: every trusted root in ${trustedRoot} lists a certificate-transparency log, so each one still requires a signed certificate timestamp`
		);
		this.name = 'IneffectiveCtlogThresholdError';
	}
}

/**
 * The bundle did not verify against any of several trusted roots. `failures`
 * lists the failure for each root in file order, and the first failure is the
 * error's `cause`.
 */
export class TrustedRootsRejectedError extends Error {
	constructor(public readonly failures: NonEmptyList<unknown>) {
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
 * and the raw predicate. When the `trustedRoot` file contains several roots, as
 * JSON Lines, verification succeeds if the bundle verifies against any of
 * them.
 */
export async function verifyBundle(
	bytes: Uint8Array,
	policy: VerifiedIdentityPolicy,
	options: BundleVerifyOptions
): Promise<VerifiedBundle> {
	// The public-good root always lists certificate-transparency logs, so this
	// combination is rejected before the root is fetched from TUF.
	if (options.ctlogThreshold === 0 && options.trustedRoot === undefined) {
		throw new IneffectiveCtlogThresholdError(undefined);
	}

	const parsed = parseBundle(bytes);
	const signedEntity = toSignedEntity(parsed.bundle);
	const roots = await trustedRoots(options);

	if (
		options.ctlogThreshold === 0 &&
		roots.every(({ root }) => root.ctlogs.length > 0)
	) {
		throw new IneffectiveCtlogThresholdError(options.trustedRoot);
	}

	const accepted = verifyAgainstAnyRoot(
		roots,
		signedEntity,
		verificationPolicy(policy),
		verifierOptions(options)
	);
	const { signer } = accepted;

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
		acceptingRoot:
			options.trustedRoot === undefined
				? { kind: 'public-good' }
				: { kind: 'file', position: accepted.position, count: roots.length },
		...(signedEntity.key.$case === 'certificate' && {
			certificateTransparency: {
				// The verifier checks every signed certificate timestamp in the
				// certificate, so each one counted here has been verified.
				signedCertificateTimestamps:
					signedEntity.key.certificate.extSCT?.signedCertificateTimestamps
						.length ?? 0,
				threshold: accepted.ctlogThreshold
			}
		}),
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
		acceptingRoot: verified.acceptingRoot,
		...(verified.certificateTransparency !== undefined && {
			certificateTransparency: verified.certificateTransparency
		}),
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
 * Sigstore's verifier takes one trusted root, so the bundle is verified against
 * each root in turn until verification succeeds. With one root, this function
 * rethrows the failure against that root unchanged. With several, it throws
 * `TrustedRootsRejectedError`, which lists the failure against each root. A
 * `PolicyError` is rethrown at once, whatever the number of roots.
 */
function verifyAgainstAnyRoot(
	roots: NonEmptyList<LoadedRoot>,
	signedEntity: SignedEntity,
	policy: VerificationPolicy,
	options: VerifierOptions
): AcceptedVerification {
	const [firstRoot, ...otherRoots] = roots;
	const first = verifyAgainstRoot(firstRoot, signedEntity, policy, options);

	if (first.ok) {
		return { ...first.accepted, position: 1 };
	}

	const failures: [unknown, ...unknown[]] = [first.failure];

	for (const [index, loaded] of otherRoots.entries()) {
		const attempt = verifyAgainstRoot(loaded, signedEntity, policy, options);

		if (attempt.ok) {
			return { ...attempt.accepted, position: index + 2 };
		}

		failures.push(attempt.failure);
	}

	if (failures.length === 1) {
		throw first.failure;
	}

	throw new TrustedRootsRejectedError(failures);
}

/**
 * The signer from the root against which the bundle verified, the root's
 * 1-based position in the list, and the certificate-transparency threshold
 * that applied to that root.
 */
interface AcceptedVerification {
	readonly signer: Signer;
	readonly position: number;
	readonly ctlogThreshold: number;
}

type RootAttempt =
	| {
			readonly ok: true;
			readonly accepted: Omit<AcceptedVerification, 'position'>;
	  }
	| { readonly ok: false; readonly failure: unknown };

function verifyAgainstRoot(
	loaded: LoadedRoot,
	signedEntity: SignedEntity,
	policy: VerificationPolicy,
	options: VerifierOptions
): RootAttempt {
	const rootOptions = rootVerifierOptions(loaded.root, options);

	try {
		return {
			ok: true,
			accepted: {
				signer: new Verifier(loaded.material, rootOptions).verify(
					signedEntity,
					policy
				),
				ctlogThreshold: rootOptions.ctlogThreshold
			}
		};
	} catch (error) {
		// The verifier checks the policy only after the bundle has verified
		// against this root, and the policy depends only on the bundle's
		// certificate. The bundle therefore fails the same policy check against
		// every other root.
		if (error instanceof PolicyError) {
			throw error;
		}

		return { ok: false, failure: error };
	}
}

/**
 * The Sigstore verifier's own default for each threshold, which applies when
 * the caller sets none.
 */
export const defaultVerifierThreshold = 1;

/**
 * A zero certificate-transparency threshold applies only to a root that lists
 * no certificate-transparency log. For a root that lists one, the threshold is
 * at least 1, so a bundle that verifies against the public-good root still
 * needs a signed certificate timestamp. `gh attestation trusted-root` prints
 * the public-good root next to GitHub's root, which lists no such log, so a
 * zero that applied to every root would accept a public-good certificate
 * without a signed certificate timestamp.
 *
 * A zero transparency-log threshold applies to every root. A `tsa-only` bundle
 * has no Rekor entry and verifies against the public-good root, which lists
 * transparency logs. If this function raised the transparency-log threshold for
 * such a root, as it does the certificate-transparency threshold, no `tsa-only`
 * bundle would verify.
 */
function rootVerifierOptions(
	root: TrustedRoot,
	options: VerifierOptions
): VerifierOptions & { readonly ctlogThreshold: number } {
	const ctlogThreshold = options.ctlogThreshold ?? defaultVerifierThreshold;

	return {
		...options,
		ctlogThreshold:
			root.ctlogs.length === 0
				? ctlogThreshold
				: Math.max(defaultVerifierThreshold, ctlogThreshold)
	};
}

type NonEmptyList<T> = readonly [T, ...T[]];

/**
 * A trusted root together with the trust material that the verifier builds
 * from it.
 */
interface LoadedRoot {
	readonly root: TrustedRoot;
	readonly material: TrustMaterial;
}

async function trustedRoots(
	options: BundleVerifyOptions
): Promise<NonEmptyList<LoadedRoot>> {
	if (options.trustedRoot === undefined) {
		const root = await getTrustedRoot();

		return [{ root, material: toTrustMaterial(root) }];
	}

	const file = options.trustedRoot;
	const [first, ...others] = parseTrustedRoots(
		file,
		await nodeReadFile(file, 'utf8')
	);

	return [
		loadedRoot(file, first),
		...others.map((document) => loadedRoot(file, document))
	];
}

/**
 * Builds the trust material for one root of the file. A root that the verifier
 * cannot load is reported here, so a broken root is not hidden by another root
 * that verifies the bundle.
 */
function loadedRoot(file: string, document: ParsedRoot): LoadedRoot {
	const root = TrustedRoot.fromJSON(document.value);

	try {
		return { root, material: toTrustMaterial(root) };
	} catch (error) {
		throw new TrustedRootFormatError(
			file,
			document.line === undefined
				? { kind: 'unusable-root' }
				: { kind: 'unusable-root-line', line: document.line },
			failureMessage(error)
		);
	}
}

/**
 * A trusted root parsed from the file, and its line number when the file is
 * JSON Lines.
 */
interface ParsedRoot {
	readonly value: object;
	readonly line?: number;
}

/**
 * Parses the text of a trusted-root file as one JSON object, which may span
 * lines, or as JSON Lines with one object per non-blank line, the form that
 * `gh attestation trusted-root` prints. The text is JSON Lines when it does not
 * parse as a whole and its first non-blank line is a JSON object on its own.
 */
function parseTrustedRoots(
	file: string,
	text: string
): NonEmptyList<ParsedRoot> {
	const lines = text
		.split('\n')
		.map((line, index) => ({ number: index + 1, text: line.trim() }))
		.filter((line) => line.text !== '');
	const [firstLine, ...otherLines] = lines;

	if (firstLine === undefined) {
		throw new TrustedRootFormatError(file, { kind: 'empty' });
	}

	const document = parseJsonObject(text);

	if (document.ok) {
		if (!isTrustedRootDocument(document.value)) {
			throw new TrustedRootFormatError(
				file,
				{ kind: 'not-a-trusted-root' },
				expectedMediaType
			);
		}

		return [{ value: document.value }];
	}

	if (!parseJsonObject(firstLine.text).ok) {
		throw new TrustedRootFormatError(
			file,
			{ kind: 'malformed-document' },
			document.message
		);
	}

	const lineObject = (line: { number: number; text: string }): ParsedRoot => {
		const parsed = parseJsonObject(line.text);

		if (!parsed.ok) {
			throw new TrustedRootFormatError(
				file,
				{ kind: 'malformed-line', line: line.number },
				parsed.message
			);
		}

		if (!isTrustedRootDocument(parsed.value)) {
			throw new TrustedRootFormatError(
				file,
				{ kind: 'not-a-trusted-root-line', line: line.number },
				expectedMediaType
			);
		}

		return { value: parsed.value, line: line.number };
	};

	return [lineObject(firstLine), ...otherLines.map((line) => lineObject(line))];
}

// The two forms of the trusted-root media type that `TrustedRoot.mediaType` in
// `@sigstore/protobuf-specs` documents: the current form, for example
// `application/vnd.dev.sigstore.trustedroot.v0.2+json`, and the old form
// `application/vnd.dev.sigstore.trustedroot+json;version=0.1`, which
// `gh attestation trusted-root` prints. The package does not export them.
const trustedRootMediaTypePattern =
	/^application\/vnd\.dev\.sigstore\.trustedroot(?:\.v\d+\.\d+\+json|\+json;version=\d+\.\d+)$/u;
const expectedMediaType =
	'expected a Sigstore trusted-root mediaType, such as application/vnd.dev.sigstore.trustedroot.v0.2+json';

// `TrustedRoot.fromJSON` accepts any object and replaces missing fields with
// empty lists, so the media type is the only field that identifies a trusted
// root.
function isTrustedRootDocument(value: object): boolean {
	return (
		'mediaType' in value &&
		typeof value.mediaType === 'string' &&
		trustedRootMediaTypePattern.test(value.mediaType)
	);
}

type JsonObjectParse =
	| { readonly ok: true; readonly value: object }
	| { readonly ok: false; readonly message: string };

function parseJsonObject(text: string): JsonObjectParse {
	let value: unknown;

	try {
		value = JSON.parse(text);
	} catch (error) {
		return { ok: false, message: failureMessage(error) };
	}

	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return { ok: false, message: 'expected a JSON object' };
	}

	return { ok: true, value };
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

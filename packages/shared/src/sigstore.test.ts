import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { PolicyError, VerificationError } from '@sigstore/verify';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
	CertificateIdentityModeError,
	CertificateIssuerModeError,
	identityPolicy,
	IneffectiveCtlogThresholdError,
	TrustedRootFormatError,
	TrustedRootsRejectedError,
	verificationPolicy,
	verifyBundle
} from './sigstore.ts';
import {
	githubInstanceBundle,
	publicGoodShapedBundle,
	signerIdentity,
	signerIssuer
} from './sigstore-bundle-fixture.ts';

function verificationFailure(error: unknown): unknown {
	return error instanceof VerificationError || error instanceof PolicyError
		? { name: error.name, code: error.code }
		: error;
}

function outcome(result: unknown): unknown {
	return result instanceof TrustedRootsRejectedError
		? {
				name: result.name,
				failures: result.failures.map((failure) => verificationFailure(failure))
			}
		: verificationFailure(result);
}

const trustedRootLogsSchema = z.looseObject({
	tlogs: z.array(z.unknown()),
	ctlogs: z.array(z.unknown())
});

/**
 * A transparency-log or certificate-transparency log instance for a trusted
 * root, with a throwaway P-256 key. No bundle in these tests has a Rekor entry
 * or a signed certificate timestamp from it.
 */
function logInstance(baseUrl: string): unknown {
	const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
	const rawBytes = publicKey.export({ format: 'der', type: 'spki' });

	return {
		baseUrl,
		hashAlgorithm: 'SHA2_256',
		publicKey: {
			rawBytes: rawBytes.toString('base64'),
			keyDetails: 'PKIX_ECDSA_P256_SHA_256',
			validFor: { start: '2000-01-01T00:00:00Z' }
		},
		logId: { keyId: createHash('sha256').update(rawBytes).digest('base64') }
	};
}

/**
 * Adds a transparency log, a certificate-transparency log or both to a trusted
 * root, after any logs that it already lists.
 */
function withLogs(
	trustedRoot: string,
	logs: { readonly tlog: boolean; readonly ctlog: boolean }
): string {
	const root = trustedRootLogsSchema.parse(JSON.parse(trustedRoot));

	return JSON.stringify({
		...root,
		tlogs: [
			...root.tlogs,
			...(logs.tlog ? [logInstance('https://rekor.example')] : [])
		],
		ctlogs: [
			...root.ctlogs,
			...(logs.ctlog ? [logInstance('https://ctfe.example')] : [])
		]
	});
}

function thrownBy(run: () => unknown): unknown {
	let thrown: unknown;

	try {
		run();
	} catch (error) {
		thrown = error;
	}

	return thrown;
}

describe('identityPolicy', () => {
	it('requires exactly one identity mode', () => {
		const missing = thrownBy(() =>
			identityPolicy({ certificateOidcIssuer: 'https://issuer.test' })
		);
		const conflicting = thrownBy(() =>
			identityPolicy({
				certificateIdentity: 'alice@example.test',
				certificateIdentityRegex: 'alice@.*',
				certificateOidcIssuer: 'https://issuer.test'
			})
		);

		expect(missing).toBeInstanceOf(CertificateIdentityModeError);
		expect(conflicting).toBeInstanceOf(CertificateIdentityModeError);

		if (
			missing instanceof CertificateIdentityModeError &&
			conflicting instanceof CertificateIdentityModeError
		) {
			expect({
				missing: missing.identityModes,
				conflicting: conflicting.identityModes
			}).toStrictEqual({ missing: [], conflicting: ['exact', 'regex'] });
		}
	});

	it('requires exactly one issuer mode', () => {
		const missing = thrownBy(() =>
			identityPolicy({ certificateIdentity: 'alice@example.test' })
		);
		const conflicting = thrownBy(() =>
			identityPolicy({
				certificateIdentity: 'alice@example.test',
				certificateOidcIssuer: 'https://issuer.test',
				certificateOidcIssuerRegex: 'https://issuer[.]test'
			})
		);

		expect(missing).toBeInstanceOf(CertificateIssuerModeError);
		expect(conflicting).toBeInstanceOf(CertificateIssuerModeError);

		if (
			missing instanceof CertificateIssuerModeError &&
			conflicting instanceof CertificateIssuerModeError
		) {
			expect({
				missing: missing.issuerModes,
				conflicting: conflicting.issuerModes
			}).toStrictEqual({ missing: [], conflicting: ['exact', 'regex'] });
		}
	});

	it('resolves each term independently, allowing mixed forms', () => {
		expect(
			identityPolicy({
				certificateIdentity: 'alice@example.test',
				certificateOidcIssuer: 'https://issuer.test'
			})
		).toStrictEqual({
			identity: 'alice@example.test',
			issuer: 'https://issuer.test'
		});

		expect(
			identityPolicy({
				certificateIdentityRegex: 'alice@.*',
				certificateOidcIssuer: 'https://issuer.test'
			})
		).toStrictEqual({
			identity: /alice@.*/,
			issuer: 'https://issuer.test'
		});
	});
});

describe('verificationPolicy', () => {
	const exactIdentity =
		'https://github.com/o/r/.github/workflows/release.yml@refs/heads/main';

	it('anchors and escapes an exact identity so a superset SAN is rejected', () => {
		const { subjectAlternativeName } = verificationPolicy({
			identity: exactIdentity,
			issuer: 'https://token.actions.githubusercontent.com'
		});
		const san = new RegExp(subjectAlternativeName ?? '');

		expect({
			exact: san.test(exactIdentity),
			suffix: san.test(`${exactIdentity}.attacker.example/x`),
			prefix: san.test(`https://evil.example/${exactIdentity}`),
			wildcardDot: san.test(exactIdentity.replace('release.yml', 'releaseXyml'))
		}).toStrictEqual({
			exact: true,
			suffix: false,
			prefix: false,
			wildcardDot: false
		});
	});

	it('pins an exact issuer and omits a regex issuer', () => {
		expect(
			verificationPolicy({ identity: /release/, issuer: 'https://issuer.test' })
		).toStrictEqual({
			subjectAlternativeName: 'release',
			extensions: { issuer: 'https://issuer.test' }
		});

		expect(
			verificationPolicy({ identity: /release/, issuer: /issuer/ })
		).toStrictEqual({ subjectAlternativeName: 'release' });
	});
});

async function withTrustedRoot<T>(
	trustedRoot: string,
	body: (trustedRootFile: string) => Promise<T>
): Promise<T> {
	const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-sigstore-'));
	const trustedRootFile = path.join(directory, 'trusted-root.json');

	try {
		await writeFile(trustedRootFile, trustedRoot);

		return await body(trustedRootFile);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

describe('verifyBundle against a GitHub-instance bundle', () => {
	const subjectDigest = 'aa'.repeat(32);
	const predicateType = 'https://slsa.dev/provenance/v1';
	const policy = { identity: signerIdentity, issuer: signerIssuer };

	it('verifies a bundle using only an RFC 3161 timestamp', async () => {
		const fixture = githubInstanceBundle({ subjectDigest, predicateType });
		const verified = await withTrustedRoot(fixture.trustedRoot, (trustedRoot) =>
			verifyBundle(fixture.bundle, policy, {
				trustedRoot,
				tlogThreshold: 0,
				ctlogThreshold: 0,
				timestampThreshold: 1
			})
		);

		expect({
			predicateType: verified.predicateType,
			subjectDigests: verified.subjectDigests,
			tlogEntries: verified.tlogEntries,
			verifiedTimestampCount: verified.verifiedTimestampCount,
			identity: verified.signer.identity?.subjectAlternativeName,
			issuer: verified.signer.identity?.extensions?.issuer
		}).toStrictEqual({
			predicateType,
			subjectDigests: [subjectDigest],
			tlogEntries: [],
			verifiedTimestampCount: 1,
			identity: signerIdentity,
			issuer: signerIssuer
		});
	});

	// The Sigstore verifier requires one transparency-log entry unless the
	// caller lowers the threshold, so verifying this bundle needs
	// `--tlog-threshold 0`. Nothing else in verification requires a Rekor entry.
	it('requires the caller to lower the transparency-log threshold', async () => {
		const fixture = githubInstanceBundle({ subjectDigest, predicateType });
		const refusal = await withTrustedRoot(
			fixture.trustedRoot,
			async (trustedRoot) => {
				try {
					await verifyBundle(fixture.bundle, policy, {
						trustedRoot,
						ctlogThreshold: 0
					});
				} catch (error) {
					return error;
				}

				return;
			}
		);

		expect(refusal).toBeInstanceOf(VerificationError);
		expect(
			refusal instanceof VerificationError ? refusal.code : undefined
		).toBe('TLOG_ERROR');
	});
});

// `gh attestation trusted-root` prints JSON Lines, one root per line, while a
// hand-written root is usually one (possibly pretty-printed) JSON document.
const trustedRootDocumentSchema = z.looseObject({
	mediaType: z.string(),
	certificateAuthorities: z.array(z.looseObject({}))
});

/**
 * Replaces the first certificate authority of a trusted root with one whose
 * certificate is not DER.
 */
function withUnloadableCertificate(trustedRoot: string): string {
	const root = trustedRootDocumentSchema.parse(JSON.parse(trustedRoot));

	return JSON.stringify({
		...root,
		certificateAuthorities: [
			{
				subject: { organization: 'cupboard', commonName: 'broken' },
				certChain: { certificates: [{ rawBytes: 'AAAA' }] }
			},
			...root.certificateAuthorities
		]
	});
}

describe('verifyBundle with a trusted-root file', () => {
	const subjectDigest = 'aa'.repeat(32);
	const predicateType = 'https://slsa.dev/provenance/v1';
	const policy = { identity: signerIdentity, issuer: signerIssuer };
	const fixture = githubInstanceBundle({ subjectDigest, predicateType });
	const otherRoot = githubInstanceBundle({
		subjectDigest,
		predicateType
	}).trustedRoot;
	const thirdRoot = githubInstanceBundle({
		subjectDigest,
		predicateType
	}).trustedRoot;
	const pretty = JSON.stringify(JSON.parse(fixture.trustedRoot), undefined, 2);
	const timestamped = publicGoodShapedBundle(
		{ subjectDigest, predicateType },
		'listed'
	);
	const timestampedByUnlistedLog = publicGoodShapedBundle(
		{ subjectDigest, predicateType },
		'unlisted'
	);
	const options = { ctlogThreshold: 0, tlogThreshold: 0 };
	// The verification result for the fixture's signer, without the signer's
	// key object and certificate OIDs.
	const verifiedSigner = {
		predicateType,
		subjectDigests: [subjectDigest],
		predicate: {},
		verifiedTimestampCount: 1,
		tlogEntries: [],
		identity: signerIdentity,
		issuer: signerIssuer
	};

	async function verifyWith(
		trustedRoot: string,
		{
			bundle = fixture.bundle,
			identityPolicy = policy,
			thresholds = options
		}: {
			readonly bundle?: Uint8Array;
			readonly identityPolicy?: typeof policy;
			readonly thresholds?: {
				readonly tlogThreshold?: number;
				readonly ctlogThreshold?: number;
			};
		} = {}
	): Promise<unknown> {
		return withTrustedRoot(trustedRoot, async (file) => {
			try {
				const { signer, ...verified } = await verifyBundle(
					bundle,
					identityPolicy,
					{ ...thresholds, trustedRoot: file }
				);

				return {
					...verified,
					identity: signer.identity?.subjectAlternativeName,
					issuer: signer.identity?.extensions?.issuer
				};
			} catch (error) {
				return error;
			}
		});
	}

	it.each([
		{ name: 'one compact JSON document', file: fixture.trustedRoot },
		{ name: 'one pretty-printed JSON document', file: pretty },
		{
			name: 'JSON Lines with the signing root first',
			file: `${fixture.trustedRoot}\n${otherRoot}\n`
		},
		{
			name: 'JSON Lines with the signing root last',
			file: `${otherRoot}\n${thirdRoot}\n${fixture.trustedRoot}\n`
		},
		{
			name: 'JSON Lines with blank lines and CRLF endings',
			file: `\r\n${otherRoot}\r\n\r\n${fixture.trustedRoot}\r\n`
		}
	])('verifies against $name', async ({ file }) => {
		expect(await verifyWith(file)).toStrictEqual(verifiedSigner);
	});

	// `TrustedRoot.mediaType` in `@sigstore/protobuf-specs` documents these
	// forms. `gh attestation trusted-root` prints the old form.
	it.each([
		'application/vnd.dev.sigstore.trustedroot.v0.2+json',
		'application/vnd.dev.sigstore.trustedroot.v0.1+json',
		'application/vnd.dev.sigstore.trustedroot+json;version=0.1'
	])('accepts a root with the media type %s', async (mediaType) => {
		const relabelled = JSON.stringify({
			...trustedRootDocumentSchema.parse(JSON.parse(fixture.trustedRoot)),
			mediaType
		});

		expect(await verifyWith(relabelled)).toStrictEqual(verifiedSigner);
	});

	it('rethrows the failure of a single root unchanged', async () => {
		const refusal = await verifyWith(otherRoot);

		expect(verificationFailure(refusal)).toStrictEqual({
			name: 'VerificationError',
			code: 'TIMESTAMP_ERROR'
		});
	});

	it('reports every root failure when none verifies', async () => {
		const refusal = await verifyWith(`${otherRoot}\n${thirdRoot}\n`);

		expect(
			refusal instanceof TrustedRootsRejectedError
				? {
						name: refusal.name,
						failures: refusal.failures.map((failure) =>
							verificationFailure(failure)
						),
						causeIsFirstFailure: refusal.cause === refusal.failures[0]
					}
				: refusal
		).toStrictEqual({
			name: 'TrustedRootsRejectedError',
			failures: [
				{ name: 'VerificationError', code: 'TIMESTAMP_ERROR' },
				{ name: 'VerificationError', code: 'TIMESTAMP_ERROR' }
			],
			causeIsFirstFailure: true
		});
	});

	// Unless a case sets its own thresholds, both thresholds are 0. No bundle
	// here has a Rekor entry. A zero certificate-transparency threshold applies
	// only to a root that lists no certificate-transparency log. A zero
	// transparency-log threshold applies to every root.
	it.each([
		{
			name: 'the signing root lists no logs',
			file: `${withLogs(otherRoot, { tlog: true, ctlog: true })}\n${fixture.trustedRoot}\n`,
			bundle: fixture.bundle,
			expected: verifiedSigner
		},
		{
			name: 'the signing root lists a transparency log',
			file: `${withLogs(fixture.trustedRoot, { tlog: true, ctlog: false })}\n${otherRoot}\n`,
			bundle: fixture.bundle,
			expected: verifiedSigner
		},
		{
			name: 'the signing root lists a certificate-transparency log and the certificate has no signed certificate timestamp',
			file: `${withLogs(fixture.trustedRoot, { tlog: false, ctlog: true })}\n${otherRoot}\n`,
			bundle: fixture.bundle,
			expected: {
				name: 'TrustedRootsRejectedError',
				failures: [
					{ name: 'VerificationError', code: 'CERTIFICATE_ERROR' },
					{ name: 'VerificationError', code: 'TIMESTAMP_ERROR' }
				]
			}
		},
		{
			name: 'a tsa-only bundle and a root that lists both kinds of log',
			file: withLogs(timestamped.trustedRoot, { tlog: true, ctlog: false }),
			bundle: timestamped.bundle,
			thresholds: { tlogThreshold: 0 },
			expected: verifiedSigner
		},
		{
			name: 'the signing root lists a certificate-transparency log and the certificate has a signed certificate timestamp',
			file: `${withLogs(timestamped.trustedRoot, { tlog: true, ctlog: false })}\n${otherRoot}\n`,
			bundle: timestamped.bundle,
			expected: verifiedSigner
		},
		{
			name: 'a signed certificate timestamp from a log that the root does not list',
			file: timestampedByUnlistedLog.trustedRoot,
			bundle: timestampedByUnlistedLog.bundle,
			expected: { name: 'VerificationError', code: 'CERTIFICATE_ERROR' }
		}
	])(
		'applies zero log thresholds per root for $name',
		async ({ file, bundle, thresholds, expected }) => {
			expect(
				outcome(await verifyWith(file, { bundle, thresholds }))
			).toStrictEqual(expected);
		}
	);

	it('rejects a zero certificate-transparency threshold that no root in the file can use', async () => {
		const { file, refusal } = await withTrustedRoot(
			withLogs(fixture.trustedRoot, { tlog: false, ctlog: true }),
			async (trustedRoot) => {
				try {
					await verifyBundle(fixture.bundle, policy, {
						...options,
						trustedRoot
					});
				} catch (error) {
					return { file: trustedRoot, refusal: error };
				}

				return { file: trustedRoot, refusal: undefined };
			}
		);

		expect(
			refusal instanceof IneffectiveCtlogThresholdError
				? { name: refusal.name, trustedRoot: refusal.trustedRoot }
				: refusal
		).toStrictEqual({
			name: 'IneffectiveCtlogThresholdError',
			trustedRoot: file
		});
	});

	it('rejects a zero certificate-transparency threshold for the public-good root before fetching it', async () => {
		let refusal: unknown;

		try {
			await verifyBundle(fixture.bundle, policy, options);
		} catch (error) {
			refusal = error;
		}

		expect(
			refusal instanceof IneffectiveCtlogThresholdError
				? { name: refusal.name, trustedRoot: refusal.trustedRoot }
				: refusal
		).toStrictEqual({
			name: 'IneffectiveCtlogThresholdError',
			trustedRoot: undefined
		});
	});

	it('rethrows a signer identity failure unwrapped', async () => {
		const refusal = await verifyWith(
			`${otherRoot}\n${fixture.trustedRoot}\n${thirdRoot}\n`,
			{
				identityPolicy: {
					identity: 'https://other.example/workflow',
					issuer: signerIssuer
				}
			}
		);

		expect(verificationFailure(refusal)).toStrictEqual({
			name: 'PolicyError',
			code: 'UNTRUSTED_SIGNER_ERROR'
		});
	});

	it.each([
		{
			name: 'a malformed line',
			file: `${fixture.trustedRoot}\n{not json\n`,
			reason: { kind: 'malformed-line', line: 2 }
		},
		{
			name: 'a line that is not a JSON object',
			file: `${fixture.trustedRoot}\nnull\n`,
			reason: { kind: 'malformed-line', line: 2 }
		},
		{
			name: 'a pretty-printed document with a syntax error',
			file: pretty.slice(0, pretty.lastIndexOf('}')),
			reason: { kind: 'malformed-document' }
		},
		{
			name: 'a document that is not a JSON object',
			file: '42\n',
			reason: { kind: 'malformed-document' }
		},
		{
			name: 'an empty file',
			file: '\n \n',
			reason: { kind: 'empty' }
		},
		{
			name: 'a JSON object that is not a trusted root',
			file: JSON.stringify({ mediaType: 'application/json' }),
			reason: { kind: 'not-a-trusted-root' }
		},
		{
			name: 'a line that is not a trusted root',
			file: `${fixture.trustedRoot}\n{}\n`,
			reason: { kind: 'not-a-trusted-root-line', line: 2 }
		},
		{
			name: 'a root with a certificate that cannot be loaded, after a root that verifies',
			file: `${fixture.trustedRoot}\n${withUnloadableCertificate(otherRoot)}\n`,
			reason: { kind: 'unusable-root-line', line: 2 }
		}
	])('rejects $name', async ({ file, reason }) => {
		const refusal = await verifyWith(file);

		expect(
			refusal instanceof TrustedRootFormatError
				? { name: refusal.name, reason: refusal.reason }
				: refusal
		).toStrictEqual({ name: 'TrustedRootFormatError', reason });
	});
});

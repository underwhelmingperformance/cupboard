import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { VerificationError } from '@sigstore/verify';
import { describe, expect, it } from 'vitest';

import {
	CertificateIdentityModeError,
	CertificateIssuerModeError,
	identityPolicy,
	verificationPolicy,
	verifyBundle
} from './sigstore.ts';
import {
	githubInstanceBundle,
	signerIdentity,
	signerIssuer
} from './sigstore-bundle-fixture.ts';

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

import { describe, expect, it } from 'vitest';

import {
	CertificateIdentityModeError,
	CertificateIssuerModeError,
	identityPolicy,
	verificationPolicy
} from './sigstore.ts';

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

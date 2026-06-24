import { describe, expect, it } from 'vitest';

import {
	CertificateIdentityModeError,
	CertificateIssuerModeError,
	CertificatePolicyModeMismatchError,
	identityPolicy,
	slsaSourceCommit
} from './attestation.ts';

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

	it('requires identity and issuer modes to match', () => {
		const error = thrownBy(() =>
			identityPolicy({
				certificateIdentity: 'alice@example.test',
				certificateOidcIssuerRegex: 'https://issuer[.]test'
			})
		);

		expect(error).toBeInstanceOf(CertificatePolicyModeMismatchError);

		if (error instanceof CertificatePolicyModeMismatchError) {
			expect({
				identityMode: error.identityMode,
				issuerMode: error.issuerMode
			}).toStrictEqual({ identityMode: 'exact', issuerMode: 'regex' });
		}
	});

	it('builds exact and regex policies', () => {
		expect(
			identityPolicy({
				certificateIdentity: 'alice@example.test',
				certificateOidcIssuer: 'https://issuer.test'
			})
		).toStrictEqual({
			mode: 'exact',
			identity: 'alice@example.test',
			issuer: 'https://issuer.test'
		});

		expect(
			identityPolicy({
				certificateIdentityRegex: 'alice@.*',
				certificateOidcIssuerRegex: 'https://issuer[.]test'
			})
		).toStrictEqual({
			mode: 'regex',
			identity: /alice@.*/,
			issuer: /https:\/\/issuer[.]test/
		});
	});
});

describe('slsaSourceCommit', () => {
	it('reads the git commit from the resolved dependencies', () => {
		expect(
			slsaSourceCommit({
				buildDefinition: {
					resolvedDependencies: [
						{
							uri: 'git+https://github.com/owner/repo',
							digest: { gitCommit: 'abc123' }
						}
					]
				}
			})
		).toBe('abc123');
	});

	it.each([
		{ name: 'an empty predicate', predicate: {} },
		{ name: 'a non-object predicate', predicate: 'nope' },
		{
			name: 'a dependency without a commit',
			predicate: { buildDefinition: { resolvedDependencies: [{ digest: {} }] } }
		}
	])('returns undefined for $name', ({ predicate }) => {
		expect(slsaSourceCommit(predicate)).toBeUndefined();
	});
});

import {
	type OidcTrustVerificationTarget,
	type VerifiedOidcClaims
} from '@cupboard/protocol/oidc-trust-match';

import {
	IssuerUnavailableError,
	SubjectTokenVerificationFailedError
} from '../errors.ts';

import {
	type OidcDiscoveryStore,
	OidcKeysUnreachableError,
	verifyInboundOidcToken
} from './oidc.ts';

const issuerRetryDelayMs = 100;

/**
 * Verifies an inbound ID token against the keys that its issuer publishes. The
 * tenant token exchange, the control token exchange and the first-admin claim
 * all use it.
 *
 * A failure to fetch the issuer's metadata or keys is an
 * `IssuerUnavailableError`, which the client can retry. The verifier retries it
 * once itself after a short delay. Every other verification failure is a
 * `SubjectTokenVerificationFailedError`.
 */
export class InboundTokenVerifier {
	constructor(private readonly discovery: OidcDiscoveryStore) {}

	private async verifyOnce(
		target: OidcTrustVerificationTarget,
		token: string,
		trustedAudiences: ReadonlySet<string>
	): Promise<VerifiedOidcClaims> {
		let issuer;

		try {
			issuer = await this.discovery.resolve(target.issuer);
		} catch (error: unknown) {
			throw new IssuerUnavailableError(target.issuer, { cause: error });
		}

		try {
			return await verifyInboundOidcToken(
				issuer.resolver,
				token,
				{
					issuer: target.issuer,
					audience: target.audience,
					trustedAudiences,
					algorithms: issuer.algorithms,
					requireIdTokenClaims: true
				},
				new Date()
			);
		} catch (error) {
			if (error instanceof OidcKeysUnreachableError) {
				throw new IssuerUnavailableError(target.issuer, { cause: error });
			}

			throw new SubjectTokenVerificationFailedError();
		}
	}

	async verify(
		target: OidcTrustVerificationTarget,
		token: string,
		trustedAudiences: ReadonlySet<string>
	): Promise<VerifiedOidcClaims> {
		try {
			return await this.verifyOnce(target, token, trustedAudiences);
		} catch (error) {
			if (!(error instanceof IssuerUnavailableError)) {
				throw error;
			}

			await new Promise((resolve) => setTimeout(resolve, issuerRetryDelayMs));

			return this.verifyOnce(target, token, trustedAudiences);
		}
	}
}

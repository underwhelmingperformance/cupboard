import {
	type OidcTrustVerificationTarget,
	type VerifiedOidcClaims
} from '@cupboard/protocol/oidc-trust-match';

import {
	IssuerUnavailableError,
	SubjectTokenTooOldError,
	SubjectTokenVerificationFailedError
} from '../errors.ts';

import {
	OidcDiscoveryError,
	type OidcDiscoveryStore,
	OidcKeysUnreachableError,
	OidcTokenTooOldError,
	OidcTokenVerificationError,
	verifyInboundOidcToken
} from './oidc.ts';

const issuerRetryDelayMs = 100;

export interface InboundTokenLimits {
	readonly maxTokenAgeSeconds?: number;
}

/**
 * Verifies an inbound ID token against the keys that its issuer publishes. The
 * tenant token exchange, the control token exchange and the first-admin claim
 * all use it.
 *
 * A failure to fetch the issuer's metadata or keys is an
 * `IssuerUnavailableError`, which the client can retry. The verifier retries it
 * once itself after a short delay. A token older than the maximum token age is
 * a `SubjectTokenTooOldError`. A token that fails verification in any other way
 * is a `SubjectTokenVerificationFailedError`. Any other error propagates unchanged
 * and becomes a 500.
 */
export class InboundTokenVerifier {
	constructor(
		private readonly discovery: Pick<OidcDiscoveryStore, 'resolve'>
	) {}

	private async verifyOnce(
		target: OidcTrustVerificationTarget,
		token: string,
		trustedAudiences: ReadonlySet<string>,
		limits: InboundTokenLimits
	): Promise<VerifiedOidcClaims> {
		let issuer;

		try {
			issuer = await this.discovery.resolve(target.issuer);
		} catch (error: unknown) {
			if (error instanceof OidcDiscoveryError) {
				throw new IssuerUnavailableError(target.issuer, { cause: error });
			}

			throw error;
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
					requireIdTokenClaims: true,
					...limits
				},
				new Date()
			);
		} catch (error) {
			if (error instanceof OidcKeysUnreachableError) {
				throw new IssuerUnavailableError(target.issuer, { cause: error });
			}

			if (error instanceof OidcTokenTooOldError) {
				throw new SubjectTokenTooOldError();
			}

			if (error instanceof OidcTokenVerificationError) {
				throw new SubjectTokenVerificationFailedError();
			}

			throw error;
		}
	}

	async verify(
		target: OidcTrustVerificationTarget,
		token: string,
		trustedAudiences: ReadonlySet<string>,
		limits: InboundTokenLimits = {}
	): Promise<VerifiedOidcClaims> {
		try {
			return await this.verifyOnce(target, token, trustedAudiences, limits);
		} catch (error) {
			if (!(error instanceof IssuerUnavailableError)) {
				throw error;
			}

			await new Promise((resolve) => setTimeout(resolve, issuerRetryDelayMs));

			return this.verifyOnce(target, token, trustedAudiences, limits);
		}
	}
}

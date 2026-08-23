import {
	isAllowedIssuerUrl,
	isHttpsIssuerUrl
} from '@cupboard/protocol/oidc-issuer';

export interface LocalDevelopmentEnvironment {
	readonly CUPBOARD_LOCAL_DEV: string | undefined;
}

/**
 * Whether local development may use a loopback HTTP issuer.
 */
export function canUseLoopbackHttp(env: LocalDevelopmentEnvironment): boolean {
	return env.CUPBOARD_LOCAL_DEV === '1' || env.CUPBOARD_LOCAL_DEV === 'true';
}

export function isAllowedIssuerTransport(
	issuer: string,
	canUseLoopbackHttp: boolean
): boolean {
	return (
		isAllowedIssuerUrl(issuer) &&
		(isHttpsIssuerUrl(issuer) || canUseLoopbackHttp)
	);
}

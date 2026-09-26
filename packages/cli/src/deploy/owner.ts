import {
	type OidcAudience,
	oidcAudienceSchema,
	type OidcIssuer,
	oidcIssuerSchema,
	type OidcSubject,
	oidcSubjectSchema
} from '@cupboard/protocol/oidc';
import { isHttpsIssuerUrl, IssuerUrl } from '@cupboard/protocol/oidc-issuer';
import { z } from 'zod';

import { decodeJwtPayload } from '../auth/jwt.ts';
import { CliError } from '../errors.ts';
import { ownDisplayName } from '../principal.ts';

import { cloudflareOauthClientId } from './cloudflare-oauth.ts';

/**
 * The issuer of the Cloudflare login. `cupboard init` and `cupboard login` use
 * it for the admin's identity unless `--oidc-issuer` specifies another.
 */
export const cloudflareDashIssuer = 'https://dash.cloudflare.com';

/**
 * An OIDC principal: the issuer and subject that identify it.
 */
export interface Principal {
	readonly issuer: OidcIssuer;
	readonly subject: OidcSubject;
}

/**
 * An OIDC principal as the control plane pins it: the global admin, or the
 * owner of a tenant that the deploy creates. The audience is absent for an
 * admin claimed before migration 0016 whose bootstrap trust rule was removed.
 */
export interface OwnerBinding extends Principal {
	readonly audience?: OidcAudience;
}

/**
 * The identity in the operator's id_token, which a first deploy makes the
 * admin. `displayName` is the token's `name`, `email`, `preferred_username` or
 * `sub` claim.
 */
export interface Claimant extends Principal {
	readonly audience: OidcAudience;
	readonly displayName: string | undefined;
}

const subjectClaimSchema = z.string().min(1).pipe(oidcSubjectSchema);

const principalClaimsSchema = z.looseObject({
	iss: z.string().min(1).pipe(oidcIssuerSchema),
	sub: subjectClaimSchema
});

/**
 * The principal in an id_token, or undefined when the token has no string
 * `iss` and `sub`.
 */
export function principalOf(idToken: string): Principal | undefined {
	const parsed = principalClaimsSchema.safeParse(decodeJwtPayload(idToken));

	if (!parsed.success) {
		return undefined;
	}

	return { issuer: parsed.data.iss, subject: parsed.data.sub };
}

/**
 * Why `/signup` on a deployed Worker would refuse an id_token: its issuer is
 * not an HTTPS URL without a query or fragment, it has no subject, or its
 * `aud` does not contain exactly one audience.
 */
export type ClaimTokenProblem = 'issuer' | 'subject' | 'audience';

function claimTokenProblemText(problem: ClaimTokenProblem): string {
	switch (problem) {
		case 'issuer': {
			return (
				'its `iss` claim is missing or is not an HTTPS URL without a query or ' +
				'fragment'
			);
		}
		case 'subject': {
			return 'it has no `sub` claim';
		}
		case 'audience': {
			return (
				'its `aud` claim does not contain exactly one audience, and the ' +
				'control trust rule that the claim creates pins one audience'
			);
		}
	}
}

/**
 * The id_token from the login cannot claim the deployment, because `/signup`
 * would refuse it.
 */
export class ClaimTokenUnusableError extends CliError {
	constructor(public readonly problem: ClaimTokenProblem) {
		super(
			'The id_token from the login cannot claim the deployment: ' +
				`${claimTokenProblemText(problem)}. Log in with an issuer and client ` +
				'whose id_tokens meet this, using `--oidc-issuer` and `--client-id`. ' +
				'Nothing was changed.'
		);
		this.name = 'ClaimTokenUnusableError';
	}
}

const claimTokenSchema = z.looseObject({
	iss: z.unknown().optional(),
	sub: z.unknown().optional(),
	aud: z.unknown().optional()
});

const audienceClaimSchema = z.string().min(1).pipe(oidcAudienceSchema);
const singleAudienceSchema = z.union([
	audienceClaimSchema,
	z.tuple([audienceClaimSchema])
]);

/**
 * The claimant in an id_token. It applies the checks that `/signup` on a
 * deployed Worker applies before it verifies the token, so a token that
 * `/signup` would refuse stops the deploy before any change. A deployed Worker
 * accepts loopback HTTP issuers only in local development, which `cupboard
 * init` never deploys, so the check requires HTTPS.
 */
export function claimantOf(idToken: string): Claimant {
	const claims = claimTokenSchema.safeParse(decodeJwtPayload(idToken)).data;
	const issuer =
		typeof claims?.iss === 'string' ? IssuerUrl.parse(claims.iss) : undefined;

	if (issuer === undefined || !isHttpsIssuerUrl(issuer.value)) {
		throw new ClaimTokenUnusableError('issuer');
	}

	const subject = subjectClaimSchema.safeParse(claims?.sub);

	if (!subject.success) {
		throw new ClaimTokenUnusableError('subject');
	}

	const audience = singleAudienceSchema.safeParse(claims?.aud);

	if (!audience.success) {
		throw new ClaimTokenUnusableError('audience');
	}

	return {
		issuer: oidcIssuerSchema.parse(issuer.value),
		subject: subject.data,
		audience: Array.isArray(audience.data) ? audience.data[0] : audience.data,
		displayName: ownDisplayName(idToken)
	};
}

/**
 * Whether two principals have the same issuer and subject.
 */
export function isSamePrincipal(
	left: Principal | undefined,
	right: Principal
): boolean {
	return left?.issuer === right.issuer && left.subject === right.subject;
}

// A value that a POSIX shell reads as one word without quoting stays as it is,
// so the usual command reads naturally. Any other value is single-quoted.
function shellWord(value: string): string {
	return /^[\w%+,./:=@-]+$/.test(value)
		? value
		: `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

/**
 * The `cupboard login` command that obtains a session for `admin` at `url`.
 * It adds `--oidc-issuer` and `--client-id` when the admin's issuer or client
 * differs from the defaults of `cupboard login`.
 */
export function adminLoginCommand(url: URL, admin: OwnerBinding): string {
	const isDefaultLogin =
		admin.issuer === cloudflareDashIssuer &&
		(admin.audience === undefined ||
			admin.audience === cloudflareOauthClientId);
	const client =
		admin.audience === undefined
			? ''
			: ` --client-id ${shellWord(admin.audience)}`;
	const flags = isDefaultLogin
		? ''
		: ` --oidc-issuer ${shellWord(admin.issuer)}${client}`;

	return `cupboard login ${url.origin}${flags}`;
}

/**
 * How a first deploy shows the identity that its claim makes the admin: the
 * display name, then the issuer, subject and audience.
 */
export function claimantLabel(claimant: Claimant): string {
	return (
		`${claimant.displayName ?? claimant.subject} (issuer ` +
		`${claimant.issuer}, subject ${claimant.subject}, audience ` +
		`${claimant.audience})`
	);
}

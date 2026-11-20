import { type TenantId } from '@cupboard/nix-store/scalars';
import { githubActionsIssuer, type OidcIssuer } from '@cupboard/protocol/oidc';
import { type VerifiedOidcClaims } from '@cupboard/protocol/oidc-trust-match';
import { z } from 'zod';

import {
	PlanArchiveIssuerUnsupportedError,
	TenantSubjectTokenUntrustedError
} from '../errors.ts';

function isHostedActionsIssuer(issuer: string | undefined): issuer is string {
	if (issuer === undefined) {
		return false;
	}
	if (issuer === githubActionsIssuer) {
		return true;
	}
	if (issuer.startsWith(githubActionsIssuer + '/')) {
		return /^[a-z\d-]+$/u.test(issuer.slice(githubActionsIssuer.length + 1));
	}
	return /^https:\/\/token\.actions\.([a-z\d-]+)\.ghe\.com(?:\/\1)?$/u.test(
		issuer
	);
}

const runClaims = z.object({
	repository_owner_id: z.string().regex(/^\d+$/u),
	repository_id: z.string().regex(/^\d+$/u),
	run_id: z.string().regex(/^\d+$/u),
	job_workflow_ref: z.string().min(1),
	job_workflow_sha: z.string().regex(/^[\da-f]{40}$/u)
});

/**
Identifies a publication across job retries in the same GitHub Actions run.
*/
export interface PlanArchiveBinding {
	readonly tenant: TenantId;
	readonly tenantIssuer: OidcIssuer;
	readonly issuer: string;
	readonly owner: string;
	readonly repository: string;
	readonly run: string;
	readonly workflow: string;
	readonly revision: string;
	readonly cache?: string;
}

/**
Extracts the run and job workflow identity after OIDC verification.
*/
export function planArchiveBinding(
	tenant: TenantId,
	tenantIssuer: OidcIssuer,
	verified: VerifiedOidcClaims,
	cache: string | undefined
): PlanArchiveBinding {
	const issuer = verified.iss;
	if (!isHostedActionsIssuer(issuer)) {
		throw new PlanArchiveIssuerUnsupportedError();
	}
	const claims = runClaims.safeParse(verified);
	if (!claims.success) {
		throw new TenantSubjectTokenUntrustedError();
	}
	return {
		tenant,
		tenantIssuer,
		issuer,
		owner: claims.data.repository_owner_id,
		repository: claims.data.repository_id,
		run: claims.data.run_id,
		workflow: claims.data.job_workflow_ref,
		revision: claims.data.job_workflow_sha,
		...(cache !== undefined && { cache })
	};
}

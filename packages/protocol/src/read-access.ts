import {
	cacheAccessModeSchema,
	cachePrioritySchema,
	cacheScopeSchema
} from '@cupboard/nix-store/scalars';
import { readUserInputSchema } from '@cupboard/shared/http';
import { z } from 'zod';

import { isGrantPermittedByRule } from './grant-match.ts';
import {
	type AuthorizationDetail,
	type AuthorizationDetails
} from './grants.ts';
import { authorizationDetailsSchema } from './grants.ts';
import { subjectTokenTypeIdToken, tokenResponseSchema } from './oidc.ts';
import {
	type OidcClaims,
	type OidcTrustRule,
	preferredModelledOidcTrustRules
} from './oidc-trust-match.ts';
import { type OidcTrustSelection } from './oidc-trust-selection.ts';
import { reuseViewNameSchema } from './reuse-views.ts';

export const readTokenBasicUser = readUserInputSchema.parse('cupboard-oidc');
export const readTokenPasswordPrefix = 'cupboard-access+jwt:';

export const readAccessGrantType =
	'urn:cupboard:params:oauth:grant-type:read-access';
export const readAccessFileEnvironment = 'CUPBOARD_READ_ACCESS_FILE';

const cacheResourceSchema = z.strictObject({
	type: z.literal('cupboard_cache'),
	cache: cacheScopeSchema,
	mode: z.enum(['content', 'metadata']).default('content')
});

const viewResourceSchema = z.strictObject({
	type: z.literal('cupboard_view'),
	view: reuseViewNameSchema
});

export const readResourceSchema = z.discriminatedUnion('type', [
	cacheResourceSchema,
	viewResourceSchema
]);

export type ReadResource = z.output<typeof readResourceSchema>;

export const readResourcesSchema = z
	.array(readResourceSchema)
	.min(1)
	.max(2)
	.refine(
		(resources) =>
			new Set(resources.map((resource) => resource.type)).size ===
			resources.length,
		'Choose at most one cache and one reuse view'
	);

const existingStateSchema = z.strictObject({
	kind: z.literal('existing'),
	access: cacheAccessModeSchema,
	priority: cachePrioritySchema
});

const absentStateSchema = z.strictObject({
	kind: z.literal('absent'),
	firstWrite: z
		.strictObject({
			access: cacheAccessModeSchema,
			priority: cachePrioritySchema
		})
		.optional()
});

const absentViewStateSchema = z.strictObject({ kind: z.literal('absent') });
const viewStateSchema = z.discriminatedUnion('kind', [
	existingStateSchema,
	absentViewStateSchema
]);

export const readResourceStateSchema = z.discriminatedUnion('type', [
	cacheResourceSchema.extend({
		state: z.discriminatedUnion('kind', [
			existingStateSchema,
			absentStateSchema
		])
	}),
	viewResourceSchema.extend({
		state: viewStateSchema
	})
]);
export type ReadResourceState = z.output<typeof readResourceStateSchema>;
export const readAccessFactsSchema = z
	.array(readResourceStateSchema)
	.min(1)
	.max(2);
export const readAccessResponseSchema = tokenResponseSchema.extend({
	authorization_details:
		tokenResponseSchema.shape.authorization_details.unwrap(),
	read_resources: readAccessFactsSchema,
	refresh_token: z.never().optional()
});
export type ReadAccessResponse = z.output<typeof readAccessResponseSchema>;

export const readAccessSnapshotSchema = z.strictObject({
	authorization_details: authorizationDetailsSchema,
	read_resources: readAccessFactsSchema
});
export const readAccessGrantRequestSchema = z.strictObject({
	grant_type: z.literal(readAccessGrantType),
	subject_token: z.string().min(1),
	subject_token_type: z.literal(subjectTokenTypeIdToken),
	read_resources: z.string().min(1)
});
export type ReadAccessGrantRequest = z.output<
	typeof readAccessGrantRequestSchema
>;

/**
Resolves exact read grants without granting private content through metadata authority.
*/
export function resolveReadAuthority(
	rule: OidcTrustRule,
	claims: OidcClaims,
	resources: readonly ReadResourceState[]
): AuthorizationDetails | undefined {
	const grants: AuthorizationDetails = [];

	for (const resource of resources) {
		const content: AuthorizationDetail =
			resource.type === 'cupboard_cache'
				? {
						type: resource.type,
						cache: resource.cache,
						actions: ['cache:content-read']
					}
				: {
						type: resource.type,
						view: resource.view,
						actions: ['view:content-read']
					};

		if (
			(resource.type !== 'cupboard_cache' || resource.mode === 'content') &&
			isGrantPermittedByRule(rule.permittedGrants, content, claims)
		) {
			grants.push(content);

			continue;
		}

		if (
			resource.type === 'cupboard_cache' &&
			(resource.mode === 'metadata' || resource.state.kind === 'absent')
		) {
			const metadata: AuthorizationDetail = {
				type: resource.type,
				cache: resource.cache,
				actions: ['cache:read']
			};

			if (isGrantPermittedByRule(rule.permittedGrants, metadata, claims)) {
				grants.push(metadata);

				continue;
			}
		}

		if (
			resource.state.kind === 'existing' &&
			resource.state.access === 'public'
		) {
			continue;
		}

		return undefined;
	}

	return grants;
}

export type ReadTrustSelection =
	| Exclude<OidcTrustSelection, { readonly outcome: 'selected' }>
	| {
			readonly outcome: 'selected';
			readonly rule: OidcTrustRule;
			readonly grants: AuthorizationDetails;
	  };

/**
Applies identity precedence before checking the configured resources' read requirements.
*/
export function selectReadTrust(
	rules: readonly OidcTrustRule[],
	claims: OidcClaims,
	resources: readonly ReadResourceState[]
): ReadTrustSelection {
	const preferred = preferredModelledOidcTrustRules(rules, claims);

	const first = preferred[0];

	if (first === undefined) {
		return { outcome: 'identity-unmatched' };
	}

	const eligible = preferred.flatMap((rule) => {
		const grants = resolveReadAuthority(rule, claims, resources);

		return grants === undefined ? [] : [{ rule, grants }];
	});
	const [selected, ...others] = eligible;

	if (selected === undefined) {
		const uncovered = resources.flatMap((resource) => {
			if (
				preferred.some(
					(rule) => resolveReadAuthority(rule, claims, [resource]) !== undefined
				)
			) {
				return [];
			}

			const detail: AuthorizationDetail =
				resource.type === 'cupboard_cache'
					? {
							type: resource.type,
							cache: resource.cache,
							actions: [
								resource.mode === 'metadata' || resource.state.kind === 'absent'
									? 'cache:read'
									: 'cache:content-read'
							]
						}
					: {
							type: resource.type,
							view: resource.view,
							actions: ['view:content-read']
						};

			return [detail];
		});

		return {
			outcome: 'authority-unmatched',
			rules: [first, ...preferred.slice(1)],
			uncovered
		};
	}

	if (others.length > 0) {
		return {
			outcome: 'ambiguous',
			rules: [selected.rule, ...others.map(({ rule }) => rule)]
		};
	}

	return { outcome: 'selected', ...selected };
}

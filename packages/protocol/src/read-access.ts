import {
	cacheAccessModeSchema,
	cachePrioritySchema,
	cacheScopeSchema
} from '@cupboard/nix-store/scalars';
import { readUserInputSchema } from '@cupboard/shared/http';
import { z } from 'zod';

import {
	type AuthorizationDetail,
	type AuthorizationDetails
} from './grants.ts';
import { authorizationDetailsSchema } from './grants.ts';
import { subjectTokenTypeIdToken, tokenResponseSchema } from './oidc.ts';
import {
	composeOidcGrants,
	type GrantComposition,
	type GrantRequirement
} from './oidc-grant-composition.ts';
import { type OidcClaims, type OidcTrustRule } from './oidc-trust-match.ts';
import { reuseViewNameSchema } from './reuse-views.ts';
import { subjectBindingFields } from './subject-binding.ts';

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

export const maxReadResources = 16;

export const readResourcesSchema = z
	.array(readResourceSchema)
	.min(1)
	.max(maxReadResources)
	.refine(
		(resources) =>
			resources.filter((resource) => resource.type === 'cupboard_view')
				.length <= 1,
		'Choose at most one reuse view'
	)
	.refine(
		(resources) =>
			new Set(resources.map((resource) => readResourceKey(resource))).size ===
			resources.length,
		'Choose each cache or reuse view once'
	);

function readResourceKey(resource: ReadResource): string {
	if (resource.type === 'cupboard_view') {
		return `view:${resource.view}`;
	}
	return resource.cache.kind === 'default'
		? 'cache:default'
		: `cache:named:${resource.cache.name}`;
}

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
	.max(maxReadResources);
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
	read_resources: z.string().min(1),
	...subjectBindingFields
});
export type ReadAccessGrantRequest = z.output<
	typeof readAccessGrantRequestSchema
>;

function readRequirement(resource: ReadResourceState): GrantRequirement {
	const isOptional =
		resource.state.kind === 'existing' && resource.state.access === 'public';
	if (resource.type === 'cupboard_view') {
		return {
			alternatives: [
				{
					type: resource.type,
					view: resource.view,
					actions: ['view:content-read']
				}
			],
			optional: isOptional
		};
	}

	const content: AuthorizationDetail = {
		type: resource.type,
		cache: resource.cache,
		actions: ['cache:content-read']
	};
	const metadata: AuthorizationDetail = {
		type: resource.type,
		cache: resource.cache,
		actions: ['cache:read']
	};
	const alternatives: [AuthorizationDetail, ...AuthorizationDetail[]] = [
		resource.mode === 'metadata' ? metadata : content
	];
	if (resource.mode === 'content' && resource.state.kind === 'absent') {
		alternatives.push(metadata);
	}
	return { alternatives, optional: isOptional };
}

/**
Resolves read requirements against one rule without extending authority.
*/
export function resolveReadAuthority(
	rule: OidcTrustRule,
	claims: OidcClaims,
	resources: readonly ReadResourceState[]
): AuthorizationDetails | undefined {
	const selection = selectReadTrust([rule], claims, resources);
	return selection.outcome === 'selected' ? selection.grants : undefined;
}

export type ReadTrustSelection = GrantComposition;

/**
Maps current resource state into requirements for the shared grant composer.
*/
export function selectReadTrust(
	rules: readonly OidcTrustRule[],
	claims: OidcClaims,
	resources: readonly ReadResourceState[],
	maximum?: AuthorizationDetails
): ReadTrustSelection {
	return composeOidcGrants(
		rules,
		claims,
		resources.map((resource) => readRequirement(resource)),
		maximum
	);
}

import {
	type CacheSelector,
	cacheSelectorSchema,
	type RootName,
	rootNameSchema,
	type TenantId,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import { z } from 'zod';

// Tokens encode grants in the RFC 9396 `authorization_details` claim.
// `isCoveredByToken` checks the route's required operation against the concrete
// request resource. Stored trust rules use templates and captures that resolve
// to concrete selectors when the server issues a token.

// Cache-scoped tenant operations. `gc:run` and `stats:read` also appear as
// domain operations: the per-cache form carries a cache, the deployment-wide
// form carries none, and the procedure's declared resource picks which.
export const cacheOperations = [
	'upload:negotiate',
	'upload:preview',
	'upload:status',
	'upload:commit',
	'upload:confirm',
	'attestation:negotiate',
	'attestation:attach',
	'root:set',
	'root:attach',
	'root:list',
	'root:remove',
	'cache:create',
	'cache:delete',
	'narinfo:delete',
	'gc:run',
	'stats:read'
] as const;

// Tenant-domain operations use authority over the tenant established by the
// issuer. They have no separate resource selector.
export const domainOperations = [
	'cache:list',
	'stats:read',
	'check:run',
	'verification:run',
	'gc:run',
	'signing-key:list',
	'signing-key:rotate',
	'signing-key:retire',
	'auth-key:list',
	'auth-key:rotate',
	'auth-key:retire',
	'oidc-trust:list',
	'oidc-trust:read',
	'oidc-trust:add',
	'oidc-trust:remove',
	'policy:list',
	'policy:add',
	'policy:remove',
	'reuse-view:list',
	'reuse-view:set',
	'reuse-view:remove'
] as const;

// These control operations require an exact tenant slug as their resource.
export const tenantOperations = [
	'tenant:create',
	'tenant:suspend',
	'tenant:resume',
	'tenant:remove',
	'tenant:set-read-mode',
	'tenant:rotate-read-credential',
	'tenant:clear-read-credential',
	'tenant:rotate-cache-read-credential',
	'tenant:clear-cache-read-credential'
] as const;

// These control operations do not select a resource.
export const controlOperations = [
	'control:check',
	'instance:read',
	'instance:initialise',
	'control-key:list',
	'control-key:rotate',
	'control-key:retire',
	'tenant:list',
	'membership:rebuild',
	'control-oidc-trust:list',
	'control-oidc-trust:read',
	'control-oidc-trust:add',
	'control-oidc-trust:remove'
] as const;

// `gc:run` and `stats:read` occur in two grant types but appear once in this
// combined schema.
export const operationSchema = z.enum([
	'upload:negotiate',
	'upload:preview',
	'upload:status',
	'upload:commit',
	'upload:confirm',
	'attestation:negotiate',
	'attestation:attach',
	'root:set',
	'root:attach',
	'root:list',
	'root:remove',
	'cache:create',
	'cache:delete',
	'cache:list',
	'narinfo:delete',
	'gc:run',
	'stats:read',
	'check:run',
	'verification:run',
	'signing-key:list',
	'signing-key:rotate',
	'signing-key:retire',
	'auth-key:list',
	'auth-key:rotate',
	'auth-key:retire',
	'oidc-trust:list',
	'oidc-trust:read',
	'oidc-trust:add',
	'oidc-trust:remove',
	'policy:list',
	'policy:add',
	'policy:remove',
	'reuse-view:list',
	'reuse-view:set',
	'reuse-view:remove',
	'control:check',
	'instance:read',
	'instance:initialise',
	'control-key:list',
	'control-key:rotate',
	'control-key:retire',
	'tenant:list',
	'tenant:create',
	'tenant:suspend',
	'tenant:resume',
	'tenant:remove',
	'tenant:set-read-mode',
	'tenant:rotate-read-credential',
	'tenant:clear-read-credential',
	'tenant:rotate-cache-read-credential',
	'tenant:clear-cache-read-credential',
	'membership:rebuild',
	'control-oidc-trust:list',
	'control-oidc-trust:read',
	'control-oidc-trust:add',
	'control-oidc-trust:remove'
]);
export type Operation = z.infer<typeof operationSchema>;

export interface ResourceRequest {
	readonly cache?: CacheSelector;
	readonly root?: RootName;
	readonly tenant?: TenantId;
}

// Issued grants carry only concrete selectors. Cache and tenant selectors are
// exact; a root selector is an exact name or a trailing-slash prefix. The
// wildcard is the only non-concrete grant and covers its whole domain.

export const grantTypes = [
	'cupboard_cache',
	'cupboard_domain',
	'cupboard_tenant',
	'cupboard_control',
	'cupboard_wildcard'
] as const;

const cacheActionsSchema = z.array(z.enum(cacheOperations)).min(1);
const domainActionsSchema = z.array(z.enum(domainOperations)).min(1);
const tenantActionsSchema = z.array(z.enum(tenantOperations)).min(1);
const controlActionsSchema = z.array(z.enum(controlOperations)).min(1);

export const authorizationDetailSchema = z.discriminatedUnion('type', [
	z.strictObject({
		type: z.literal('cupboard_cache'),
		actions: cacheActionsSchema,
		cache: cacheSelectorSchema,
		root: rootNameSchema.optional()
	}),
	z.strictObject({
		type: z.literal('cupboard_domain'),
		actions: domainActionsSchema
	}),
	z.strictObject({
		type: z.literal('cupboard_tenant'),
		actions: tenantActionsSchema,
		tenant: tenantIdSchema
	}),
	z.strictObject({
		type: z.literal('cupboard_control'),
		actions: controlActionsSchema
	}),
	z.strictObject({ type: z.literal('cupboard_wildcard') })
]);
export type AuthorizationDetail = z.infer<typeof authorizationDetailSchema>;

export const authorizationDetailsSchema = z.array(authorizationDetailSchema);
export type AuthorizationDetails = z.infer<typeof authorizationDetailsSchema>;

function isRootWithin(requested: string, granted: string): boolean {
	return granted.endsWith('/')
		? requested.startsWith(granted)
		: requested === granted;
}

// At issuance, a rule that permits `upload:negotiate` may also issue
// `upload:preview` because preview performs only the read-only classification
// step.
const impliedAtIssuance: Partial<Record<Operation, Operation>> = {
	'upload:preview': 'upload:negotiate'
};

// A presented negotiate grant also authorises preview during route checks and
// attenuation.
const impliedByPresentedAuthority: Partial<Record<Operation, Operation>> = {
	'upload:preview': 'upload:negotiate'
};

function isOperationImplied(
	actions: readonly Operation[],
	operation: Operation,
	impliedBy: Partial<Record<Operation, Operation>>
): boolean {
	if (actions.includes(operation)) {
		return true;
	}

	const broaderOperation = impliedBy[operation];

	return broaderOperation !== undefined && actions.includes(broaderOperation);
}

/**
 * Checks whether a stored trust-rule grant permits `operation` when the server
 * issues or refreshes a token. The operation can be listed directly or implied
 * by {@link impliedAtIssuance}.
 */
export function isOperationPermittedAtIssuance(
	actions: readonly Operation[],
	operation: Operation
): boolean {
	return isOperationImplied(actions, operation, impliedAtIssuance);
}

/**
 * Checks whether a presented token authorises `operation`. Route checks and
 * attenuation accept either a listed operation or one implied by
 * {@link impliedByPresentedAuthority}.
 */
export function isOperationSatisfiedByPresentedActions(
	actions: readonly Operation[],
	operation: Operation
): boolean {
	return isOperationImplied(actions, operation, impliedByPresentedAuthority);
}

function isCoveredByGrant(
	grant: AuthorizationDetail,
	operation: Operation,
	resource: ResourceRequest
): boolean {
	if (grant.type === 'cupboard_wildcard') {
		return true;
	}

	const actions: readonly Operation[] = grant.actions;

	if (!isOperationSatisfiedByPresentedActions(actions, operation)) {
		return false;
	}

	switch (grant.type) {
		case 'cupboard_cache': {
			return (
				resource.cache !== undefined &&
				resource.cache === grant.cache &&
				(resource.root === undefined ||
					(grant.root !== undefined && isRootWithin(resource.root, grant.root)))
			);
		}
		case 'cupboard_tenant': {
			return resource.tenant !== undefined && resource.tenant === grant.tenant;
		}
		case 'cupboard_domain':
		case 'cupboard_control': {
			// Resource-free: covers only the deployment-wide invocation, never a
			// cache- or tenant-scoped one.
			return resource.cache === undefined && resource.tenant === undefined;
		}
	}
}

/**
 * Checks whether any presented grant authorises `operation` on `resource`.
 * The server uses this after token verification, and the CLI uses the same
 * decision for its preflight check.
 */
export function isCoveredByToken(
	grants: readonly AuthorizationDetail[],
	operation: Operation,
	resource: ResourceRequest
): boolean {
	return grants.some((grant) => isCoveredByGrant(grant, operation, resource));
}

function detailResource(detail: AuthorizationDetail): ResourceRequest {
	switch (detail.type) {
		case 'cupboard_cache': {
			return { cache: detail.cache, root: detail.root };
		}
		case 'cupboard_tenant': {
			return { tenant: detail.tenant };
		}
		default: {
			return {};
		}
	}
}

/**
 * Checks whether `grants` authorises every operation in `detail` for its
 * selected resource. Attenuation uses this to prevent a new token from exceeding
 * the presenter's authority. Only a wildcard grant covers a requested wildcard.
 */
export function isAuthorizationDetailCovered(
	grants: readonly AuthorizationDetail[],
	detail: AuthorizationDetail
): boolean {
	if (detail.type === 'cupboard_wildcard') {
		return grants.some((grant) => grant.type === 'cupboard_wildcard');
	}

	const resource = detailResource(detail);
	const actions: readonly Operation[] = detail.actions;

	return actions.every((operation) =>
		isCoveredByToken(grants, operation, resource)
	);
}

export const templateMaxLength = 256;
export const capturePatternMaxLength = 512;
export const captureGroupMaxLength = 64;
export const claimNameMaxLength = 128;
export const maxSubstitutionsPerBinding = 8;
export const displayFieldMaxLength = 256;

const templateVariablePattern = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const templatePlaceholderPattern = /\{([A-Za-z_][A-Za-z0-9_]*)\}/gu;

export const templateSchema = z.string().min(1).max(templateMaxLength);

export function templateVariables(template: string): string[] {
	const variables: string[] = [];

	for (const match of template.matchAll(templatePlaceholderPattern)) {
		const variable = match[1];

		if (variable !== undefined) {
			variables.push(variable);
		}
	}

	return variables;
}

const captureSchema = z.strictObject({
	pattern: z.string().min(1).max(capturePatternMaxLength),
	group: z.string().min(1).max(captureGroupMaxLength)
});

export const substitutionSchema = z
	.strictObject({
		claim: z.string().min(1).max(claimNameMaxLength),
		capture: captureSchema.optional(),
		slug: z.literal(true).optional()
	})
	.refine((value) => value.capture === undefined || value.slug === undefined, {
		message: 'Set at most one of capture and slug'
	});
export type Substitution = z.infer<typeof substitutionSchema>;

const substitutionMapSchema = z
	.record(z.string().regex(templateVariablePattern), substitutionSchema)
	.refine((map) => Object.keys(map).length <= maxSubstitutionsPerBinding, {
		message: `A binding may define at most ${String(maxSubstitutionsPerBinding)} substitutions`
	});

const bindingShape = {
	equalsTemplate: templateSchema.optional(),
	exact: z.string().min(1).optional(),
	substitutions: substitutionMapSchema.optional()
};

function refineBinding(
	value: {
		readonly equalsTemplate?: string;
		readonly exact?: string;
		readonly substitutions?: Record<string, Substitution>;
		readonly equalsResource?: 'cache';
	},
	ctx: z.RefinementCtx,
	canUseResource: boolean
): void {
	const choices = [
		value.equalsTemplate !== undefined,
		value.exact !== undefined,
		value.equalsResource !== undefined
	].filter(Boolean).length;

	if (choices !== 1) {
		ctx.addIssue({
			code: 'custom',
			message: canUseResource
				? 'Set exactly one of equalsTemplate, exact, and equalsResource'
				: 'Set exactly one of equalsTemplate and exact'
		});
	}

	if (value.equalsTemplate === undefined) {
		return;
	}

	const provided = new Set(Object.keys(value.substitutions ?? {}));

	for (const variable of templateVariables(value.equalsTemplate)) {
		if (!provided.has(variable)) {
			ctx.addIssue({
				code: 'custom',
				message: `Define a substitution for template variable ${variable}`
			});
		}
	}
}

export const cacheBindingSchema = z
	.strictObject({ ...bindingShape, validate: z.literal('cacheName') })
	.superRefine((value, ctx) => {
		refineBinding(value, ctx, false);
	});
export const rootBindingSchema = z
	.strictObject({
		...bindingShape,
		validate: z.literal('rootName'),
		equalsResource: z.literal('cache').optional()
	})
	.superRefine((value, ctx) => {
		refineBinding(value, ctx, true);
	});
export const tenantBindingSchema = z
	.strictObject({ ...bindingShape, validate: z.literal('tenant') })
	.superRefine((value, ctx) => {
		refineBinding(value, ctx, false);
	});

export const oidcTrustDisplaySchema = z.strictObject({
	provider: z.string().max(displayFieldMaxLength).optional(),
	preset: z.string().max(displayFieldMaxLength).optional(),
	repository: z.string().max(displayFieldMaxLength).optional()
});
export type OidcTrustDisplay = z.infer<typeof oidcTrustDisplaySchema>;

const cacheResourcesSchema = z.strictObject({
	cache: cacheBindingSchema,
	root: rootBindingSchema.optional()
});
const tenantResourcesSchema = z.strictObject({ tenant: tenantBindingSchema });

export const permittedGrantSchema = z.discriminatedUnion('type', [
	z.strictObject({
		type: z.literal('cupboard_cache'),
		actions: cacheActionsSchema,
		resources: cacheResourcesSchema
	}),
	z.strictObject({
		type: z.literal('cupboard_domain'),
		actions: domainActionsSchema
	}),
	z.strictObject({
		type: z.literal('cupboard_tenant'),
		actions: tenantActionsSchema,
		resources: tenantResourcesSchema
	}),
	z.strictObject({
		type: z.literal('cupboard_control'),
		actions: controlActionsSchema
	}),
	z.strictObject({ type: z.literal('cupboard_wildcard') })
]);
export type PermittedGrant = z.infer<typeof permittedGrantSchema>;

const knownOperations: ReadonlySet<string> = new Set(operationSchema.options);

const grantWithActionsSchema = z.looseObject({ actions: z.array(z.unknown()) });

// Stored rules can contain operations removed by a later release. Remove unknown
// operations before strict validation. Remove a non-wildcard grant if no
// recognised operation remains. Preserve wildcard grants because they have no
// action list.
function withoutRetiredActions(grants: unknown): unknown {
	if (!Array.isArray(grants)) {
		return grants;
	}

	const items: readonly unknown[] = grants;

	return items
		.map((grant) => {
			const parsed = grantWithActionsSchema.safeParse(grant);

			if (!parsed.success) {
				return grant;
			}

			return {
				...parsed.data,
				actions: parsed.data.actions.filter(
					(action) => typeof action === 'string' && knownOperations.has(action)
				)
			};
		})
		.filter((grant) => {
			const parsed = grantWithActionsSchema.safeParse(grant);

			return !parsed.success || parsed.data.actions.length > 0;
		});
}

/**
 * Validates stored trust-rule grants from both current and earlier releases.
 * Before strict validation, the preprocessor removes retired operations and any
 * non-wildcard grant with no recognised operation. An upgrade that narrows the
 * operation set therefore does not invalidate the stored rule.
 */
export const storedPermittedGrantsSchema = z.preprocess(
	withoutRetiredActions,
	z.array(permittedGrantSchema)
);

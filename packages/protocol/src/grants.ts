import {
	cacheSelectorSchema,
	rootNameSchema,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import { z } from 'zod';

// Capability model. A token carries a set of grants as RFC 9396
// `authorization_details`; the authoriser asks one question, `isCoveredByToken`,
// against the operation a route declares and the concrete resource it acts on.
// A trust rule stores grants whose resources are bindings (templates, captures,
// relations) that resolve to those concrete selectors at issue time.

// Cache-scoped tenant operations. `gc:run` and `stats:read` also appear as
// domain operations: the per-cache form carries a cache, the deployment-wide
// form carries none, and the procedure's declared resource picks which.
export const cacheOperations = [
	'upload:negotiate',
	'upload:status',
	'upload:commit',
	'attestation:negotiate',
	'attestation:attach',
	'root:set',
	'root:list',
	'root:remove',
	'cache:create',
	'cache:delete',
	'narinfo:delete',
	'gc:run',
	'stats:read'
] as const;

// Tenant-domain operations, authority over the tenant the issuer established,
// with no resource of their own.
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
	'policy:remove'
] as const;

// Control operations that act on a specific tenant (an exact slug).
export const tenantOperations = [
	'tenant:create',
	'tenant:suspend',
	'tenant:resume',
	'tenant:remove',
	'tenant:set-read-mode',
	'tenant:rotate-read-credential',
	'tenant:clear-read-credential'
] as const;

// Resource-free control operations.
export const controlOperations = [
	'control:check',
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

// Every operation, deduplicated (`gc:run`/`stats:read` span two grant types).
export const operationSchema = z.enum([
	'upload:negotiate',
	'upload:status',
	'upload:commit',
	'attestation:negotiate',
	'attestation:attach',
	'root:set',
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
	'control:check',
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
	'membership:rebuild',
	'control-oidc-trust:list',
	'control-oidc-trust:read',
	'control-oidc-trust:add',
	'control-oidc-trust:remove'
]);
export type Operation = z.infer<typeof operationSchema>;

/** The concrete resource a route acts on, resolved before authorisation. */
export interface ResourceRequest {
	readonly cache?: string;
	readonly root?: string;
	readonly tenant?: string;
}

// ── Concrete grants (what a token carries; RFC 9396 authorization_details) ──
//
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

/** A requested root is within a granted root selector: exact, or prefix. */
function isRootWithin(requested: string, granted: string): boolean {
	return granted.endsWith('/')
		? requested.startsWith(granted)
		: requested === granted;
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

	if (!actions.includes(operation)) {
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
 * Whether any grant on the token authorises `operation` on `resource`. The
 * single authorisation decision, shared by the server (after token
 * verification) and the CLI (when constructing requested grants).
 */
export function isCoveredByToken(
	grants: readonly AuthorizationDetail[],
	operation: Operation,
	resource: ResourceRequest
): boolean {
	return grants.some((grant) => isCoveredByGrant(grant, operation, resource));
}

// The concrete resource a requested grant acts on, read straight from its
// selectors (it carries no bindings).
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
 * Whether the grant set covers every authority a requested detail carries: each
 * of its operations on its own resource. The subset test for attenuation and
 * refresh narrowing, so a narrowed token never reaches anything the presenter
 * could not. A requested wildcard is covered only by a presented wildcard.
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

// ── Stored trust-rule grants (resources are bindings, not concrete values) ──

export const templateMaxLength = 256;
export const capturePatternMaxLength = 512;
export const captureGroupMaxLength = 64;
export const claimNameMaxLength = 128;
export const maxSubstitutionsPerBinding = 8;
export const displayFieldMaxLength = 256;

const templateVariablePattern = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const templatePlaceholderPattern = /\{([A-Za-z_][A-Za-z0-9_]*)\}/gu;

export const templateSchema = z.string().min(1).max(templateMaxLength);

/** The variable names a `{name}` template references, in order, with repeats. */
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

// A substitution names a verified claim and an optional single transform.
export const substitutionSchema = z
	.strictObject({
		claim: z.string().min(1).max(claimNameMaxLength),
		capture: captureSchema.optional(),
		slug: z.literal(true).optional()
	})
	.refine(
		(value) => !(value.capture !== undefined && value.slug !== undefined),
		{
			message: 'a substitution uses at most one of capture or slug'
		}
	);
export type Substitution = z.infer<typeof substitutionSchema>;

const substitutionMapSchema = z
	.record(z.string().regex(templateVariablePattern), substitutionSchema)
	.refine((map) => Object.keys(map).length <= maxSubstitutionsPerBinding, {
		message: `at most ${String(maxSubstitutionsPerBinding)} substitutions`
	});

// The fields every binding shares: a template-or-exact source for a value
// validated against its destination grammar once rendered.
const bindingShape = {
	equalsTemplate: templateSchema.optional(),
	exact: z.string().min(1).optional(),
	substitutions: substitutionMapSchema.optional()
};

// Exactly one source must be set, and every variable a template references must
// have a substitution. A relational binding sets `equalsResource` instead, so a
// root may equal the cache its grant resolved.
function refineBinding(
	value: {
		readonly equalsTemplate?: string;
		readonly exact?: string;
		readonly substitutions?: Record<string, Substitution>;
		readonly equalsResource?: 'cache';
	},
	ctx: z.RefinementCtx
): void {
	const choices = [
		value.equalsTemplate !== undefined,
		value.exact !== undefined,
		value.equalsResource !== undefined
	].filter(Boolean).length;

	if (choices !== 1) {
		ctx.addIssue({
			code: 'custom',
			message:
				'a binding sets exactly one of equalsTemplate, exact, equalsResource'
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
				message: `template variable ${variable} has no substitution`
			});
		}
	}
}

export const cacheBindingSchema = z
	.strictObject({ ...bindingShape, validate: z.literal('cacheName') })
	.superRefine(refineBinding);
export const rootBindingSchema = z
	.strictObject({
		...bindingShape,
		validate: z.literal('rootName'),
		equalsResource: z.literal('cache').optional()
	})
	.superRefine(refineBinding);
export const tenantBindingSchema = z
	.strictObject({ ...bindingShape, validate: z.literal('tenant') })
	.superRefine(refineBinding);

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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

// A grant a rule persisted under an earlier build may name an operation since
// retired (a removed scope). Drop the unknown actions so the rule still
// validates against the current operation set; the rule is not failed outright. A grant carrying no recognised action becomes meaningless and is
// dropped; a wildcard grant has no actions and passes through untouched.
function withoutRetiredActions(grants: unknown): unknown {
	if (!Array.isArray(grants)) {
		return grants;
	}

	const items: readonly unknown[] = grants;

	const pruned = items.map((grant) => {
		if (!isRecord(grant) || !Array.isArray(grant.actions)) {
			return grant;
		}

		const actions: readonly unknown[] = grant.actions;

		return {
			...grant,
			actions: actions.filter(
				(action) => typeof action === 'string' && knownOperations.has(action)
			)
		};
	});

	return pruned.filter(
		(grant) =>
			!isRecord(grant) ||
			!Array.isArray(grant.actions) ||
			grant.actions.length > 0
	);
}

/**
 * Validates the grants a trust rule persisted, tolerating an older row that
 * still names a retired operation. Unknown actions are dropped and any grant
 * left empty is removed before the strict grant schema runs, so a routine
 * upgrade that narrows the operation set does not fail a stored rule.
 */
export const storedPermittedGrantsSchema = z.preprocess(
	withoutRetiredActions,
	z.array(permittedGrantSchema)
);

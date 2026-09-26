import type { LocalStep } from '@cupboard/protocol/deployment';
import {
	oidcAudienceSchema,
	oidcIssuerSchema,
	oidcSubjectSchema
} from '@cupboard/protocol/oidc';
import { z } from 'zod';

import { throwIfAborted } from '../abort.ts';
import { CliError } from '../errors.ts';
import { principalLabel } from '../principal.ts';

import { removeClaimSecret } from './claim-secret.ts';
import {
	type CloudflareApi,
	liveD1BindingSchema,
	type ScriptConfiguration
} from './cloudflare-api.ts';
import { jwtExpiryMs } from './cloudflare-oauth.ts';
import type { DeploymentConfig } from './config.ts';
import type { DeployOptions } from './deploy-run.ts';
import type { DatabaseId, ScriptName } from './identifiers.ts';
import {
	type Claimant,
	claimantLabel,
	claimantOf,
	type OwnerBinding
} from './owner.ts';
import {
	type ClaimSecret,
	claimSecretName,
	generateClaimSecret
} from './secrets.ts';
import type { DeployUi } from './ui.ts';

/**
 * Who may change the deployment in this run, determined before any change:
 *
 * - `bootstrap`: the control database has no admin and this run has a
 *   terminal, so this run claims the deployment for the operator with a
 *   claim secret and the operator's id_token. `claimant` is the
 *   identity in that id_token, which becomes the admin;
 * - `unclaimed`: no admin and no terminal to log in from, so this run
 *   provisions and uploads but leaves the claim to a run with a terminal;
 * - `admin`: an admin exists, and this run updates the deployment with the
 *   session that `cupboard login` cached.
 */
export type DeployAuthority =
	| {
			readonly kind: 'bootstrap';
			readonly claimSecret: ClaimSecret;
			readonly idToken: () => Promise<string>;
			readonly claimant: Claimant;
	  }
	| { readonly kind: 'unclaimed' }
	| { readonly kind: 'admin'; readonly admin: OwnerBinding };

/**
 * The authority for this run, or `declined` when the operator declined the
 * claim at the confirmation prompt.
 */
export type EstablishedAuthority =
	DeployAuthority | { readonly kind: 'declined' };

/**
 * Which of the two databases records the admin when the plan selects a
 * database other than the deployed Workers' database.
 */
export type AdminRecordedIn = 'bound' | 'planned' | 'both';

/**
 * The plan selects a D1 database other than the database of the deployed
 * Workers, and one of the two databases records an admin. Deploying would
 * either run as a first deploy while a database records an admin, or leave
 * the admin in a database that the Workers are no longer bound to.
 */
export class AdminDatabaseMismatchError extends CliError {
	constructor(
		public readonly boundDatabase: string | undefined,
		public readonly plannedDatabase: string | undefined,
		public readonly admin: OwnerBinding,
		public readonly recordedIn: AdminRecordedIn
	) {
		const bound = boundDatabase ?? 'no control database';
		const planned = plannedDatabase ?? 'no control database';
		const recorder = {
			bound: `the D1 database ${bound} records`,
			planned: `the D1 database ${planned} records`,
			both: 'both databases record'
		}[recordedIn];

		super(
			`The plan selects the D1 database ${planned}, but the deployed ` +
				`Workers use ${bound}, and ${recorder} the admin ` +
				`${principalLabel(admin)}. Select ${bound} in the plan, or bind ` +
				'the control Worker to the selected database first, as described under ' +
				'"Changing the control database" in the deployment guide ' +
				'(docs/deploying.md). Nothing was changed.'
		);
		this.name = 'AdminDatabaseMismatchError';
	}
}

/**
 * The control database that the deployed Workers are bound to, identified by
 * the binding's database id.
 */
export interface BoundDatabase {
	readonly id: DatabaseId;
	readonly name: string | undefined;
}

/**
 * The facts about the deployment and the plan that decide who may change it.
 */
export interface AuthorityDeployment {
	/**
	 * The database that the deployed Workers are bound to: the control Worker's
	 * binding, or the tenant Worker's binding when the control Worker was
	 * deleted. Undefined when neither Worker has the binding.
	 */
	readonly boundDatabase: BoundDatabase | undefined;
	/**
	 * The name of the control database selected in the plan.
	 */
	readonly plannedDatabaseName: string | undefined;
	/**
	 * Whether this run has a terminal, so the operator can log in.
	 */
	readonly interactive: boolean;
}

/**
 * The reads and the login that deciding the authority performs.
 */
export interface AuthorityEffects {
	readonly api: Pick<CloudflareApi, 'findD1Database' | 'd1QueryRows'>;
	/**
	 * An id_token for the operator. The token can be one from an earlier call.
	 */
	readonly idToken: () => Promise<string>;
	readonly generateClaimSecret: () => ClaimSecret;
	readonly signal?: AbortSignal;
}

/**
 * Decides who may change the deployment. Nothing here changes the account, so
 * a refusal leaves the deployment as it was.
 *
 * The admin is read from the database that the deployed Workers are bound to
 * and from the database selected in the plan. When the two differ and either
 * records an admin, the deploy refuses: without the refusal, it could run as a
 * first deploy while a database records an admin, or leave the admin in a
 * database that the Workers are no longer bound to.
 *
 * Whether the deploy claims or updates the deployment depends on the
 * `global_admin` row, not on whether Workers are deployed. A deployment
 * uploaded without a claim, or one whose deploy stopped between setting the
 * claim secret and claiming, has Workers but no admin, and the next run from a
 * terminal claims it with a fresh secret.
 */
export async function decideAuthority(
	deployment: AuthorityDeployment,
	effects: AuthorityEffects
): Promise<DeployAuthority> {
	throwIfAborted(effects.signal);

	const bound = deployment.boundDatabase;
	const plannedName = deployment.plannedDatabaseName;
	const plannedId =
		plannedName === undefined
			? undefined
			: await effects.api.findD1Database(plannedName);
	const isSameDatabase = bound?.id === plannedId;
	const plannedAdmin = await adminRecordedIn(effects, plannedId);
	const boundAdmin = isSameDatabase
		? plannedAdmin
		: await adminRecordedIn(effects, bound?.id);
	const admin = boundAdmin ?? plannedAdmin;

	if (admin === undefined) {
		return firstDeployAuthority(deployment, effects);
	}

	if (!isSameDatabase) {
		throw new AdminDatabaseMismatchError(
			bound?.name,
			plannedName,
			admin,
			recordedIn(boundAdmin, plannedAdmin)
		);
	}

	return { kind: 'admin', admin };
}

function recordedIn(
	boundAdmin: OwnerBinding | undefined,
	plannedAdmin: OwnerBinding | undefined
): AdminRecordedIn {
	if (boundAdmin !== undefined && plannedAdmin !== undefined) {
		return 'both';
	}

	return boundAdmin === undefined ? 'planned' : 'bound';
}

async function adminRecordedIn(
	effects: Pick<AuthorityEffects, 'api'>,
	databaseId: DatabaseId | undefined
): Promise<OwnerBinding | undefined> {
	if (databaseId === undefined) {
		return undefined;
	}

	const { api } = effects;

	return readGlobalAdmin(
		{ queryRows: (id, sql) => api.d1QueryRows(id, sql) },
		databaseId
	);
}

async function firstDeployAuthority(
	deployment: Pick<AuthorityDeployment, 'interactive'>,
	effects: Pick<AuthorityEffects, 'idToken' | 'generateClaimSecret'>
): Promise<DeployAuthority> {
	if (!deployment.interactive) {
		return { kind: 'unclaimed' };
	}

	// Log in before anything changes, so a refused or cancelled login, or an
	// id_token that `/signup` would refuse, leaves the account untouched.
	const idToken = await effects.idToken();
	const claimant = claimantOf(idToken);

	return {
		kind: 'bootstrap',
		claimSecret: effects.generateClaimSecret(),
		idToken: effects.idToken,
		claimant
	};
}

const globalAdminColumnsQuery =
	"SELECT name FROM pragma_table_info('global_admin');";

// `queryRows` returns one string per row, so the row is read as a JSON array.
// Migration 0016 fills an unknown audience with an empty string, which the
// query reads as null.
const globalAdminQuery =
	"SELECT json_array(issuer, subject, NULLIF(audience, '')) FROM global_admin WHERE id = 'singleton';";

// Migration 0016 adds the `audience` column and fills it from the bootstrap
// trust rule. On a database without migration 0016, this query reads the
// audience from the same rule.
const globalAdminWithoutAudienceQuery =
	"SELECT json_array(issuer, subject, NULLIF((SELECT audience FROM control_trust WHERE id = 'signup'), '')) FROM global_admin WHERE id = 'singleton';";

const globalAdminRowSchema = z.tuple([
	z.string().min(1).pipe(oidcIssuerSchema),
	z.string().min(1).pipe(oidcSubjectSchema),
	z.string().min(1).pipe(oidcAudienceSchema).nullable()
]);

export class GlobalAdminRowInvalidError extends CliError {
	constructor(options?: { readonly cause?: unknown }) {
		super(
			'The global_admin row in D1 has an unexpected shape. Check the control database before retrying.',
			options
		);
		this.name = 'GlobalAdminRowInvalidError';
	}
}

/**
 * The deployment's global admin, read from the control database before any
 * migration runs. Undefined when nobody has claimed the deployment, or when
 * the database predates the `global_admin` table. The audience of an admin
 * claimed before migration 0016 comes from the bootstrap trust rule, and is
 * absent when that rule is missing.
 */
export async function readGlobalAdmin(
	api: {
		queryRows(databaseId: DatabaseId, sql: string): Promise<readonly string[]>;
	},
	databaseId: DatabaseId
): Promise<OwnerBinding | undefined> {
	const columns = await api.queryRows(databaseId, globalAdminColumnsQuery);

	if (columns.length === 0) {
		return undefined;
	}

	const [row] = await api.queryRows(
		databaseId,
		columns.includes('audience')
			? globalAdminQuery
			: globalAdminWithoutAudienceQuery
	);

	if (row === undefined) {
		return undefined;
	}

	let decoded: unknown;

	try {
		decoded = JSON.parse(row);
	} catch (error) {
		throw new GlobalAdminRowInvalidError({ cause: error });
	}

	const parsed = globalAdminRowSchema.safeParse(decoded);

	if (!parsed.success) {
		throw new GlobalAdminRowInvalidError();
	}

	const [issuer, subject, audience] = parsed.data;

	return audience === null
		? { issuer, subject }
		: { issuer, subject, audience };
}

// The claim's id_token only has to remain valid for the `/signup` and
// `/token` requests. A short margin keeps the id_token from the login before
// the upload in use, so the claim normally needs no second login, even with
// an issuer whose id_tokens are valid for only a few minutes.
const claimIdTokenMarginMs = 60 * 1000;

/**
 * An id_token source that logs in once, and logs in again only when the
 * current token expires within a minute. A first deploy logs in before
 * provisioning, and the claim can happen minutes later, after the token has
 * expired.
 */
export function renewingIdToken(
	login: () => Promise<string>,
	now: () => number = Date.now
): () => Promise<string> {
	let held: string | undefined;

	return async () => {
		const expiry = held === undefined ? undefined : jwtExpiryMs(held);

		if (
			held !== undefined &&
			(expiry === undefined || expiry > now() + claimIdTokenMarginMs)
		) {
			return held;
		}

		held = await login();

		return held;
	};
}

/**
 * Adds the claim secret to the control Worker's secrets on a first
 * deploy, so the claim can present it once the new build serves. For an
 * update or an unclaimed deploy, it returns the options unchanged.
 */
export function withClaimSecret(
	options: DeployOptions,
	authority: DeployAuthority
): DeployOptions {
	if (authority.kind !== 'bootstrap') {
		return options;
	}

	return {
		...options,
		secrets: {
			...options.secrets,
			control: [
				...options.secrets.control,
				{ name: claimSecretName, text: authority.claimSecret }
			]
		}
	};
}

/**
 * The function that migrates tenants during an update. Only an admin creates
 * tenants, so a deployment without an admin has none, and the result is
 * undefined for a first deploy or an unclaimed deploy.
 */
export function tenantMigratorFor(
	authority: DeployAuthority,
	migrate: (requiredStep: LocalStep) => Promise<void>
): ((requiredStep: LocalStep) => Promise<void>) | undefined {
	return authority.kind === 'admin' ? migrate : undefined;
}

/**
 * Removes a claim secret that an earlier first deploy left on the control
 * Worker, which happens when that deploy was interrupted or could not delete
 * the secret. An update and a deploy without a terminal remove it; a first
 * deploy from a terminal sets and deletes its own secret. A failed removal
 * produces a warning, and the deploy continues.
 */
export async function removeLeftoverClaimSecret(
	authority: DeployAuthority,
	dependencies: {
		readonly ui: DeployUi;
		readonly api: Pick<CloudflareApi, 'deleteSecret'>;
		readonly controlScriptName: ScriptName;
		readonly controlSecrets: () => Promise<readonly string[]>;
	}
): Promise<void> {
	if (authority.kind === 'bootstrap') {
		return;
	}

	const secrets = await dependencies.controlSecrets();

	if (!secrets.includes(claimSecretName)) {
		return;
	}

	await removeClaimSecret(
		dependencies.ui,
		dependencies.api,
		dependencies.controlScriptName,
		'Removing a leftover claim secret'
	);
}

// The Workers' binding for the control database, which records the admin.
const controlDatabaseBinding = 'CUPBOARD_DB';

function controlDatabaseName(config: DeploymentConfig): string | undefined {
	return config.control.d1Databases.find(
		(database) => database.binding === controlDatabaseBinding
	)?.databaseName;
}

function boundDatabaseId(
	configuration: ScriptConfiguration | undefined
): DatabaseId | undefined {
	return configuration?.bindings.flatMap((binding) => {
		const parsed = liveD1BindingSchema.safeParse(binding);

		return parsed.success && parsed.data.name === controlDatabaseBinding
			? [parsed.data.database_id]
			: [];
	})[0];
}

/**
 * The Cloudflare reads that determine who may change the deployment.
 */
export type AuthorityApi = Pick<
	CloudflareApi,
	| 'findD1Database'
	| 'findD1DatabaseName'
	| 'd1QueryRows'
	| 'getScriptConfiguration'
>;

export interface AuthorityWorld {
	readonly ui: DeployUi;
	readonly api: AuthorityApi;
	readonly idToken: () => Promise<string>;
	/**
	 * Asks whether the claim may make `claimant` the admin.
	 */
	readonly confirmClaim: (claimant: Claimant) => Promise<boolean>;
	readonly interactive: boolean;
	readonly signal?: AbortSignal | undefined;
}

/**
 * Determines who may change the deployment before anything changes, with the
 * rules of {@link decideAuthority}, and reports the result. A first deploy logs
 * the operator in with the issuer and client from `--oidc-issuer` and
 * `--client-id`, prints who the claim will make the admin, and asks for
 * confirmation.
 */
export async function establishAuthority(
	plans: {
		readonly agreed: { readonly config: DeploymentConfig };
	},
	world: AuthorityWorld
): Promise<EstablishedAuthority> {
	const { ui, api } = world;
	const controlName = plans.agreed.config.control.name;
	const control = await api.getScriptConfiguration(controlName);
	// Without the control Worker, the tenant Worker's binding shows which
	// database the deployment used.
	const boundId = boundDatabaseId(
		control ??
			(await api.getScriptConfiguration(plans.agreed.config.tenant.name))
	);

	// Not run inside a reporter phase, because a first deploy may open a
	// browser to log in.
	const authority = await decideAuthority(
		{
			boundDatabase:
				boundId === undefined
					? undefined
					: { id: boundId, name: await api.findD1DatabaseName(boundId) },
			plannedDatabaseName: controlDatabaseName(plans.agreed.config),
			interactive: world.interactive
		},
		{
			api,
			idToken: world.idToken,
			generateClaimSecret,
			...(world.signal !== undefined && { signal: world.signal })
		}
	);

	switch (authority.kind) {
		case 'admin': {
			ui.info(
				`Updating the deployment administered by ${principalLabel(authority.admin)}`
			);
			break;
		}
		case 'bootstrap': {
			ui.info(
				'This deployment has no admin yet. Once it is deployed, the claim ' +
					`makes ${claimantLabel(authority.claimant)} its admin, and the ` +
					'claim cannot be undone. For the claim, the deploy sets a ' +
					`one-time secret, ${claimSecretName}, on the control Worker and ` +
					'removes it afterwards.'
			);

			if (!(await world.confirmClaim(authority.claimant))) {
				return { kind: 'declined' };
			}

			break;
		}
		case 'unclaimed': {
			ui.warn(
				'This deployment has no admin, and this run has no terminal to log ' +
					'in from. It will be deployed without an admin.'
			);
			break;
		}
	}

	return authority;
}

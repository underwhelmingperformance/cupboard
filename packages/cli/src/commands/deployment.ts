import {
	hasReachedTransitionState,
	type LocalStepStatus,
	type ParsedDeploymentTransitionsResponse,
	type StoredTransitionRow,
	transitionIds
} from '@cupboard/protocol/deployment';
import { type AuthorizationDetails } from '@cupboard/protocol/grants';
import {
	formatTimestamp,
	type Reporter,
	type ResultRow
} from '@cupboard/reporter';
import { type Command } from 'commander';

import { type Audience, audienceSchema, parseAudience } from '../audience.ts';
import { cachedOwnerProvider, githubOidcTokenProvider } from '../auth/auth.ts';
import { commandUi, type ProgramOptions } from '../cli.ts';
import { CupboardClient } from '../client/client.ts';
import { controlRpc } from '../client/orpc.ts';
import { parseWorkerUrl } from '../client/transport.ts';
import { readStoredTransition } from '../deploy/deployment-state.ts';
import {
	pendingText,
	stalledTenantText,
	unwokenTenantText
} from '../deploy/local-step-samples.ts';
import {
	type SettlementClient,
	type SettlementOptions,
	settleTenants
} from '../deploy/settlement.ts';
import { deploymentUrlArgument } from '../url-argument.ts';

export interface DeploymentClient {
	transitions(): Promise<ParsedDeploymentTransitionsResponse>;
	readonly localStep: SettlementClient;
}

export type DeploymentResumeOptions = SettlementOptions;

interface DeploymentAuthOptions {
	readonly githubOidc?: boolean;
	readonly audience?: Audience;
}

interface DeploymentStatusOptions {
	readonly details?: boolean;
}

const requiredTransitionIds = new Set(transitionIds);

function tenantSummary(status: LocalStepStatus): string {
	return [
		`${String(status.ready)} ready`,
		...(status.working > 0 ? [`${String(status.working)} migrating`] : []),
		...(status.stalled > 0 ? [`${String(status.stalled)} need attention`] : []),
		...(status.unwoken > 0
			? [`${String(status.unwoken)} waiting to start`]
			: [])
	].join(', ');
}

function readinessRows(
	status: LocalStepStatus,
	transitions: ParsedDeploymentTransitionsResponse
): ResultRow[] {
	const isIncompatible = transitions.unrecognised.some(
		(row) => readStoredTransition(transitionIds, row).kind === 'refused'
	);

	const completed = new Set(
		transitions.transitions
			.values()
			.filter((transition) => transition.state === 'complete')
			.map((transition) => transition.id)
	);

	const isIncomplete = !completed.isSupersetOf(requiredTransitionIds);

	let readiness = 'Ready';
	let next: string | undefined;

	if (status.pending > 0) {
		readiness =
			status.working > 0 ? 'Updating tenants' : 'Waiting for tenant updates';
		next =
			'Use deployment resume with this deployment URL to wake pending tenants and wait for completion.';
	}

	if (status.stalled > 0) {
		readiness = 'Tenant updates need attention';
		next =
			'Check the tenant errors below, then use deployment resume to retry.';
	}

	if (isIncomplete) {
		readiness = 'Deployment incomplete';
		next =
			'Re-run cupboard init with the same release and source to finish the deployment.';
	}

	if (isIncompatible) {
		readiness = 'CLI upgrade required';
		next =
			'Use a CLI release compatible with this deployment before deploying again.';
	}

	return [
		{ label: 'Deployment', value: readiness },
		{ label: 'Tenants', value: tenantSummary(status) },
		...(next === undefined ? [] : [{ label: 'Next step', value: next }])
	];
}

// What this build's `cupboard deploy` does with a row that the server lists
// under `unrecognised`.
function unrecognisedRowText(row: StoredTransitionRow): string {
	const since = `${row.state} since ${formatTimestamp(row.updatedAt)}`;
	const reading = readStoredTransition(transitionIds, row);

	if (reading.kind === 'unrecognised') {
		return `${since}; this build does not define this transition, and no contract migration of it has started, so cupboard deploy leaves it unchanged`;
	}

	if (reading.kind === 'refused' && reading.reason === 'contracted') {
		return `${since}; this build does not define this transition, and cupboard deploy stops because its contract migrations have started and may have removed schema that this build needs`;
	}

	if (reading.kind === 'refused' && reading.reason === 'unknown-state') {
		return `${since}; this build defines the transition but not state '${row.state}', so cupboard deploy stops; deploy a build that defines that state`;
	}

	return `${since}; this build defines neither the transition nor the state, so cupboard deploy stops; deploy a build that defines both`;
}

function unrecognisedRows(
	unrecognised: readonly StoredTransitionRow[]
): { label: string; value: string }[] {
	return unrecognised.map((row) => ({
		label: `Transition ${row.id}`,
		value: unrecognisedRowText(row)
	}));
}

function sampleRows(status: LocalStepStatus, isDetailed = false): ResultRow[] {
	const workingSample = status.workingSample ?? [];
	const sampled =
		workingSample.length +
		status.stalledSample.length +
		status.unwokenSample.length;

	return [
		...workingSample.map((tenant) => {
			const progress =
				tenant.progressedAt === undefined
					? 'started'
					: `last progress ${formatTimestamp(tenant.progressedAt)}`;

			const migration =
				isDetailed && tenant.migration !== undefined
					? `; ${tenant.migration.migration}, ${tenant.migration.stage}, cursor ${String(tenant.migration.cursor)}`
					: '';

			return {
				label: 'Migrating',
				value: `${tenant.tenant}: ${progress}${migration}`
			};
		}),
		...status.stalledSample.map((tenant) => ({
			label: isDetailed ? 'Stalled' : 'Needs attention',
			value: stalledTenantText(tenant)
		})),
		...status.unwokenSample.map((tenant) => ({
			label: isDetailed ? 'Not yet woken' : 'Waiting to start',
			value: unwokenTenantText(tenant)
		})),
		...(status.pending > sampled
			? [
					{
						label: 'Not listed',
						value: `${String(status.pending - sampled)} more pending tenants`
					}
				]
			: [])
	];
}

/**
 * Shows deployment readiness, tenant migration progress and the next operator
 * action. Detailed output includes schema transitions and migration identifiers.
 */
export async function runDeploymentStatus(
	reporter: Reporter,
	client: DeploymentClient,
	options: DeploymentStatusOptions = {}
): Promise<void> {
	const { transitions, unrecognised } = await client.transitions();
	const status = await client.localStep.status();
	const transitionRows =
		transitions.length === 0 && unrecognised.length === 0
			? [{ label: 'Transitions', value: 'none recorded' }]
			: transitions.map((transition) => ({
					label: `Transition ${transition.id}`,
					value: `${transition.state} since ${formatTimestamp(transition.updatedAt)}`
				}));
	reporter.result({
		kind: 'deployment-status',
		data: { transitions, unrecognised, ...status },
		rows: [
			...(options.details === true
				? [
						...transitionRows,
						...unrecognisedRows(unrecognised),
						{ label: 'Required local step', value: String(status.required) },
						{ label: 'Ready tenants', value: String(status.ready) },
						{ label: 'Pending tenants', value: pendingText(status) }
					]
				: readinessRows(status, { transitions, unrecognised })),
			...sampleRows(status, options.details)
		]
	});
}

/**
 * Wakes the pending tenants and waits until each has recorded the required
 * local step, as the deploy does, then reports whether a schema transition is
 * still incomplete and needs another `cupboard init`. A recorded row that this
 * build does not define is listed with what this build's deploy does with it,
 * and is left out of the transitions to complete.
 */
export async function runDeploymentResume(
	reporter: Reporter,
	client: DeploymentClient,
	options: DeploymentResumeOptions
): Promise<void> {
	const status = await settleTenants(client.localStep, reporter, options);
	const { transitions, unrecognised } = await client.transitions();
	reporter.result({
		kind: 'deployment-readiness',
		data: status,
		rows: [
			{ label: 'Ready tenants', value: String(status.ready) },
			{ label: 'Required local step', value: String(status.required) },
			...unrecognisedRows(unrecognised)
		]
	});
	const refused = unrecognised
		.filter(
			(row) => readStoredTransition(transitionIds, row).kind === 'refused'
		)
		.map((row) => row.id);
	const reached = `Every active or suspended tenant has reached local step ${String(status.required)}.`;

	if (refused.length > 0) {
		reporter.info(
			`${reached} This build's cupboard deploy stops on ${refused.join(', ')}, as listed above.`
		);
		return;
	}

	const recorded = new Map(
		transitions.map((transition) => [transition.id, transition.state])
	);
	const incomplete = transitionIds.filter(
		(id) => !hasReachedTransitionState(recorded.get(id), 'complete')
	);

	reporter.info(
		incomplete.length === 0
			? `Every active or suspended tenant has reached local step ${String(status.required)}, and every schema transition is complete.`
			: `${reached} Re-run cupboard deploy to complete ${incomplete.join(', ')}.`
	);
}

export function registerDeploymentCommands(
	program: Command,
	options: ProgramOptions = {}
): void {
	const deployment = program
		.command('deployment')
		.description('Inspect and resume tenant migration work.');
	const client = (
		url: URL,
		cliOptions: DeploymentAuthOptions,
		authorizationDetails: AuthorizationDetails
	): DeploymentClient => {
		const credential =
			cliOptions.githubOidc === true
				? githubOidcTokenProvider(
						CupboardClient.fromUrl(url, {
							cache: { kind: 'default' },
							signal: options.signal
						}),
						cliOptions.audience ?? audienceSchema.parse(url),
						authorizationDetails
					)
				: cachedOwnerProvider(url, { signal: options.signal });
		const rpc = controlRpc(url, {
			credential,
			signal: options.signal
		});

		return {
			transitions: () => rpc.deployment.transitions(),
			localStep: rpc.localStep
		};
	};
	deployment
		.command('status')
		.description('Show deployment readiness and tenant migration progress.')
		.option('--details', 'Show schema transitions and migration identifiers.')
		.argument('<url>', deploymentUrlArgument, parseWorkerUrl)
		.option(
			'--github-oidc',
			"authorise with the workflow's GitHub Actions OIDC token through a control trust rule"
		)
		.option(
			'--audience <audience>',
			'OIDC audience to request with --github-oidc (default: the deployment URL)',
			parseAudience
		)
		.action(
			async (
				url: URL,
				cliOptions: DeploymentAuthOptions & DeploymentStatusOptions
			) => {
				await runDeploymentStatus(
					commandUi(program, options).reporter(),
					client(url, cliOptions, [
						{
							type: 'cupboard_control',
							actions: ['deployment:read', 'local-step:read']
						}
					]),
					cliOptions
				);
			}
		);
	deployment
		.command('resume')
		.description(
			'Wake the tenants that are still migrating, wait while they finish, and ' +
				'report whether the deploy can finish.'
		)
		.argument('<url>', deploymentUrlArgument, parseWorkerUrl)
		.option(
			'--github-oidc',
			"authorise with the workflow's GitHub Actions OIDC token through a control trust rule"
		)
		.option(
			'--audience <audience>',
			'OIDC audience to request with --github-oidc (default: the deployment URL)',
			parseAudience
		)
		.action(async (url: URL, cliOptions: DeploymentAuthOptions) => {
			await runDeploymentResume(
				commandUi(program, options).reporter(),
				client(url, cliOptions, [
					{
						type: 'cupboard_control',
						actions: ['deployment:read', 'local-step:read', 'local-step:wake']
					}
				]),
				{
					...(options.signal !== undefined && { signal: options.signal })
				}
			);
		});
}

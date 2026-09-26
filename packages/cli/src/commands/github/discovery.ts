import { Buffer } from 'node:buffer';

import { parseTenantCacheUrl } from '@cupboard/nix-store/cache-url';
import { canonicalHref } from '@cupboard/nix-store/url';
import { StatusCodes } from 'http-status-codes';
import { parseDocument } from 'yaml';
import { z } from 'zod';

import { abortReason } from '../../abort.ts';
import {
	CliError,
	WorkflowReferenceExactRequiredError,
	WorkflowReferenceMalformedError,
	WorkflowReferenceMutableError,
	WorkflowReferenceTagPatternError,
	WorkflowReferenceUnpinnedError
} from '../../errors.ts';
import {
	githubApi,
	GithubPermissionError,
	GithubRateLimitError,
	isGithubRateLimitResponse,
	isGithubResponseStatus,
	type LookupRepositoryOptions
} from '../oidc-trust/github.ts';

import { parseExactWorkflowReference } from './convention.ts';
import { jobConditionOutcome } from './job-condition.ts';

type WorkflowInput = string | number | boolean;
type WorkflowInputs = Readonly<Record<string, WorkflowInput>>;

export interface WorkflowSource {
	resolveBranch(repository: string, branch: string): Promise<string>;
	list(repository: string, reference: string): Promise<readonly string[]>;
	read(repository: string, path: string, reference: string): Promise<string>;
}

export const referenceFilterKeys = [
	'branches',
	'branches-ignore',
	'tags',
	'tags-ignore'
] as const;
export type ReferenceFilterKey = (typeof referenceFilterKeys)[number];

export interface WorkflowTrigger {
	readonly event: string;
	readonly filters: Readonly<
		Partial<Record<ReferenceFilterKey, readonly string[]>>
	>;
	readonly hasPathFilter: boolean;
	/**
	 * The job's `if` conditions. They are set only when the check cannot
	 * evaluate whether they allow the job to run for this event.
	 */
	readonly undecidedConditions?: readonly string[];
	/**
	 * Set for a `pull_request` trigger when the job's conditions exclude pull
	 * requests from forks.
	 */
	readonly isSameRepositoryOnly?: boolean;
}

export interface DiscoveredPublishingJob {
	readonly caller: string;
	readonly job: string;
	readonly kind: 'flake' | 'installable';
	readonly workflowRef: string;
	readonly inputs: WorkflowInputs;
	readonly triggers: readonly WorkflowTrigger[];
}

export interface UnverifiedPublishingJob {
	readonly caller: string;
	readonly job: string;
	readonly workflowRef?: string;
	readonly detail: string;
}

export interface WorkflowDiscovery {
	readonly revision: string;
	readonly jobs: readonly DiscoveredPublishingJob[];
	readonly unverified: readonly UnverifiedPublishingJob[];
}

export class WorkflowDiscoveryError extends CliError {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = 'WorkflowDiscoveryError';
	}
}

export class WorkflowParseError extends WorkflowDiscoveryError {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = 'WorkflowParseError';
	}
}

export class WorkflowBranchNotFoundError extends WorkflowDiscoveryError {
	constructor(
		public readonly repository: string,
		public readonly branch: string
	) {
		super(`GitHub repository ${repository} has no branch ${branch}.`);
		this.name = 'WorkflowBranchNotFoundError';
	}
}

const inputSchema = z.union([z.string(), z.number(), z.boolean()]);
const mappingSchema = z.record(z.string(), z.unknown());

// GitHub accepts one pattern or a list. A value of another shape becomes a
// pattern that the check reports as unsupported.
const patternsSchema = z
	.unknown()
	.transform((value): readonly string[] =>
		(Array.isArray(value) ? value : [value]).map((pattern: unknown) =>
			typeof pattern === 'string' ? pattern : JSON.stringify(pattern)
		)
	);

const inputDeclarationSchema = z
	.looseObject({ default: inputSchema.optional().catch(undefined) })
	.catch({});
const inputDeclarationsSchema = z
	.record(z.string(), inputDeclarationSchema)
	.optional()
	.catch(undefined);

const eventSchema = z.looseObject({
	branches: patternsSchema.optional(),
	'branches-ignore': patternsSchema.optional(),
	tags: patternsSchema.optional(),
	'tags-ignore': patternsSchema.optional(),
	paths: z.unknown().optional(),
	'paths-ignore': z.unknown().optional(),
	inputs: inputDeclarationsSchema
});
// An event without configuration, such as `pull_request:`, parses as null.
const eventConfigurationSchema = eventSchema.optional().catch(undefined);
const eventsSchema = z.record(z.string(), eventConfigurationSchema);

const stepSchema = z.looseObject({
	uses: z.string().optional().catch(undefined),
	run: z.string().optional().catch(undefined),
	with: mappingSchema.optional().catch(undefined)
});
const stepsSchema = z.array(stepSchema.catch({})).optional().catch(undefined);

const jobSchema = z.looseObject({
	if: z.union([z.string(), z.boolean()]).optional().catch(undefined),
	uses: z.string().optional().catch(undefined),
	with: mappingSchema.optional().catch(undefined),
	steps: stepsSchema
});
const jobsSchema = z
	.record(z.string(), jobSchema.catch({}))
	.optional()
	.catch(undefined);

const eventListSchema = z.array(z.unknown());
const onSchema = z
	.union([z.string(), eventListSchema, eventsSchema])
	.optional()
	.catch(undefined);

const workflowSchema = z.looseObject({ on: onSchema, jobs: jobsSchema });

const actionSchema = z.looseObject({
	runs: z
		.looseObject({
			using: z.string().optional().catch(undefined),
			steps: stepsSchema
		})
		.optional()
		.catch(undefined)
});

type Workflow = z.output<typeof workflowSchema>;
type WorkflowJob = z.output<typeof jobSchema>;
type WorkflowStep = z.output<typeof stepSchema>;
type LocalAction = z.output<typeof actionSchema>;

function yamlFile<T>(
	content: string,
	path: string,
	schema: z.ZodType<T>,
	description: string
): T {
	const parsed = parseDocument(content, { uniqueKeys: true });

	if (parsed.errors.length > 0) {
		throw new WorkflowParseError(
			`Cannot parse ${path}: ${parsed.errors[0]?.message ?? 'invalid YAML'}`,
			{
				cause: parsed.errors[0]
			}
		);
	}

	const file = schema.safeParse(parsed.toJS());

	if (!file.success) {
		throw new WorkflowParseError(`${path} must contain ${description}`, {
			cause: file.error
		});
	}

	return file.data;
}

function workflowTriggers(on: Workflow['on']): WorkflowTrigger[] {
	if (typeof on === 'string') {
		return [{ event: on, filters: {}, hasPathFilter: false }];
	}

	if (Array.isArray(on)) {
		return on
			.filter((entry): entry is string => typeof entry === 'string')
			.map((event) => ({ event, filters: {}, hasPathFilter: false }));
	}

	return Object.entries(on ?? {}).map(([event, configuration]) => ({
		event,
		filters: Object.fromEntries(
			referenceFilterKeys.flatMap((key) => {
				const patterns = configuration?.[key];

				return patterns === undefined ? [] : [[key, patterns]];
			})
		),
		hasPathFilter:
			configuration?.paths !== undefined ||
			configuration?.['paths-ignore'] !== undefined
	}));
}

function inputDefaults(workflow: Workflow): WorkflowInputs {
	const on = workflow.on;
	const declarations =
		typeof on === 'object' && !Array.isArray(on)
			? on.workflow_call?.inputs
			: undefined;

	return Object.fromEntries(
		Object.entries(declarations ?? {}).flatMap(([key, declaration]) =>
			declaration.default === undefined ? [] : [[key, declaration.default]]
		)
	);
}

const passThrough = /^\$\{\{\s*inputs\.([A-Za-z0-9_-]+)\s*\}\}$/;

function resolveInputs(
	values: WorkflowJob['with'],
	parent: WorkflowInputs
): WorkflowInputs {
	return Object.fromEntries(
		Object.entries(values ?? {}).flatMap(([key, entry]) => {
			const value = inputSchema.safeParse(entry);

			if (!value.success) {
				return [];
			}

			if (typeof value.data === 'string') {
				const parameter = passThrough.exec(value.data)?.[1];

				if (parameter !== undefined && parent[parameter] !== undefined) {
					return [[key, parent[parameter]]];
				}
			}

			return [[key, value.data]];
		})
	);
}

function calledWorkflow(
	uses: string,
	repository: string,
	branch: string,
	revision: string,
	currentReference: string
): { path: string; ref: string } | undefined {
	if (uses.startsWith('./.github/workflows/')) {
		return { path: uses.slice(2), ref: currentReference };
	}

	const prefix = `${repository}/`;

	if (!uses.toLowerCase().startsWith(prefix.toLowerCase())) {
		return;
	}

	const at = uses.lastIndexOf('@');

	if (at === -1) {
		return;
	}

	const reference = uses.slice(at + 1);

	return {
		path: uses.slice(prefix.length, at),
		ref: reference === branch ? revision : reference
	};
}

const cupboardWorkflowPrefix =
	'underwhelmingperformance/cupboard/.github/workflows/';
const publishingActions = new Set([
	'push',
	'attest',
	'attest-attach',
	'build-cohort',
	'plan',
	'setup'
]);
const cupboardAction =
	/^underwhelmingperformance\/cupboard\/actions\/([^@/]+)@/u;
// The CLI commands that accept --github-oidc and change the tenant. A call
// through a variable, such as "${CUPBOARD_PATH}" cache remove, has no
// `cupboard` word, so the check also looks for the flag itself.
const publishingCommand =
	/\bcupboard\s+(?:push|build-push|attest\s+attach|plan\s+cohort|cache\s+(?:create|remove)|root\s+ensure|confirm)\b|--github-oidc\b/u;

function publicationKind(
	uses: string
): DiscoveredPublishingJob['kind'] | undefined {
	const reference = uses.toLowerCase();

	if (
		reference.startsWith(`${cupboardWorkflowPrefix}cupboard-flake-publish.yml@`)
	) {
		return 'flake';
	}

	if (reference.startsWith(`${cupboardWorkflowPrefix}cupboard-publish.yml@`)) {
		return 'installable';
	}
}

/**
 * The directory of a local action, such as `.github/actions/publish` for
 * `uses: ./.github/actions/publish`. GitHub resolves the path from the root of
 * the repository.
 */
function localActionDirectory(uses: string | undefined): string | undefined {
	if (uses?.startsWith('./') !== true) {
		return undefined;
	}

	return uses.slice(2).replace(/\/+$/u, '');
}

function isDirectPublicationStep(step: WorkflowStep, tenant: URL): boolean {
	const action =
		step.uses === undefined
			? undefined
			: cupboardAction.exec(step.uses.toLowerCase())?.[1];

	if (action !== undefined && publishingActions.has(action)) {
		const isSetup = action === 'setup';
		const url = step.with?.[isSetup ? 'cache-url' : 'url'];

		if (isSetup && url === undefined) {
			return false;
		}

		return (
			typeof url !== 'string' ||
			url.includes('${{') ||
			isTargetTenant(url, tenant)
		);
	}

	const run = step.run;

	if (run === undefined || !publishingCommand.test(run)) {
		return false;
	}

	const urls = run.match(/https?:\/\/[^\s"'`]+/gu) ?? [];

	return (
		run.includes('$') ||
		urls.length === 0 ||
		urls.some((url) => isTargetTenant(url, tenant))
	);
}

/**
 * The reference to verify for a Cupboard workflow pin. A caller can write a
 * tag with or without `refs/tags/`. A `refs/heads/` pin is returned as
 * written, so the pin check fails it as a branch pin.
 */
function pinnedReference(uses: string): string | undefined {
	const at = uses.lastIndexOf('@');
	const pin = uses.slice(at + 1);
	const reference =
		pin.startsWith('refs/') || /^[0-9a-f]{40}$/.test(pin)
			? uses
			: `${uses.slice(0, at + 1)}refs/tags/${pin}`;

	try {
		return parseExactWorkflowReference(reference).reference;
	} catch (error) {
		if (
			error instanceof WorkflowReferenceMutableError &&
			pin.startsWith('refs/heads/')
		) {
			return reference;
		}

		if (
			error instanceof WorkflowReferenceExactRequiredError ||
			error instanceof WorkflowReferenceMalformedError ||
			error instanceof WorkflowReferenceMutableError ||
			error instanceof WorkflowReferenceTagPatternError ||
			error instanceof WorkflowReferenceUnpinnedError
		) {
			return;
		}

		throw error;
	}
}

function isTargetTenant(value: string, tenant: URL): boolean {
	try {
		return parseTenantCacheUrl(new URL(value)).tenantUrl.href === tenant.href;
	} catch {
		return false;
	}
}

function isExternalPublication(inputs: WorkflowInputs, tenant: URL): boolean {
	return Object.entries(inputs).some(
		([input, value]) =>
			typeof value === 'string' &&
			(isTargetTenant(value, tenant) ||
				(value.includes('${{') &&
					(input === 'url' ||
						input.endsWith('-url') ||
						/\b(?:secrets|vars)\./u.test(value))))
	);
}

/**
 * The triggers for which the job's `if` conditions may allow it to run. A
 * trigger that a condition excludes is dropped. When the check cannot evaluate
 * the conditions for a trigger, it keeps the trigger and records the
 * conditions so that the check can report them.
 */
function conditionedTriggers(
	triggers: readonly WorkflowTrigger[],
	conditions: readonly (string | boolean)[]
): WorkflowTrigger[] {
	return triggers.flatMap((trigger) => {
		const outcomes = conditions.map((condition) =>
			jobConditionOutcome(condition, trigger.event)
		);

		if (outcomes.includes(false)) {
			return [];
		}

		const isSameRepositoryOnly =
			trigger.event === 'pull_request' &&
			conditions.some(
				(condition) =>
					jobConditionOutcome(condition, trigger.event, 'fork') === false
			);
		const conditioned = isSameRepositoryOnly
			? { ...trigger, isSameRepositoryOnly }
			: trigger;

		if (outcomes.every((outcome) => outcome === true)) {
			return [conditioned];
		}

		return [
			{
				...conditioned,
				undecidedConditions: conditions.map(String)
			}
		];
	});
}

interface VisitContext {
	readonly caller: string;
	readonly callerLabel?: string;
	readonly path: string;
	readonly reference: string;
	readonly inputs: WorkflowInputs;
	readonly triggers: readonly WorkflowTrigger[];
	readonly conditions: readonly (string | boolean)[];
	readonly ancestors: ReadonlySet<string>;
}

export async function discoverPublishingJobs(
	repository: string,
	branch: string,
	tenant: URL,
	source: WorkflowSource
): Promise<WorkflowDiscovery> {
	const revision = await source.resolveBranch(repository, branch);
	const jobs: DiscoveredPublishingJob[] = [];
	const unverified: UnverifiedPublishingJob[] = [];
	const files = await source.list(repository, revision);
	const workflows = new Map<string, Promise<Workflow>>();
	const actions = new Map<string, Promise<LocalAction>>();

	function readWorkflow(path: string, reference: string): Promise<Workflow> {
		const location = `${path}@${reference}`;
		const cached = workflows.get(location);

		if (cached !== undefined) {
			return cached;
		}

		const workflow = (async () => {
			const content = await source.read(repository, path, reference);

			return yamlFile(content, path, workflowSchema, 'a workflow object');
		})();
		workflows.set(location, workflow);

		return workflow;
	}

	function readAction(
		directory: string,
		reference: string
	): Promise<LocalAction> {
		const location = `${directory}@${reference}`;
		const cached = actions.get(location);

		if (cached !== undefined) {
			return cached;
		}

		const prefix = directory === '' ? '' : `${directory}/`;
		const action = (async () => {
			let path = `${prefix}action.yml`;
			let content: string;

			try {
				content = await source.read(repository, path, reference);
			} catch (error) {
				if (!(error instanceof WorkflowDiscoveryError)) {
					throw error;
				}

				path = `${prefix}action.yaml`;
				content = await source.read(repository, path, reference);
			}

			return yamlFile(content, path, actionSchema, 'an action object');
		})();
		actions.set(location, action);

		return action;
	}

	/**
	 * Why a job's steps publish directly, or `undefined` when they do not. The
	 * check also reads the steps of each local composite action that a step
	 * uses.
	 */
	async function directPublication(
		steps: readonly WorkflowStep[],
		reference: string,
		through: readonly string[]
	): Promise<string | undefined> {
		for (const step of steps) {
			if (isDirectPublicationStep(step, tenant)) {
				const [outer] = through;

				return outer === undefined
					? 'this job calls a Cupboard action or CLI command directly; inspect its tenant, grant and root inputs'
					: `this job calls a Cupboard action or CLI command through the local action ./${outer}; inspect its tenant, grant and root inputs`;
			}

			const directory = localActionDirectory(step.uses);

			if (directory === undefined || through.includes(directory)) {
				continue;
			}

			let action: LocalAction;

			try {
				action = await readAction(directory, reference);
			} catch (error) {
				if (!(error instanceof WorkflowDiscoveryError)) {
					throw error;
				}

				return `the check cannot read the local action ./${directory}: ${error.message}`;
			}

			if (action.runs?.using !== 'composite') {
				continue;
			}

			const detail = await directPublication(
				action.runs.steps ?? [],
				reference,
				[...through, directory]
			);

			if (detail !== undefined) {
				return detail;
			}
		}

		return undefined;
	}

	async function visit(context: VisitContext): Promise<void> {
		const { caller, callerLabel, path, reference } = context;
		const location = `${path}@${reference}`;

		if (context.ancestors.has(location)) {
			unverified.push({
				caller,
				job: callerLabel ?? 'workflow',
				detail: `reusable workflow calls form a cycle at ${location}`
			});
			return;
		}

		let workflow: Workflow;

		try {
			workflow = await readWorkflow(path, reference);
		} catch (error) {
			if (!(error instanceof WorkflowDiscoveryError)) {
				throw error;
			}

			unverified.push({
				caller,
				job: callerLabel ?? 'workflow',
				detail: error.message
			});
			return;
		}

		// A workflow's own inputs exist only when another workflow calls it.
		const effectiveInputs =
			callerLabel === undefined
				? context.inputs
				: { ...inputDefaults(workflow), ...context.inputs };
		const ancestors = new Set([...context.ancestors, location]);

		const workflowJobs = Object.entries(workflow.jobs ?? {});

		for (const [jobId, job] of workflowJobs) {
			const label =
				callerLabel === undefined
					? jobId
					: `${callerLabel} (${path.slice(path.lastIndexOf('/') + 1)}: ${jobId})`;
			const conditions =
				job.if === undefined
					? context.conditions
					: [...context.conditions, job.if];
			const triggers = conditionedTriggers(context.triggers, conditions);

			if (triggers.length === 0) {
				continue;
			}

			const direct = await directPublication(job.steps ?? [], reference, []);

			if (direct !== undefined) {
				unverified.push({ caller, job: label, detail: direct });
			}

			const uses = job.uses;

			if (uses === undefined) {
				continue;
			}

			const supplied = resolveInputs(job.with, effectiveInputs);
			const kind = publicationKind(uses);
			const nested =
				kind === undefined
					? calledWorkflow(uses, repository, branch, revision, reference)
					: undefined;

			if (nested !== undefined) {
				await visit({
					caller,
					callerLabel: label,
					path: nested.path,
					reference: nested.ref,
					inputs: supplied,
					triggers,
					conditions,
					ancestors
				});
				continue;
			}

			if (kind === undefined) {
				if (
					uses.includes('/.github/workflows/') &&
					isExternalPublication(supplied, tenant)
				) {
					unverified.push({
						caller,
						job: label,
						detail: `${uses} is an external reusable workflow; the check cannot inspect its publication steps`
					});
				}

				continue;
			}

			const pin = uses.slice(uses.lastIndexOf('@') + 1);
			const workflowPath =
				kind === 'flake'
					? 'cupboard-flake-publish.yml'
					: 'cupboard-publish.yml';
			const workflowReference = pinnedReference(
				`${cupboardWorkflowPrefix}${workflowPath}@${pin}`
			);
			const target = supplied.url;

			if (typeof target !== 'string' || target.includes('${{')) {
				unverified.push({
					caller,
					job: label,
					...(workflowReference !== undefined && {
						workflowRef: workflowReference
					}),
					detail: `with.url is missing or uses an expression, so the check cannot determine whether this job targets ${canonicalHref(tenant)}`
				});
				continue;
			}

			if (
				!isTargetTenant(target, tenant) ||
				(kind === 'flake' && supplied.push === false)
			) {
				continue;
			}

			if (kind === 'flake' && typeof supplied.push === 'string') {
				unverified.push({
					caller,
					job: label,
					...(workflowReference !== undefined && {
						workflowRef: workflowReference
					}),
					detail:
						'the push input is dynamic, so the check cannot determine whether this job publishes'
				});
				continue;
			}

			if (workflowReference === undefined) {
				unverified.push({
					caller,
					job: label,
					detail: `${uses} does not use an exact release tag or full commit ID`
				});
				continue;
			}

			jobs.push({
				caller,
				job: label,
				kind,
				workflowRef: workflowReference,
				inputs: supplied,
				triggers
			});
		}
	}

	const sortedFiles = files.toSorted((left, right) =>
		left.localeCompare(right)
	);

	for (const path of sortedFiles) {
		if (!/^\.github\/workflows\/[^/]+\.ya?ml$/.test(path)) {
			continue;
		}

		let workflow: Workflow;

		try {
			workflow = await readWorkflow(path, revision);
		} catch (error) {
			if (!(error instanceof WorkflowDiscoveryError)) {
				throw error;
			}

			unverified.push({ caller: path, job: 'workflow', detail: error.message });
			continue;
		}

		const triggers = workflowTriggers(workflow.on).filter(
			(trigger) => trigger.event !== 'workflow_call'
		);

		if (triggers.length === 0) {
			continue;
		}

		await visit({
			caller: path,
			path,
			reference: revision,
			inputs: {},
			triggers,
			conditions: [],
			ancestors: new Set()
		});
	}

	return { revision, jobs, unverified };
}

function repositoryParts(repository: string): { owner: string; repo: string } {
	const [owner, repo] = repository.split('/', 2);

	if (owner === undefined || repo === undefined) {
		throw new WorkflowDiscoveryError(`Invalid GitHub repository ${repository}`);
	}

	return { owner, repo };
}

export function githubWorkflowSource(
	options: LookupRepositoryOptions = {}
): WorkflowSource {
	const octokit = githubApi(options);

	async function request<T>(
		resource: string,
		body: () => Promise<T>
	): Promise<T> {
		try {
			return await body();
		} catch (error) {
			if (options.signal?.aborted === true) {
				throw abortReason(options.signal);
			}

			if (isGithubRateLimitResponse(error)) {
				throw new GithubRateLimitError();
			}

			if (
				isGithubResponseStatus(error, StatusCodes.UNAUTHORIZED) ||
				isGithubResponseStatus(error, StatusCodes.FORBIDDEN)
			) {
				throw new GithubPermissionError(resource);
			}

			if (error instanceof WorkflowDiscoveryError) {
				throw error;
			}

			throw new WorkflowDiscoveryError(`Cannot read ${resource} from GitHub`, {
				cause: error
			});
		}
	}

	return {
		resolveBranch(repository, branch) {
			return request(`${repository} branch ${branch}`, async () => {
				try {
					// The branch head can change while a cached response is still
					// fresh.
					const response = await octokit.rest.repos.getBranch({
						...repositoryParts(repository),
						branch,
						headers: { 'cache-control': 'no-cache' }
					});

					return response.data.commit.sha;
				} catch (error) {
					if (isGithubResponseStatus(error, StatusCodes.NOT_FOUND)) {
						throw new WorkflowBranchNotFoundError(repository, branch);
					}

					throw error;
				}
			});
		},
		list(repository, reference) {
			return request(`${repository}/.github/workflows`, async () => {
				let response: Awaited<ReturnType<typeof octokit.rest.repos.getContent>>;

				try {
					response = await octokit.rest.repos.getContent({
						...repositoryParts(repository),
						path: '.github/workflows',
						ref: reference
					});
				} catch (error) {
					if (isGithubResponseStatus(error, StatusCodes.NOT_FOUND)) {
						return [];
					}

					throw error;
				}

				if (!Array.isArray(response.data)) {
					throw new WorkflowDiscoveryError(
						`${repository}/.github/workflows is not a directory`
					);
				}

				return response.data.map((file) => file.path);
			});
		},
		read(repository, path, reference) {
			return request(`${repository}/${path}@${reference}`, async () => {
				const response = await octokit.rest.repos.getContent({
					...repositoryParts(repository),
					path,
					ref: reference
				});

				if (
					Array.isArray(response.data) ||
					response.data.type !== 'file' ||
					response.data.encoding !== 'base64'
				) {
					throw new WorkflowDiscoveryError(
						`${repository}/${path}@${reference} is not a readable workflow file`
					);
				}

				return Buffer.from(response.data.content, 'base64').toString('utf8');
			});
		}
	};
}

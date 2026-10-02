import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { z } from 'zod';

import {
	type NixSystem,
	nixSystemRunners,
	nixSystemRunnerSchema
} from '../packages/nix/src/nix-systems.ts';

const flakeWorkflow = new URL(
	'../.github/workflows/cupboard-flake-publish.yml',
	import.meta.url
);
const publishWorkflow = new URL(
	'../.github/workflows/cupboard-publish.yml',
	import.meta.url
);
const releaseCacheWorkflow = new URL(
	'../.github/workflows/release-cache.yml',
	import.meta.url
);
const releaseWorkflow = new URL(
	'../.github/workflows/release.yml',
	import.meta.url
);
const cachePublishWorkflow = new URL(
	'../.github/workflows/cache-publish.yml',
	import.meta.url
);
const ciWorkflow = new URL('../.github/workflows/ci.yml', import.meta.url);
const prepareAction = new URL('../actions/prepare/action.yml', import.meta.url);
const legacyPublishCaller = new URL(
	'../tests/fixtures/github-actions/cupboard-publish-legacy-caller.yml',
	import.meta.url
);
const remoteStoreDockerfile = new URL(
	'../tests/fixtures/nix-ssh-store/Dockerfile',
	import.meta.url
);

const checkoutAction =
	'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1';
const nixInstaller =
	'nixbuild/nix-quick-install-action@9f63be77f412a248c9d9a65a4c82cf066cdf8f0c';
const nixClientVersion = '2.34.7';
const cloudGuardStep = 'Require GitHub Cloud workflow identity';
const reservationStep = 'Reserve the cupboard workflow checkout';
const workflowCheckoutPath = '.cupboard-workflow';
const sourceCheckoutDirectory = '${{ github.workspace }}/.cupboard-workflow';
const cupboardActionPrefix = '$/actions/';

const cupboardAction = (name: string) => `${cupboardActionPrefix}${name}`;

/**
 * The scalar forms GitHub accepts for a step input or an environment value.
 */
const scalarSchema = z.union([z.string(), z.boolean(), z.number()]);
const scalarMapSchema = z.record(z.string(), scalarSchema);

const stepSchema = z.looseObject({
	name: z.string().optional(),
	id: z.string().optional(),
	uses: z.string().optional(),
	if: z.string().optional(),
	run: z.string().optional(),
	env: scalarMapSchema.optional(),
	with: scalarMapSchema.optional()
});

const strategySchema = z.looseObject({
	'fail-fast': z.boolean().optional(),
	matrix: z.unknown()
});
const needsSchema = z.union([z.string(), z.array(z.string())]);
const permissionsSchema = z.record(z.string(), z.string());
const stepsSchema = z.array(stepSchema).default([]);

const jobSchema = z.looseObject({
	name: z.string().optional(),
	if: z.string().optional(),
	uses: z.string().optional(),
	needs: needsSchema.optional(),
	outputs: scalarMapSchema.optional(),
	steps: stepsSchema,
	strategy: strategySchema.optional(),
	permissions: permissionsSchema.optional(),
	with: scalarMapSchema.optional(),
	'continue-on-error': scalarSchema.optional()
});

const workflowInputSchema = z.looseObject({
	description: z.string(),
	required: z.boolean().optional(),
	default: scalarSchema.optional(),
	type: z.string().optional()
});

const secretSchema = z.looseObject({ description: z.string().optional() });
const workflowInputsSchema = z.record(z.string(), workflowInputSchema);
const secretsSchema = z.record(z.string(), secretSchema);
const workflowCallSchema = z.looseObject({
	inputs: workflowInputsSchema.default({}),
	secrets: secretsSchema.default({})
});
const triggersSchema = z.looseObject({
	workflow_call: workflowCallSchema.optional()
});
const jobsSchema = z.record(z.string(), jobSchema);

const workflowSchema = z.looseObject({
	name: z.string(),
	on: triggersSchema,
	jobs: jobsSchema
});

type Workflow = z.output<typeof workflowSchema>;
type Step = z.output<typeof stepSchema>;

const releaseCacheMatrixSchema = z.strictObject({
	include: z.array(nixSystemRunnerSchema)
});

const releaseAssetSchema = z.strictObject({
	'asset-platform': z.enum(['linux', 'macos']),
	'asset-arch': z.enum(['x64', 'arm64'])
});

const releaseBinaryBuildSchema = releaseAssetSchema.extend({
	runner: z.string()
});

const releaseBinaryMatrixSchema = z.strictObject({
	include: z.array(releaseBinaryBuildSchema)
});

const releaseAssetBySystem: Record<
	NixSystem,
	z.infer<typeof releaseAssetSchema>
> = {
	'x86_64-linux': { 'asset-platform': 'linux', 'asset-arch': 'x64' },
	'aarch64-linux': { 'asset-platform': 'linux', 'asset-arch': 'arm64' },
	'x86_64-darwin': { 'asset-platform': 'macos', 'asset-arch': 'x64' },
	'aarch64-darwin': { 'asset-platform': 'macos', 'asset-arch': 'arm64' }
};

async function loadWorkflow(file: URL): Promise<Workflow> {
	const document: unknown = parse(await readFile(file, 'utf8'));

	return workflowSchema.parse(document);
}

/**
 * Every step of every job, in document order, tagged with its job name.
 */
function allSteps(
	workflow: Workflow
): { job: string; index: number; step: Step }[] {
	return Object.entries(workflow.jobs).flatMap(([job, definition]) =>
		definition.steps.map((step, index) => ({ job, index, step }))
	);
}

function stepsUsing(workflow: Workflow, uses: string) {
	return allSteps(workflow).filter((entry) => entry.step.uses === uses);
}

function inputsOf(workflow: Workflow, uses: string) {
	return stepsUsing(workflow, uses).map((entry) => entry.step.with);
}

/**
 * The `run` body of one named step, which the tests read as shell source.
 */
function shellOf(workflow: Workflow, job: string, name: string): string {
	const step = workflow.jobs[job]?.steps.find(
		(candidate) => candidate.name === name
	);

	if (step?.run === undefined) {
		throw new Error(`${job} has no step named "${name}" that runs a script`);
	}

	return step.run;
}

function jobNeeds(workflow: Workflow, job: string): string[] {
	const needs = workflow.jobs[job]?.needs;

	if (needs === undefined) {
		return [];
	}

	return typeof needs === 'string' ? [needs] : needs;
}

const reusableWorkflows = [
	{ name: 'flake publish', file: flakeWorkflow, entryJob: 'configure' },
	{ name: 'publish', file: publishWorkflow, entryJob: 'publish' }
];

it('passes additional runner cache reads to setup in every flake build job', async () => {
	const workflow = await loadWorkflow(flakeWorkflow);
	expect({
		input: workflow.on.workflow_call?.inputs['read-caches']?.type,
		setups: stepsUsing(workflow, cupboardAction('setup')).map(
			({ job, step }) => ({ job, readCaches: step.with?.['read-caches'] })
		)
	}).toStrictEqual({
		input: 'string',
		setups: [
			{ job: 'plan', readCaches: '${{ inputs.read-caches }}' },
			{ job: 'cohort', readCaches: '${{ inputs.read-caches }}' },
			{ job: 'remove-cache', readCaches: undefined }
		]
	});
});

describe('workflow action references', () => {
	it.each(reusableWorkflows)(
		'resolves its own actions from the called revision in $name',
		async ({ file }) => {
			const workflow = await loadWorkflow(file);
			const uses = allSteps(workflow).flatMap(({ step }) =>
				step.uses === undefined ? [] : [step.uses]
			);

			expect({
				referencesItsOwnActions: uses.some((spec) =>
					spec.startsWith(cupboardActionPrefix)
				),
				// Earlier releases checked cupboard's actions out and referenced
				// them through the workspace.
				workspaceRelativeActions: uses.filter((spec) => spec.startsWith('./'))
			}).toStrictEqual({
				referencesItsOwnActions: true,
				workspaceRelativeActions: []
			});
		}
	);

	it.each(reusableWorkflows)(
		'checks its own source out only for a source acquisition in $name',
		async ({ file }) => {
			const workflow = await loadWorkflow(file);
			const checkouts = stepsUsing(workflow, checkoutAction);
			const callerCheckouts = checkouts.filter(
				({ step }) => step.with?.repository === undefined
			);
			const workflowSource = checkouts.filter(
				({ step }) => step.with?.repository !== undefined
			);
			// The source build is the checkout's one reader.
			const sourceGates = allSteps(workflow)
				.filter(({ step }) => step.uses === cupboardAction('setup'))
				.map(({ step }) => step.with?.['checkout-dir']);

			expect({
				workflowSource: workflowSource.map(({ step }) => step.with),
				callerCheckouts: callerCheckouts.map(({ step }) => step.with),
				sourceGates,
				reservedFirst: workflowSource.map(({ job, index }) => ({
					job,
					precedingStep: workflow.jobs[job]?.steps[index - 1]?.name
				}))
			}).toStrictEqual({
				workflowSource: workflowSource.map(() => ({
					repository: '${{ job.workflow_repository }}',
					ref: '${{ job.workflow_sha }}',
					path: workflowCheckoutPath,
					'persist-credentials': false
				})),
				callerCheckouts: callerCheckouts.map(() => ({
					'persist-credentials': false
				})),
				sourceGates: sourceGates.map(() => sourceCheckoutDirectory),
				reservedFirst: workflowSource.map(({ job }) => ({
					job,
					precedingStep: reservationStep
				}))
			});
		}
	);

	it.each(reusableWorkflows)(
		'gates the source checkout on the resolved coordinate in $name',
		async ({ file }) => {
			const workflow = await loadWorkflow(file);
			const gated = allSteps(workflow).filter(
				({ step }) =>
					step.name === reservationStep ||
					step.with?.path === workflowCheckoutPath
			);

			expect(
				gated.map(({ job, step }) => ({ job, gate: step.if }))
			).toStrictEqual(
				gated.map(({ job }) => ({
					job,
					// The coordinate comes from the resolver step in the job that runs
					// it, and from the configure job's output everywhere else.
					gate: workflow.jobs[job]?.steps.some(
						(step) => step.uses === cupboardAction('resolve-cupboard')
					)
						? "${{ fromJSON(steps.resolve-cupboard.outputs.cupboard).kind == 'source' }}"
						: "${{ fromJSON(needs.configure.outputs.cupboard).kind == 'source' }}"
				}))
			);
		}
	);

	it.each(reusableWorkflows)(
		'refuses to replace caller content at the checkout path in $name',
		async ({ file }) => {
			const workflow = await loadWorkflow(file);
			const guards = allSteps(workflow).filter(
				({ step }) => step.name === reservationStep
			);

			// The guard is an inline script, so its conditions are read as text.
			expect(
				guards.map(({ job, step }) => ({
					job,
					checksOrdinaryPaths: step.run?.includes(
						'[ -e "${CUPBOARD_WORKFLOW_CHECKOUT}" ]'
					),
					checksSymlinks: step.run?.includes(
						'[ -L "${CUPBOARD_WORKFLOW_CHECKOUT}" ]'
					),
					failsClosed: step.run?.includes('exit 1')
				}))
			).toStrictEqual(
				guards.map(({ job }) => ({
					job,
					checksOrdinaryPaths: true,
					checksSymlinks: true,
					failsClosed: true
				}))
			);
		}
	);

	it.each(reusableWorkflows)(
		'requires GitHub Cloud before any job reads the workflow identity in $name',
		async ({ file, entryJob }) => {
			const workflow = await loadWorkflow(file);
			const guards = allSteps(workflow).filter(
				({ step }) => step.name === cloudGuardStep
			);

			expect({
				guards: guards.map(({ job, index }) => ({ job, index })),
				// Every other job runs after the guarded one, so the guard covers the
				// identity fields those jobs read.
				laterJobsDependOnTheGuardedJob: Object.keys(workflow.jobs)
					.filter((job) => job !== entryJob)
					.map((job) => jobNeeds(workflow, job).includes(entryJob))
			}).toStrictEqual({
				guards: [{ job: entryJob, index: 0 }],
				laterJobsDependOnTheGuardedJob: Object.keys(workflow.jobs)
					.filter((job) => job !== entryJob)
					.map(() => true)
			});
		}
	);
});

describe('cupboard acquisition', () => {
	const resolverInputs = {
		'cupboard-version': '${{ inputs.cupboard-version }}',
		'workflow-repository': '${{ job.workflow_repository }}',
		'workflow-ref': '${{ job.workflow_ref }}',
		'workflow-sha': '${{ job.workflow_sha }}',
		'github-token': '${{ github.token }}',
		'github-api-url': '${{ github.api_url }}',
		'github-graphql-url': '${{ github.graphql_url }}'
	};

	it.each(reusableWorkflows)(
		'resolves one release coordinate from the called commit in $name',
		async ({ file }) => {
			const workflow = await loadWorkflow(file);

			expect(
				inputsOf(workflow, cupboardAction('resolve-cupboard'))
			).toStrictEqual([resolverInputs]);
		}
	);

	it.each(reusableWorkflows)(
		'leaves the release tag optional and undefaulted in $name',
		async ({ file }) => {
			const workflow = await loadWorkflow(file);
			const version = workflow.on.workflow_call?.inputs['cupboard-version'];

			expect({
				required: version?.required,
				default: version?.default,
				type: version?.type,
				// The workflow resolves a source commit itself; a caller never names one.
				sourceCommitInput:
					workflow.on.workflow_call?.inputs['cupboard-source-commit']
			}).toStrictEqual({
				required: false,
				default: undefined,
				type: 'string',
				sourceCommitInput: undefined
			});
		}
	);

	const provisionInputNames = new Set([
		'provision-cache',
		'cache-access-mode',
		'provision-cache-ttl'
	]);

	type StepInputs = Record<string, string | number | boolean> | undefined;

	function selectInputs(
		inputs: StepInputs,
		isKept: (name: string) => boolean
	): Record<string, string | number | boolean> {
		return Object.fromEntries(
			Object.entries(inputs ?? {}).filter(([name]) => isKept(name))
		);
	}

	it('gives every publishing flake job the coordinate configure resolved', async () => {
		const workflow = await loadWorkflow(flakeWorkflow);
		const publishingSetup = allSteps(workflow).filter(
			(entry) =>
				['plan', 'cohort'].includes(entry.job) &&
				entry.step.uses === cupboardAction('setup')
		);
		const setupInputs = publishingSetup.map(({ step }) =>
			selectInputs(step.with, (name) => !provisionInputNames.has(name))
		);

		expect({
			jobs: publishingSetup.map(({ job }) => job),
			callerCheckouts: allSteps(workflow)
				.filter(
					({ step }) =>
						step.uses?.startsWith('actions/checkout@') === true &&
						step.with?.repository === undefined
				)
				.map(({ job, step }) => ({ job, condition: step.if })),
			configureOutput: workflow.jobs.configure?.steps.find(
				(step) => step.uses === cupboardAction('resolve-cupboard')
			)?.id,
			setupInputs
		}).toStrictEqual({
			jobs: ['plan', 'cohort'],
			callerCheckouts: [
				{ job: 'plan', condition: undefined },
				{ job: 'cohort', condition: undefined }
			],
			configureOutput: 'resolve-cupboard',
			setupInputs: setupInputs.map(() => ({
				'read-caches': '${{ inputs.read-caches }}',
				'cache-url': '${{ inputs.url }}',
				audience: '${{ inputs.audience }}',
				cache: '${{ needs.configure.outputs.cache }}',
				cupboard: '${{ needs.configure.outputs.cupboard }}',
				'trusted-public-key': '${{ inputs.trusted-public-key }}',
				'destination-read-user': '${{ secrets.destination_read_user }}',
				'destination-read-password': '${{ secrets.destination_read_password }}',
				'read-user': '${{ secrets.read_user || secrets.fallback_read_user }}',
				'read-password':
					'${{ secrets.read_password || secrets.fallback_read_password }}',
				'private-substituters': '${{ secrets.private_substituters }}',
				'reuse-view': '${{ needs.configure.outputs.reuse-view }}',
				'checkout-dir': sourceCheckoutDirectory
			}))
		});
	});

	it('installs cupboard without a cache substituter for the removal job', async () => {
		const workflow = await loadWorkflow(flakeWorkflow);
		const removalSetup = (workflow.jobs['remove-cache']?.steps ?? []).filter(
			(step) => step.uses === cupboardAction('setup')
		);

		expect(removalSetup.map((step) => step.with)).toStrictEqual([
			{
				cupboard: '${{ needs.configure.outputs.cupboard }}',
				'checkout-dir': sourceCheckoutDirectory,
				audience: '${{ inputs.audience }}'
			}
		]);
	});

	it('prepares Nix before acquiring cupboard from source for removal', async () => {
		const workflow = await loadWorkflow(flakeWorkflow);
		const steps = workflow.jobs['remove-cache']?.steps ?? [];
		const prepareIndex = steps.findIndex(
			(step) => step.uses === cupboardAction('prepare')
		);
		const setupIndex = steps.findIndex(
			(step) => step.uses === cupboardAction('setup')
		);

		expect({
			preparation: steps.filter(
				(step) => step.uses === cupboardAction('prepare')
			),
			beforeAcquisition: prepareIndex !== -1 && prepareIndex < setupIndex
		}).toStrictEqual({
			preparation: [
				{
					uses: cupboardAction('prepare'),
					if: "${{ fromJSON(needs.configure.outputs.cupboard).kind == 'source' }}"
				}
			],
			beforeAcquisition: true
		});
	});

	it('creates the pull-request cache from the plan job alone', async () => {
		const workflow = await loadWorkflow(flakeWorkflow);
		const provisioning = inputsOf(workflow, cupboardAction('setup'))
			.map((inputs) =>
				selectInputs(inputs, (name) => provisionInputNames.has(name))
			)
			.filter((inputs) => inputs['provision-cache'] !== undefined);
		const accessModes = inputsOf(workflow, cupboardAction('setup'))
			.map((inputs) => inputs?.['cache-access-mode'])
			.filter((mode) => mode !== undefined);
		const policy = workflow.on.workflow_call?.inputs['cache-access-mode'];

		expect({
			configuredAccessMode:
				workflow.jobs.configure?.outputs?.['cache-access-mode'],
			accessBeforeWork: ['plan', 'cohort'].map((job) => {
				const steps = workflow.jobs[job]?.steps ?? [];
				const setup = steps.findIndex(
					(step) => step.uses === cupboardAction('setup')
				);
				const work = steps.findIndex(
					(step) =>
						step.name === 'Evaluate target manifest' ||
						step.uses === cupboardAction('build-cohort')
				);
				return { job, beforeWork: setup !== -1 && work > setup };
			}),
			policy: {
				required: policy?.required,
				default: policy?.default,
				type: policy?.type,
				description: typeof policy?.description
			},
			provisioning,
			accessModes
		}).toStrictEqual({
			configuredAccessMode: '${{ steps.resolve.outputs.cache-access-mode }}',
			accessBeforeWork: [
				{ job: 'plan', beforeWork: true },
				{ job: 'cohort', beforeWork: true }
			],
			policy: {
				required: false,
				default: '',
				type: 'string',
				description: 'string'
			},
			provisioning: [
				{
					'provision-cache': '${{ needs.configure.outputs.provision-cache }}',
					'cache-access-mode':
						'${{ needs.configure.outputs.cache-access-mode }}',
					'provision-cache-ttl':
						'${{ needs.configure.outputs.provision-cache-ttl }}'
				}
			],
			accessModes: [
				'${{ needs.configure.outputs.cache-access-mode }}',
				'${{ needs.configure.outputs.cache-access-mode }}'
			]
		});
	});

	it('passes the independent build and substituter choices to the simple build action', async () => {
		const workflow = await loadWorkflow(publishWorkflow);

		expect(inputsOf(workflow, cupboardAction('build-paths'))).toStrictEqual([
			{
				installables: '${{ inputs.installable }}',
				'inline-paths': false,
				'publication-url': '${{ inputs.url }}',
				build: '${{ inputs.build }}',
				publish: '${{ inputs.publish }}',
				substituter: '${{ inputs.substituter }}',
				'cupboard-path': '${{ steps.setup.outputs.cupboard-path }}',
				'read-session-target': '${{ steps.setup.outputs.read-session-target }}',
				'read-session-view': '${{ steps.setup.outputs.read-session-view }}',
				'read-session-caches': '${{ steps.setup.outputs.read-session-caches }}',
				audience: '${{ steps.setup.outputs.read-session-audience }}'
			}
		]);
	});

	it('validates the four simple workflow choices', async () => {
		const workflow = await loadWorkflow(publishWorkflow);
		const validation = shellOf(
			workflow,
			'publish',
			'Validate publication options'
		);

		expect(validation).toContain('missing|rebuild)');
		expect(validation).toContain('leave|copy)');
		expect(validation).toContain('none|outputs|built|closure)');
		expect(validation).toContain('true|false)');
	});

	it('reuses one acquisition across setup and push in the publish workflow', async () => {
		const workflow = await loadWorkflow(publishWorkflow);

		expect({
			setup: inputsOf(workflow, cupboardAction('setup')),
			pushBinary: inputsOf(workflow, cupboardAction('push')).map(
				(inputs) => inputs?.['cupboard-path']
			)
		}).toStrictEqual({
			setup: [
				{
					'cache-url': '${{ inputs.url }}',
					audience: '${{ inputs.audience }}',
					cache: '${{ inputs.cache }}',
					'trusted-public-key': '${{ inputs.trusted-public-key }}',
					cupboard: '${{ steps.resolve-cupboard.outputs.cupboard }}',
					'checkout-dir': sourceCheckoutDirectory
				}
			],
			pushBinary: ['${{ steps.setup.outputs.cupboard-path }}']
		});
	});

	it('lets a publish workflow TTL override its permanent default', async () => {
		const workflow = await loadWorkflow(publishWorkflow);
		expect(
			inputsOf(workflow, cupboardAction('push')).map((inputs) => ({
				ttl: inputs?.ttl,
				permanent: inputs?.permanent
			}))
		).toStrictEqual([
			{
				ttl: '${{ inputs.ttl }}',
				permanent: "${{ inputs.ttl == '' && inputs.permanent }}"
			}
		]);
	});

	it('resolves a release for a caller that names no version', async () => {
		const caller = await readFile(legacyPublishCaller, 'utf8');
		const callerWorkflow = workflowSchema.parse(parse(caller));

		expect(
			Object.values(callerWorkflow.jobs).map((job) => ({
				workflow: job.uses,
				version: job.with?.['cupboard-version']
			}))
		).toStrictEqual([
			{
				workflow:
					'underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@main',
				version: undefined
			}
		]);
	});
});

describe('SSH credential isolation', () => {
	it('passes builder credentials only for a remote group with no direct store', async () => {
		const workflow = await loadWorkflow(flakeWorkflow);
		const [planPrepare, cohortPrepare] = inputsOf(
			workflow,
			cupboardAction('prepare')
		);
		const storeCredentials = {
			store: '${{ inputs.store }}',
			'store-ssh-key':
				"${{ inputs.store != '' && secrets.store_ssh_key || '' }}",
			'store-ssh-config':
				"${{ inputs.store != '' && secrets.store_ssh_config || '' }}",
			'store-known-hosts':
				"${{ inputs.store != '' && inputs.store-known-hosts || '' }}",
			'store-ambient-identity':
				"${{ inputs.store != '' && inputs.store-ambient-identity || false }}"
		};

		expect({ planPrepare, cohortPrepare }).toStrictEqual({
			// Evaluating a closure root can realise derivations, so the plan job
			// takes the builders the caller configured.
			planPrepare: {
				'ssh-key': '${{ secrets.input_ssh_key }}',
				'input-known-hosts': '${{ inputs.input-known-hosts }}',
				'nix-config': '${{ inputs.nix-config }}',
				remote: "${{ inputs.builders != '' && inputs.store == '' }}",
				builders: "${{ inputs.store == '' && inputs.builders || '' }}",
				'builder-ssh-key':
					"${{ inputs.builders != '' && inputs.store == '' && secrets.builder_ssh_key || '' }}",
				'builder-ssh-config':
					"${{ inputs.builders != '' && inputs.store == '' && secrets.builder_ssh_config || '' }}",
				'builder-known-hosts':
					"${{ inputs.builders != '' && inputs.store == '' && inputs.builder-known-hosts || '' }}",
				...storeCredentials
			},
			// A cohort job takes them only when its own target group is remote.
			cohortPrepare: {
				'ssh-key': '${{ secrets.input_ssh_key }}',
				'input-known-hosts': '${{ inputs.input-known-hosts }}',
				'nix-config': '${{ inputs.nix-config }}',
				'maximise-space': '${{ inputs.maximise-space }}',
				remote: "${{ matrix.remote && inputs.store == '' }}",
				builders:
					"${{ matrix.remote && inputs.store == '' && inputs.builders || '' }}",
				'builder-ssh-key':
					"${{ matrix.remote && inputs.store == '' && secrets.builder_ssh_key || '' }}",
				'builder-ssh-config':
					"${{ matrix.remote && inputs.store == '' && secrets.builder_ssh_config || '' }}",
				'builder-known-hosts':
					"${{ matrix.remote && inputs.store == '' && inputs.builder-known-hosts || '' }}",
				...storeCredentials
			}
		});
	});

	it('declares every secret the prepare steps read', async () => {
		const workflow = await loadWorkflow(flakeWorkflow);

		// Declaration order, so a new secret has to be added here deliberately.
		expect(Object.keys(workflow.on.workflow_call?.secrets ?? {})).toStrictEqual(
			[
				'builder_ssh_key',
				'builder_ssh_config',
				'store_ssh_key',
				'store_ssh_config',
				'input_ssh_key',
				'destination_read_user',
				'destination_read_password',
				'read_user',
				'read_password',
				'fallback_read_user',
				'fallback_read_password',
				'private_substituters'
			]
		);
	});

	it('runs the transport script for validation and configuration', async () => {
		const contents = await readFile(prepareAction, 'utf8');

		expect(
			contents.match(
				/ssh-transport\.sh" (?:validate|configure-input|configure)/gu
			)
		).toStrictEqual([
			'ssh-transport.sh" validate',
			'ssh-transport.sh" configure-input',
			'ssh-transport.sh" configure'
		]);
	});
});

describe('cohort planning and publication', () => {
	it('runs one cohort job for each planned cohort', async () => {
		const workflow = await loadWorkflow(flakeWorkflow);
		const cohort = workflow.jobs.cohort;

		expect({
			if: cohort?.if,
			strategy: cohort?.strategy,
			// A tolerated target failure is the action's decision, so neither the job
			// nor the step may swallow the outcome.
			toleratedFailures: [
				cohort?.['continue-on-error'],
				...(cohort?.steps ?? []).map((step) => step['continue-on-error'])
			].filter((value) => value !== undefined)
		}).toStrictEqual({
			if: "${{ needs.plan.outputs.cohort-count != '0' }}",
			strategy: {
				'fail-fast': false,
				matrix: '${{ fromJSON(needs.plan.outputs.cohort-matrix) }}'
			},
			toleratedFailures: []
		});
	});

	it('passes the resolved publication settings to the plan', async () => {
		const workflow = await loadWorkflow(flakeWorkflow);

		expect(inputsOf(workflow, cupboardAction('plan'))).toStrictEqual([
			{
				targets: '${{ steps.targets.outputs.manifest }}',
				url: '${{ inputs.url }}',
				'cupboard-path': '${{ steps.setup.outputs.cupboard-path }}',
				'read-session-target': '${{ steps.setup.outputs.read-session-target }}',
				'read-session-view': '${{ steps.setup.outputs.read-session-view }}',
				'read-session-caches': '${{ steps.setup.outputs.read-session-caches }}',
				audience: '${{ steps.setup.outputs.read-session-audience }}',
				cache: '${{ needs.configure.outputs.cache }}',
				'root-prefix': '${{ needs.configure.outputs.root-prefix }}',
				ttl: '${{ needs.configure.outputs.ttl }}',
				permanent: '${{ needs.configure.outputs.permanent }}',
				optimise: "${{ needs.configure.outputs.publish != 'none' }}",
				publish: '${{ needs.configure.outputs.publish }}',
				build: '${{ inputs.build }}',
				substituter: '${{ inputs.substituter }}',
				'read-user':
					'${{ secrets.destination_read_user || secrets.read_user || secrets.fallback_read_user }}',
				'read-password':
					'${{ secrets.destination_read_password || secrets.read_password || secrets.fallback_read_password }}',
				'enable-packing': '${{ inputs.enable-packing }}',
				'pack-capacity': '${{ inputs.pack-capacity }}',
				store: '${{ inputs.store }}'
			}
		]);
	});

	it('plans once and fans out only over cohorts', async () => {
		const workflow = await loadWorkflow(flakeWorkflow);

		expect(Object.keys(workflow.jobs)).toStrictEqual([
			'configure',
			'plan',
			'cohort',
			'remove-cache'
		]);
	});

	it('builds and publishes a cohort through one action', async () => {
		const workflow = await loadWorkflow(flakeWorkflow);
		const cupboardActions = allSteps(workflow)
			.map(({ step }) => step.uses)
			.filter((uses) => uses?.startsWith(cupboardActionPrefix));

		expect({
			cupboardActions,
			// The receipt comes from the supervised build, so no separate push or
			// build step may publish alongside it.
			artifactSteps: allSteps(workflow).filter(({ step }) =>
				step.uses?.startsWith('actions/upload-artifact')
			)
		}).toStrictEqual({
			cupboardActions: [
				cupboardAction('resolve-cupboard'),
				cupboardAction('prepare'),
				cupboardAction('setup'),
				cupboardAction('plan'),
				cupboardAction('prepare'),
				cupboardAction('setup'),
				cupboardAction('build-cohort'),
				cupboardAction('attest'),
				cupboardAction('attest-attach'),
				cupboardAction('attest-status'),
				cupboardAction('prepare'),
				cupboardAction('setup')
			],
			artifactSteps: []
		});
	});

	it('leaves build concurrency to the Nix configuration', async () => {
		const workflow = await loadWorkflow(flakeWorkflow);

		expect(inputsOf(workflow, cupboardAction('build-cohort'))).toStrictEqual([
			{
				'cohort-json': '${{ toJSON(matrix) }}',
				'best-effort': '${{ matrix.bestEffort }}',
				url: '${{ inputs.url }}',
				'cupboard-path': '${{ steps.setup.outputs.cupboard-path }}',
				'read-session-target': '${{ steps.setup.outputs.read-session-target }}',
				'read-session-view': '${{ steps.setup.outputs.read-session-view }}',
				'read-session-caches': '${{ steps.setup.outputs.read-session-caches }}',
				audience: '${{ steps.setup.outputs.read-session-audience }}',
				cache: '${{ needs.configure.outputs.cache }}',
				'reuse-view': '${{ needs.configure.outputs.reuse-view }}',
				ttl: '${{ needs.configure.outputs.ttl }}',
				permanent: '${{ needs.configure.outputs.permanent }}',
				'read-user':
					'${{ secrets.destination_read_user || secrets.read_user || secrets.fallback_read_user }}',
				'read-password':
					'${{ secrets.destination_read_password || secrets.read_password || secrets.fallback_read_password }}',
				'fallback-read-user':
					'${{ secrets.read_user || secrets.fallback_read_user }}',
				'fallback-read-password':
					'${{ secrets.read_password || secrets.fallback_read_password }}',
				// No `max-jobs`. Passing 0 would send every derivation to the builders,
				// including one that sets `preferLocalBuild`; a caller that wants that
				// policy sets `max-jobs` through `nix-config`.
				store: '${{ inputs.store }}',
				publish: '${{ needs.configure.outputs.publish }}',
				build: '${{ inputs.build }}',
				substituter: '${{ inputs.substituter }}',
				'gc-between-cohorts':
					"${{ inputs.gc-between-cohorts && runner.environment == 'github-hosted' && inputs.store == '' }}",
				'run-root':
					"${{ format('{0}/_cupboard-run/{1}', needs.configure.outputs.root-prefix, github.run_id) }}",
				'run-root-ttl': '${{ inputs.run-root-ttl }}',
				'run-root-permanent': '${{ inputs.run-root-permanent }}'
			}
		]);
	});
});

describe('attestation', () => {
	it.each([false, true])(
		'preserves successive step manifests with shared input directory %s',
		async (sharedDirectory) => {
			const source: unknown = parse(
				await readFile(
					new URL('../actions/attest/action.yml', import.meta.url),
					'utf8'
				)
			);
			const action = z
				.object({ runs: z.object({ steps: stepsSchema }) })
				.parse(source);
			const sign = action.runs.steps.find((step) => step.id === 'attest');
			if (sign?.run === undefined) {
				throw new Error('The attestation action has no signing script');
			}
			const directory = await mkdtemp(
				path.join(tmpdir(), 'cupboard-manifests-')
			);
			const manifests: string[] = [];

			try {
				for (const step of ['first step', 'second step']) {
					const subjectsDirectory = path.join(
						directory,
						sharedDirectory ? 'inputs' : step
					);
					await mkdir(subjectsDirectory, { recursive: true });
					const result = await execFileAsync(
						'bash',
						[
							'-c',
							String.raw`
node() {
  while (( $# )); do
    if [[ "$1" == --bundles-file ]]; then
      mkdir -p "$(dirname "$2")"
      printf '%s\n' "$MARKER" > "$2"
      printf '%s\n' "$2"
      break
    fi
    shift
  done
}
${sign.run}`
						],
						{
							env: {
								...process.env,
								...Object.fromEntries(
									Object.keys(sign.env ?? {}).map((key) => [key, ''])
								),
								GITHUB_ACTION_PATH: directory,
								RUNNER_TEMP: directory,
								CHECKSUMS_FILE: path.join(subjectsDirectory, `${step}.txt`),
								MARKER: step
							}
						}
					);
					manifests.push(result.stdout.trim());
				}
				const contents = await Promise.all(
					manifests.map((manifest) => readFile(manifest, 'utf8'))
				);
				expect({
					distinctManifests: new Set(manifests).size,
					contents
				}).toStrictEqual({
					distinctManifests: 2,
					contents: ['first step\n', 'second step\n']
				});
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		}
	);

	it('passes the resolver build checksums to the signer', async () => {
		const source: unknown = parse(
			await readFile(
				new URL('../actions/attest/action.yml', import.meta.url),
				'utf8'
			)
		);
		const action = z
			.object({ runs: z.object({ steps: stepsSchema }) })
			.parse(source);
		const sign = action.runs.steps.find((step) => step.id === 'attest');
		expect({
			builtChecksums: sign?.env?.BUILT_CHECKSUMS_FILE,
			suppliedToSigner: sign?.run?.includes(
				'--built-checksums-file "$BUILT_CHECKSUMS_FILE"'
			)
		}).toStrictEqual({
			builtChecksums: '${{ steps.subjects.outputs.built-checksums-file }}',
			suppliedToSigner: true
		});
	});

	it.each([publishWorkflow, flakeWorkflow])(
		'uses the Boolean build-provenance switch in %s',
		async (file) => {
			const workflow = await loadWorkflow(file);
			const input = workflow.on.workflow_call?.inputs.attest;
			expect({ type: input?.type, default: input?.default }).toStrictEqual({
				type: 'boolean',
				default: true
			});
		}
	);

	it('publishes observed builds by default in the flake workflow', async () => {
		const workflow = await loadWorkflow(flakeWorkflow);
		expect(workflow.on.workflow_call?.inputs.publish?.default).toBe('built');
	});

	it('publishes selected outputs by default in the simple workflow', async () => {
		const workflow = await loadWorkflow(publishWorkflow);
		const push = allSteps(workflow).find(
			({ step }) => step.uses === cupboardAction('push')
		)?.step;
		const inputs = workflow.on.workflow_call?.inputs;

		expect({
			defaults: {
				build: inputs?.build?.default,
				substituter: inputs?.substituter?.default,
				publish: inputs?.publish?.default,
				attest: inputs?.attest?.default
			},
			pathsFile: push?.with?.['paths-file'],
			closure: push?.with?.closure,
			buildReceipt: push?.with?.['build-receipt-file'],
			if: push?.if
		}).toStrictEqual({
			defaults: {
				build: 'missing',
				substituter: 'copy',
				publish: 'outputs',
				attest: true
			},
			pathsFile: '${{ steps.build.outputs.publish-paths-file }}',
			closure: "${{ inputs.publish == 'closure' }}",
			buildReceipt: '${{ steps.build.outputs.receipt-file }}',
			if: "${{ inputs.publish != 'none' }}"
		});
	});

	it('signs the receipt after publication and attaches the bundle after signing', async () => {
		const workflows = await Promise.all(
			reusableWorkflows.map(async ({ name, file }) => ({
				name,
				workflow: await loadWorkflow(file)
			}))
		);

		expect(
			workflows.map(({ name, workflow }) => {
				const order = allSteps(workflow).map(({ step }) => step.uses);

				return {
					name,
					publishesBeforeSigning:
						Math.max(
							order.indexOf(cupboardAction('push')),
							order.indexOf(cupboardAction('build-cohort'))
						) < order.indexOf(cupboardAction('attest')),
					signsBeforeAttaching:
						order.indexOf(cupboardAction('attest')) <
						order.indexOf(cupboardAction('attest-attach')),
					// An unsigned bundle must never reach the push.
					pushAttestations: inputsOf(workflow, cupboardAction('push')).map(
						(inputs) => inputs?.attestations
					)
				};
			})
		).toStrictEqual([
			{
				name: 'flake publish',
				publishesBeforeSigning: true,
				signsBeforeAttaching: true,
				pushAttestations: []
			},
			{
				name: 'publish',
				publishesBeforeSigning: true,
				signsBeforeAttaching: true,
				pushAttestations: [undefined]
			}
		]);
	});

	it('verifies every subject against the destination it published to', async () => {
		const [flake, publish] = await Promise.all([
			loadWorkflow(flakeWorkflow),
			loadWorkflow(publishWorkflow)
		]);

		expect({
			flake: inputsOf(flake, cupboardAction('attest')),
			publish: inputsOf(publish, cupboardAction('attest'))
		}).toStrictEqual({
			flake: [
				{
					'inline-bundles': false,
					'receipt-file': '${{ steps.build-cohort.outputs.receipt-file }}',
					url: '${{ inputs.url }}',
					cache: '${{ needs.configure.outputs.cache }}',
					'cupboard-path': '${{ steps.setup.outputs.cupboard-path }}',
					'read-session-target':
						'${{ steps.setup.outputs.read-session-target }}',
					'read-session-view': '${{ steps.setup.outputs.read-session-view }}',
					'read-session-caches':
						'${{ steps.setup.outputs.read-session-caches }}',
					audience: '${{ steps.setup.outputs.read-session-audience }}',
					'read-user':
						'${{ secrets.destination_read_user || secrets.read_user || secrets.fallback_read_user }}',
					'read-password':
						'${{ secrets.destination_read_password || secrets.read_password || secrets.fallback_read_password }}'
				}
			],
			publish: [
				{
					'inline-bundles': false,
					'receipt-file': '${{ steps.push.outputs.receipt-file }}',
					url: '${{ inputs.url }}',
					cache: '${{ inputs.cache }}',
					'cupboard-path': '${{ steps.setup.outputs.cupboard-path }}',
					'read-session-target':
						'${{ steps.setup.outputs.read-session-target }}',
					'read-session-view': '${{ steps.setup.outputs.read-session-view }}',
					'read-session-caches':
						'${{ steps.setup.outputs.read-session-caches }}',
					audience: '${{ steps.setup.outputs.read-session-audience }}'
				}
			]
		});
	});

	it.each([
		{
			name: 'cupboard-flake-publish.yml',
			file: flakeWorkflow,
			gated: [
				{
					uses: cupboardAction('attest'),
					if: "${{ inputs.attest && needs.configure.outputs.publish != 'none' && steps.build-cohort.outputs.receipt-file != '' }}"
				},
				{
					uses: cupboardAction('attest-attach'),
					if: "${{ inputs.attest && needs.configure.outputs.publish != 'none' && steps.build-cohort.outputs.receipt-file != '' && steps.attest.outputs.bundles-file != '' }}"
				}
			],
			attach: [
				{
					url: '${{ inputs.url }}',
					'cupboard-path': '${{ steps.setup.outputs.cupboard-path }}',
					'read-session-target':
						'${{ steps.setup.outputs.read-session-target }}',
					'read-session-view': '${{ steps.setup.outputs.read-session-view }}',
					'read-session-caches':
						'${{ steps.setup.outputs.read-session-caches }}',
					audience: '${{ steps.setup.outputs.read-session-audience }}',
					cache: '${{ needs.configure.outputs.cache }}',
					'read-user':
						'${{ secrets.destination_read_user || secrets.read_user || secrets.fallback_read_user }}',
					'read-password':
						'${{ secrets.destination_read_password || secrets.read_password || secrets.fallback_read_password }}',
					'receipt-file': '${{ steps.build-cohort.outputs.receipt-file }}',
					'checksums-file': '${{ steps.attest.outputs.checksums-file }}',
					'bundles-file': '${{ steps.attest.outputs.bundles-file }}'
				}
			]
		},
		{
			name: 'cupboard-publish.yml',
			file: publishWorkflow,
			gated: [
				{
					uses: cupboardAction('attest'),
					if: "${{ inputs.attest && steps.push.outcome == 'success' }}"
				},
				{
					uses: cupboardAction('attest-attach'),
					if: "${{ inputs.attest && steps.attest.outputs.bundles-file != '' }}"
				}
			],
			attach: [
				{
					url: '${{ inputs.url }}',
					'cupboard-path': '${{ steps.setup.outputs.cupboard-path }}',
					'read-session-target':
						'${{ steps.setup.outputs.read-session-target }}',
					'read-session-view': '${{ steps.setup.outputs.read-session-view }}',
					'read-session-caches':
						'${{ steps.setup.outputs.read-session-caches }}',
					audience: '${{ steps.setup.outputs.read-session-audience }}',
					cache: '${{ inputs.cache }}',
					'receipt-file': '${{ steps.push.outputs.receipt-file }}',
					'checksums-file': '${{ steps.attest.outputs.checksums-file }}',
					'bundles-file': '${{ steps.attest.outputs.bundles-file }}'
				}
			]
		}
	])(
		'attaches every signed bundle when signing produced any, in $name',
		async ({ file, gated, attach }) => {
			const workflow = await loadWorkflow(file);

			expect({
				gated: allSteps(workflow)
					.filter(({ step }) =>
						[
							cupboardAction('attest'),
							cupboardAction('attest-attach')
						].includes(step.uses ?? '')
					)
					.map(({ step }) => ({ uses: step.uses, if: step.if })),
				attach: inputsOf(workflow, cupboardAction('attest-attach'))
			}).toStrictEqual({ gated, attach });
		}
	);
});

describe('publication attestation coverage', () => {
	it.each([
		{
			file: publishWorkflow,
			name: 'simple',
			receipt: '${{ steps.push.outputs.receipt-file }}',
			condition:
				"${{ inputs.publish != 'none' && steps.push.outputs.receipt-file != '' }}",
			cache: '${{ inputs.cache }}',
			credentials: {}
		},
		{
			file: flakeWorkflow,
			name: 'flake',
			receipt: '${{ steps.build-cohort.outputs.receipt-file }}',
			condition:
				"${{ needs.configure.outputs.publish != 'none' && steps.build-cohort.outputs.receipt-file != '' }}",
			cache: '${{ needs.configure.outputs.cache }}',
			credentials: {
				'read-user':
					'${{ secrets.destination_read_user || secrets.read_user || secrets.fallback_read_user }}',
				'read-password':
					'${{ secrets.destination_read_password || secrets.read_password || secrets.fallback_read_password }}'
			}
		}
	])(
		'reports coverage after attachment even without fresh signing in $name',
		async ({ file, receipt, condition, cache, credentials }) => {
			const steps = allSteps(await loadWorkflow(file)).map(({ step }) => step);
			const index = steps.findIndex(
				(step) => step.uses === cupboardAction('attest-status')
			);
			const step = steps[index];
			const attach = steps.findIndex(
				(item) => item.uses === cupboardAction('attest-attach')
			);
			expect({ step, afterAttach: index > attach }).toStrictEqual({
				step: {
					name: 'Report stored attestation coverage',
					uses: cupboardAction('attest-status'),
					if: condition,
					with: {
						url: '${{ inputs.url }}',
						cache,
						'cupboard-path': '${{ steps.setup.outputs.cupboard-path }}',
						'read-session-target':
							'${{ steps.setup.outputs.read-session-target }}',
						'read-session-view': '${{ steps.setup.outputs.read-session-view }}',
						'read-session-caches':
							'${{ steps.setup.outputs.read-session-caches }}',
						audience: '${{ steps.setup.outputs.read-session-audience }}',
						'receipt-file': receipt,
						'bundles-file': '${{ steps.attest.outputs.bundles-file }}',
						...credentials
					}
				},
				afterAttach: true
			});
		}
	);
});

describe('local store collection', () => {
	it('collects only an ephemeral local store, after the bundle is attached', async () => {
		const workflow = await loadWorkflow(flakeWorkflow);
		const steps = workflow.jobs.cohort?.steps ?? [];
		const named = (name: string) =>
			steps.findIndex((step) => step.name === name);

		expect({
			order:
				steps.findIndex(
					(step) => step.uses === cupboardAction('attest-attach')
				) < named('Explain skipped local store collection'),
			explain: steps[named('Explain skipped local store collection')]?.if,
			collect: steps[named('Collect the local store')]?.if,
			// The action's own collection between cohorts uses the same gate.
			internal: inputsOf(workflow, cupboardAction('build-cohort'))[0]?.[
				'gc-between-cohorts'
			]
		}).toStrictEqual({
			order: true,
			explain:
				"${{ !cancelled() && inputs.gc-between-cohorts && (runner.environment != 'github-hosted' || inputs.store != '') }}",
			collect:
				"${{ !cancelled() && inputs.gc-between-cohorts && runner.environment == 'github-hosted' && inputs.store == '' }}",
			internal:
				"${{ inputs.gc-between-cohorts && runner.environment == 'github-hosted' && inputs.store == '' }}"
		});
	});

	it('releases the out-links before collecting and never fails the job', async () => {
		const workflow = await loadWorkflow(flakeWorkflow);
		const collect = shellOf(workflow, 'cohort', 'Collect the local store');

		// The step is an inline script, so its order is read as text.
		expect({
			releasesBeforeCollecting:
				collect.indexOf('rm -rf -- "${OUT_LINK_DIRECTORY}"') <
				collect.indexOf('if ! nix store gc; then'),
			warnsOnFailure: collect.includes("echo '::warning::nix store gc failed")
		}).toStrictEqual({
			releasesBeforeCollecting: true,
			warnsOnFailure: true
		});
	});
});

describe('resolved publication inputs', () => {
	it('rejects a line break in every resolved value before writing an output', async () => {
		const workflow = await loadWorkflow(flakeWorkflow);
		const resolve = shellOf(workflow, 'configure', 'Resolve inputs');
		const validation =
			'for name in PRESET CACHE ROOT_PREFIX TTL REUSE_VIEW BRANCH CACHE_ACCESS_MODE; do';

		expect({
			validation: resolve.includes(validation),
			lineFeed: resolve.includes(`"\${!name}" == *$'\\n'*`),
			carriageReturn: resolve.includes(`"\${!name}" == *$'\\r'*`),
			buildersValidation: resolve.includes(
				`if [[ "\${BUILDERS}" == *$'\\n'* || "\${BUILDERS}" == *$'\\r'* ]]; then`
			),
			beforeOutputs:
				resolve.indexOf(validation) < resolve.indexOf('echo "cache=${CACHE}"')
		}).toStrictEqual({
			validation: true,
			lineFeed: true,
			carriageReturn: true,
			buildersValidation: true,
			beforeOutputs: true
		});
	});

	it('resolves the destination cache selection once for every later job', async () => {
		const workflow = await loadWorkflow(flakeWorkflow);
		const resolve = shellOf(workflow, 'configure', 'Resolve inputs');

		expect({
			defaultCache: workflow.on.workflow_call?.inputs.cache?.default,
			output: workflow.jobs.configure?.outputs?.cache,
			written: resolve.includes('echo "cache=${CACHE}"')
		}).toStrictEqual({
			defaultCache: '',
			output: '${{ steps.resolve.outputs.cache }}',
			written: true
		});
	});

	it('refuses a pull request from a fork before deriving anything', async () => {
		const workflow = await loadWorkflow(flakeWorkflow);
		const resolve = shellOf(workflow, 'configure', 'Resolve inputs');
		const refusal =
			'if [ -z "${HEAD_REPOSITORY_ID}" ] || [ "${HEAD_REPOSITORY_ID}" != "${REPOSITORY_ID}" ]; then';

		expect({
			headRepositoryId: workflow.jobs.configure?.steps.find(
				(step) => step.name === 'Resolve inputs'
			)?.env?.HEAD_REPOSITORY_ID,
			refuses: resolve.includes(refusal),
			beforeTheCacheName:
				resolve.indexOf(refusal) <
				resolve.indexOf('pr_cache="gh-${REPOSITORY_ID}-pr-${PR_NUMBER}"')
		}).toStrictEqual({
			headRepositoryId: '${{ github.event.pull_request.head.repo.id }}',
			refuses: true,
			beforeTheCacheName: true
		});
	});

	it('accepts a non-pull-request run only from the trusted branch', async () => {
		const workflow = await loadWorkflow(flakeWorkflow);
		const resolve = shellOf(workflow, 'configure', 'Resolve inputs');

		expect({
			branchInput: workflow.on.workflow_call?.inputs.branch?.default,
			trustedRef: resolve.includes(
				'elif [ "${REF}" = "refs/heads/${BRANCH}" ]; then'
			),
			refusesOtherRefs: resolve.includes('exit 1')
		}).toStrictEqual({
			branchInput: 'main',
			trustedRef: true,
			refusesOtherRefs: true
		});
	});

	// The conditions come from an inline script, so each one is read as text.
	// `scripts/prepare-ssh-transport.test.ts` runs the equivalent guards in
	// actions/prepare against real inputs.
	it.each([
		{
			name: 'a preset alongside an explicit cache selection',
			condition:
				'if [ -n "${CACHE}${ROOT_PREFIX}${TTL}" ] || [ "${PERMANENT}" = true ]; then'
		},
		{
			name: 'a direct store together with classic builders',
			condition: 'if [ -n "${STORE}" ] && [ -n "${BUILDERS}" ]; then'
		},
		{
			name: 'an ambient store identity without a store',
			condition:
				'if [ "${STORE_AMBIENT_IDENTITY}" = true ] && [ -z "${STORE}" ]; then'
		},
		{
			name: 'builders whose host keys are not pinned',
			condition:
				'if [ -n "${BUILDERS}" ] && [[ ! "${BUILDER_KNOWN_HOSTS}" =~ [^[:space:]] ]]; then'
		},
		{
			name: 'a store whose host key is pinned nowhere',
			condition: 'if [ "${store_uri_has_host_key}" != true ]; then'
		},
		{
			name: 'URI-only host-key pinning on a nonstandard port',
			condition: 'if [ "${store_uri_uses_default_ssh_port}" != true ]; then'
		}
	])('refuses $name before planning', async ({ condition }) => {
		const workflow = await loadWorkflow(flakeWorkflow);
		const resolve = shellOf(workflow, 'configure', 'Resolve inputs');

		expect(resolve.includes(condition)).toBe(true);
	});
});

describe('pinned Nix client', () => {
	it('installs one Nix version everywhere it installs Nix', async () => {
		const [workflows, action, dockerfile] = await Promise.all([
			Promise.all(
				[ciWorkflow, publishWorkflow, releaseCacheWorkflow].map((file) =>
					loadWorkflow(file)
				)
			),
			readFile(prepareAction, 'utf8'),
			readFile(remoteStoreDockerfile, 'utf8')
		]);
		const installs = workflows.flatMap((workflow) =>
			stepsUsing(workflow, nixInstaller).map(({ step }) => step.with)
		);

		expect({
			installs,
			// The composite action is not a workflow, so its pinned step is read
			// from the file.
			prepareInstalls: action.includes(`nix_version: ${nixClientVersion}`),
			otherInstallers: workflows.flatMap((workflow) =>
				allSteps(workflow)
					.map(({ step }) => step.uses)
					.filter((uses) => uses?.includes('nix-installer-action'))
			),
			// The e2e daemon image is the matching release of the same series.
			remoteDaemon: dockerfile.includes('FROM nixos/nix:2.34.8@sha256:')
		}).toStrictEqual({
			installs: installs.map(() => ({ nix_version: nixClientVersion })),
			prepareInstalls: true,
			otherInstallers: [],
			remoteDaemon: true
		});
	});
});

describe('release cache publication', () => {
	it('publishes a release binary for every supported Nix system', async () => {
		const workflow = await loadWorkflow(releaseCacheWorkflow);
		const publish = workflow.jobs.publish;

		expect({
			matrix: releaseCacheMatrixSchema.parse(publish?.strategy?.matrix).include,
			with: publish?.with,
			failFast: publish?.strategy?.['fail-fast'],
			// A failed platform must fail the release rather than pass quietly.
			tolerance: publish?.['continue-on-error'],
			flakehubNeedsPublish: jobNeeds(workflow, 'flakehub')
		}).toStrictEqual({
			matrix: nixSystemRunners,
			with: {
				'runs-on': '${{ matrix.runner }}',
				url: 'https://cupboard.supply/t/cupboard',
				build: 'rebuild',
				cache: 'releases',
				'trusted-public-key':
					'cupboard-1:tiaTSFvY6LqLUwbjsNcig64LnxZ+T5EQgW5Cr4XjXqU=',
				root: 'github:${{ github.repository }}/${{ github.event.release.tag_name }}',
				'cupboard-version': '${{ github.event.release.tag_name }}'
			},
			failFast: false,
			tolerance: undefined,
			flakehubNeedsPublish: ['publish']
		});
	});
});

describe('binary release', () => {
	it('builds a release binary on the runner for every supported Nix system', async () => {
		const workflow = await loadWorkflow(releaseWorkflow);
		const build = workflow.jobs.build;

		expect({
			matrix: releaseBinaryMatrixSchema.parse(build?.strategy?.matrix).include,
			failFast: build?.strategy?.['fail-fast']
		}).toStrictEqual({
			matrix: nixSystemRunners.map(({ system, runner }) => ({
				runner,
				...releaseAssetBySystem[system]
			})),
			failFast: false
		});
	});
});

describe('repository cache publishing', () => {
	it.each([
		{ workflow: cachePublishWorkflow, jobs: ['publish-pr', 'publish-main'] },
		{ workflow: releaseCacheWorkflow, jobs: ['publish'] }
	])(
		'requests fresh build evidence from $workflow',
		async ({ workflow, jobs }) => {
			const definition = await loadWorkflow(workflow);
			expect(
				jobs.map((job) => ({ job, build: definition.jobs[job]?.with?.build }))
			).toStrictEqual(jobs.map((job) => ({ job, build: 'rebuild' })));
		}
	);

	it('resolves the CLI from the called workflow revision and pins the public key', async () => {
		const workflow = await loadWorkflow(cachePublishWorkflow);
		const jobs = Object.values(workflow.jobs);

		expect({
			versions: jobs.map((job) => job.with?.['cupboard-version']),
			trustedPublicKeys: jobs.map((job) => job.with?.['trusted-public-key']),
			workflows: jobs.map((job) => job.uses)
		}).toStrictEqual({
			versions: [undefined, undefined],
			trustedPublicKeys: Array.from(
				{ length: jobs.length },
				() => 'cupboard-1:tiaTSFvY6LqLUwbjsNcig64LnxZ+T5EQgW5Cr4XjXqU='
			),
			workflows: Array.from(
				{ length: jobs.length },
				() =>
					'underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@main'
			)
		});
	});
});

const execFileAsync = promisify(execFile);

async function resolvePublicationEvent(event: {
	readonly action: string;
	readonly merged: boolean;
	readonly eventName?: string;
	readonly preset?: string;
	readonly cache?: string;
	readonly cacheAccessMode?: string;
	readonly publish?: 'none' | 'outputs' | 'closure';
	readonly push?: boolean;
	readonly credentials?: Readonly<Record<string, string | undefined>>;
	readonly onOutput?: (stdout: string) => void;
}): Promise<Record<string, string>> {
	const workflow = await loadWorkflow(flakeWorkflow);
	const step = workflow.jobs.configure?.steps.find(
		(candidate) => candidate.name === 'Resolve inputs'
	);

	if (step?.run === undefined) {
		throw new Error('The publication workflow has no input-resolution script');
	}
	const directory = await mkdtemp(
		path.join(tmpdir(), 'cupboard-publication-event-')
	);
	const output = path.join(directory, 'output');

	try {
		const { stdout } = await execFileAsync('bash', ['-c', step.run], {
			env: {
				...Object.fromEntries(
					Object.keys(step.env ?? {}).map((key) => [key, ''])
				),
				PRESET: event.preset ?? 'pull-request-and-branch',
				CACHE: event.cache ?? '',
				CACHE_ACCESS_MODE: event.cacheAccessMode ?? '',
				ROOT_PREFIX: event.preset === '' ? 'release' : '',
				BUILD: 'missing',
				SUBSTITUTER: 'copy',
				PUBLISH: event.publish ?? 'outputs',
				PUSH: String(event.push ?? true),
				ATTEST: 'true',
				PERMANENT: 'false',
				EVENT_NAME: event.eventName ?? 'pull_request',
				EVENT_ACTION: event.action,
				MERGED: String(event.merged),
				PR_NUMBER: '7',
				REPOSITORY: 'acme/infra',
				REPOSITORY_ID: '1234',
				HEAD_REPOSITORY_ID: '1234',
				REF:
					event.merged ||
					(event.eventName !== undefined && event.eventName !== 'pull_request')
						? 'refs/heads/main'
						: 'refs/pull/7/merge',
				BRANCH: 'main',
				...event.credentials,
				GITHUB_OUTPUT: output
			}
		});
		event.onOutput?.(stdout);
		const written = await readFile(output, 'utf8');

		return Object.fromEntries(
			written
				.trimEnd()
				.split('\n')
				.map((line) => {
					const separator = line.indexOf('=');

					return [line.slice(0, separator), line.slice(separator + 1)];
				})
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

describe('pull-request cache lifecycle', () => {
	it.each(
		['pull_request', 'push', 'workflow_dispatch', 'schedule'].flatMap(
			(eventName) =>
				['public', 'private'].map((cacheAccessMode) => ({
					eventName,
					cacheAccessMode
				}))
		)
	)(
		'checks explicit cache access on $eventName: $cacheAccessMode',
		async ({ eventName, cacheAccessMode }) => {
			expect(
				await resolvePublicationEvent({
					action: 'opened',
					merged: false,
					eventName,
					preset: '',
					cache: 'release',
					cacheAccessMode
				})
			).toStrictEqual({
				publish: 'outputs',
				cache: 'release',
				'cache-access-mode': cacheAccessMode,
				'root-prefix': 'release',
				ttl: '',
				permanent: 'false',
				'reuse-view': '',
				'provision-cache': '',
				'provision-cache-ttl': '',
				'remove-cache': ''
			});
		}
	);

	it.each([
		{
			eventName: 'pull_request',
			publish: 'outputs',
			access: 'private',
			cache: 'gh-1234-pr-7',
			root: 'github:acme/infra/pr-7',
			ttl: '14d',
			permanent: 'false',
			view: ''
		},
		{
			eventName: 'pull_request',
			publish: 'none',
			access: '',
			cache: '',
			root: 'github:acme/infra/pr-7',
			ttl: '14d',
			permanent: 'false',
			view: ''
		},
		...['push', 'workflow_dispatch', 'schedule'].flatMap((eventName) =>
			(['outputs', 'none'] as const).map((publish) => ({
				eventName,
				publish,
				access: '',
				cache: '',
				root: 'github:acme/infra/main',
				ttl: '',
				permanent: 'true',
				view: 'pull-requests-1234'
			}))
		)
	] as const)(
		'keeps preset access selection scoped to the PR cache: %j',
		async (selection) => {
			expect(
				await resolvePublicationEvent({
					action: 'opened',
					merged: false,
					eventName: selection.eventName,
					publish: selection.publish,
					cacheAccessMode: 'private'
				})
			).toStrictEqual({
				publish: selection.publish,
				cache: selection.cache,
				'cache-access-mode': selection.access,
				'root-prefix': selection.root,
				ttl: selection.ttl,
				permanent: selection.permanent,
				'reuse-view': selection.view,
				'provision-cache': selection.cache,
				'provision-cache-ttl': selection.ttl,
				'remove-cache': ''
			});
		}
	);

	it.each([
		{ credentials: {}, warned: false },
		{
			credentials: { READ_USER: 'reader', READ_PASSWORD: 'secret' },
			warned: false
		},
		{
			credentials: {
				FALLBACK_READ_USER: 'reader',
				FALLBACK_READ_PASSWORD: 'secret'
			},
			warned: true
		},
		{
			credentials: {
				READ_USER: 'reader',
				READ_PASSWORD: 'secret',
				FALLBACK_READ_USER: 'reader',
				FALLBACK_READ_PASSWORD: 'secret'
			},
			warned: true
		}
	])(
		'warns for deprecated static read aliases without revealing values: %j',
		async ({ credentials, warned }) => {
			let diagnostics = '';
			const outputs = await resolvePublicationEvent({
				action: 'opened',
				merged: false,
				credentials,
				onOutput: (stdout) => {
					diagnostics = stdout;
				}
			});
			expect({ outputs, diagnostics }).toStrictEqual({
				outputs: {
					publish: 'outputs',
					cache: 'gh-1234-pr-7',
					'cache-access-mode': '',
					'root-prefix': 'github:acme/infra/pr-7',
					ttl: '14d',
					permanent: 'false',
					'reuse-view': '',
					'provision-cache': 'gh-1234-pr-7',
					'provision-cache-ttl': '14d',
					'remove-cache': ''
				},
				diagnostics: warned
					? '::warning::fallback_read_user is deprecated. Use read_user.\n::warning::fallback_read_password is deprecated. Use read_password.\n'
					: ''
			});
		}
	);
	it.each([
		{
			credentials: { READ_USER: 'reader' },
			message: '::error::read_user and read_password must be supplied together'
		},
		{
			credentials: {
				READ_USER: 'reader',
				READ_PASSWORD: 'one',
				FALLBACK_READ_USER: 'other',
				FALLBACK_READ_PASSWORD: 'two'
			},
			message:
				'::error::read_user/read_password and fallback_read_user/fallback_read_password must match when both are supplied'
		}
	])(
		'rejects incomplete or conflicting static read pairs',
		async ({ credentials, message }) => {
			try {
				await resolvePublicationEvent({
					action: 'opened',
					merged: false,
					credentials
				});
			} catch (error) {
				if (
					!(error instanceof Error) ||
					!('stdout' in error) ||
					typeof error.stdout !== 'string'
				) {
					throw error;
				}
				expect(error.stdout.trim()).toBe(message);
				return;
			}
			throw new Error('Expected the workflow to reject the static read pair');
		}
	);

	it.each([{ publish: 'none' as const }, { push: false }])(
		'uses the default cache without provisioning or removal for read-only input %s',
		async (selection) => {
			expect(
				await resolvePublicationEvent({
					action: 'closed',
					merged: false,
					...selection
				})
			).toStrictEqual({
				publish: 'none',
				cache: '',
				'cache-access-mode': '',
				'root-prefix': 'github:acme/infra/pr-7',
				ttl: '14d',
				permanent: 'false',
				'reuse-view': '',
				'provision-cache': '',
				'provision-cache-ttl': '14d',
				'remove-cache': ''
			});
		}
	);

	it.each([
		{ action: 'opened', merged: false, removed: '' },
		{ action: 'closed', merged: false, removed: 'gh-1234-pr-7' },
		{ action: 'closed', merged: true, removed: '' }
	])(
		'resolves a $action pull request with merged=$merged',
		async ({ action, merged, removed }) => {
			expect(await resolvePublicationEvent({ action, merged })).toStrictEqual({
				publish: 'outputs',
				cache: 'gh-1234-pr-7',
				'cache-access-mode': '',
				'root-prefix': 'github:acme/infra/pr-7',
				ttl: '14d',
				permanent: 'false',
				'reuse-view': '',
				'provision-cache': 'gh-1234-pr-7',
				'provision-cache-ttl': '14d',
				'remove-cache': removed
			});
		}
	);

	it('keeps closed events out of planning and grants release verification to removal', async () => {
		const workflow = await loadWorkflow(flakeWorkflow);
		expect({
			merged: workflow.jobs.configure?.steps.find(
				(step) => step.name === 'Resolve inputs'
			)?.env?.MERGED,
			planCondition: workflow.jobs.plan?.if,
			removalPermissions: workflow.jobs['remove-cache']?.permissions
		}).toStrictEqual({
			merged: '${{ github.event.pull_request.merged }}',
			planCondition:
				"github.event_name != 'pull_request' || github.event.action != 'closed'",
			removalPermissions: {
				contents: 'read',
				attestations: 'read',
				'id-token': 'write'
			}
		});
	});
});

it.each([
	{ audience: '', expected: '' },
	{ audience: ' '.repeat(3), expected: '' },
	{ audience: '  custom-audience  ', expected: 'custom-audience' },
	{ audience: ' custom-audience ', expected: 'custom-audience' }
])(
	'uses the normalised audience in extracted workflow scripts: $audience',
	async ({ audience, expected }) => {
		const workflow = await loadWorkflow(flakeWorkflow);
		const evaluate = workflow.jobs.plan?.steps.find(
			(step) => step.name === 'Evaluate target manifest'
		);
		const remove = workflow.jobs['remove-cache']?.steps.find(
			(step) => step.name === 'Remove the cache'
		);
		if (evaluate?.run === undefined || remove?.run === undefined) {
			throw new Error(
				'The flake workflow must have evaluation and removal scripts'
			);
		}
		const setup = workflow.jobs['remove-cache']?.steps.find(
			(step) => step.id === 'setup'
		);
		const directory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-workflow-audience-')
		);
		const binary = path.join(directory, 'cupboard');
		const capture = path.join(directory, 'arguments.json');
		try {
			await writeFile(
				binary,
				`#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.ARGUMENTS_FILE, JSON.stringify(process.argv.slice(2))); process.stdout.write('[]');\n`,
				{ mode: 0o700 }
			);
			const argumentsByStep: unknown[] = [];
			for (const step of [evaluate, remove]) {
				if (step.run === undefined) {
					throw new Error('The workflow step must have a shell script');
				}
				const environment = Object.fromEntries(
					Object.entries(step.env ?? {}).map(([key, value]) => [
						key,
						value === '${{ inputs.audience }}'
							? audience
							: value === '${{ steps.setup.outputs.read-session-audience }}'
								? expected
								: ''
					])
				);
				await execFileAsync('bash', ['-c', step.run], {
					env: {
						...process.env,
						...environment,
						ARGUMENTS_FILE: capture,
						CUPBOARD_PATH: binary,
						TARGETS: '.#targets',
						PUBLISH: 'outputs',
						READ_SESSION_TARGET:
							'https://cache.example.test/t/acme/cache/builds',
						READ_SESSION_CACHES:
							'["https://cache.example.test/t/acme/cache/extra"]',
						READ_SESSION_VIEW: 'prior',
						URL: 'https://cache.example.test/t/acme',
						CACHE: 'pr-7',
						GITHUB_OUTPUT: path.join(directory, 'output')
					}
				});
				argumentsByStep.push(JSON.parse(await readFile(capture, 'utf8')));
			}
			expect({
				setupAudience: setup?.with?.audience,
				argumentsByStep
			}).toStrictEqual({
				setupAudience: '${{ inputs.audience }}',
				argumentsByStep: [
					[
						'run',
						'https://cache.example.test/t/acme/cache/builds',
						'--github-oidc',
						...(expected === '' ? [] : ['--audience', expected]),
						'--read-cache',
						'https://cache.example.test/t/acme/cache/extra',
						'--reuse-view',
						'prior',
						'--',
						'nix',
						'eval',
						'--json',
						'.#targets'
					],
					[
						'cache',
						'remove',
						'https://cache.example.test/t/acme',
						'pr-7',
						'--github-oidc',
						'--force',
						'--yes',
						...(expected === '' ? [] : ['--audience', expected])
					]
				]
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}
);

it.each([flakeWorkflow, publishWorkflow])(
	'passes setup audience output to all downstream calls in %s',
	async (file) => {
		const workflow = await loadWorkflow(file);
		const bindings = Object.entries(workflow.jobs).flatMap(
			([job, definition]) =>
				definition.steps
					.filter(
						(step) =>
							step.uses?.startsWith(cupboardActionPrefix) === true &&
							step.with?.audience !== undefined
					)
					.map((step) => ({
						job,
						action: step.uses,
						audience: step.with?.audience,
						setup: definition.steps.find(
							(candidate) => candidate.id === 'setup'
						)?.uses
					}))
		);
		expect(bindings).toStrictEqual(
			bindings.map((binding) => ({
				...binding,
				audience:
					binding.action === cupboardAction('setup')
						? '${{ inputs.audience }}'
						: '${{ steps.setup.outputs.read-session-audience }}',
				setup: cupboardAction('setup')
			}))
		);
	}
);

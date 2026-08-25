import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { z } from 'zod';

import {
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
const workflowCheckoutPath = '.cupboard-workflow';
const reservationStep = 'Reserve the cupboard workflow checkout';
const cloudGuardStep = 'Require GitHub Cloud workflow identity';

const cupboardAction = (name: string) =>
	`./${workflowCheckoutPath}/actions/${name}`;

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

describe('workflow source checkout', () => {
	it.each(reusableWorkflows)(
		'checks out its own actions at the called commit in $name',
		async ({ file }) => {
			const workflow = await loadWorkflow(file);
			const checkouts = stepsUsing(workflow, checkoutAction);
			const callerCheckouts = checkouts.filter(
				({ step }) => step.with?.repository === undefined
			);
			const workflowSource = checkouts.filter(
				({ step }) => step.with?.repository !== undefined
			);

			expect({
				workflowSource: workflowSource.map(({ step }) => step.with),
				callerCheckouts: callerCheckouts.map(({ step }) => step.with),
				// A step must never find cupboard's actions at the path an earlier
				// release checked them out to.
				legacyActionPath: allSteps(workflow).some(({ step }) =>
					step.uses?.startsWith('./.cupboard/')
				)
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
				legacyActionPath: false
			});
		}
	);

	it.each(reusableWorkflows)(
		'reserves the checkout path before every workflow-source checkout in $name',
		async ({ file }) => {
			const workflow = await loadWorkflow(file);
			const workflowSource = stepsUsing(workflow, checkoutAction).filter(
				({ step }) => step.with?.repository !== undefined
			);

			expect(
				workflowSource.map(({ job, index }) => ({
					job,
					precedingStep: workflow.jobs[job]?.steps[index - 1]?.name
				}))
			).toStrictEqual(
				workflowSource.map(({ job }) => ({
					job,
					precedingStep: reservationStep
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

	it.each(reusableWorkflows)(
		'refuses to replace caller content at the checkout path in $name',
		async ({ file, entryJob }) => {
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
					failsClosed: step.run?.includes('exit 1'),
					// Only the first job may find its own earlier checkout, which it
					// recognises by the origin URL before refreshing it.
					acceptsItsOwnCheckout: step.run?.includes('remote get-url origin')
				}))
			).toStrictEqual(
				guards.map(({ job }) => ({
					job,
					checksOrdinaryPaths: true,
					checksSymlinks: true,
					failsClosed: true,
					acceptsItsOwnCheckout: job === entryJob && file === flakeWorkflow
				}))
			);
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

	it('gives every flake publish job the coordinate configure resolved', async () => {
		const workflow = await loadWorkflow(flakeWorkflow);
		const setupInputs = inputsOf(workflow, cupboardAction('setup'));

		expect({
			configureOutput: workflow.jobs.configure?.steps.find(
				(step) => step.uses === cupboardAction('resolve-cupboard')
			)?.id,
			setupInputs
		}).toStrictEqual({
			configureOutput: 'resolve-cupboard',
			setupInputs: setupInputs.map(() => ({
				'cache-url': '${{ inputs.url }}',
				cache: '${{ needs.configure.outputs.cache }}',
				cupboard: '${{ needs.configure.outputs.cupboard }}',
				'trusted-public-key': '${{ inputs.trusted-public-key }}',
				'read-user': '${{ secrets.read_user }}',
				'read-password': '${{ secrets.read_password }}',
				'reuse-view': '${{ needs.configure.outputs.reuse-view }}'
			}))
		});
	});

	it('rebuilds a cached output when the publish workflow attests', async () => {
		const workflow = await loadWorkflow(publishWorkflow);

		expect(inputsOf(workflow, cupboardAction('build-paths'))).toStrictEqual([
			{
				installables: '${{ inputs.installable }}',
				// A cached output is no evidence that this run built anything, so a
				// retry after a failed attachment produces a new receipt.
				'require-provenance': '${{ inputs.attest }}'
			}
		]);
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
					cache: '${{ inputs.cache }}',
					'trusted-public-key': '${{ inputs.trusted-public-key }}',
					cupboard: '${{ steps.resolve-cupboard.outputs.cupboard }}'
				}
			],
			pushBinary: ['${{ steps.setup.outputs.cupboard-path }}']
		});
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
				'read_user',
				'read_password'
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
				cache: '${{ needs.configure.outputs.cache }}',
				'root-prefix': '${{ needs.configure.outputs.root-prefix }}',
				ttl: '${{ needs.configure.outputs.ttl }}',
				optimise: '${{ inputs.push }}',
				'read-user': '${{ secrets.read_user }}',
				'read-password': '${{ secrets.read_password }}',
				'enable-packing': '${{ inputs.enable-packing }}',
				'pack-capacity': '${{ inputs.pack-capacity }}',
				store: '${{ inputs.store }}',
				'require-provenance': '${{ inputs.push }}'
			}
		]);
	});

	it('plans once and fans out only over cohorts', async () => {
		const workflow = await loadWorkflow(flakeWorkflow);

		expect(Object.keys(workflow.jobs)).toStrictEqual([
			'configure',
			'plan',
			'cohort'
		]);
	});

	it('builds and publishes a cohort through one action', async () => {
		const workflow = await loadWorkflow(flakeWorkflow);
		const cupboardActions = allSteps(workflow)
			.map(({ step }) => step.uses)
			.filter((uses) => uses?.startsWith(`./${workflowCheckoutPath}/actions/`));

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
				cupboardAction('attest-attach')
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
				cache: '${{ needs.configure.outputs.cache }}',
				'reuse-view': '${{ needs.configure.outputs.reuse-view }}',
				ttl: '${{ needs.configure.outputs.ttl }}',
				'read-user': '${{ secrets.read_user }}',
				'read-password': '${{ secrets.read_password }}',
				// No `max-jobs`. Passing 0 would send every derivation to the builders,
				// including one that sets `preferLocalBuild`; a caller that wants that
				// policy sets `max-jobs` through `nix-config`.
				store: '${{ inputs.store }}',
				push: '${{ inputs.push }}',
				'require-provenance': '${{ inputs.push }}',
				'gc-between-cohorts':
					"${{ inputs.gc-between-cohorts && runner.environment == 'github-hosted' && inputs.store == '' }}",
				'run-root':
					"${{ format('{0}/_cupboard-run/{1}', needs.configure.outputs.root-prefix, github.run_id) }}",
				'run-root-ttl': '${{ inputs.run-root-ttl }}'
			}
		]);
	});
});

describe('attestation', () => {
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
					'receipt-file': '${{ steps.build-cohort.outputs.receipt-file }}',
					url: '${{ inputs.url }}',
					cache: '${{ needs.configure.outputs.cache }}',
					'read-user': '${{ secrets.read_user }}',
					'read-password': '${{ secrets.read_password }}'
				}
			],
			publish: [
				{
					'receipt-file': '${{ steps.build.outputs.receipt-file }}',
					url: '${{ inputs.url }}',
					cache: '${{ inputs.cache }}'
				}
			]
		});
	});

	it('attaches a cohort bundle only after a build this run published', async () => {
		const workflow = await loadWorkflow(flakeWorkflow);
		const gated = allSteps(workflow)
			.filter(({ step }) =>
				[cupboardAction('attest'), cupboardAction('attest-attach')].includes(
					step.uses ?? ''
				)
			)
			.map(({ step }) => ({ uses: step.uses, if: step.if }));

		expect({
			gated,
			attach: inputsOf(workflow, cupboardAction('attest-attach'))
		}).toStrictEqual({
			gated: [
				{
					uses: cupboardAction('attest'),
					if: "${{ inputs.push && steps.build-cohort.outputs.receipt-file != '' }}"
				},
				{
					uses: cupboardAction('attest-attach'),
					if: "${{ inputs.push && steps.build-cohort.outputs.receipt-file != '' && steps.attest.outputs.bundle-path != '' }}"
				}
			],
			attach: [
				{
					url: '${{ inputs.url }}',
					'cupboard-path': '${{ steps.setup.outputs.cupboard-path }}',
					cache: '${{ needs.configure.outputs.cache }}',
					'read-user': '${{ secrets.read_user }}',
					'read-password': '${{ secrets.read_password }}',
					'receipt-file': '${{ steps.build-cohort.outputs.receipt-file }}',
					'checksums-file': '${{ steps.attest.outputs.checksums-file }}',
					bundle:
						'${{ steps.attest.outputs.bundle-path }}\n${{ steps.attest.outputs.origin-bundle-path }}\n'
				}
			]
		});
	});
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
			'for name in PRESET CACHE ROOT_PREFIX TTL REUSE_VIEW BRANCH; do';

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
				cache: 'releases',
				root: 'github:${{ github.repository }}/${{ github.event.release.tag_name }}',
				'cupboard-version': '${{ github.event.release.tag_name }}'
			},
			failFast: false,
			tolerance: undefined,
			flakehubNeedsPublish: ['publish']
		});
	});
});

describe('repository cache publishing', () => {
	it('pins one released CLI across both caller jobs', async () => {
		const workflow = await loadWorkflow(cachePublishWorkflow);
		const versions = Object.values(workflow.jobs).map(
			(job) => job.with?.['cupboard-version']
		);

		expect({
			// The version is compared with itself rather than a literal, so a release
			// bump does not have to edit this test.
			consistent: new Set(versions).size,
			defined: versions.every((version) => version !== undefined),
			workflows: Object.values(workflow.jobs).map((job) => job.uses)
		}).toStrictEqual({
			consistent: 1,
			defined: true,
			workflows: Array.from(
				{ length: versions.length },
				() =>
					'underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@main'
			)
		});
	});
});

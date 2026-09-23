import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { parse } from 'yaml';
import { z } from 'zod';

// The reference is rendered from the action and workflow definitions so the
// documented inputs cannot drift from what GitHub accepts.
export const actionsReferencePath = new URL(
	'../docs/reference/actions.md',
	import.meta.url
);

interface PublicWorkflow {
	readonly file: string;
	// Workflow files carry a name but no description, so summarise them here.
	readonly summary: string;
}

const publicWorkflows: readonly PublicWorkflow[] = [
	{
		file: 'cupboard-flake-publish',
		summary:
			'Plans, builds, publishes and attests every target in a flake manifest, skipping work the cache already holds.'
	},
	{
		file: 'cupboard-publish',
		summary:
			'Builds one flake installable on one runner, then publishes and attests it. It reads the cache without credentials, so the destination must be public.'
	}
];
const publicActions = [
	'setup',
	'build-paths',
	'push',
	'attest',
	'attest-attach'
] as const;
const internalActions = [
	'plan',
	'build-cohort',
	'prepare',
	'resolve-cupboard'
] as const;

const scalarSchema = z.union([z.string(), z.boolean(), z.number()]);

const actionInputSchema = z.object({
	description: z.string().optional(),
	required: z.boolean().optional(),
	default: scalarSchema.optional()
});

const actionOutputSchema = z.object({ description: z.string().optional() });

const actionSchema = z.object({
	description: z.string(),
	inputs: z.record(z.string(), actionInputSchema).optional(),
	outputs: z.record(z.string(), actionOutputSchema).optional()
});

const workflowInputSchema = actionInputSchema.extend({
	type: z.string()
});

const permissionLevelSchema = z.enum(['read', 'write', 'none']);

const workflowSecretSchema = z.object({
	description: z.string().optional(),
	required: z.boolean().optional()
});

const workflowCallSchema = z.object({
	inputs: z.record(z.string(), workflowInputSchema).optional(),
	secrets: z.record(z.string(), workflowSecretSchema).optional()
});

const workflowJobSchema = z.object({
	permissions: z.record(z.string(), permissionLevelSchema).optional()
});

const workflowSchema = z.object({
	name: z.string(),
	on: z.object({ workflow_call: workflowCallSchema }),
	jobs: z.record(z.string(), workflowJobSchema)
});

type ActionDefinition = z.infer<typeof actionSchema>;
type WorkflowDefinition = z.infer<typeof workflowSchema>;
type PermissionLevel = z.infer<typeof permissionLevelSchema>;

export interface ReferenceSources {
	readonly workflows: readonly (readonly [
		PublicWorkflow,
		WorkflowDefinition
	])[];
	readonly actions: readonly (readonly [string, ActionDefinition])[];
}

function parseYaml<T>(url: URL, schema: z.ZodType<T>): T {
	// `yaml` follows YAML 1.2, so the `on` key stays a string.
	return schema.parse(parse(readFileSync(url, 'utf8')));
}

export function readReferenceSources(): ReferenceSources {
	return {
		workflows: publicWorkflows.map(
			(workflow) =>
				[
					workflow,
					parseYaml(
						new URL(
							`../.github/workflows/${workflow.file}.yml`,
							import.meta.url
						),
						workflowSchema
					)
				] as const
		),
		actions: publicActions.map(
			(name) =>
				[
					name,
					parseYaml(
						new URL(`../actions/${name}/action.yml`, import.meta.url),
						actionSchema
					)
				] as const
		)
	};
}

// Collapse a YAML description to one line, escaping `<` so a placeholder such
// as `<number>` is not read as an HTML tag.
function prose(text: string | undefined): string {
	return (text ?? '')
		.split(/\s+/u)
		.filter(Boolean)
		.join(' ')
		.replaceAll('<', '&lt;');
}

function cell(text: string): string {
	return text.replaceAll('|', String.raw`\|`);
}

function code(value: string): string {
	return value.includes('`') ? `\`\` ${value} \`\`` : `\`${value}\``;
}

function renderDefault(
	value: z.infer<typeof scalarSchema> | undefined
): string {
	if (value === undefined || value === '') {
		return '';
	}

	return code(String(value));
}

function table(
	headings: readonly string[],
	rows: readonly (readonly string[])[]
): string {
	return [
		`| ${headings.join(' | ')} |`,
		`| ${headings.map(() => '---').join(' | ')} |`,
		...rows.map((row) => `| ${row.map((text) => cell(text)).join(' | ')} |`)
	].join('\n');
}

const permissionRank: Record<PermissionLevel, number> = {
	none: 0,
	read: 1,
	write: 2
};

// A caller must grant every permission any job of the workflow requests, so
// report the strongest level per scope.
function callerPermissions(
	workflow: WorkflowDefinition
): readonly (readonly [string, PermissionLevel])[] {
	const strongest = new Map<string, PermissionLevel>();

	for (const job of Object.values(workflow.jobs)) {
		const requested = Object.entries(job.permissions ?? {});

		for (const [scope, level] of requested) {
			const current = strongest.get(scope);

			if (
				current === undefined ||
				permissionRank[level] > permissionRank[current]
			) {
				strongest.set(scope, level);
			}
		}
	}

	return strongest
		.entries()
		.toArray()
		.toSorted(([a], [b]) => a.localeCompare(b));
}

function renderWorkflow(
	{ file, summary }: PublicWorkflow,
	workflow: WorkflowDefinition
): string {
	const call = workflow.on.workflow_call;
	const inputs = Object.entries(call.inputs ?? {});
	const secrets = Object.entries(call.secrets ?? {});
	const permissions = callerPermissions(workflow);
	const sections = [
		`### ${file}.yml`,
		summary,
		'```yaml\n' +
			`uses: underwhelmingperformance/cupboard/.github/workflows/${file}.yml@vX.Y.Z\n` +
			'```',
		'#### Permissions',
		'The calling job must grant:',
		permissions.map(([scope, level]) => `- \`${scope}: ${level}\``).join('\n'),
		'#### Inputs',
		table(
			['Input', 'Type', 'Default', 'Description'],
			inputs.map(([name, input]) => [
				code(name),
				input.type,
				input.required ? '**required**' : renderDefault(input.default),
				prose(input.description)
			])
		)
	];

	if (secrets.length > 0) {
		sections.push(
			'#### Secrets',
			table(
				['Secret', 'Required', 'Description'],
				secrets.map(([name, secret]) => [
					code(name),
					secret.required ? 'yes' : 'no',
					prose(secret.description)
				])
			)
		);
	}

	return sections.join('\n\n');
}

function renderAction(name: string, action: ActionDefinition): string {
	const inputs = Object.entries(action.inputs ?? {});
	const outputs = Object.entries(action.outputs ?? {});
	const sections = [
		`### actions/${name}`,
		prose(action.description),
		'```yaml\n' +
			`uses: underwhelmingperformance/cupboard/actions/${name}@<commit> # vX.Y.Z\n` +
			'```',
		'#### Inputs',
		table(
			['Input', 'Default', 'Description'],
			inputs.map(([inputName, input]) => [
				code(inputName),
				input.required ? '**required**' : renderDefault(input.default),
				prose(input.description)
			])
		)
	];

	if (outputs.length > 0) {
		sections.push(
			'#### Outputs',
			table(
				['Output', 'Description'],
				outputs.map(([outputName, output]) => [
					code(outputName),
					prose(output.description)
				])
			)
		);
	}

	return sections.join('\n\n');
}

export function renderActionsReference(sources: ReferenceSources): string {
	const internal = internalActions
		.map((name) => `\`actions/${name}\``)
		.join(', ');

	return `${[
		'<!-- Generated by `pnpm update:actions-reference` from the action and workflow definitions. Do not edit by hand. -->',
		'# Actions and workflows reference',
		"The inputs, secrets, outputs and permissions of cupboard's reusable workflows and composite actions. [The CI guides](../README.md#publishing-from-github-actions) explain how to use them.",
		'Always reference them from `underwhelmingperformance/cupboard`: the actions locate their own code and releases relative to that repository. Pin reusable workflows to a release tag and actions to a full commit.',
		'## Reusable workflows',
		...sources.workflows.map(([publicWorkflow, workflow]) =>
			renderWorkflow(publicWorkflow, workflow)
		),
		'## Actions',
		...sources.actions.map(([name, action]) => renderAction(name, action)),
		'## Internal actions',
		`${internal} are building blocks of the reusable workflows. Their inputs are not a stable interface and can change in any release; call the reusable workflows instead.`
	].join('\n\n')}\n`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	writeFileSync(
		actionsReferencePath,
		renderActionsReference(readReferenceSources())
	);
}

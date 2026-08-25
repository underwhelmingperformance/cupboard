import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { z } from 'zod';

// The composite actions derive their toolchain from the workspace's own pins:
// pnpm from package.json's packageManager field and Node from .node-version.
// A version literal in an action.yml would drift from those pins and fail a
// caller's run on a network-restricted runner, so none may exist, and every
// action must derive the pins the same way.
const repositoryRoot = path.join(import.meta.dirname, '..');
const actionsDirectory = path.join(repositoryRoot, 'actions');
const githubActionsDocumentationPath = path.join(
	repositoryRoot,
	'docs',
	'github-actions.md'
);

const manifestSchema = z.object({
	packageManager: z.templateLiteral(['pnpm@', z.string()])
});

function actionFiles(): string[] {
	return readdirSync(actionsDirectory, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => path.join(actionsDirectory, entry.name, 'action.yml'))
		.filter((file) => existsSync(file));
}

const actionOutputSchema = z.looseObject({ value: z.string() });
const actionOutputsSchema = z.record(z.string(), actionOutputSchema);
const actionStepSchema = z.looseObject({
	env: z.record(z.string(), z.string()).optional()
});
const actionRunsSchema = z.looseObject({
	steps: z.array(actionStepSchema).default([])
});
const actionSchema = z.looseObject({
	outputs: actionOutputsSchema.default({}),
	runs: actionRunsSchema
});

function actionDocument(action: string) {
	const document: unknown = parse(
		readFileSync(path.join(actionsDirectory, action, 'action.yml'), 'utf8')
	);

	return actionSchema.parse(document);
}

/**
 * Each output of a composite action, mapped to the expression it publishes.
 */
function actionOutputs(action: string): Record<string, string> {
	return Object.fromEntries(
		Object.entries(actionDocument(action).outputs).map(([name, output]) => [
			name,
			output.value
		])
	);
}

function actionSteps(action: string) {
	return actionDocument(action).runs.steps;
}

const manifestPath = path.join(repositoryRoot, 'package.json');
const ciWorkflowPath = path.join(
	repositoryRoot,
	'.github',
	'workflows',
	'ci.yml'
);
const releaseWorkflowPath = path.join(
	repositoryRoot,
	'.github',
	'workflows',
	'release.yml'
);

function manifestPnpmVersion(): string {
	const manifest = manifestSchema.parse(
		JSON.parse(readFileSync(manifestPath, 'utf8'))
	);

	// The field may carry a corepack integrity suffix (`+sha512.<hash>`);
	// the actions install by bare version, so parity compares that.
	return manifest.packageManager.replace(/^pnpm@/, '').replace(/\+[^+]*$/, '');
}

// The same extraction the toolchain step in each action.yml runs.
function derivedPnpmVersion(): string | undefined {
	const source = readFileSync(manifestPath, 'utf8');
	const [first] = source.matchAll(
		/"packageManager": *"pnpm@(?<version>[^+"]*)/g
	);

	return first?.groups?.version;
}

describe('composite action toolchain derivation', () => {
	const files = actionFiles();
	const bodies = new Map(
		files.map((file) => [file, readFileSync(file, 'utf8')])
	);

	it('finds the composite actions', () => {
		expect(files.length).toBeGreaterThan(0);
	});

	it('derives the pnpm version the manifest pins', () => {
		expect(derivedPnpmVersion()).toBe(manifestPnpmVersion());
	});

	it('pins a plain Node version for node-version-file', () => {
		const nodeVersion = readFileSync(
			path.join(repositoryRoot, '.node-version'),
			'utf8'
		).trim();

		expect(nodeVersion).toMatch(/^\d+\.\d+\.\d+$/);
	});

	it.each(files.map((file) => [path.relative(repositoryRoot, file), file]))(
		'%s derives its toolchain and hardcodes no version',
		(_label, file) => {
			const body = bodies.get(file) ?? '';
			const hasPnpmInstall = body.includes('pnpm/action-setup');
			const hasNodeInstall = body.includes('actions/setup-node');

			expect({
				derivesPnpm: body.includes(
					'version: ${{ steps.toolchain.outputs.pnpm-version }}'
				),
				derivesNode:
					body.includes(
						'node-version: ${{ steps.toolchain.outputs.node-version }}'
					) && body.includes('echo "node-version=$node_version"'),
				usesCallerRelativeNodeVersionFile: body.includes('node-version-file:'),
				versionLiterals: body
					.matchAll(/(?:PNPM_VERSION|node-version): *'?[\d.]+'?/g)
					.toArray()
			}).toStrictEqual({
				derivesPnpm: hasPnpmInstall,
				derivesNode: hasNodeInstall,
				usesCallerRelativeNodeVersionFile: false,
				versionLiterals: []
			});
		}
	);

	it('pins one setup-node revision across every action', () => {
		const revisions = new Set(
			files
				.flatMap((file) =>
					(bodies.get(file) ?? '')
						.matchAll(/uses: (?<pin>actions\/setup-node@\S+)/g)
						.toArray()
				)
				.map((pin) => pin.groups?.pin)
		);

		expect([...revisions]).toHaveLength(1);
	});
});

describe('source acquisition smoke', () => {
	it('runs the setup action from a canonical source coordinate in CI', () => {
		const workflow = readFileSync(ciWorkflowPath, 'utf8');

		expect({
			canonicalSource: workflow.includes(
				'\'{kind:"source", $repository, $sourceCommit}\''
			),
			setupInput: workflow.includes(
				'cupboard: ${{ steps.source.outputs.cupboard }}'
			),
			checksVersion: workflow.includes(
				'test "$("$CUPBOARD_PATH" --version)" = "$expected"'
			),
			checksHookRelay: workflow.includes(
				'/libexec/cupboard/cupboard-hook-relay"'
			)
		}).toStrictEqual({
			canonicalSource: true,
			setupInput: true,
			checksVersion: true,
			checksHookRelay: true
		});
	});
});

describe('release acquisition smoke', () => {
	it('validates and canonicalises the release input before building every asset', () => {
		const workflow = readFileSync(releaseWorkflowPath, 'utf8');
		const compactWorkflow = workflow.replaceAll(/\s+/gu, ' ');
		const validationJob = workflow.indexOf('  validate:');
		const buildJob = workflow.indexOf('  build:');

		expect({
			validationPrecedesBuild:
				workflow.includes('  validate:') && validationJob < buildJob,
			validatesExactVersion: workflow.includes(
				'[[ ! "${INPUT_VERSION}" =~ ^v?(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$ ]]'
			),
			canonicalConcurrency: compactWorkflow.includes(
				"group: ${{ github.workflow }}-${{ startsWith(inputs.version, 'v') && inputs.version || format('v{0}', inputs.version) }}"
			),
			buildUsesValidatedVersion: workflow.includes(
				'VERSION: ${{ needs.validate.outputs.version }}'
			),
			checksHookRelay:
				workflow.includes('cupboard-hook-relay') ||
				readFileSync(ciWorkflowPath, 'utf8').includes(
					'$(dirname "$CUPBOARD_PATH")/cupboard-hook-relay'
				)
		}).toStrictEqual({
			validationPrecedesBuild: true,
			validatesExactVersion: true,
			canonicalConcurrency: true,
			buildUsesValidatedVersion: true,
			checksHookRelay: true
		});
	});
});

describe('documentation action pins', () => {
	it('pins checkout independently from the example cupboard revision', () => {
		const documentation = readFileSync(githubActionsDocumentationPath, 'utf8');
		const checkoutUses = documentation
			.matchAll(/uses: actions\/checkout@(?<revision>\S+) # (?<version>\S+)/g)
			.map((match) => ({
				revision: match.groups?.revision,
				version: match.groups?.version
			}))
			.toArray();

		expect(checkoutUses).toStrictEqual([
			{
				revision: '3d3c42e5aac5ba805825da76410c181273ba90b1',
				version: 'v7.0.1'
			},
			{
				revision: '3d3c42e5aac5ba805825da76410c181273ba90b1',
				version: 'v7.0.1'
			},
			{
				revision: '3d3c42e5aac5ba805825da76410c181273ba90b1',
				version: 'v7.0.1'
			},
			{
				revision: '3d3c42e5aac5ba805825da76410c181273ba90b1',
				version: 'v7.0.1'
			}
		]);
	});
});

describe('canonical acquisition composition', () => {
	it('exposes the reusable acquisition JSON beside the resolved version', () => {
		expect(actionOutputs('setup')).toStrictEqual({
			'cupboard-path': '${{ steps.setup.outputs.cupboard-path }}',
			cupboard: '${{ steps.setup.outputs.cupboard }}',
			'cupboard-version': '${{ steps.setup.outputs.cupboard-version }}',
			'nix-config-file': '${{ steps.setup.outputs.nix-config-file }}'
		});
	});

	it('keeps the standalone push version output beside its path', () => {
		expect(actionOutputs('push')).toStrictEqual({
			'cupboard-path': '${{ steps.push.outputs.cupboard-path }}',
			'cupboard-version': '${{ steps.push.outputs.cupboard-version }}',
			'uploaded-paths': '${{ steps.push.outputs.uploaded-paths }}',
			'reused-blobs': '${{ steps.push.outputs.reused-blobs }}',
			'skipped-paths': '${{ steps.push.outputs.skipped-paths }}',
			'uploaded-bytes': '${{ steps.push.outputs.uploaded-bytes }}'
		});
	});

	it.each(['setup', 'push'])(
		'%s passes the release repository the caller named',
		(action) => {
			const steps = actionSteps(action).filter(
				(step) => step.env?.RELEASE_REPOSITORY !== undefined
			);

			// A fallback to `github.action_repository` would look for releases in the
			// repository the caller pinned the action from, which is not always the
			// repository that publishes them.
			expect(steps.map((step) => step.env?.RELEASE_REPOSITORY)).toStrictEqual([
				'${{ inputs.release-repository }}'
			]);
		}
	);
});

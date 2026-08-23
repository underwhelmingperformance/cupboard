import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
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
	it('documents reusable acquisition JSON beside the legacy version output', () => {
		const setupAction = readFileSync(
			path.join(actionsDirectory, 'setup', 'action.yml'),
			'utf8'
		);

		expect({
			canonical: setupAction.includes(
				'cupboard:\n    description:\n      Pass this JSON to another setup invocation to acquire the same release or\n      source commit.\n    value: ${{ steps.setup.outputs.cupboard }}'
			),
			legacyVersion: setupAction.includes(
				'cupboard-version:\n    description: Resolved cupboard release tag; empty for source acquisition.\n    value: ${{ steps.setup.outputs.cupboard-version }}'
			)
		}).toStrictEqual({ canonical: true, legacyVersion: true });
	});

	it('keeps the standalone push version output beside its path', () => {
		const pushAction = readFileSync(
			path.join(actionsDirectory, 'push', 'action.yml'),
			'utf8'
		);

		expect(pushAction).toContain(
			'cupboard-version:\n    description: Version reported by the cupboard executable.\n    value: ${{ steps.push.outputs.cupboard-version }}'
		);
	});

	it.each(['setup', 'push'])(
		'%s leaves release-repository unset for canonical acquisition',
		(action) => {
			const body = readFileSync(
				path.join(actionsDirectory, action, 'action.yml'),
				'utf8'
			);

			expect({
				rawInput: body.includes(
					'RELEASE_REPOSITORY: ${{ inputs.release-repository }}'
				),
				actionRepositoryFallback: body.includes(
					'inputs.release-repository || github.action_repository'
				)
			}).toStrictEqual({
				rawInput: true,
				actionRepositoryFallback: false
			});
		}
	);
});

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

function manifestPnpmVersion(): string {
	const manifest = manifestSchema.parse(
		JSON.parse(readFileSync(manifestPath, 'utf8'))
	);

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

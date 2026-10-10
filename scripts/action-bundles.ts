import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { CodedError } from '@cupboard/shared/errors';
import { build } from 'esbuild';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const actions = [
	{ name: 'build-paths', entrypoints: ['main', 'post', 'worker'] },
	{ name: 'evaluate-targets', entrypoints: ['main', 'worker'] }
] as const;

class ActionBundleGenerationError extends CodedError {
	constructor(sourcePath: string) {
		super(`No action bundle was generated for ${sourcePath}.`);
		this.name = 'ActionBundleGenerationError';
	}
}

class ActionBundleStaleError extends CodedError {
	constructor(outputPath: string) {
		super(
			`${path.relative(repositoryRoot, outputPath)} is missing or stale. Run pnpm update:action-bundles.`
		);
		this.name = 'ActionBundleStaleError';
	}
}

/**
 * Generates a self-contained Node action from its TypeScript entrypoint.
 */
export async function renderActionBundle(sourcePath: string): Promise<string> {
	const result = await build({
		absWorkingDir: repositoryRoot,
		entryPoints: [sourcePath],
		bundle: true,
		format: 'cjs',
		platform: 'node',
		target: 'node24',
		minify: true,
		legalComments: 'eof',
		write: false,
		banner: {
			js: '// Generated from TypeScript by pnpm update:action-bundles.'
		}
	});
	const output = result.outputFiles[0];
	if (output === undefined) {
		throw new ActionBundleGenerationError(sourcePath);
	}

	return output.text;
}

async function updateActionBundles(shouldCheck: boolean): Promise<void> {
	for (const action of actions) {
		for (const entrypoint of action.entrypoints) {
			const sourcePath = path.join(
				repositoryRoot,
				'actions',
				'src',
				action.name,
				`${entrypoint}.ts`
			);
			const outputPath = path.join(
				repositoryRoot,
				'actions',
				action.name,
				'dist',
				`${entrypoint}.cjs`
			);
			const contents = await renderActionBundle(sourcePath);
			if (shouldCheck) {
				let recorded: string | undefined;
				try {
					recorded = await readFile(outputPath, 'utf8');
				} catch (error) {
					if (
						!(error instanceof Error) ||
						!('code' in error) ||
						error.code !== 'ENOENT'
					) {
						throw error;
					}
				}
				if (recorded !== contents) {
					throw new ActionBundleStaleError(outputPath);
				}
				continue;
			}

			await mkdir(path.dirname(outputPath), { recursive: true });
			await writeFile(outputPath, contents);
		}
	}
}

if (
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	await updateActionBundles(process.argv.includes('--check'));
}

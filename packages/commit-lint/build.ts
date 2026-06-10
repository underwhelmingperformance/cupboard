import { build } from 'esbuild';

import packageJson from './package.json' with { type: 'json' };

/**
 * Bundle the CLI into a single runnable file. Workspace-internal code (the
 * private `@cupboard/reporter`) and its presentation libraries are inlined so
 * the published package depends only on real, installable npm packages; those
 * declared `dependencies` are kept external so a consumer's install resolves
 * them (and `@commitlint/load` can still load presets dynamically at runtime).
 */
const external = new Set(Object.keys(packageJson.dependencies));

function packageRoot(specifier: string): string {
	const segments = specifier.split('/');

	if (specifier.startsWith('@')) {
		return `${segments[0] ?? ''}/${segments[1] ?? ''}`;
	}

	return segments[0] ?? '';
}

await build({
	banner: { js: '#!/usr/bin/env node' },
	bundle: true,
	entryPoints: ['src/main.ts'],
	format: 'esm',
	outfile: 'dist/main.js',
	platform: 'node',
	plugins: [
		{
			name: 'externalise-declared-dependencies',
			setup(pluginBuild) {
				pluginBuild.onResolve({ filter: /^[^./]/ }, (arguments_) => {
					if (
						arguments_.path.startsWith('node:') ||
						external.has(packageRoot(arguments_.path))
					) {
						return { external: true, path: arguments_.path };
					}

					return;
				});
			}
		}
	]
});

import type { BuildOptions } from 'esbuild';

/**
 * A bundled Worker ready to upload: the single ES module's source and the
 * filename the script metadata references as its `main_module`.
 */
export interface WorkerBundle {
	readonly mainModule: string;
	readonly code: string;
}

/**
 * Produces a {@link WorkerBundle} for a Worker entrypoint. Tree mode bundles the
 * live source with esbuild; embedded mode returns the bytes baked into the
 * binary at build time.
 */
export interface Bundler {
	bundle(entryPath: string, mainModule: string): Promise<WorkerBundle>;
}

// The same options wrangler's deployment bundle uses for a module Worker under
// `nodejs_compat`: keep `node:`/`cloudflare:` imports external (the runtime
// supplies them), resolve workerd's export conditions, and inline the Durable
// Object's `.sql` migration files as text. Validated by bundling both server
// Workers and running them in Miniflare.
const baseOptions: BuildOptions = {
	bundle: true,
	format: 'esm',
	platform: 'browser',
	target: 'es2022',
	conditions: ['workerd', 'worker', 'browser', 'import', 'module', 'default'],
	mainFields: ['module', 'main'],
	external: ['node:*', 'cloudflare:*'],
	loader: { '.sql': 'text' },
	define: { 'process.env.NODE_ENV': '"production"' },
	write: false,
	metafile: false
};

export class WorkerBundleError extends Error {
	constructor(entryPath: string, cause: string) {
		super(`Failed to bundle ${entryPath}:\n${cause}`);
		this.name = 'WorkerBundleError';
	}
}

/**
 * The esbuild-backed bundler used in tree mode. esbuild is imported lazily so it
 * stays out of the released single-executable, which only ever deploys embedded
 * bundles.
 */
export function createEsbuildBundler(): Bundler {
	return {
		async bundle(entryPath, mainModule) {
			const { build } = await import('esbuild');

			const result = await build({
				...baseOptions,
				entryPoints: [entryPath]
			}).catch((error: unknown) => {
				throw new WorkerBundleError(
					entryPath,
					error instanceof Error ? error.message : String(error)
				);
			});

			const output = result.outputFiles?.[0];

			if (output === undefined) {
				throw new WorkerBundleError(entryPath, 'esbuild produced no output');
			}

			return { mainModule, code: output.text };
		}
	};
}

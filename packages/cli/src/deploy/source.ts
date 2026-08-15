import { existsSync } from 'node:fs';
import path from 'node:path';

import { type ScriptName, scriptNameSchema } from './identifiers.ts';

/**
 * A Worker this command deploys: the script name Cloudflare knows it by, the
 * entry source (relative to the checkout root) used in tree mode, and the
 * filename its bundle is referenced by in the upload metadata.
 */
export interface WorkerEntry {
	readonly scriptName: ScriptName;
	readonly entryFile: string;
	readonly mainModule: string;
}

export const controlWorker: WorkerEntry = {
	scriptName: scriptNameSchema.parse('cupboard'),
	entryFile: 'packages/server/src/worker.ts',
	mainModule: 'worker.js'
};

export const tenantWorker: WorkerEntry = {
	scriptName: scriptNameSchema.parse('cupboard-tenant'),
	entryFile: 'packages/server/src/tenant-worker.ts',
	mainModule: 'tenant-worker.js'
};

export type RunMode = 'tree' | 'embedded';

/**
 * Where this invocation gets its Worker bytes. `tree` rebuilds from a checkout's
 * source; `embedded` uploads the bundles baked into the binary at release time.
 * `notice` carries a one-line explanation to surface to the user when the choice
 * is non-obvious (a released binary run inside a checkout).
 */
export interface WorkerSourcePlan {
	readonly mode: RunMode;
	readonly checkoutRoot: string | undefined;
	readonly notice: string | undefined;
}

export interface RunEnvironment {
	readonly isSea: boolean;
	readonly cwd: string;
	readonly fromTree: boolean;
	readonly isFilePresent: (filePath: string) => boolean;
}

export class NoCheckoutError extends Error {
	constructor(public readonly cwd: string) {
		super(
			'Tree mode needs a cupboard checkout, but none was found above the working directory.'
		);
		this.name = 'NoCheckoutError';
	}
}

/**
 * Walk upwards from `start` for the workspace root: the first directory holding
 * both `pnpm-workspace.yaml` and the server Worker source. Returns undefined
 * when run outside a checkout (the released binary's normal case).
 */
export function findCheckoutRoot(
	start: string,
	hasPath: (filePath: string) => boolean = existsSync
): string | undefined {
	let directory = start;

	for (;;) {
		const marker = path.join(directory, 'pnpm-workspace.yaml');
		const serverEntry = path.join(directory, controlWorker.entryFile);

		if (hasPath(marker) && hasPath(serverEntry)) {
			return directory;
		}

		const parent = path.dirname(directory);

		if (parent === directory) {
			return undefined;
		}

		directory = parent;
	}
}

/**
 * Decide whether to deploy from a checkout's source or the embedded bundles.
 *
 * Running unbuilt from source always deploys the working tree. The released
 * single-executable deploys its embedded bundles, except when invoked inside a
 * checkout: there it defaults to embedded with a pointer to `pnpm cli deploy`,
 * and only rebuilds from the tree when `--from-tree` is given.
 */
export function planWorkerSource(
	environment: RunEnvironment
): WorkerSourcePlan {
	const checkoutRoot = findCheckoutRoot(
		environment.cwd,
		environment.isFilePresent
	);

	if (!environment.isSea) {
		if (checkoutRoot === undefined) {
			throw new NoCheckoutError(environment.cwd);
		}

		return { mode: 'tree', checkoutRoot, notice: undefined };
	}

	if (checkoutRoot === undefined) {
		return { mode: 'embedded', checkoutRoot: undefined, notice: undefined };
	}

	if (environment.fromTree) {
		return {
			mode: 'tree',
			checkoutRoot,
			notice: `Deploying the Workers from the working tree at ${checkoutRoot}, not the bundles embedded in this binary.`
		};
	}

	return {
		mode: 'embedded',
		checkoutRoot,
		notice:
			'Running the released binary inside a checkout. Deploying its embedded bundles; pass --from-tree, or run `pnpm cli deploy`, to deploy the working tree instead.'
	};
}

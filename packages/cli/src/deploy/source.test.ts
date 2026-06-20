import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
	findCheckoutRoot,
	NoCheckoutError,
	planWorkerSource,
	type RunEnvironment
} from './source.ts';

function thrownBy(run: () => unknown): unknown {
	let thrown: unknown;

	try {
		run();
	} catch (error) {
		thrown = error;
	}

	return thrown;
}

// A checkout rooted at `/repo`: the workspace marker and the server entry exist
// under it and nowhere else.
function isInCheckout(filePath: string): boolean {
	return (
		filePath === '/repo/pnpm-workspace.yaml' ||
		filePath === '/repo/packages/server/src/worker.ts'
	);
}

function hasNoCheckout(): boolean {
	return false;
}

describe('findCheckoutRoot', () => {
	it('walks up to the workspace root', () => {
		expect(findCheckoutRoot('/repo/packages/cli/src', isInCheckout)).toBe(
			'/repo'
		);
	});

	it('returns undefined outside a checkout', () => {
		expect(findCheckoutRoot('/somewhere/else', hasNoCheckout)).toBeUndefined();
	});
});

function environment(overrides: Partial<RunEnvironment>): RunEnvironment {
	return {
		isSea: false,
		cwd: '/repo/packages/cli',
		fromTree: false,
		fileExists: isInCheckout,
		...overrides
	};
}

describe('planWorkerSource', () => {
	it('deploys the tree when run unbuilt from a checkout', () => {
		expect(planWorkerSource(environment({ isSea: false }))).toStrictEqual({
			mode: 'tree',
			checkoutRoot: '/repo',
			notice: undefined
		});
	});

	it('throws when run unbuilt outside a checkout', () => {
		const error = z
			.instanceof(NoCheckoutError)
			.parse(
				thrownBy(() =>
					planWorkerSource(
						environment({ isSea: false, fileExists: hasNoCheckout })
					)
				)
			);

		expect({ name: error.name, cwd: error.cwd }).toStrictEqual({
			name: 'NoCheckoutError',
			cwd: '/repo/packages/cli'
		});
	});

	it('deploys embedded bundles from the released binary outside a checkout', () => {
		expect(
			planWorkerSource(environment({ isSea: true, fileExists: hasNoCheckout }))
		).toStrictEqual({
			mode: 'embedded',
			checkoutRoot: undefined,
			notice: undefined
		});
	});

	it('defaults a released binary inside a checkout to embedded with a notice', () => {
		expect(planWorkerSource(environment({ isSea: true }))).toStrictEqual({
			mode: 'embedded',
			checkoutRoot: '/repo',
			notice:
				'Running the released binary inside a checkout. Deploying its embedded bundles; pass --from-tree, or run `pnpm cli deploy`, to deploy the working tree instead.'
		});
	});

	it('rebuilds from the tree when a released binary is given --from-tree', () => {
		expect(
			planWorkerSource(environment({ isSea: true, fromTree: true }))
		).toStrictEqual({
			mode: 'tree',
			checkoutRoot: '/repo',
			notice:
				'Deploying the Workers from the working tree at /repo, not the bundles embedded in this binary.'
		});
	});
});

import { describe, expect, it } from 'vitest';

import {
	findCheckoutRoot,
	NoCheckoutError,
	planWorkerSource,
	type RunEnvironment
} from './source.ts';

// A checkout rooted at `/repo`: the workspace marker and the server entry exist
// under it and nowhere else.
function inCheckout(filePath: string): boolean {
	return (
		filePath === '/repo/pnpm-workspace.yaml' ||
		filePath === '/repo/packages/server/src/worker.ts'
	);
}

function noCheckout(): boolean {
	return false;
}

describe('findCheckoutRoot', () => {
	it('walks up to the workspace root', () => {
		expect(findCheckoutRoot('/repo/packages/cli/src', inCheckout)).toBe(
			'/repo'
		);
	});

	it('returns undefined outside a checkout', () => {
		expect(findCheckoutRoot('/somewhere/else', noCheckout)).toBeUndefined();
	});
});

function environment(overrides: Partial<RunEnvironment>): RunEnvironment {
	return {
		isSea: false,
		cwd: '/repo/packages/cli',
		fromTree: false,
		fileExists: inCheckout,
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
		expect(() =>
			planWorkerSource(environment({ isSea: false, fileExists: noCheckout }))
		).toThrow(NoCheckoutError);
	});

	it('deploys embedded bundles from the released binary outside a checkout', () => {
		expect(
			planWorkerSource(environment({ isSea: true, fileExists: noCheckout }))
		).toStrictEqual({
			mode: 'embedded',
			checkoutRoot: undefined,
			notice: undefined
		});
	});

	it('defaults a released binary inside a checkout to embedded with a notice', () => {
		const plan = planWorkerSource(environment({ isSea: true }));

		expect(plan.mode).toBe('embedded');
		expect(plan.checkoutRoot).toBe('/repo');
		expect(plan.notice).toContain('--from-tree');
	});

	it('rebuilds from the tree when a released binary is given --from-tree', () => {
		const plan = planWorkerSource(environment({ isSea: true, fromTree: true }));

		expect(plan.mode).toBe('tree');
		expect(plan.checkoutRoot).toBe('/repo');
		expect(plan.notice).toContain('/repo');
	});
});

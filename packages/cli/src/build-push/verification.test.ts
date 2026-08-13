import type { NixBuildSettings } from '@cupboard/nix';
import type { DerivationBuildRequirements } from '@cupboard/nix-store/derivation';
import { describe, expect, it } from 'vitest';

import { UnverifiableTargetError } from '../errors.ts';

import {
	requireVerifiableTargets,
	type VerificationSupportOptions
} from './verification.ts';

const nativeDrv = '/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-app.drv';
const foreignDrv = '/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-app.drv';
const featureDrv = '/nix/store/cccccccccccccccccccccccccccccccc-app.drv';

const requirements: ReadonlyMap<string, DerivationBuildRequirements> = new Map([
	[nativeDrv, { system: 'x86_64-linux', requiredSystemFeatures: [] }],
	[foreignDrv, { system: 'aarch64-darwin', requiredSystemFeatures: [] }],
	[
		featureDrv,
		{ system: 'x86_64-linux', requiredSystemFeatures: ['big-parallel', 'kvm'] }
	]
]);

const coordinator: NixBuildSettings = {
	systems: ['x86_64-linux', 'i686-linux'],
	features: ['big-parallel'],
	builders: 'ssh://builds.example aarch64-darwin - 8'
};

// Every read is recorded, so a case that refuses without reading anything is
// visible as an empty list rather than as an absent assertion.
function optionsFor(
	overrides: Partial<VerificationSupportOptions>,
	read: string[]
): VerificationSupportOptions {
	return {
		verifyRebuilds: true,
		installables: [],
		building: coordinator,
		requirements: (drvPath) => {
			read.push(drvPath);
			const found = requirements.get(drvPath);

			if (found === undefined) {
				throw new Error(`no fixture for ${drvPath}`);
			}

			return Promise.resolve(found);
		},
		...overrides
	};
}

describe('requireVerifiableTargets', () => {
	it.each([
		{
			name: 'every target builds on this machine',
			overrides: { installables: [`${nativeDrv}^*`] },
			read: [nativeDrv]
		},
		{
			name: 'a target requires a feature this machine offers',
			overrides: {
				installables: [`${featureDrv}^*`],
				building: { ...coordinator, features: ['big-parallel', 'kvm'] }
			},
			read: [featureDrv]
		},
		{
			name: 'the run does not verify its rebuilds',
			overrides: {
				verifyRebuilds: false,
				installables: [`${foreignDrv}^*`]
			},
			read: []
		},
		{
			name: 'no remote builders are configured',
			overrides: {
				installables: [`${foreignDrv}^*`],
				building: { systems: coordinator.systems, features: [] }
			},
			read: []
		},
		{
			name: 'nothing names this machine',
			overrides: {
				installables: [`${foreignDrv}^*`],
				building: { ...coordinator, systems: [] }
			},
			read: []
		},
		{
			name: 'no installable names a derivation',
			overrides: {
				installables: [
					'.#app',
					'/nix/store/dddddddddddddddddddddddddddddddd-app'
				]
			},
			read: []
		}
	])('admits a run where $name', async ({ overrides, read }) => {
		const readPaths: string[] = [];

		await expect(
			requireVerifiableTargets(optionsFor(overrides, readPaths))
		).resolves.toBeUndefined();

		expect(readPaths).toStrictEqual(read);
	});

	it.each([
		{
			name: 'a target built for another system',
			overrides: { installables: [`${foreignDrv}^*`] },
			targets: [
				{ drvPath: foreignDrv, system: 'aarch64-darwin', missingFeatures: [] }
			]
		},
		{
			name: 'a target requiring a feature this machine lacks',
			overrides: { installables: [`${featureDrv}^out`] },
			targets: [
				{
					drvPath: featureDrv,
					system: 'x86_64-linux',
					missingFeatures: ['kvm']
				}
			]
		},
		{
			name: 'a mixed target set, naming only what does not fit',
			overrides: {
				installables: [nativeDrv, `${foreignDrv}^*`, `${featureDrv}^*`]
			},
			targets: [
				{ drvPath: foreignDrv, system: 'aarch64-darwin', missingFeatures: [] },
				{
					drvPath: featureDrv,
					system: 'x86_64-linux',
					missingFeatures: ['kvm']
				}
			]
		}
	])('refuses a run declaring $name', async ({ overrides, targets }) => {
		let thrown: unknown;

		try {
			await requireVerifiableTargets(optionsFor(overrides, []));
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(UnverifiableTargetError);

		if (!(thrown instanceof UnverifiableTargetError)) {
			return;
		}

		expect({
			name: thrown.name,
			targets: thrown.targets,
			systems: thrown.systems,
			features: thrown.features,
			exitCode: thrown.exitCode
		}).toStrictEqual({
			name: 'UnverifiableTargetError',
			targets,
			systems: coordinator.systems,
			features: coordinator.features,
			exitCode: 2
		});
	});
});

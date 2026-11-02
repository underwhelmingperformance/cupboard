import {
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { buildReceiptV3Schema } from '@cupboard/protocol/build';
import { describe, expect, it, vi } from 'vitest';

import {
	cohortPublicationFootprints,
	type CohortPublicationSnapshot
} from './cohort-publication.ts';

const storePath = (name: string) =>
	storePathSchema.parse(`/nix/store/${'0'.repeat(32)}-${name}`);
const app = storePath('app');
const sibling = storePath('sibling');
const appDevelopment = storePath('app-dev');
const tool = storePath('tool');
const floatingTool = storePath('floating-tool');
const upstream = storePath('upstream');
const omitted = storePath('omitted');
const runtime = storePath('runtime');
const appDerivation = storePath('app.drv');
const siblingDerivation = storePath('sibling.drv');
const toolDerivation = storePath('tool.drv');
const floatingDerivation = storePath('floating-tool.drv');

function snapshot(): CohortPublicationSnapshot {
	return {
		receipt: buildReceiptV3Schema.parse({
			version: 3,
			paths: [
				app,
				sibling,
				appDevelopment,
				tool,
				floatingTool,
				upstream,
				runtime
			],
			leftUpstream: [upstream],
			subjects: [
				{
					origin: 'built',
					storePath: app,
					derivation: appDerivation,
					buildStore: 'auto',
					verification: 'local',
					narHash: '00'.repeat(32)
				},
				{
					origin: 'built',
					storePath: appDevelopment,
					derivation: appDerivation,
					buildStore: 'auto',
					verification: 'local',
					narHash: '00'.repeat(32)
				},
				{
					origin: 'built',
					storePath: sibling,
					derivation: siblingDerivation,
					buildStore: 'auto',
					verification: 'local',
					narHash: '00'.repeat(32)
				},
				{
					origin: 'built',
					storePath: floatingTool,
					derivation: floatingDerivation,
					buildStore: 'auto',
					verification: 'local',
					narHash: '00'.repeat(32)
				}
			]
		}),
		targets: [app, sibling],
		owners: new Map([
			[app, new Set(['shared-root'])],
			[sibling, new Set(['shared-root'])]
		]),
		targetDerivations: new Map([
			[app, new Set([appDerivation])],
			[sibling, new Set([siblingDerivation])]
		]),
		dependencyOutputs: [
			{ storePath: tool, requiredBy: [appDerivation] },
			{ storePath: upstream, requiredBy: [appDerivation] },
			{ storePath: omitted, requiredBy: [appDerivation] }
		],
		graph: {
			closure: [],
			outputs: [],
			floatingOutputs: [],
			substitutableDerivations: [],
			derivationDependencies: [
				{
					derivation: appDerivation,
					inputs: [toolDerivation, floatingDerivation]
				},
				{ derivation: siblingDerivation, inputs: [] }
			]
		},
		incompleteRoots: new Set(),
		resolveClosure: vi.fn((_paths: readonly StorePathString[]) =>
			Promise.resolve(
				[app, runtime, upstream, omitted].map((output) => ({
					storePath: output
				}))
			)
		)
	};
}

describe('cohortPublicationFootprints', () => {
	it('captures required build tools and observed floating tools, excluding siblings, omitted paths and deliberately upstream artifacts', async () => {
		const input = snapshot();
		const footprints = await cohortPublicationFootprints(input, 'built');
		expect(footprints.get(app)).toEqual([app, floatingTool, tool]);
		expect(footprints.get(sibling)).toEqual([sibling]);
		expect(input.resolveClosure).not.toHaveBeenCalled();
	});

	it('does not invent unknown output members from the graph or expand output-only publication', async () => {
		const input = snapshot();
		const footprints = await cohortPublicationFootprints(input, 'outputs');
		expect([...footprints]).toEqual([
			[app, [app]],
			[sibling, [sibling]]
		]);
		expect(input.resolveClosure).not.toHaveBeenCalled();
	});

	it('intersects an explicitly requested runtime closure with the actual accepted selection', async () => {
		const input = snapshot();
		const footprints = await cohortPublicationFootprints(
			{ ...input, targets: [app] },
			'closure'
		);
		expect(footprints.get(app)).toEqual([app, runtime]);
		expect(input.resolveClosure).toHaveBeenCalledWith([app]);
	});

	it('does not capture deliberately upstream or failed result outputs', async () => {
		const input = snapshot();
		const footprints = await cohortPublicationFootprints(
			{
				...input,
				targets: [app, upstream, omitted, sibling],
				receipt: { ...input.receipt, failed: [sibling] }
			},
			'built'
		);
		expect(footprints.keys().toArray()).toEqual([app]);
	});
});

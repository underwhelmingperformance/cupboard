import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { PublishTarget } from '../../actions/src/publish-plan.ts';
import { discoverNixStoreConfig } from '../../packages/nix/src/index.ts';
import { parseFlakeLockRevision } from '../../scripts/conformance-oracle.ts';
import {
	createDivertedStoreDirectory,
	createDivertedStorePlanner,
	removeDivertedStore
} from '../../scripts/measure-realisation/diverted-store.ts';
import { measureRealisation } from '../../scripts/measure-realisation/measurement.ts';

// The fixture measures the exact nixpkgs revision this repository pins, so a
// registry update cannot change the e2e underneath the code being tested. The
// unit suites already cover parsing and aggregation with injected answers.
const nixpkgsRevision = parseFlakeLockRevision(
	readFileSync(path.resolve('flake.lock'), 'utf8')
);
const flake = `github:NixOS/nixpkgs/${nixpkgsRevision}`;
const isNixPresent =
	spawnSync('nix', ['--version'], { stdio: 'ignore' }).status === 0;

function target(attribute: string): PublishTarget {
	return {
		attr: attribute,
		system: 'unused',
		os: 'unused',
		remote: false,
		bestEffort: false,
		rootSuffix: attribute,
		outputs: ['out'],
		cohort: 'tools'
	};
}

describe.skipIf(!isNixPresent)('measure-realisation end to end', () => {
	it(
		'measures each target apart and both together against an empty store',
		{ timeout: 600_000 },
		async () => {
			const prefix = path.join(tmpdir(), 'cupboard-realisation-e2e-');
			const directory = await createDivertedStoreDirectory(
				await mkdtemp(prefix)
			);

			try {
				const report = await measureRealisation({
					flake,
					substituters: ['https://cache.nixos.org'],
					targets: [target('hello'), target('cowsay')],
					planner: createDivertedStorePlanner({
						flake,
						storeDirectory: discoverNixStoreConfig().storeDirectory,
						directory,
						substituters: ['https://cache.nixos.org']
					})
				});
				const combined = report.combined;

				expect({
					attrs: report.targets.map((measured) => measured.attr),
					groups: report.groups.map((group) => group.key),
					// Every target is substitutable from the public cache, so a cold
					// runner fetches all of them and builds none.
					builds: report.targets.map(
						(measured) => measured.measurement.willBuild
					),
					fetchesSomething: report.targets.every(
						(measured) => measured.measurement.willSubstitute > 0
					),
					// The two share their whole toolchain closure, so realising them
					// together costs less than realising them one at a time.
					groupedIsCheaper:
						combined !== undefined &&
						combined.comparison.together.narSize <
							combined.comparison.apart.narSize
				}).toStrictEqual({
					attrs: ['hello', 'cowsay'],
					groups: ['tools'],
					builds: [0, 0],
					fetchesSomething: true,
					groupedIsCheaper: true
				});
			} finally {
				await removeDivertedStore(directory);
			}
		}
	);
});

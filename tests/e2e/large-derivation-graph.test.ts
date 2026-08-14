import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
	materialiseDerivationGraph,
	runNixDerivationShow
} from '../../actions/src/commands/build-cohort.ts';
import { defaultNixConfigEnvironment } from '../../packages/nix/src/store-config.ts';
import { makeWritable, temporaryRoot } from '../support/filesystem.ts';
import { isolatedEnvironment } from '../support/nix.ts';

const isNixPresent =
	spawnSync('nix', ['--version'], { stdio: 'ignore' }).status === 0;

// Ten derivations, each carrying a two-mebibyte environment value, produce
// a derivation graph whose JSON is well over the 16 MiB capture limit.
const derivationCount = 10;
const paddingBytes = 2 * 1024 * 1024;

interface Fixture {
	readonly root: string;
	readonly installable: string;
	readonly storeUri: string;
}

const state: { fixture?: Fixture; hostEnvironment?: NodeJS.ProcessEnv } = {};

function fixture(): Fixture {
	const prepared = state.fixture;

	if (prepared === undefined) {
		throw new Error('The large derivation graph fixture was not prepared');
	}

	return prepared;
}

function replaceProcessEnvironment(environment: NodeJS.ProcessEnv): void {
	for (const name of Object.keys(process.env)) {
		Reflect.deleteProperty(process.env, name);
	}

	Object.assign(process.env, environment);
}

function system(): string {
	const value = defaultNixConfigEnvironment.currentSystem();

	if (value === undefined) {
		throw new Error('Nix did not report a current system');
	}

	return value;
}

beforeAll(async () => {
	if (!isNixPresent) {
		return;
	}

	state.hostEnvironment = { ...process.env };

	const root = await mkdtemp(
		path.join(temporaryRoot, 'cupboard-large-derivation-graph-')
	);
	const source = path.join(root, 'source');
	const storeRoot = path.join(root, 'store');
	const home = path.join(root, 'home');
	await mkdir(source, { recursive: true });
	await mkdir(storeRoot, { recursive: true });

	const layers = Array.from(
		{ length: derivationCount },
		(_ignored, index) => `
    d${String(index)} = derivation {
      name = "cupboard-large-graph-${String(index)}";
      system = "${system()}";
      builder = "/bin/sh";
      args = [ "-c" "echo done > $out" ];
      padding = big;${index === 0 ? '' : `\n      previous = d${String(index - 1)};`}
    };`
	).join('');

	await writeFile(
		path.join(source, 'flake.nix'),
		`{
  outputs = { self }: rec {
    big = "${'x'.repeat(paddingBytes)}";${layers}
    packages.${system()}.default = d${String(derivationCount - 1)};
  };
}
`
	);

	replaceProcessEnvironment({
		...(await isolatedEnvironment(home)),
		NIX_REMOTE: `local?root=${storeRoot}`
	});

	state.fixture = {
		root,
		installable: `path:${source}#packages.${system()}.default^out`,
		storeUri: `local?root=${storeRoot}`
	};
}, 120_000);

afterAll(async () => {
	const hostEnvironment = state.hostEnvironment;

	if (hostEnvironment !== undefined) {
		replaceProcessEnvironment(hostEnvironment);
	}

	const prepared = state.fixture;

	if (prepared !== undefined) {
		await makeWritable(prepared.root);
		await rm(prepared.root, { force: true, recursive: true });
	}
}, 120_000);

describe.skipIf(!isNixPresent)(
	'a derivation graph larger than the capture limit',
	() => {
		it('is materialised in full, because nothing reads the graph output', async () => {
			const prepared = fixture();

			await materialiseDerivationGraph([prepared.installable], undefined, {
				evalStore: prepared.storeUri
			});
		}, 300_000);

		// Proves the fixture is genuinely larger than the capture limit;
		// the materialisation test above means nothing for a small graph.
		it('exceeds the captured evaluation path byte limit', async () => {
			const prepared = fixture();

			await expect(
				runNixDerivationShow([prepared.installable], undefined, true, {
					evalStore: prepared.storeUri
				})
			).rejects.toMatchObject({ name: 'CommandOutputTooLargeError' });
		}, 300_000);
	}
);

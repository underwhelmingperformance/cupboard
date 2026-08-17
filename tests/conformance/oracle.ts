import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, it } from 'vitest';

import {
	type NixOptions,
	type NixResult,
	type NixSettingTable,
	oracleFileName,
	oracleFilePath,
	type OracleRecord,
	type OracleSystem,
	parseOracleRecord,
	readNixSettingTable,
	readNixSystem,
	readNixVersion,
	resolveConformanceNixBinary,
	runNix
} from '../../scripts/conformance-oracle.ts';
import { withTemporaryDirectory } from '../support/filesystem.ts';
import { isolatedEnvironment } from '../support/nix.ts';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');

/**
The recorded Nix version, loaded once for test assertions.
*/
export const recordedOracle: OracleRecord = parseOracleRecord(
	readFileSync(path.join(import.meta.dirname, oracleFileName), 'utf8')
);

export class OracleVersionDriftError extends Error {
	constructor(
		public readonly system: OracleSystem,
		public readonly recorded: string,
		public readonly resolved: string
	) {
		super(
			`${oracleFilePath} records Nix version ${recorded} for ${system}, but ` +
				`the flake builds ${resolved}. Run \`pnpm update:conformance-oracle ` +
				`--system ${system}\` to refresh it.`
		);
		this.name = 'OracleVersionDriftError';
	}
}

/**
 * The Nix binary used as the reference for a conformance case. Every invocation
 * uses an environment supplied by the caller to select the fixture
 * configuration.
 */
export class Oracle {
	constructor(
		private readonly binary: string,
		public readonly system: OracleSystem,
		public readonly version: string
	) {}

	run(
		arguments_: readonly string[],
		options: NixOptions = {}
	): Promise<NixResult> {
		return runNix(this.binary, arguments_, options);
	}

	/**
	Reads the setting types and infers the integer widths for this Nix.
	*/
	readSettingTable(): Promise<NixSettingTable> {
		return readNixSettingTable(this.binary);
	}

	/**
	 * Runs a sibling tool from the resolved Nix installation, such as
	 * `nix-store`. Resolving the tool beside the `nix` binary avoids using a
	 * different Nix installation from `PATH`.
	 */
	runTool(
		tool: string,
		arguments_: readonly string[],
		options: NixOptions = {}
	): Promise<NixResult> {
		return runNix(
			path.join(path.dirname(this.binary), tool),
			arguments_,
			options
		);
	}
}

type OracleResolution =
	| { readonly kind: 'available'; readonly oracle: Oracle }
	| { readonly kind: 'drifted'; readonly error: OracleVersionDriftError };

async function resolveOracle(): Promise<OracleResolution> {
	const binary = await resolveConformanceNixBinary(repositoryRoot);

	const { system, version } = await withTemporaryDirectory(
		'cupboard-conformance-version-',
		async (home) => {
			const environment = await isolatedEnvironment(home);
			const [system, version] = await Promise.all([
				readNixSystem(binary, environment),
				readNixVersion(binary, environment)
			]);

			return { system, version };
		}
	);

	if (version !== recordedOracle.versions[system]) {
		return {
			kind: 'drifted',
			error: new OracleVersionDriftError(
				system,
				recordedOracle.versions[system],
				version
			)
		};
	}

	return { kind: 'available', oracle: new Oracle(binary, system, version) };
}

// Resolving costs a flake build, so each test file does it once and every case
// in the file shares the resolved binary.
const resolution = await resolveOracle();

/**
 * Declares a suite of cases that run against the pinned oracle.
 *
 * A machine that cannot build the oracle fails the suite, so a missing oracle
 * cannot produce a false pass. A machine that builds a version not in the record
 * reports a single failure instead: comparing our client against an unrecorded
 * `nix` would invalidate the recorded comparison target.
 */
export function describeConformance(
	name: string,
	body: (oracle: Oracle) => void
): void {
	if (resolution.kind === 'drifted') {
		const { error } = resolution;

		describe(name, () => {
			it('uses the Nix version recorded by the oracle', () => {
				throw error;
			});
		});

		return;
	}

	const { oracle } = resolution;

	describe(name, () => {
		body(oracle);
	});
}

import { describe, expect, it } from 'vitest';

import {
	checkConformanceOracle,
	type GeneratedSettingsRecord,
	IncompleteOracleProbeError,
	IncompleteOracleUpdateError,
	integerWidthOf,
	InvalidFlakeLockError,
	InvalidOracleFileError,
	InvalidOracleProbeError,
	InvalidSettingsDocumentError,
	type NixSettingTable,
	type NixSettingTypes,
	type OracleRecord,
	type OracleSystem,
	oracleSystems,
	type OracleWorkspace,
	parseFlakeLockRevision,
	parseOracleRecord,
	parseProbedOracle,
	parseSettingTypes,
	type ProbedOracle,
	renderSettingTypes,
	serialiseOracleRecord,
	SettingTypesVersionDriftError,
	UnknownIntegerWidthError,
	UnparsableFlakeLockError,
	UnparsableOracleFileError,
	UnparsableOracleProbeError,
	UnparsableSettingsDocumentError,
	updateConformanceOracle
} from './conformance-oracle.ts';

const pinnedRevision = 'b5aa0fbd538984f6e3d201be0005b4463d8b09f8';
const pinnedVersion = 'nix (Nix) 2.34.7';
const movedVersion = 'nix (Nix) 2.35.0';

const pinnedVersions: Readonly<Record<OracleSystem, string>> = {
	'x86_64-linux': pinnedVersion,
	'aarch64-linux': pinnedVersion,
	'x86_64-darwin': pinnedVersion,
	'aarch64-darwin': pinnedVersion
};

const pinnedSettingTypes: NixSettingTypes = {
	'keep-outputs': 'boolean',
	'log-lines': 'integer',
	substituters: 'list'
};

const pinnedSettingTable: NixSettingTable = {
	types: pinnedSettingTypes,
	integerWidths: { 'log-lines': 'uint64' }
};

function generatedSettings(
	versions: Readonly<Record<OracleSystem, string>>
): GeneratedSettingsRecord {
	return {
		'x86_64-linux': { generatedFromNix: versions['x86_64-linux'] },
		'aarch64-linux': { generatedFromNix: versions['aarch64-linux'] },
		'x86_64-darwin': { generatedFromNix: versions['x86_64-darwin'] },
		'aarch64-darwin': { generatedFromNix: versions['aarch64-darwin'] }
	};
}

const pinnedGenerated = generatedSettings(pinnedVersions);

async function captureError<T>(
	type: new (...parameters: never[]) => T,
	action: () => unknown
): Promise<T> {
	try {
		await action();
	} catch (error) {
		if (error instanceof type) {
			return error;
		}

		throw error;
	}

	throw new TypeError('expected the call to throw');
}

function flakeLock(revision: string): string {
	return JSON.stringify({
		nodes: {
			nixpkgs: {
				locked: {
					owner: 'NixOS',
					repo: 'nixpkgs',
					rev: revision,
					type: 'github'
				}
			},
			root: { inputs: { nixpkgs: 'nixpkgs' } }
		},
		root: 'root',
		version: 7
	});
}

/**
A workspace initialised with the record. It captures each write.
*/
function fakeWorkspace(record: OracleRecord | undefined): OracleWorkspace & {
	writes: string[];
	tables: { system: OracleSystem; text: string }[];
} {
	const writes: string[] = [];
	const tables: { system: OracleSystem; text: string }[] = [];

	return {
		writes,
		tables,
		readOracleFile: () => {
			if (record === undefined) {
				throw new Error('no such file');
			}

			return serialiseOracleRecord(record);
		},
		writeOracleFile: (text) => {
			writes.push(text);
		},
		writeSettingTypesFile: (system, text) => {
			tables.push({ system, text });
		}
	};
}

function fakeProbe(
	system: OracleSystem,
	version: string = pinnedVersion
): ProbedOracle {
	return { system, version, table: pinnedSettingTable };
}

describe('parseOracleRecord', () => {
	it('accepts a well-formed record', () => {
		const record: OracleRecord = {
			versions: pinnedVersions
		};

		expect(parseOracleRecord(serialiseOracleRecord(record))).toStrictEqual(
			record
		);
	});

	it('rejects unparsable JSON', async () => {
		const error = await captureError(UnparsableOracleFileError, () =>
			parseOracleRecord('{')
		);

		expect(error.cause).toBeInstanceOf(SyntaxError);
	});

	it.each<{
		name: string;
		text: string;
		issues: readonly { code: string; path: readonly PropertyKey[] }[];
	}>([
		{
			name: 'a JSON array',
			text: '[]',
			issues: [{ code: 'invalid_type', path: [] }]
		},
		{
			name: 'missing versions',
			text: '{}',
			issues: [{ code: 'invalid_type', path: ['versions'] }]
		},
		{
			name: 'a version outside the format printed by nix --version',
			text: `{ "versions": { "x86_64-linux": "2.34.7", "aarch64-linux": "${pinnedVersion}", "x86_64-darwin": "${pinnedVersion}", "aarch64-darwin": "${pinnedVersion}" } }`,
			issues: [{ code: 'invalid_format', path: ['versions', 'x86_64-linux'] }]
		},
		{
			name: 'a missing system',
			text: `{ "versions": { "x86_64-linux": "${pinnedVersion}", "aarch64-linux": "${pinnedVersion}", "x86_64-darwin": "${pinnedVersion}" } }`,
			issues: [{ code: 'custom', path: ['versions', 'aarch64-darwin'] }]
		},
		{
			name: 'an obsolete nixpkgs revision',
			text: `{ "versions": ${JSON.stringify(pinnedVersions)}, "nixpkgsRevision": "${pinnedRevision}" }`,
			issues: [{ code: 'unrecognized_keys', path: [] }]
		}
	])('rejects $name', async ({ text, issues }) => {
		const error = await captureError(InvalidOracleFileError, () =>
			parseOracleRecord(text)
		);

		expect(
			error.issues.map(({ code, path }) => ({ code, path }))
		).toStrictEqual(issues);
	});
});

describe('parseFlakeLockRevision', () => {
	it('reads the locked revision of the nixpkgs input', () => {
		expect(parseFlakeLockRevision(flakeLock(pinnedRevision))).toBe(
			pinnedRevision
		);
	});

	it('rejects unparsable JSON', async () => {
		const error = await captureError(UnparsableFlakeLockError, () =>
			parseFlakeLockRevision('{')
		);

		expect(error.cause).toBeInstanceOf(SyntaxError);
	});

	it.each<{
		name: string;
		text: string;
		issues: readonly { code: string; path: readonly PropertyKey[] }[];
	}>([
		{
			name: 'a lockfile with no nodes',
			text: '{}',
			issues: [{ code: 'invalid_type', path: ['nodes'] }]
		},
		{
			name: 'a lockfile that locks no nixpkgs',
			text: '{ "nodes": {} }',
			issues: [{ code: 'invalid_type', path: ['nodes', 'nixpkgs'] }]
		},
		{
			name: 'a nixpkgs input locked to a branch name',
			text: '{ "nodes": { "nixpkgs": { "locked": { "rev": "nixos-unstable" } } } }',
			issues: [
				{ code: 'invalid_format', path: ['nodes', 'nixpkgs', 'locked', 'rev'] }
			]
		}
	])('rejects $name', async ({ text, issues }) => {
		const error = await captureError(InvalidFlakeLockError, () =>
			parseFlakeLockRevision(text)
		);

		expect(
			error.issues.map(({ code, path }) => ({ code, path }))
		).toStrictEqual(issues);
	});
});

describe('checkConformanceOracle', () => {
	it('passes when the record and generated table use the same Nix version', () => {
		const workspace = fakeWorkspace({
			versions: pinnedVersions
		});

		expect(() => {
			checkConformanceOracle(workspace, pinnedGenerated);
		}).not.toThrow();
	});

	// The generated table controls validation of Nix settings. Its recorded
	// version must therefore match the oracle record.
	it('reports a table generated from another Nix version', async () => {
		const workspace = fakeWorkspace({
			versions: pinnedVersions
		});

		const error = await captureError(SettingTypesVersionDriftError, () => {
			checkConformanceOracle(
				workspace,
				generatedSettings({
					...pinnedVersions,
					'aarch64-darwin': movedVersion
				})
			);
		});

		expect({
			system: error.system,
			oracle: error.oracle,
			generated: error.generated
		}).toStrictEqual({
			system: 'aarch64-darwin',
			oracle: pinnedVersion,
			generated: movedVersion
		});
	});
});

describe('parseProbedOracle', () => {
	it('reads a typed table from a target-system probe', () => {
		const document = JSON.stringify({
			system: 'x86_64-linux',
			version: pinnedVersion,
			settings: {
				'keep-outputs': { value: false },
				'log-lines': { value: 25 }
			},
			acceptedWidthProbes: {
				'log-lines': {
					negative: false,
					unsignedThirtyTwo: true,
					signedSixtyFour: true,
					unsignedSixtyFour: true
				}
			}
		});

		expect(parseProbedOracle(document)).toStrictEqual({
			system: 'x86_64-linux',
			version: pinnedVersion,
			table: {
				types: { 'keep-outputs': 'boolean', 'log-lines': 'integer' },
				integerWidths: { 'log-lines': 'uint64' }
			}
		});
	});

	it('reports invalid probe JSON with its cause', async () => {
		const error = await captureError(UnparsableOracleProbeError, () =>
			parseProbedOracle('{')
		);

		expect(error.cause).toBeInstanceOf(SyntaxError);
	});

	it('reports a structurally invalid probe', () => {
		expect(() => parseProbedOracle('{}')).toThrow(InvalidOracleProbeError);
	});

	it('reports the integer setting omitted by the probe', async () => {
		const document = JSON.stringify({
			system: 'x86_64-linux',
			version: pinnedVersion,
			settings: {
				'log-lines': { value: 25 }
			},
			acceptedWidthProbes: {}
		});

		const error = await captureError(IncompleteOracleProbeError, () =>
			parseProbedOracle(document)
		);

		expect(error.setting).toBe('log-lines');
	});
});

describe('parseSettingTypes', () => {
	// Nix writes null in `experimentalFeature` when no feature gates a setting.
	it('reads the value type reported for each setting', () => {
		const document = [
			'{',
			'  "keep-outputs": { "value": false, "experimentalFeature": null },',
			'  "log-lines": { "value": 25, "experimentalFeature": null },',
			'  "store": { "value": "auto", "experimentalFeature": null },',
			'  "substituters": { "value": ["https://cache.nixos.org/"], "experimentalFeature": null },',
			'  "access-tokens": { "value": {}, "experimentalFeature": null }',
			'}'
		].join('\n');

		expect(parseSettingTypes(document)).toStrictEqual({
			'keep-outputs': 'boolean',
			'log-lines': 'integer',
			store: 'string',
			substituters: 'list',
			'access-tokens': 'map'
		});
	});

	it('reads the value type of a setting behind an experimental feature', () => {
		const document = [
			'{',
			'  "impure-env": { "value": {}, "experimentalFeature": "configurable-impure-env" },',
			'  "log-lines": { "value": 25, "experimentalFeature": null }',
			'}'
		].join('\n');

		expect(parseSettingTypes(document)).toStrictEqual({
			'impure-env': 'map',
			'log-lines': 'integer'
		});
	});

	it('reports invalid settings JSON with its cause', async () => {
		const error = await captureError(UnparsableSettingsDocumentError, () =>
			parseSettingTypes('{')
		);

		expect(error.cause).toBeInstanceOf(SyntaxError);
	});

	it('reports a structurally invalid settings document', async () => {
		const error = await captureError(InvalidSettingsDocumentError, () =>
			parseSettingTypes('[]')
		);

		expect(error.issues).toStrictEqual([
			{
				expected: 'record',
				code: 'invalid_type',
				path: [],
				message: 'Invalid input: expected record, received array'
			}
		]);
	});
});

describe('renderSettingTypes', () => {
	it('sorts the settings and quotes only non-identifier names', () => {
		const rendered = renderSettingTypes(
			'x86_64-linux',
			pinnedVersion,
			pinnedSettingTable
		);

		expect(rendered).toContain(
			`export const generatedFromNix = '${pinnedVersion}';`
		);
		expect(rendered.slice(rendered.indexOf('nixSettingTypes'))).toBe(
			[
				'nixSettingTypes: Readonly<Record<string, NixSettingValueType>> = {',
				"	'keep-outputs': 'boolean',",
				"	'log-lines': 'integer',",
				"	substituters: 'list'",
				'};',
				'',
				'// The width of each integer setting, inferred from the boundary values that',
				'// the pinned Nix accepts. `nix config show` does not report these widths.',
				'export const nixIntegerWidths: Readonly<Record<string, NixIntegerWidth>> = {',
				"	'log-lines': 'uint64'",
				'};',
				''
			].join('\n')
		);
	});
});

describe('integerWidthOf', () => {
	it.each([
		{
			name: 'an unsigned 32-bit setting',
			accepted: {
				negative: false,
				unsignedThirtyTwo: true,
				signedSixtyFour: false,
				unsignedSixtyFour: false
			},
			expected: 'uint32'
		},
		{
			name: 'an unsigned 64-bit setting',
			accepted: {
				negative: false,
				unsignedThirtyTwo: true,
				signedSixtyFour: true,
				unsignedSixtyFour: true
			},
			expected: 'uint64'
		},
		{
			name: 'a signed 64-bit setting',
			accepted: {
				negative: true,
				unsignedThirtyTwo: true,
				signedSixtyFour: true,
				unsignedSixtyFour: false
			},
			expected: 'int64'
		}
	])('infers $name from the accepted probes', ({ accepted, expected }) => {
		expect(integerWidthOf('a-setting', accepted)).toBe(expected);
	});

	// Reject an unrecognised probe result instead of recording incorrect bounds.
	it('refuses a combination that matches no supported width', () => {
		expect(() =>
			integerWidthOf('a-setting', {
				negative: true,
				unsignedThirtyTwo: false,
				signedSixtyFour: false,
				unsignedSixtyFour: true
			})
		).toThrow(UnknownIntegerWidthError);
	});
});

describe('updateConformanceOracle', () => {
	it('does not rewrite a current oracle record', () => {
		const workspace = fakeWorkspace({
			versions: pinnedVersions
		});

		const outcome = updateConformanceOracle(workspace, [
			fakeProbe('x86_64-linux')
		]);

		expect(outcome).toStrictEqual({
			kind: 'already-current',
			record: { versions: pinnedVersions }
		});
		expect(workspace.writes).toStrictEqual([]);
		expect(workspace.tables).toStrictEqual([
			{
				system: 'x86_64-linux',
				text: renderSettingTypes(
					'x86_64-linux',
					pinnedVersion,
					pinnedSettingTable
				)
			}
		]);
	});

	it('updates only the selected system in an existing record', () => {
		const workspace = fakeWorkspace({ versions: pinnedVersions });
		const written: OracleRecord = {
			versions: { ...pinnedVersions, 'aarch64-linux': movedVersion }
		};

		const outcome = updateConformanceOracle(workspace, [
			fakeProbe('aarch64-linux', movedVersion)
		]);

		expect(outcome).toStrictEqual({
			kind: 'recorded',
			record: written
		});
		expect(
			workspace.writes.map((text) => parseOracleRecord(text))
		).toStrictEqual([written]);
	});

	it('creates a complete record from probes for every system', () => {
		const workspace = fakeWorkspace(undefined);
		const probes = oracleSystems.map((system) => fakeProbe(system));

		const outcome = updateConformanceOracle(workspace, probes);

		expect(outcome).toStrictEqual({
			kind: 'recorded',
			record: { versions: pinnedVersions }
		});
	});

	it('reports missing systems when creating a record from a partial probe', async () => {
		const workspace = fakeWorkspace(undefined);

		const error = await captureError(IncompleteOracleUpdateError, () =>
			updateConformanceOracle(workspace, [fakeProbe('x86_64-linux')])
		);

		expect(error.missingSystems).toStrictEqual([
			'aarch64-linux',
			'x86_64-darwin',
			'aarch64-darwin'
		]);
		expect(workspace.tables).toStrictEqual([]);
	});
});

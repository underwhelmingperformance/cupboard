import { describe, expect, it } from 'vitest';

import {
	checkConformanceOracle,
	type GeneratedSettingsRecord,
	integerWidthOf,
	InvalidFlakeLockError,
	InvalidOracleFileError,
	type NixSettingTable,
	type NixSettingTypes,
	type OracleNix,
	type OracleRecord,
	type OracleWorkspace,
	parseFlakeLockRevision,
	parseOracleRecord,
	parseSettingTypes,
	renderSettingTypes,
	serialiseOracleRecord,
	SettingTypesVersionDriftError,
	UnknownIntegerWidthError,
	UnparsableFlakeLockError,
	UnparsableOracleFileError,
	UnreadableSettingsError,
	updateConformanceOracle
} from './conformance-oracle.ts';

const pinnedRevision = 'b5aa0fbd538984f6e3d201be0005b4463d8b09f8';
const pinnedVersion = 'nix (Nix) 2.34.7';
const movedVersion = 'nix (Nix) 2.35.0';

const pinnedSettingTypes: NixSettingTypes = {
	'keep-outputs': 'boolean',
	'log-lines': 'integer',
	substituters: 'list'
};

const pinnedSettingTable: NixSettingTable = {
	types: pinnedSettingTypes,
	integerWidths: { 'log-lines': 'uint64' }
};

const pinnedGenerated: GeneratedSettingsRecord = {
	version: pinnedVersion
};

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
function fakeWorkspace(
	record: OracleRecord | undefined
): OracleWorkspace & { writes: string[]; tables: string[] } {
	const writes: string[] = [];
	const tables: string[] = [];

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
		writeSettingTypesFile: (text) => {
			tables.push(text);
		}
	};
}

function fakeNix(version: string): OracleNix {
	return {
		readVersion: () => Promise.resolve(version),
		readSettingTable: () => Promise.resolve(pinnedSettingTable)
	};
}

describe('parseOracleRecord', () => {
	it('accepts a well-formed record', () => {
		const record: OracleRecord = {
			version: pinnedVersion
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
			name: 'a missing version',
			text: '{}',
			issues: [{ code: 'invalid_type', path: ['version'] }]
		},
		{
			name: 'a version outside the format printed by nix --version',
			text: '{ "version": "2.34.7" }',
			issues: [{ code: 'invalid_format', path: ['version'] }]
		},
		{
			name: 'an obsolete nixpkgs revision',
			text: `{ "version": "${pinnedVersion}", "nixpkgsRevision": "${pinnedRevision}" }`,
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
			version: pinnedVersion
		});

		expect(() => {
			checkConformanceOracle(workspace, pinnedGenerated);
		}).not.toThrow();
	});

	// The generated table controls validation of Nix settings. Its recorded
	// version must therefore match the oracle record.
	it('reports a table generated from another Nix version', async () => {
		const workspace = fakeWorkspace({
			version: pinnedVersion
		});

		const error = await captureError(SettingTypesVersionDriftError, () => {
			checkConformanceOracle(workspace, {
				version: movedVersion
			});
		});

		expect({ oracle: error.oracle, generated: error.generated }).toStrictEqual({
			oracle: pinnedVersion,
			generated: movedVersion
		});
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

	it.each([
		{ name: 'a document that is not JSON', document: '{' },
		{ name: 'a document of something else', document: '[]' }
	])('refuses $name', async ({ document }) => {
		await captureError(UnreadableSettingsError, () =>
			parseSettingTypes(document)
		);
	});
});

describe('renderSettingTypes', () => {
	it('sorts the settings and quotes only non-identifier names', () => {
		const rendered = renderSettingTypes(
			{ version: pinnedVersion },
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
	it('does not rewrite a current oracle record', async () => {
		const workspace = fakeWorkspace({
			version: pinnedVersion
		});

		const outcome = await updateConformanceOracle(
			workspace,
			fakeNix(pinnedVersion)
		);

		expect(outcome).toStrictEqual({
			kind: 'already-current',
			record: { version: pinnedVersion }
		});
		expect(workspace.writes).toStrictEqual([]);
		// Refresh the table even when the oracle record is already current.
		expect(workspace.tables).toStrictEqual([
			renderSettingTypes({ version: pinnedVersion }, pinnedSettingTable)
		]);
	});

	it.each<{
		name: string;
		recorded: OracleRecord | undefined;
		version: string;
		written: OracleRecord;
	}>([
		{
			name: 'the flake now builds a different Nix',
			recorded: { version: pinnedVersion },
			version: movedVersion,
			written: { version: movedVersion }
		},
		{
			name: 'there is no record yet',
			recorded: undefined,
			version: pinnedVersion,
			written: { version: pinnedVersion }
		}
	])('records the resolved Nix version when $name', async (testCase) => {
		const workspace = fakeWorkspace(testCase.recorded);

		const outcome = await updateConformanceOracle(
			workspace,
			fakeNix(testCase.version)
		);

		expect(outcome).toStrictEqual({
			kind: 'recorded',
			record: testCase.written
		});
		expect(
			workspace.writes.map((text) => parseOracleRecord(text))
		).toStrictEqual([testCase.written]);
	});
});

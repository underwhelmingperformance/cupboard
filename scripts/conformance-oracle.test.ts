import { describe, expect, it } from 'vitest';

import {
	checkConformanceOracle,
	type GeneratedSettingTypes,
	integerWidthOf,
	InvalidFlakeLockError,
	InvalidOracleFileError,
	type NixSettingTable,
	type NixSettingTypes,
	type OracleNix,
	type OracleRecord,
	OracleRevisionDriftError,
	type OracleWorkspace,
	parseFlakeLockRevision,
	parseOracleRecord,
	parseSettingTypes,
	renderSettingTypes,
	requiresConformanceOracle,
	serialiseOracleRecord,
	SettingTypesDriftError,
	UnknownIntegerWidthError,
	UnparsableFlakeLockError,
	UnparsableOracleFileError,
	UnreadableSettingsError,
	updateConformanceOracle
} from './conformance-oracle.ts';

const pinnedRevision = 'b5aa0fbd538984f6e3d201be0005b4463d8b09f8';
const movedRevision = 'f'.repeat(40);
const pinnedVersion = 'nix (Nix) 2.34.7';
const movedVersion = 'nix (Nix) 2.35.0';

describe('requiresConformanceOracle', () => {
	it.each([
		{ value: undefined, expected: false },
		{ value: '', expected: false },
		{ value: '0', expected: false },
		{ value: '1', expected: true }
	])(
		'reads the required-oracle environment value $value',
		({ value, expected }) => {
			expect(
				requiresConformanceOracle({
					CUPBOARD_REQUIRE_CONFORMANCE_ORACLE: value
				})
			).toBe(expected);
		}
	);
});

const pinnedSettingTypes: NixSettingTypes = {
	'keep-outputs': 'boolean',
	'log-lines': 'integer',
	substituters: 'list'
};

const pinnedSettingTable: NixSettingTable = {
	types: pinnedSettingTypes,
	integerWidths: { 'log-lines': 'uint64' }
};

const pinnedGenerated: GeneratedSettingTypes = {
	nixpkgsRevision: pinnedRevision,
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

/** A workspace holding the given lockfile and record, recording every write. */
function fakeWorkspace(
	revision: string,
	record: OracleRecord | undefined
): OracleWorkspace & { writes: string[]; tables: string[] } {
	const writes: string[] = [];
	const tables: string[] = [];

	return {
		writes,
		tables,
		readFlakeLock: () => flakeLock(revision),
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
			nixpkgsRevision: pinnedRevision,
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
			text: `{ "nixpkgsRevision": "${pinnedRevision}" }`,
			issues: [{ code: 'invalid_type', path: ['version'] }]
		},
		{
			name: 'a missing nixpkgs revision',
			text: `{ "version": "${pinnedVersion}" }`,
			issues: [{ code: 'invalid_type', path: ['nixpkgsRevision'] }]
		},
		{
			name: 'a version that is not what nix reports',
			text: `{ "nixpkgsRevision": "${pinnedRevision}", "version": "2.34.7" }`,
			issues: [{ code: 'invalid_format', path: ['version'] }]
		},
		{
			name: 'a revision that is not a git object name',
			text: `{ "nixpkgsRevision": "nixos-unstable", "version": "${pinnedVersion}" }`,
			issues: [{ code: 'invalid_format', path: ['nixpkgsRevision'] }]
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
	it('reads the revision the nixpkgs input is locked to', () => {
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
	it('passes when the record names the pinned nixpkgs', () => {
		const workspace = fakeWorkspace(pinnedRevision, {
			nixpkgsRevision: pinnedRevision,
			version: pinnedVersion
		});

		expect(() => {
			checkConformanceOracle(workspace, pinnedGenerated);
		}).not.toThrow();
	});

	it('reports both revisions when the lockfile has moved on', async () => {
		const workspace = fakeWorkspace(movedRevision, {
			nixpkgsRevision: pinnedRevision,
			version: pinnedVersion
		});

		const error = await captureError(OracleRevisionDriftError, () => {
			checkConformanceOracle(workspace, pinnedGenerated);
		});

		expect({ recorded: error.recorded, actual: error.actual }).toStrictEqual({
			recorded: pinnedRevision,
			actual: movedRevision
		});
	});

	// The table decides which settings the client reads and which values it
	// refuses, so one generated from another nixpkgs states a nix nobody runs.
	it('reports a table generated from a nixpkgs the lockfile has moved off', async () => {
		const workspace = fakeWorkspace(pinnedRevision, {
			nixpkgsRevision: pinnedRevision,
			version: pinnedVersion
		});

		const error = await captureError(SettingTypesDriftError, () => {
			checkConformanceOracle(workspace, {
				nixpkgsRevision: movedRevision,
				version: movedVersion
			});
		});

		expect({ recorded: error.recorded, actual: error.actual }).toStrictEqual({
			recorded: movedRevision,
			actual: pinnedRevision
		});
	});
});

describe('parseSettingTypes', () => {
	// The document is written as nix writes it, with a null naming the setting
	// no experimental feature gates.
	it('reads the kind of value each setting holds', () => {
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

	it('reads the value kind of a setting behind an experimental feature', () => {
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
	it('writes the settings sorted, quoting only the names that need it', () => {
		const rendered = renderSettingTypes(
			{ nixpkgsRevision: pinnedRevision, version: pinnedVersion },
			pinnedSettingTable
		);

		expect(rendered).toContain(
			`export const generatedFromNix = '${pinnedVersion}';`
		);
		expect(rendered).toContain(
			`export const generatedFromNixpkgs = '${pinnedRevision}';`
		);
		expect(rendered.slice(rendered.indexOf('nixSettingTypes'))).toBe(
			[
				'nixSettingTypes: Readonly<Record<string, NixSettingValueType>> = {',
				"	'keep-outputs': 'boolean',",
				"	'log-lines': 'integer',",
				"	substituters: 'list'",
				'};',
				'',
				'// The width nix declared each integer setting with, settled by asking the',
				'// pinned nix which values it takes. `nix config show` states none of this,',
				'// so a setting missing here is one no value can be bounded against.',
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
	])('reads $name from what it accepts', ({ accepted, expected }) => {
		expect(integerWidthOf('a-setting', accepted)).toBe(expected);
	});

	// A nix declaring a width this script has no reading for asks for one rather
	// than having the wrong bounds recorded for it.
	it('refuses a combination naming no width it knows', () => {
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
	it('leaves a current record alone', async () => {
		const workspace = fakeWorkspace(pinnedRevision, {
			nixpkgsRevision: pinnedRevision,
			version: pinnedVersion
		});

		const outcome = await updateConformanceOracle(
			workspace,
			fakeNix(pinnedVersion)
		);

		expect(outcome).toStrictEqual({
			kind: 'already-current',
			record: { nixpkgsRevision: pinnedRevision, version: pinnedVersion }
		});
		expect(workspace.writes).toStrictEqual([]);
		// The table is written from whichever nix the record names, so a record
		// that was already current still leaves the table current.
		expect(workspace.tables).toStrictEqual([
			renderSettingTypes(
				{ nixpkgsRevision: pinnedRevision, version: pinnedVersion },
				pinnedSettingTable
			)
		]);
	});

	it.each<{
		name: string;
		revision: string;
		recorded: OracleRecord | undefined;
		version: string;
		written: OracleRecord;
	}>([
		{
			name: 'the lockfile pins a different nixpkgs',
			revision: movedRevision,
			recorded: { nixpkgsRevision: pinnedRevision, version: pinnedVersion },
			version: pinnedVersion,
			written: { nixpkgsRevision: movedRevision, version: pinnedVersion }
		},
		{
			name: 'the same nixpkgs now builds a different nix',
			revision: pinnedRevision,
			recorded: { nixpkgsRevision: pinnedRevision, version: pinnedVersion },
			version: movedVersion,
			written: { nixpkgsRevision: pinnedRevision, version: movedVersion }
		},
		{
			name: 'there is no record yet',
			revision: pinnedRevision,
			recorded: undefined,
			version: pinnedVersion,
			written: { nixpkgsRevision: pinnedRevision, version: pinnedVersion }
		}
	])('records the resolved nix when $name', async (testCase) => {
		const workspace = fakeWorkspace(testCase.revision, testCase.recorded);

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

import { describe, expect, it } from 'vitest';

import {
	Derivation,
	type DerivationBuildRequirements,
	derivationPathOf
} from './derivation.ts';
import { MalformedDerivationError } from './errors.ts';

const outputPath = '/nix/store/3yyckywrmfcykcn72nsv8j38hzggnv9b-probe';
const derivationPath = '/nix/store/3yyckywrmfcykcn72nsv8j38hzggnv9b-probe.drv';

// The shape `nix-instantiate` writes: seven elements, with the environment
// last as a list of name/value pairs.
function derivation(
	environment: readonly (readonly [string, string])[],
	platform = 'aarch64-darwin'
): string {
	const entries = environment
		.map(([name, value]) => `("${name}","${escaped(value)}")`)
		.join(',');

	return (
		`Derive([("out","${outputPath}","","")],[],[],"${platform}",` +
		`"/bin/sh",["-c","echo hi > $out"],[${entries}])`
	);
}

function escaped(value: string): string {
	return value
		.replaceAll('\\', '\\\\')
		.replaceAll('"', String.raw`\"`)
		.replaceAll('\n', String.raw`\n`)
		.replaceAll('\t', String.raw`\t`);
}

function structuredDerivation(attributes: unknown): string {
	return derivation([['__json', JSON.stringify(attributes)]]);
}

function canSubstitute(aterm: string): boolean {
	return Derivation.parse(aterm).allowsSubstitutes;
}

function readBuildRequirements(aterm: string): DerivationBuildRequirements {
	return Derivation.parse(aterm).buildRequirements;
}

describe('Derivation.outputs', () => {
	const developmentPath =
		'/nix/store/1a2q0zvmgfg8ic2xmyq5dnzq6r5c6vjr-probe-dev';

	it.each([
		{
			name: 'an input-addressed output, whose path the derivation fixes',
			outputs: `("out","${outputPath}","","")`,
			expected: new Map([['out', outputPath]])
		},
		{
			name: 'several outputs, each under its own name',
			outputs: `("dev","${developmentPath}","",""),("out","${outputPath}","","")`,
			expected: new Map([
				['dev', developmentPath],
				['out', outputPath]
			])
		},
		{
			name: 'a fixed-output derivation, whose path the hash fixes',
			outputs: `("out","${outputPath}","r:sha256","0f2s1n0i8g6b9a3c")`,
			expected: new Map([['out', outputPath]])
		},
		{
			name: 'a floating output, whose path the build settles',
			outputs: '("out","","r:sha256","")',
			expected: new Map([['out', undefined]])
		}
	])('reads $name', ({ outputs, expected }) => {
		const aterm = `Derive([${outputs}],[],[],"aarch64-darwin","/bin/sh",[],[])`;

		expect(Derivation.parse(aterm).outputs).toStrictEqual(expected);
	});

	it('refuses an output that does not hold a name and a path', () => {
		const aterm =
			'Derive([("out","","")],[],[],"aarch64-darwin","/bin/sh",[],[])';

		expect(() => Derivation.parse(aterm).outputs).toThrow(
			MalformedDerivationError
		);
	});
});

describe('Derivation.inputDerivations', () => {
	const compiler = '/nix/store/8kw2q3z7m9rvxj4hn5cd6b1ypa0gglsf-gcc.drv';
	const library = '/nix/store/qc7d0v3rjn8x2mlpf6ashy195wkbdgz9-zlib.drv';

	it.each([
		{
			name: 'no inputs at all',
			inputs: '',
			expected: new Map()
		},
		{
			name: 'one input and the single output it uses',
			inputs: `("${compiler}",["out"])`,
			expected: new Map([[compiler, ['out']]])
		},
		{
			name: 'several inputs, each with the outputs it uses',
			inputs: `("${compiler}",["out"]),("${library}",["dev","out"])`,
			expected: new Map([
				[compiler, ['out']],
				[library, ['dev', 'out']]
			])
		}
	])('reads $name', ({ inputs, expected }) => {
		const aterm =
			`Derive([("out","${outputPath}","","")],[${inputs}],[],` +
			'"aarch64-darwin","/bin/sh",[],[])';

		expect(Derivation.parse(aterm).inputDerivations).toStrictEqual(expected);
	});

	it('refuses an input that does not hold a path and its outputs', () => {
		const aterm =
			`Derive([("out","${outputPath}","","")],[("${compiler}")],[],` +
			'"aarch64-darwin","/bin/sh",[],[])';

		expect(() => Derivation.parse(aterm).inputDerivations).toThrow(
			MalformedDerivationError
		);
	});
});

describe('Derivation.allowsSubstitutes', () => {
	it.each([
		{
			name: 'a derivation that never sets the option',
			aterm: derivation([
				['builder', '/bin/sh'],
				['name', 'probe'],
				['out', outputPath]
			]),
			expected: true
		},
		{
			name: 'the empty value Nix writes for allowSubstitutes = false',
			aterm: derivation([
				['allowSubstitutes', ''],
				['name', 'probe']
			]),
			expected: false
		},
		{
			name: 'the "1" Nix writes for allowSubstitutes = true',
			aterm: derivation([['allowSubstitutes', '1']]),
			expected: true
		},
		{
			name: 'a value that is neither empty nor "1"',
			aterm: derivation([['allowSubstitutes', 'true']]),
			expected: false
		},
		{
			name: 'a repeated entry, where the last one wins',
			aterm: derivation([
				['allowSubstitutes', '1'],
				['allowSubstitutes', '']
			]),
			expected: false
		},
		{
			name: 'structured attributes withholding substitution',
			aterm: structuredDerivation({
				allowSubstitutes: false,
				name: 'probe'
			}),
			expected: false
		},
		{
			name: 'structured attributes allowing substitution',
			aterm: structuredDerivation({ allowSubstitutes: true }),
			expected: true
		},
		{
			name: 'structured attributes that never set the option',
			aterm: structuredDerivation({ name: 'probe' }),
			expected: true
		},
		{
			name: 'an environment value carrying escaped quotes and newlines',
			aterm: derivation([
				['buildCommand', 'echo "one"\n\techo \\two\n'],
				['allowSubstitutes', '']
			]),
			expected: false
		},
		{
			name: 'an environment value that looks like a term',
			aterm: derivation([
				['buildCommand', 'Derive([("allowSubstitutes","1")])'],
				['allowSubstitutes', '']
			]),
			expected: false
		},
		{
			name: 'an empty environment',
			aterm: derivation([]),
			expected: true
		}
	])('reads $name', ({ aterm, expected }) => {
		expect(Derivation.parse(aterm).allowsSubstitutes).toBe(expected);
	});

	it.each([
		{
			name: 'bytes that are not a derivation at all',
			aterm: 'not a derivation',
			reason: "expected 'Derive(' at offset 0"
		},
		{
			name: 'a versioned term the dynamic-derivations feature writes',
			aterm: 'DrvWithVersion("xp-dyn-drv",[],[],[],"","",[],[])',
			reason: "expected 'Derive(' at offset 0"
		},
		{
			name: 'a term with too few elements',
			aterm: 'Derive([],[],[],"system","builder",[])',
			reason: '6 elements where a derivation has 7'
		},
		{
			name: 'an unterminated string',
			aterm: 'Derive([],[],[],"system","builder",[],[("name","value',
			reason: 'an unterminated string'
		},
		{
			name: 'an environment entry that is not a pair',
			aterm: 'Derive([],[],[],"system","builder",[],[("name")])',
			reason: 'an environment entry is not a name and a value'
		},
		{
			name: 'an environment entry holding a list',
			aterm: 'Derive([],[],[],"system","builder",[],[("name",["value"])])',
			reason: 'an environment entry holds something other than strings'
		},
		{
			name: 'an environment that is a string',
			aterm: 'Derive([],[],[],"system","builder",[],"environment")',
			reason: 'the environment is not a list'
		},
		{
			name: 'structured attributes that are not JSON',
			aterm: derivation([['__json', 'not json']]),
			reason: '__json is not valid JSON'
		},
		{
			name: 'structured attributes that are not an object',
			aterm: derivation([['__json', '[]']]),
			reason: '__json is not an object'
		},
		{
			name: 'a structured allowSubstitutes that is not a boolean',
			aterm: structuredDerivation({ allowSubstitutes: 'no' }),
			reason: 'the structured allowSubstitutes attribute is not a boolean'
		}
	])('refuses $name', ({ aterm, reason }) => {
		let thrown: unknown;

		try {
			canSubstitute(aterm);
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(MalformedDerivationError);

		if (!(thrown instanceof MalformedDerivationError)) {
			return;
		}

		expect({ name: thrown.name, reason: thrown.reason }).toStrictEqual({
			name: 'MalformedDerivationError',
			reason
		});
	});
});

describe('Derivation.buildRequirements', () => {
	it.each([
		{
			name: 'a derivation requiring nothing of its machine',
			aterm: derivation([['name', 'probe']], 'x86_64-linux'),
			expected: { system: 'x86_64-linux', requiredSystemFeatures: [] }
		},
		{
			name: 'the whitespace-joined list Nix writes for one feature',
			aterm: derivation([['requiredSystemFeatures', 'kvm']]),
			expected: {
				system: 'aarch64-darwin',
				requiredSystemFeatures: ['kvm']
			}
		},
		{
			name: 'a list of several features, repeats collapsed',
			aterm: derivation([
				['requiredSystemFeatures', 'big-parallel  kvm big-parallel']
			]),
			expected: {
				system: 'aarch64-darwin',
				requiredSystemFeatures: ['big-parallel', 'kvm']
			}
		},
		{
			name: 'an empty list',
			aterm: derivation([['requiredSystemFeatures', '']]),
			expected: { system: 'aarch64-darwin', requiredSystemFeatures: [] }
		},
		{
			name: 'structured attributes carrying the features as an array',
			aterm: structuredDerivation({
				name: 'probe',
				requiredSystemFeatures: ['big-parallel', 'kvm']
			}),
			expected: {
				system: 'aarch64-darwin',
				requiredSystemFeatures: ['big-parallel', 'kvm']
			}
		},
		{
			name: 'structured attributes that never set the features',
			aterm: structuredDerivation({ name: 'probe' }),
			expected: { system: 'aarch64-darwin', requiredSystemFeatures: [] }
		},
		{
			name: 'an unstructured entry beside structured attributes, which wins',
			aterm: derivation([
				['requiredSystemFeatures', 'kvm'],
				['__json', JSON.stringify({ requiredSystemFeatures: ['uid-range'] })]
			]),
			expected: {
				system: 'aarch64-darwin',
				requiredSystemFeatures: ['uid-range']
			}
		}
	])('reads $name', ({ aterm, expected }) => {
		expect(Derivation.parse(aterm).buildRequirements).toStrictEqual(expected);
	});

	it.each([
		{
			name: 'a term whose platform is a list',
			aterm: 'Derive([],[],[],["system"],"builder",[],[])',
			reason: 'the platform is not a string'
		},
		{
			name: 'structured features that are not a list of strings',
			aterm: structuredDerivation({ requiredSystemFeatures: 'kvm' }),
			reason:
				'the structured requiredSystemFeatures attribute is not a list of strings'
		}
	])('refuses $name', ({ aterm, reason }) => {
		let thrown: unknown;

		try {
			readBuildRequirements(aterm);
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(MalformedDerivationError);

		if (!(thrown instanceof MalformedDerivationError)) {
			return;
		}

		expect({ name: thrown.name, reason: thrown.reason }).toStrictEqual({
			name: 'MalformedDerivationError',
			reason
		});
	});
});

describe('derivationPathOf', () => {
	it.each([
		{
			name: 'a derivation with the outputs it should produce',
			installable: `${derivationPath}^*`,
			expected: derivationPath
		},
		{
			name: 'a derivation with named outputs',
			installable: `${derivationPath}^out,dev`,
			expected: derivationPath
		},
		{
			name: 'a bare derivation',
			installable: derivationPath,
			expected: derivationPath
		},
		{ name: 'an output path', installable: outputPath, expected: undefined },
		{ name: 'a flake attribute', installable: '.#app', expected: undefined },
		{
			name: 'a path outside any store',
			installable: '/tmp/probe.drv',
			expected: undefined
		}
	])('reads $name', ({ installable, expected }) => {
		expect(derivationPathOf(installable)).toBe(expected);
	});
});

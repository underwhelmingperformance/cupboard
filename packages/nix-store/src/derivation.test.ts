import { describe, expect, it } from 'vitest';

import {
	Derivation,
	type DerivationBuildRequirements,
	derivationPathOf
} from './derivation.ts';
import { MalformedDerivationError } from './errors.ts';

const outputPath = '/nix/store/3yyckywrmfcykcn72nsv8j38hzggnv9b-probe';
const derivationPath = '/nix/store/3yyckywrmfcykcn72nsv8j38hzggnv9b-probe.drv';

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

function expectRefusal(read: () => unknown, reason: string): void {
	let thrown: unknown;

	try {
		read();
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
}

describe('Derivation.parse', () => {
	it.each([
		{
			name: 'rejects an output with three fields',
			aterm: 'Derive([("out","","")],[],[],"aarch64-darwin","/bin/sh",[],[])',
			reason: 'an output has 3 fields instead of 4'
		},
		{
			name: 'rejects an input derivation without an output-name list',
			aterm:
				`Derive([("out","${outputPath}","","")],[("${derivationPath}")],[],` +
				'"aarch64-darwin","/bin/sh",[],[])',
			reason:
				'an input derivation must contain a path and a list of output names'
		},
		{
			name: 'rejects a list in the platform position',
			aterm: 'Derive([],[],[],["aarch64-darwin"],"/bin/sh",[],[])',
			reason: 'the platform is not a string'
		},
		{
			name: 'rejects invalid JSON in __json',
			aterm: derivation([['__json', 'not json']]),
			reason: '__json is not valid JSON'
		}
	])('$name', ({ aterm, reason }) => {
		expectRefusal(() => Derivation.parse(aterm), reason);
	});
});

describe('Derivation.outputs', () => {
	const developmentPath =
		'/nix/store/1a2q0zvmgfg8ic2xmyq5dnzq6r5c6vjr-probe-dev';

	it.each([
		{
			name: 'parses an input-addressed output path',
			outputs: `("out","${outputPath}","","")`,
			expected: new Map([['out', outputPath]])
		},
		{
			name: 'parses several named outputs',
			outputs: `("dev","${developmentPath}","",""),("out","${outputPath}","","")`,
			expected: new Map([
				['dev', developmentPath],
				['out', outputPath]
			])
		},
		{
			name: 'parses a fixed-output path',
			outputs: `("out","${outputPath}","r:sha256","0f2s1n0i8g6b9a3c")`,
			expected: new Map([['out', outputPath]])
		},
		{
			name: 'uses undefined for a floating output path',
			outputs: '("out","","r:sha256","")',
			expected: new Map([['out', undefined]])
		}
	])('$name', ({ outputs, expected }) => {
		const aterm = `Derive([${outputs}],[],[],"aarch64-darwin","/bin/sh",[],[])`;

		expect(Derivation.parse(aterm).outputs).toStrictEqual(expected);
	});

	it('rejects a non-string output name', () => {
		const aterm =
			`Derive([(["out"],"${outputPath}","","")],[],[],` +
			'"aarch64-darwin","/bin/sh",[],[])';

		expectRefusal(
			() => Derivation.parse(aterm).outputs,
			'an output name and path must both be strings'
		);
	});
});

describe('Derivation.inputDerivations', () => {
	const compiler = '/nix/store/8kw2q3z7m9rvxj4hn5cd6b1ypa0gglsf-gcc.drv';
	const library = '/nix/store/qc7d0v3rjn8x2mlpf6ashy195wkbdgz9-zlib.drv';

	it.each([
		{
			name: 'parses no input derivations',
			inputs: '',
			expected: new Map()
		},
		{
			name: 'parses one input derivation and its output',
			inputs: `("${compiler}",["out"])`,
			expected: new Map([[compiler, ['out']]])
		},
		{
			name: 'parses several input derivations and their outputs',
			inputs: `("${compiler}",["out"]),("${library}",["dev","out"])`,
			expected: new Map([
				[compiler, ['out']],
				[library, ['dev', 'out']]
			])
		}
	])('$name', ({ inputs, expected }) => {
		const aterm =
			`Derive([("out","${outputPath}","","")],[${inputs}],[],` +
			'"aarch64-darwin","/bin/sh",[],[])';

		expect(Derivation.parse(aterm).inputDerivations).toStrictEqual(expected);
	});

	it.each([
		{
			name: 'rejects a non-string input derivation path',
			input: `(["${compiler}"],["out"])`
		},
		{
			name: 'rejects a non-list input derivation output selection',
			input: `("${compiler}","out")`
		}
	])('$name', ({ input }) => {
		const aterm =
			`Derive([("out","${outputPath}","","")],[${input}],[],` +
			'"aarch64-darwin","/bin/sh",[],[])';

		expectRefusal(
			() => Derivation.parse(aterm).inputDerivations,
			'an input derivation path must be a string and its output names must be a list'
		);
	});

	it('rejects a non-string input derivation output name', () => {
		const aterm =
			`Derive([("out","${outputPath}","","")],[("${compiler}",[["out"]])],[],` +
			'"aarch64-darwin","/bin/sh",[],[])';

		expectRefusal(
			() => Derivation.parse(aterm).inputDerivations,
			'an input derivation output name must be a string'
		);
	});
});

describe('Derivation.inputSources', () => {
	const source = '/nix/store/5z8pqx1kd9cr4hm2j7f6n0wvg3sbyala-source';
	const patch = '/nix/store/7x1bh9j5q3n6d8a0fkmr2cvwsp4yzlgc-fix.patch';

	it.each([
		{
			name: 'parses no input sources',
			sources: '',
			expected: []
		},
		{
			name: 'parses one input source',
			sources: `"${source}"`,
			expected: [source]
		},
		{
			name: 'preserves input-source order',
			sources: `"${source}","${patch}"`,
			expected: [source, patch]
		}
	])('$name', ({ sources, expected }) => {
		const aterm =
			`Derive([("out","${outputPath}","","")],[],[${sources}],` +
			'"aarch64-darwin","/bin/sh",[],[])';

		expect(Derivation.parse(aterm).inputSources).toStrictEqual(expected);
	});

	it('rejects a list in the input-source position', () => {
		const aterm =
			`Derive([("out","${outputPath}","","")],[],[["${source}"]],` +
			'"aarch64-darwin","/bin/sh",[],[])';

		expectRefusal(
			() => Derivation.parse(aterm).inputSources,
			'an input source must be a string'
		);
	});
});

describe('Derivation.allowsSubstitutes', () => {
	it.each([
		{
			name: 'defaults to true when the unstructured option is absent',
			aterm: derivation([
				['builder', '/bin/sh'],
				['name', 'probe'],
				['out', outputPath]
			]),
			expected: true
		},
		{
			name: 'parses an empty unstructured value as false',
			aterm: derivation([
				['allowSubstitutes', ''],
				['name', 'probe']
			]),
			expected: false
		},
		{
			name: 'parses the unstructured value "1" as true',
			aterm: derivation([['allowSubstitutes', '1']]),
			expected: true
		},
		{
			name: 'parses another unstructured value as false',
			aterm: derivation([['allowSubstitutes', 'true']]),
			expected: false
		},
		{
			name: 'uses the last duplicate unstructured value',
			aterm: derivation([
				['allowSubstitutes', '1'],
				['allowSubstitutes', '']
			]),
			expected: false
		},
		{
			name: 'parses a structured false value',
			aterm: structuredDerivation({
				allowSubstitutes: false,
				name: 'probe'
			}),
			expected: false
		},
		{
			name: 'parses a structured true value',
			aterm: structuredDerivation({ allowSubstitutes: true }),
			expected: true
		},
		{
			name: 'defaults to true when the structured option is absent',
			aterm: structuredDerivation({ name: 'probe' }),
			expected: true
		},
		{
			name: 'parses allowSubstitutes after an escaped environment value',
			aterm: derivation([
				['buildCommand', 'echo "one"\n\techo \\two\n'],
				['allowSubstitutes', '']
			]),
			expected: false
		},
		{
			name: 'does not parse term syntax inside an environment value',
			aterm: derivation([
				['buildCommand', 'Derive([("allowSubstitutes","1")])'],
				['allowSubstitutes', '']
			]),
			expected: false
		},
		{
			name: 'defaults to true for an empty environment',
			aterm: derivation([]),
			expected: true
		}
	])('$name', ({ aterm, expected }) => {
		expect(Derivation.parse(aterm).allowsSubstitutes).toBe(expected);
	});

	it.each([
		{
			name: 'rejects text without a Derive prefix',
			aterm: 'not a derivation',
			reason: "expected 'Derive(' at offset 0"
		},
		{
			name: 'rejects a DrvWithVersion dynamic-derivation term',
			aterm: 'DrvWithVersion("xp-dyn-drv",[],[],[],"","",[],[])',
			reason: "expected 'Derive(' at offset 0"
		},
		{
			name: 'rejects a Derive term with six elements',
			aterm: 'Derive([],[],[],"system","builder",[])',
			reason: '6 elements; expected 7'
		},
		{
			name: 'rejects an unterminated string',
			aterm: 'Derive([],[],[],"system","builder",[],[("name","value',
			reason: 'an unterminated string'
		},
		{
			name: 'rejects an environment entry with one element',
			aterm: 'Derive([],[],[],"system","builder",[],[("name")])',
			reason: 'an environment entry must be a two-element name-value pair'
		},
		{
			name: 'rejects a non-string environment value',
			aterm: 'Derive([],[],[],"system","builder",[],[("name",["value"])])',
			reason: 'an environment entry name and value must both be strings'
		},
		{
			name: 'rejects a string in the environment position',
			aterm: 'Derive([],[],[],"system","builder",[],"environment")',
			reason: 'the environment is not a list'
		},
		{
			name: 'rejects invalid JSON in __json',
			aterm: derivation([['__json', 'not json']]),
			reason: '__json is not valid JSON'
		},
		{
			name: 'rejects an array in __json',
			aterm: derivation([['__json', '[]']]),
			reason: '__json is not an object'
		},
		{
			name: 'rejects a non-boolean structured allowSubstitutes value',
			aterm: structuredDerivation({ allowSubstitutes: 'no' }),
			reason: 'the structured allowSubstitutes attribute is not a boolean'
		}
	])('$name', ({ aterm, reason }) => {
		expectRefusal(() => canSubstitute(aterm), reason);
	});
});

describe('Derivation.buildRequirements', () => {
	it.each([
		{
			name: 'parses a platform with no required features',
			aterm: derivation([['name', 'probe']], 'x86_64-linux'),
			expected: { system: 'x86_64-linux', requiredSystemFeatures: [] }
		},
		{
			name: 'parses one unstructured required feature',
			aterm: derivation([['requiredSystemFeatures', 'kvm']]),
			expected: {
				system: 'aarch64-darwin',
				requiredSystemFeatures: ['kvm']
			}
		},
		{
			name: 'parses unstructured features in order without duplicates',
			aterm: derivation([
				['requiredSystemFeatures', 'big-parallel  kvm big-parallel']
			]),
			expected: {
				system: 'aarch64-darwin',
				requiredSystemFeatures: ['big-parallel', 'kvm']
			}
		},
		{
			name: 'parses an empty unstructured feature list',
			aterm: derivation([['requiredSystemFeatures', '']]),
			expected: { system: 'aarch64-darwin', requiredSystemFeatures: [] }
		},
		{
			name: 'parses a structured feature array',
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
			name: 'defaults absent structured features to an empty list',
			aterm: structuredDerivation({ name: 'probe' }),
			expected: { system: 'aarch64-darwin', requiredSystemFeatures: [] }
		},
		{
			name: 'prefers structured features to an unstructured entry',
			aterm: derivation([
				['requiredSystemFeatures', 'kvm'],
				['__json', JSON.stringify({ requiredSystemFeatures: ['uid-range'] })]
			]),
			expected: {
				system: 'aarch64-darwin',
				requiredSystemFeatures: ['uid-range']
			}
		}
	])('$name', ({ aterm, expected }) => {
		expect(Derivation.parse(aterm).buildRequirements).toStrictEqual(expected);
	});

	it.each([
		{
			name: 'rejects a list in the platform position',
			aterm: 'Derive([],[],[],["system"],"builder",[],[])',
			reason: 'the platform is not a string'
		},
		{
			name: 'rejects a non-array structured feature value',
			aterm: structuredDerivation({ requiredSystemFeatures: 'kvm' }),
			reason:
				'the structured requiredSystemFeatures attribute is not a list of strings'
		}
	])('$name', ({ aterm, reason }) => {
		expectRefusal(() => readBuildRequirements(aterm), reason);
	});
});

describe('derivationPathOf', () => {
	it.each([
		{
			name: 'parses an all-outputs derived path',
			installable: `${derivationPath}^*`,
			expected: derivationPath
		},
		{
			name: 'parses named outputs from a derived path',
			installable: `${derivationPath}^out,dev`,
			expected: derivationPath
		},
		{
			name: 'parses a bare derivation store path',
			installable: derivationPath,
			expected: derivationPath
		},
		{
			name: 'returns undefined for an output store path',
			installable: outputPath,
			expected: undefined
		},
		{
			name: 'returns undefined for a flake attribute',
			installable: '.#app',
			expected: undefined
		},
		{
			name: 'returns undefined for a path outside the store',
			installable: '/tmp/probe.drv',
			expected: undefined
		}
	])('$name', ({ installable, expected }) => {
		expect(derivationPathOf(installable)).toBe(expected);
	});
});

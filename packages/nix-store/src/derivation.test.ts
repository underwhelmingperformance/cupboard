import { describe, expect, it } from 'vitest';

import { canSubstituteDerivation } from './derivation.ts';
import { MalformedDerivationError } from './errors.ts';

const outputPath = '/nix/store/3yyckywrmfcykcn72nsv8j38hzggnv9b-probe';

// The shape `nix-instantiate` writes: seven elements, with the environment
// last as a list of name/value pairs.
function derivation(
	environment: readonly (readonly [string, string])[]
): string {
	const entries = environment
		.map(([name, value]) => `("${name}","${escaped(value)}")`)
		.join(',');

	return (
		`Derive([("out","${outputPath}","","")],[],[],"aarch64-darwin",` +
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

describe('canSubstituteDerivation', () => {
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
		expect(canSubstituteDerivation(aterm)).toBe(expected);
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
			canSubstituteDerivation(aterm);
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

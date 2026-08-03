import { MalformedDerivationError } from './errors.ts';

/**
 * Whether a derivation's own `allowSubstitutes` option lets Nix fetch its
 * outputs rather than build them. A derivation that never sets the option
 * allows substitution, which is Nix's default.
 *
 * This is only the derivation's half of the answer. Nix will not substitute
 * anything when the `substitute` setting is off, and it ignores a `false`
 * here when `always-allow-substitutes` is on.
 */
export function canSubstituteDerivation(aterm: string): boolean {
	const environment = derivationEnvironment(aterm);
	const structured = environment.get('__json');

	if (structured !== undefined) {
		return canSubstituteStructured(structured);
	}

	const value = environment.get('allowSubstitutes');

	// Nix reads an unstructured environment variable as a boolean by
	// comparing it with `"1"`, so any other spelling is false.
	return value === undefined || value === '1';
}

function canSubstituteStructured(structuredAttributes: string): boolean {
	let parsed: unknown;

	try {
		parsed = JSON.parse(structuredAttributes);
	} catch {
		throw new MalformedDerivationError('__json is not valid JSON');
	}

	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new MalformedDerivationError('__json is not an object');
	}

	if (!('allowSubstitutes' in parsed)) {
		return true;
	}

	const value = parsed.allowSubstitutes;

	if (typeof value !== 'boolean') {
		throw new MalformedDerivationError(
			'the structured allowSubstitutes attribute is not a boolean'
		);
	}

	return value;
}

/**
 * A derivation ATerm as far as this module reads it: a nested value is either
 * a string or a sequence, and a list and a tuple both parse as a sequence,
 * since nothing here distinguishes them.
 */
type ATermValue = string | readonly ATermValue[];

function isSequence(value: ATermValue): value is readonly ATermValue[] {
	return typeof value !== 'string';
}

// `Derive(outputs, inputDerivations, inputSources, platform, builder, args,
// environment)`. Only the last element is read, but every element ahead of it
// has to be parsed to find where it starts.
const derivePrefix = 'Derive(';
const deriveElementCount = 7;
const environmentIndex = 6;

// The environment as a map from name to value. A derivation may repeat a
// name, and Nix keeps the last one it reads, which is what a map assignment
// does.
function derivationEnvironment(aterm: string): ReadonlyMap<string, string> {
	const reader = new ATermReader(aterm);
	const elements = reader.readDerive();
	const environment = elements[environmentIndex];

	if (environment === undefined || !isSequence(environment)) {
		throw new MalformedDerivationError('the environment is not a list');
	}

	const entries = new Map<string, string>();

	for (const entry of environment) {
		if (!isSequence(entry) || entry.length !== 2) {
			throw new MalformedDerivationError(
				'an environment entry is not a name and a value'
			);
		}

		const [name, value] = entry;

		if (typeof name !== 'string' || typeof value !== 'string') {
			throw new MalformedDerivationError(
				'an environment entry holds something other than strings'
			);
		}

		entries.set(name, value);
	}

	return entries;
}

// Nix writes these two characters escaped inside an ATerm string, along with
// the three whitespace characters below.
const escapedCharacters = new Map([
	['n', '\n'],
	['r', '\r'],
	['t', '\t'],
	['"', '"'],
	['\\', '\\']
]);

class ATermReader {
	private offset = 0;

	constructor(private readonly text: string) {}

	private expect(literal: string): void {
		if (!this.text.startsWith(literal, this.offset)) {
			throw new MalformedDerivationError(
				`expected '${literal}' at offset ${String(this.offset)}`
			);
		}

		this.offset += literal.length;
	}

	private readString(): string {
		this.expect('"');

		let value = '';

		for (;;) {
			const character = this.text[this.offset];

			if (character === undefined) {
				throw new MalformedDerivationError('an unterminated string');
			}

			this.offset += 1;

			if (character === '"') {
				return value;
			}

			if (character !== '\\') {
				value += character;
				continue;
			}

			const escaped = this.text[this.offset];

			if (escaped === undefined) {
				throw new MalformedDerivationError('an unterminated escape');
			}

			this.offset += 1;
			value += escapedCharacters.get(escaped) ?? escaped;
		}
	}

	private readSequence(close: string): readonly ATermValue[] {
		const values: ATermValue[] = [];

		if (this.text.startsWith(close, this.offset)) {
			this.offset += close.length;

			return values;
		}

		for (;;) {
			values.push(this.readValue());

			const separator = this.text[this.offset];
			this.offset += 1;

			if (separator === close) {
				return values;
			}

			if (separator !== ',') {
				throw new MalformedDerivationError(
					`expected ',' or '${close}' at offset ${String(this.offset - 1)}`
				);
			}
		}
	}

	private readValue(): ATermValue {
		const character = this.text[this.offset];

		if (character === '"') {
			return this.readString();
		}

		if (character === '[') {
			this.offset += 1;

			return this.readSequence(']');
		}

		if (character === '(') {
			this.offset += 1;

			return this.readSequence(')');
		}

		throw new MalformedDerivationError(
			`expected a value at offset ${String(this.offset)}`
		);
	}

	/**
	 * The seven elements of a `Derive(...)` term. A derivation written in any
	 * other shape, such as the versioned term the dynamic-derivations feature
	 * produces, is refused rather than guessed at.
	 */
	readDerive(): readonly ATermValue[] {
		this.expect(derivePrefix);

		const elements = this.readSequence(')');

		if (elements.length !== deriveElementCount) {
			throw new MalformedDerivationError(
				`${String(elements.length)} elements where a derivation has ${String(deriveElementCount)}`
			);
		}

		return elements;
	}
}

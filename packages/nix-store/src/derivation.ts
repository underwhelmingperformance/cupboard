import { z } from 'zod';

import { MalformedDerivationError } from './errors.ts';
import { storePathSchema, type StorePathString } from './scalars.ts';

const structuredAttributesSchema = z.looseObject({});
const featureListSchema = z.array(z.string());

export class Derivation {
	/**
	 * Parses a serialised `Derive(...)` term. This reader supports the unversioned
	 * seven-element grammar and rejects `DrvWithVersion(...)`, which Nix uses for
	 * derivations with dynamic inputs, with {@link MalformedDerivationError}.
	 */
	static parse(aterm: string): Derivation {
		return new Derivation(derivationTerm(aterm));
	}

	private readonly system: string;
	private readonly environment: ReadonlyMap<string, string>;
	private readonly structured: Readonly<Record<string, unknown>> | undefined;

	/**
	 * A floating content-addressed output maps to `undefined` because its store
	 * path depends on the result of the build.
	 */
	readonly outputs: ReadonlyMap<string, StorePathString | undefined>;

	/**
	 * The output names required from each input derivation. Nix must make the
	 * selected outputs available before it can build this derivation.
	 */
	readonly inputDerivations: ReadonlyMap<StorePathString, readonly string[]>;

	readonly inputSources: readonly StorePathString[];

	private constructor(elements: readonly ATermValue[]) {
		this.outputs = derivationOutputs(elements);
		this.inputDerivations = derivationInputs(elements);
		this.inputSources = derivationSources(elements);
		this.system = derivationPlatform(elements);
		this.environment = derivationEnvironment(elements);
		this.structured = structuredAttributes(this.environment);
	}

	/**
	 * The platform and system features that a machine must provide to build this
	 * derivation. Nix matches the platform against `system` and `extra-platforms`,
	 * and every required feature must appear in `system-features`.
	 */
	get buildRequirements(): DerivationBuildRequirements {
		return {
			system: this.system,
			requiredSystemFeatures: requiredSystemFeatures(
				this.environment,
				this.structured
			)
		};
	}

	/**
	 * Whether this derivation's own `allowSubstitutes` option lets Nix fetch
	 * its outputs rather than build them. A derivation that never sets the
	 * option allows substitution, which is Nix's default.
	 *
	 * The derivation option is only one part of the substitution policy. Nix
	 * does not substitute anything when the `substitute` setting is off. It
	 * ignores a `false` value here when `always-allow-substitutes` is on.
	 */
	get allowsSubstitutes(): boolean {
		return canSubstitute(this.environment, this.structured);
	}
}

function canSubstitute(
	environment: ReadonlyMap<string, string>,
	structured: Readonly<Record<string, unknown>> | undefined
): boolean {
	if (structured !== undefined) {
		return canSubstituteStructured(structured);
	}

	const value = environment.get('allowSubstitutes');

	// Nix parses an unstructured environment variable as true only when its
	// value is `"1"`.
	return value === undefined || value === '1';
}

function canSubstituteStructured(
	structured: Readonly<Record<string, unknown>>
): boolean {
	if (!('allowSubstitutes' in structured)) {
		return true;
	}

	const value = structured.allowSubstitutes;

	if (typeof value !== 'boolean') {
		throw new MalformedDerivationError(
			'the structured allowSubstitutes attribute is not a boolean'
		);
	}

	return value;
}

export interface DerivationBuildRequirements {
	readonly system: string;
	/**
	 * The required system features in derivation order, without duplicates.
	 */
	readonly requiredSystemFeatures: readonly string[];
}

function derivationOutputs(
	elements: readonly ATermValue[]
): ReadonlyMap<string, StorePathString | undefined> {
	const outputs = elements[outputIndex];

	if (outputs === undefined || !isSequence(outputs)) {
		throw new MalformedDerivationError('the outputs are not a list');
	}

	const declared = new Map<string, StorePathString | undefined>();

	for (const output of outputs) {
		if (!isSequence(output) || output.length !== outputFieldCount) {
			throw new MalformedDerivationError(
				`an output has ${isSequence(output) ? String(output.length) : 'no'} fields instead of ${String(outputFieldCount)}`
			);
		}

		const [name, path] = output;

		if (typeof name !== 'string' || typeof path !== 'string') {
			throw new MalformedDerivationError(
				'an output name and path must both be strings'
			);
		}

		declared.set(name, path === '' ? undefined : storePathSchema.parse(path));
	}

	return declared;
}

function derivationInputs(
	elements: readonly ATermValue[]
): ReadonlyMap<StorePathString, readonly string[]> {
	const inputs = elements[inputDerivationIndex];

	if (inputs === undefined || !isSequence(inputs)) {
		throw new MalformedDerivationError('the input derivations are not a list');
	}

	const required = new Map<StorePathString, readonly string[]>();

	for (const input of inputs) {
		if (!isSequence(input) || input.length !== 2) {
			throw new MalformedDerivationError(
				'an input derivation must contain a path and a list of output names'
			);
		}

		const [drvPath, outputNames] = input;

		if (
			typeof drvPath !== 'string' ||
			outputNames === undefined ||
			!isSequence(outputNames)
		) {
			throw new MalformedDerivationError(
				'an input derivation path must be a string and its output names must be a list'
			);
		}

		required.set(
			storePathSchema.parse(drvPath),
			outputNames.map((outputName) => {
				if (isSequence(outputName)) {
					throw new MalformedDerivationError(
						'an input derivation output name must be a string'
					);
				}

				return outputName;
			})
		);
	}

	return required;
}

function derivationSources(
	elements: readonly ATermValue[]
): readonly StorePathString[] {
	const sources = elements[inputSourceIndex];

	if (sources === undefined || !isSequence(sources)) {
		throw new MalformedDerivationError('the input sources are not a list');
	}

	return sources.map((source) => {
		if (isSequence(source)) {
			throw new MalformedDerivationError('an input source must be a string');
		}

		return storePathSchema.parse(source);
	});
}

function derivationPlatform(elements: readonly ATermValue[]): string {
	const platform = elements[platformIndex];

	if (platform === undefined || isSequence(platform)) {
		throw new MalformedDerivationError('the platform is not a string');
	}

	return platform;
}

function requiredSystemFeatures(
	environment: ReadonlyMap<string, string>,
	structured: Readonly<Record<string, unknown>> | undefined
): readonly string[] {
	if (structured === undefined) {
		// Nix serialises an unstructured feature list by joining its members with
		// whitespace.
		return orderedUnique(
			(environment.get('requiredSystemFeatures') ?? '').split(/\s+/u)
		);
	}

	if (!('requiredSystemFeatures' in structured)) {
		return [];
	}

	const value = featureListSchema.safeParse(structured.requiredSystemFeatures);

	if (!value.success) {
		throw new MalformedDerivationError(
			'the structured requiredSystemFeatures attribute is not a list of strings'
		);
	}

	return orderedUnique(value.data);
}

function orderedUnique(values: readonly string[]): readonly string[] {
	return new Set(values.filter(Boolean)).values().toArray();
}

const derivationSuffix = '.drv';

/**
 * Extracts the `.drv` store path from a derivation installable. This includes
 * derived-path forms that append `^` and an output selection. Returns
 * `undefined` for other installables.
 */
export function derivationPathOf(
	installable: string
): StorePathString | undefined {
	const separator = installable.indexOf('^');
	const base = separator === -1 ? installable : installable.slice(0, separator);
	const parsed = storePathSchema.safeParse(base);

	if (!parsed.success || !parsed.data.endsWith(derivationSuffix)) {
		return undefined;
	}

	return parsed.data;
}

function structuredAttributes(
	environment: ReadonlyMap<string, string>
): Readonly<Record<string, unknown>> | undefined {
	const value = environment.get('__json');

	if (value === undefined) {
		return undefined;
	}

	let parsed: unknown;

	try {
		parsed = JSON.parse(value);
	} catch {
		throw new MalformedDerivationError('__json is not valid JSON');
	}

	const structured = structuredAttributesSchema.safeParse(parsed);

	if (!structured.success) {
		throw new MalformedDerivationError('__json is not an object');
	}

	return structured.data;
}

type ATermValue = string | readonly ATermValue[];

function isSequence(value: ATermValue): value is readonly ATermValue[] {
	return typeof value !== 'string';
}

// The unversioned grammar has exactly seven positional elements:
// `Derive(outputs, inputDerivations, inputSources, platform, builder, args,
// environment)`.
const derivePrefix = 'Derive(';
const deriveElementCount = 7;
const outputIndex = 0;
const inputDerivationIndex = 1;
const inputSourceIndex = 2;
const platformIndex = 3;
const environmentIndex = 6;

const outputFieldCount = 4;

function derivationTerm(aterm: string): readonly ATermValue[] {
	return new ATermReader(aterm).readDerive();
}

// Nix permits duplicate environment names and uses the last value. Repeated
// Map assignments preserve that behaviour.
function derivationEnvironment(
	elements: readonly ATermValue[]
): ReadonlyMap<string, string> {
	const environment = elements[environmentIndex];

	if (environment === undefined || !isSequence(environment)) {
		throw new MalformedDerivationError('the environment is not a list');
	}

	const entries = new Map<string, string>();

	for (const entry of environment) {
		if (!isSequence(entry) || entry.length !== 2) {
			throw new MalformedDerivationError(
				'an environment entry must be a two-element name-value pair'
			);
		}

		const [name, value] = entry;

		if (typeof name !== 'string' || typeof value !== 'string') {
			throw new MalformedDerivationError(
				'an environment entry name and value must both be strings'
			);
		}

		entries.set(name, value);
	}

	return entries;
}

// Nix serialises newlines, carriage returns, tabs, double quotes and
// backslashes with these ATerm escapes.
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

	readDerive(): readonly ATermValue[] {
		this.expect(derivePrefix);

		const elements = this.readSequence(')');

		if (elements.length !== deriveElementCount) {
			throw new MalformedDerivationError(
				`${String(elements.length)} elements; expected ${String(deriveElementCount)}`
			);
		}

		return elements;
	}
}

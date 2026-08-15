import { z } from 'zod';

import { MalformedDerivationError } from './errors.ts';
import { storePathSchema, type StorePathString } from './scalars.ts';

const structuredAttributesSchema = z.looseObject({});
const featureListSchema = z.array(z.string());

/**
 * A derivation parsed from its serialised store file. Graph walks read several
 * properties from the same derivation, so the constructor parses the term
 * once.
 */
export class Derivation {
	/**
	 * Reads the `Derive(...)` term in the given serialised derivation. A
	 * derivation written in any other shape, such as the versioned term the
	 * dynamic-derivations feature produces, is refused with
	 * {@link MalformedDerivationError}.
	 */
	static parse(aterm: string): Derivation {
		return new Derivation(derivationTerm(aterm));
	}

	private readonly system: string;
	private readonly environment: ReadonlyMap<string, string>;
	private readonly structured: Readonly<Record<string, unknown>> | undefined;

	/**
	 * The derivation's declared outputs, keyed by output name. The path is
	 * `undefined` for a floating content-addressed output because the build
	 * determines its path.
	 */
	readonly outputs: ReadonlyMap<string, StorePathString | undefined>;

	/**
	 * The input derivations, with the output names used from each one. These
	 * outputs must be available before this derivation can be built.
	 */
	readonly inputDerivations: ReadonlyMap<StorePathString, readonly string[]>;

	/**
	 * Store paths this derivation reads directly rather than through another
	 * derivation's output.
	 */
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
	 * The system and system features required to build this derivation. Nix
	 * builds a derivation locally only on a machine whose `system` (or
	 * `extra-platforms`) covers
	 * the platform and whose `system-features` cover every required feature;
	 * anything else needs a builder that does.
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

	// Nix reads an unstructured environment variable as a boolean by
	// comparing it with `"1"`, so any other spelling is false.
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

/** The machine requirements for building a derivation. */
export interface DerivationBuildRequirements {
	/** The derivation's platform: the system its builder runs on. */
	readonly system: string;
	/**
	 * The `requiredSystemFeatures` the building machine must offer, in the
	 * order the derivation lists them and deduplicated.
	 */
	readonly requiredSystemFeatures: readonly string[];
}

// `[(name, path, hashAlgo, hash), ...]`. A floating content-addressed output
// writes an empty path, since its path follows from what the build produces.
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
				'an output name or path is not a string'
			);
		}

		declared.set(name, path === '' ? undefined : storePathSchema.parse(path));
	}

	return declared;
}

// `[(drvPath, [outputName, ...]), ...]`. A derivation with dynamic input
// derivations serialises as `DrvWithVersion(...)`, which `readDerive` refuses
// before this function runs, so every node here is a plain list.
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
				'an input derivation is not a path and its outputs'
			);
		}

		const [drvPath, outputNames] = input;

		if (
			typeof drvPath !== 'string' ||
			outputNames === undefined ||
			!isSequence(outputNames)
		) {
			throw new MalformedDerivationError(
				'an input derivation path is not a string or its outputs are not a list'
			);
		}

		required.set(
			storePathSchema.parse(drvPath),
			outputNames.map((outputName) => {
				if (isSequence(outputName)) {
					throw new MalformedDerivationError(
						'an input derivation output is not a name'
					);
				}

				return outputName;
			})
		);
	}

	return required;
}

// `[storePath, ...]`. These are opaque store paths the builder reads directly,
// distinct from the selected outputs of the input derivations above.
function derivationSources(
	elements: readonly ATermValue[]
): readonly StorePathString[] {
	const sources = elements[inputSourceIndex];

	if (sources === undefined || !isSequence(sources)) {
		throw new MalformedDerivationError('the input sources are not a list');
	}

	return sources.map((source) => {
		if (isSequence(source)) {
			throw new MalformedDerivationError('an input source is not a path');
		}

		return storePathSchema.parse(source);
	});
}

// `"<system>"`. The platform the derivation's builder runs on.
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
		// Nix writes an unstructured list as its whitespace-joined members.
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
 * The derivation path referenced by an installable, or `undefined` if it does
 * not reference a derivation. A derived path appends `^` and its expected
 * outputs to the derivation path, so this function removes that suffix.
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

// Structured attributes travel in the `__json` environment entry, parsed here.
// A derivation without that entry has no structured attributes.
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

/**
 * A derivation ATerm as far as this module reads it: a nested value is either
 * a string or a sequence. Lists and tuples both parse as sequences because
 * this module does not distinguish between them.
 */
type ATermValue = string | readonly ATermValue[];

function isSequence(value: ATermValue): value is readonly ATermValue[] {
	return typeof value !== 'string';
}

// `Derive(outputs, inputDerivations, inputSources, platform, builder, args,
// environment)`. Every element before the last one this module reads has to be
// parsed to find where that element starts, so the reader parses the whole
// term.
const derivePrefix = 'Derive(';
const deriveElementCount = 7;
const outputIndex = 0;
const inputDerivationIndex = 1;
const inputSourceIndex = 2;
const platformIndex = 3;
const environmentIndex = 6;

// `(name, path, hashAlgo, hash)`.
const outputFieldCount = 4;

// The seven elements of the `Derive(...)` term the given bytes serialise.
function derivationTerm(aterm: string): readonly ATermValue[] {
	return new ATermReader(aterm).readDerive();
}

// The environment as a map from name to value. A derivation may repeat a
// name, and Nix keeps the last one it reads, which is what a map assignment
// does.
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

// Nix escapes the quote and backslash characters inside an ATerm string, along
// with the three whitespace characters listed here.
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

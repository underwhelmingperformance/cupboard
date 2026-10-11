import { z } from 'zod';

import { ProtocolError } from './errors.ts';
import {
	type NixFingerprint,
	nixFingerprintSchema,
	nixKeyNameSchema,
	storePathBasenameSchema,
	storePathNameMaxLength,
	storePathNamePattern
} from './scalars.ts';
import { isNixSignature, NixSignature } from './signature.ts';

export const nixOutputNameSchema = z
	.string()
	.min(1)
	.max(storePathNameMaxLength)
	.regex(storePathNamePattern)
	.brand('NixOutputName');

export const buildTraceKeySchema = z
	.object({
		drvPath: storePathBasenameSchema,
		outputName: nixOutputNameSchema
	})
	.readonly();
export type BuildTraceKey = z.output<typeof buildTraceKeySchema>;

const signatureSchema = z
	.object({
		keyName: nixKeyNameSchema,
		sig: z.string().max(4096)
	})
	.refine(({ keyName, sig }) => isNixSignature(`${keyName}:${sig}`))
	.readonly();

export const buildTraceValueSchema = z
	.object({
		outPath: storePathBasenameSchema,
		signatures: z.array(signatureSchema).max(1024).default([]).readonly()
	})
	.readonly();
export type BuildTraceValue = z.output<typeof buildTraceValueSchema>;

export const buildTraceSchema = z
	.object({
		key: buildTraceKeySchema,
		value: buildTraceValueSchema
	})
	.readonly();

const namedSignatureSchema = z.string().max(8192).refine(isNixSignature);
const inputSignatureSchema = z.union([signatureSchema, namedSignatureSchema]);
const inputValueSchema = z.object({
	outPath: storePathBasenameSchema,
	signatures: z.array(inputSignatureSchema).max(1024).default([])
});
const inputSchema = z.object({
	key: buildTraceKeySchema,
	value: inputValueSchema
});

export class InvalidBuildTraceError extends ProtocolError {
	constructor(reason: string) {
		super(`Invalid Nix build trace: ${reason}`);
		this.name = 'InvalidBuildTraceError';
	}
}

/**
 * A Nix 2.35 build-trace entry. The key identifies a resolved derivation output;
 * its signed value specifies the resulting store-path basename.
 */
export class BuildTrace {
	readonly key: BuildTraceKey;
	readonly value: BuildTraceValue;

	constructor(entry: unknown) {
		const parsed = inputSchema.safeParse(entry);
		if (!parsed.success) {
			throw new InvalidBuildTraceError(parsed.error.message);
		}
		this.key = parsed.data.key;
		this.value = buildTraceValueSchema.parse({
			outPath: parsed.data.value.outPath,
			signatures: parsed.data.value.signatures.map((signature) => {
				if (typeof signature !== 'string') {
					return signature;
				}
				const parsedSignature = new NixSignature(signature);
				return { keyName: parsedSignature.name, sig: parsedSignature.material };
			})
		});
	}

	get path(): string {
		return `build-trace-v2/${encodeURIComponent(this.key.drvPath)}/${encodeURIComponent(this.key.outputName)}.doi`;
	}

	get signatureValues(): readonly string[] {
		return this.value.signatures.map(({ keyName, sig }) => `${keyName}:${sig}`);
	}

	/**
	 * The compact JSON document signed by Nix. The key and value use basenames,
	 * and signatures are excluded from the signed document.
	 */
	fingerprint(): NixFingerprint {
		return nixFingerprintSchema.parse(
			JSON.stringify({
				key: this.key,
				value: { outPath: this.value.outPath }
			})
		);
	}

	/**
	 * The value-only JSON body for the entry's `.doi` endpoint.
	 */
	renderValue(): string {
		return JSON.stringify(this.value);
	}
}

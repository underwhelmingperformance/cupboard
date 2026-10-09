import { describe, expect, it } from 'vitest';

import {
	controlDatabaseValidationSecretName,
	validateTransferredControlDatabase
} from './control-database-validation.ts';
import { scriptNameSchema } from './identifiers.ts';

const scriptName = scriptNameSchema.parse('cupboard');

describe('control database validation secret', () => {
	it.each([true, false])(
		'removes the reserved secret after validation success=%s',
		async (success) => {
			const calls: string[] = [];
			let installed: string | undefined;
			const result = validateTransferredControlDatabase({
				api: {
					putSecret: (script, secret) => {
						calls.push(`install:${script}:${secret.name}`);
						installed = secret.text;
						return Promise.resolve();
					}
				},
				cleanupApi: {
					deleteSecret: (script, name) => {
						calls.push(`remove:${script}:${name}`);
						return Promise.resolve();
					}
				},
				scriptName,
				validate: (secret) => {
					expect(secret).toBe(installed);
					expect(secret).toMatch(/^[\w-]{43}$/);
					calls.push('validate');
					return success
						? Promise.resolve()
						: Promise.reject(new Error('key invalid'));
				}
			});
			if (success) {
				await result;
			} else {
				await expect(result).rejects.toThrow('key invalid');
			}
			expect(calls).toStrictEqual([
				`install:cupboard:${controlDatabaseValidationSecretName}`,
				'validate',
				`remove:cupboard:${controlDatabaseValidationSecretName}`
			]);
		}
	);
});

import { ORPCError } from '@orpc/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { abortReason } from '../abort.ts';

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

function fixture(
	validate: (signal: AbortSignal) => Promise<unknown>,
	signal?: AbortSignal
) {
	const calls: string[] = [];
	let installed: string | undefined;
	const options = {
		api: {
			putSecret: (
				_script: typeof scriptName,
				secret: { name: string; text: string }
			) => {
				calls.push('install');
				installed = secret.text;
				return Promise.resolve();
			}
		},
		cleanupApi: {
			deleteSecret: (script: typeof scriptName, name: string) => {
				calls.push(`remove:${script}:${name}`);
				return Promise.resolve();
			}
		},
		scriptName,
		signal,
		sleep: (ms: number) =>
			new Promise<void>((resolve) => setTimeout(resolve, ms)),
		validate: (secret: string, validationSignal: AbortSignal) => {
			expect(secret).toBe(installed);
			calls.push('validate');
			return validate(validationSignal);
		}
	};
	return { calls, options };
}

describe('temporary validation secret propagation', () => {
	afterEach(() => vi.useRealTimers());

	it('retries authentication refusal with the same installed secret', async () => {
		vi.useFakeTimers();
		let attempts = 0;
		const { calls, options } = fixture(() => {
			attempts += 1;
			return attempts < 3
				? Promise.reject(new ORPCError('UNAUTHORIZED'))
				: Promise.resolve({ valid: true });
		});
		const result = validateTransferredControlDatabase(options);
		const completed = validationOutcome(result);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(await completed).toBeUndefined();
		expect(calls).toStrictEqual([
			'install',
			'validate',
			'validate',
			'validate',
			`remove:cupboard:${controlDatabaseValidationSecretName}`
		]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each([
		new ORPCError('INTERNAL_SERVER_ERROR', { message: 'invalid copied key' }),
		new ORPCError('SERVICE_UNAVAILABLE'),
		new ORPCError('FORBIDDEN', { status: 401 })
	])('does not retry a validation failure: %s', async (failure) => {
		const { calls, options } = fixture(() => Promise.reject(failure));
		await expect(validateTransferredControlDatabase(options)).rejects.toBe(
			failure
		);
		expect(calls).toStrictEqual([
			'install',
			'validate',
			`remove:cupboard:${controlDatabaseValidationSecretName}`
		]);
	});

	it('bounds persistent authentication refusal and removes the secret', async () => {
		vi.useFakeTimers();
		const { calls, options } = fixture(() =>
			Promise.reject(new ORPCError('UNAUTHORIZED'))
		);
		const result = validateTransferredControlDatabase(options);
		const rejected = validationOutcome(result);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(await rejected).toStrictEqual(
			new DOMException(
				'Control database validation did not complete within 60 seconds',
				'TimeoutError'
			)
		);
		expect(calls).toStrictEqual([
			'install',
			...Array.from({ length: 12 }, () => 'validate'),
			`remove:cupboard:${controlDatabaseValidationSecretName}`
		]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('aborts an in-flight request at the validation deadline', async () => {
		vi.useFakeTimers();
		const { calls, options } = fixture(
			(signal) =>
				new Promise((_, reject) => {
					signal.addEventListener(
						'abort',
						() => {
							calls.push('request-aborted');
							reject(abortReason(signal));
						},
						{ once: true }
					);
				})
		);
		const result = validateTransferredControlDatabase(options);
		const rejected = validationOutcome(result);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(await rejected).toStrictEqual(
			new DOMException(
				'Control database validation did not complete within 60 seconds',
				'TimeoutError'
			)
		);
		expect(calls).toStrictEqual([
			'install',
			'validate',
			'request-aborted',
			`remove:cupboard:${controlDatabaseValidationSecretName}`
		]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each(['waiting', 'request'])(
		'removes the secret after cancellation while %s',
		async (phase) => {
			vi.useFakeTimers();
			const controller = new AbortController();
			const failure = new Error('deployment cancelled');
			const { calls, options } = fixture((signal) => {
				if (phase === 'waiting') {
					return Promise.reject(new ORPCError('UNAUTHORIZED'));
				}
				return new Promise((_, reject) => {
					signal.addEventListener(
						'abort',
						() => {
							calls.push('request-aborted');
							reject(abortReason(signal));
						},
						{ once: true }
					);
				});
			}, controller.signal);
			const result = validateTransferredControlDatabase(options);
			const rejected = validationOutcome(result);
			await vi.advanceTimersByTimeAsync(0);
			controller.abort(failure);
			expect(await rejected).toBe(failure);
			expect(calls).toStrictEqual([
				'install',
				'validate',
				...(phase === 'request' ? ['request-aborted'] : []),
				`remove:cupboard:${controlDatabaseValidationSecretName}`
			]);
			await vi.advanceTimersByTimeAsync(5000);
			expect(vi.getTimerCount()).toBe(0);
		}
	);
});

async function validationOutcome(result: Promise<unknown>): Promise<unknown> {
	try {
		return await result;
	} catch (error) {
		return error;
	}
}

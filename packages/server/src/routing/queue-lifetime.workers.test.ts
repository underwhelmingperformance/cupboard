import { tenantIdSchema } from '@cupboard/nix-store/scalars';
import {
	createExecutionContext,
	waitOnExecutionContext
} from 'cloudflare:test';
import { env as tenantEnv } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NarReadBufferPool } from '../blob/nar-read-buffers.ts';
import { type R2RequestAdmission } from '../blob/r2-request-admission.ts';
import { testControlEnv } from '../test-support.ts';
import worker from '../worker.ts';

import { handleWorkerQueue } from './queue.ts';
import * as scheduled from './scheduled.ts';

function batch(actions: string[], count = 1): MessageBatch {
	return {
		queue: 'cupboard-maintenance',
		metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
		messages: Array.from({ length: count }, (_, index): Message => ({
			id: `verify-${index.toString()}`,
			timestamp: new Date(),
			attempts: 1,
			body: { kind: 'tenant-verify', tenant: tenantIdSchema.parse('acme') },
			ack: () => {
				actions.push('ack');
			},
			retry: () => {
				actions.push('retry');
			}
		})),
		ackAll: () => {
			throw new Error('Unexpected batch acknowledgement');
		},
		retryAll: () => {
			throw new Error('Unexpected batch retry');
		}
	};
}

describe('Worker queue invocation lifetime', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});
	it('shares R2 admission across deferred work from separate verification passes', async () => {
		const gate = Promise.withResolvers<undefined>();
		const actions: string[] = [];
		const deferred: Promise<void>[] = [];
		const admissions = new Set<R2RequestAdmission>();
		let active = 0;
		let peak = 0;
		let started = 0;
		const read = async () => {
			active++;
			started++;
			peak = Math.max(peak, active);
			await gate.promise;
			active--;
		};
		vi.spyOn(scheduled, 'verifyTenant').mockImplementation((...arguments_) => {
			const options = arguments_[7];
			if (options?.admission === undefined) {
				return Promise.resolve();
			}
			const admission = options.admission;
			admissions.add(admission);
			for (let index = 0; index < 4; index++) {
				options.defer?.(admission.read(read));
			}
			return Promise.resolve();
		});
		try {
			await handleWorkerQueue(
				batch(actions, 2),
				{ ...tenantEnv, ...testControlEnv },
				new NarReadBufferPool(),
				{
					defer: (completion) => {
						deferred.push(completion);
					}
				}
			);
			const before = {
				active,
				peak,
				started,
				actions: [...actions],
				admissions: admissions.size
			};
			gate.resolve(undefined);
			await Promise.all(deferred);
			expect({ before, active, peak, started, actions }).toStrictEqual({
				before: {
					active: 6,
					peak: 6,
					started: 6,
					actions: ['ack', 'ack'],
					admissions: 1
				},
				active: 0,
				peak: 6,
				started: 8,
				actions: ['ack', 'ack']
			});
		} finally {
			gate.resolve(undefined);
			await Promise.all(deferred);
		}
	});
	it('forwards the real execution context to verification without waiting before acknowledgement', async () => {
		const context = createExecutionContext();
		const gate = Promise.withResolvers<undefined>();
		const actions: string[] = [];
		let isForwarded = false;
		const verify = vi
			.spyOn(scheduled, 'verifyTenant')
			.mockImplementation((...arguments_) => {
				const options = arguments_[7];
				if (options?.defer === undefined) {
					return Promise.resolve();
				}

				isForwarded = true;
				options.defer(gate.promise);
				return Promise.resolve();
			});
		try {
			await worker.queue(
				batch(actions),
				{ ...tenantEnv, ...testControlEnv },
				context
			);
			let isComplete = false;
			const waiting = waitOnExecutionContext(context);
			void waiting.then(() => {
				isComplete = true;
			});
			await Promise.resolve();
			const before = {
				isForwarded,
				isComplete,
				actions: [...actions],
				calls: verify.mock.calls.length
			};
			gate.resolve(undefined);
			await waiting;
			expect({ before, isComplete, actions }).toStrictEqual({
				before: {
					isForwarded: true,
					isComplete: false,
					actions: ['ack'],
					calls: 1
				},
				isComplete: true,
				actions: ['ack']
			});
		} finally {
			gate.resolve(undefined);
			await waitOnExecutionContext(context);
		}
	});
});

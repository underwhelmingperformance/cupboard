import { createHash, randomUUID } from 'node:crypto';

import { byCodeUnit } from '@cupboard/nix-store/store-path';
import { retryingFetcher } from '@cupboard/shared/retry';
import {
	type Context,
	defaultTextMapSetter,
	SpanKind,
	SpanStatusCode,
	trace
} from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';

export interface MetadataProbeInput {
	readonly operation: 'discovery' | 'legacy' | 'metadata' | 'intersection';
	readonly inputs: readonly string[];
}

export interface MetadataProbeOutcome {
	readonly status: 'complete' | 'continuation' | 'capability';
	readonly checked: number;
	readonly found: number;
	readonly missing: number;
	readonly possibleMatches?: number;
}

export interface MetadataProbeResult<T> {
	readonly value: T;
	readonly outcome: MetadataProbeOutcome;
}

export interface MetadataProbeObserver {
	run<T>(
		input: MetadataProbeInput,
		operation: (fetcher: typeof fetch) => Promise<MetadataProbeResult<T>>
	): Promise<T>;
}

interface MetadataRequestIdentity {
	readonly version: 1;
	readonly source: string;
	readonly requestId: string;
	readonly operation: MetadataProbeInput['operation'];
	readonly inputCount: number;
	readonly inputFingerprint: string;
	readonly inputOrderFingerprint: string;
}

export interface MetadataAttemptDiagnostic extends MetadataRequestIdentity {
	readonly kind: 'attempt';
	readonly attempt: number;
	readonly traceId: string;
	readonly spanId: string;
	readonly propagated: boolean;
	readonly startedAt: number;
	readonly headersAt?: number;
	readonly finishedAt: number;
	readonly elapsedMs: number;
	readonly status?: number;
	readonly body: 'complete' | 'cancelled' | 'error' | 'incomplete';
	readonly errorType?: string;
}

export interface MetadataRequestDiagnostic extends MetadataRequestIdentity {
	readonly kind: 'request';
	readonly traceId: string;
	readonly startedAt: number;
	readonly finishedAt: number;
	readonly elapsedMs: number;
	readonly attempts: number;
	readonly outcome:
		| MetadataProbeOutcome
		| { readonly status: 'error'; readonly errorType: string };
}

export interface MetadataSourceDiagnostic {
	readonly version: 1;
	readonly kind: 'source';
	readonly traceId: string;
	readonly source: string;
	readonly mode: 'discovering' | 'bulk' | 'legacy';
	readonly status: 'complete' | 'error';
	readonly checked: number;
	readonly total: number;
	readonly found: number;
	readonly missing: number;
	readonly remaining: number;
	readonly requests: number;
	readonly inFlight: number;
	readonly elapsedMs: number;
	readonly droppedRecords: number;
}

/**
Client transport attempts, validated lookup results and final source accounting.
*/
export type TenantDependencyDiagnostic =
	| MetadataAttemptDiagnostic
	| MetadataRequestDiagnostic
	| MetadataSourceDiagnostic;

interface MetadataDiagnosticsOptions {
	readonly source: string;
	readonly parent: Context;
	readonly propagate: boolean;
	readonly fetcher: typeof fetch;
	readonly onChange: (inFlightDelta: number, requestDelta: number) => void;
	readonly onDiagnostic?: (diagnostic: TenantDependencyDiagnostic) => void;
	readonly onDiagnosticError?: (error: unknown) => void;
}

function errorType(error: unknown): string {
	return error instanceof Error ? error.name : 'UnknownError';
}

function observeBody(
	response: Response,
	finish: (body: MetadataAttemptDiagnostic['body'], error?: unknown) => void
): Response {
	if (response.body === null) {
		finish('complete');
		return response;
	}
	const reader = response.body.getReader();
	let isCancelled = false;
	return new Response(
		new ReadableStream<Uint8Array>({
			async pull(controller) {
				try {
					const result = await reader.read();
					if (isCancelled) {
						return;
					}
					if (result.done) {
						controller.close();
						reader.releaseLock();
						finish('complete');
						return;
					}
					const value: unknown = result.value;
					if (!(value instanceof Uint8Array)) {
						throw new TypeError(
							'The metadata response body must contain bytes'
						);
					}
					controller.enqueue(value);
				} catch (error) {
					if (isCancelled) {
						return;
					}
					controller.error(error);
					reader.releaseLock();
					finish('error', error);
				}
			},
			async cancel(reason) {
				isCancelled = true;
				try {
					await reader.cancel(reason);
				} finally {
					reader.releaseLock();
					finish('cancelled');
				}
			}
		}),
		{
			status: response.status,
			statusText: response.statusText,
			headers: response.headers
		}
	);
}

export class MetadataDiagnostics implements MetadataProbeObserver {
	#droppedRecords = 0;
	readonly #propagator = new W3CTraceContextPropagator();

	constructor(readonly options: MetadataDiagnosticsOptions) {}

	async #attempt(
		context: {
			readonly identity: MetadataRequestIdentity;
			readonly attempt: number;
			readonly unfinished: Set<() => void>;
		},
		input: Parameters<typeof fetch>[0],
		init: Parameters<typeof fetch>[1]
	): Promise<Response> {
		const { identity, attempt, unfinished } = context;
		const requestSpan = trace.getTracer('cupboard.nix').startSpan(
			'cache-metadata-request',
			{
				kind: SpanKind.CLIENT,
				attributes: {
					'server.address': new URL(this.options.source).hostname,
					'http.request.method': init?.method ?? 'GET',
					'cupboard.probe.operation': identity.operation,
					'cupboard.probe.input_sha256': identity.inputFingerprint,
					'cupboard.probe.attempt': attempt
				}
			},
			this.options.parent
		);
		let isPropagated = false;
		const headers = new Headers(
			init?.headers ?? (input instanceof Request ? input.headers : undefined)
		);
		if (this.options.propagate) {
			const carrier: Record<string, string> = {};
			this.#propagator.inject(
				trace.setSpan(this.options.parent, requestSpan),
				carrier,
				defaultTextMapSetter
			);
			isPropagated = carrier.traceparent !== undefined;
			for (const [key, value] of Object.entries(carrier)) {
				headers.set(key, value);
			}
		}
		const startedAt = Date.now();
		let headersAt: number | undefined;
		let status: number | undefined;
		let isFinished = false;
		const finish = (
			body: MetadataAttemptDiagnostic['body'],
			error?: unknown
		): void => {
			if (isFinished) {
				return;
			}
			isFinished = true;
			unfinished.delete(abandon);
			if (error !== undefined) {
				if (error instanceof Error) {
					requestSpan.recordException(error);
				}
				requestSpan.setStatus({ code: SpanStatusCode.ERROR });
			}
			requestSpan.end();
			const finishedAt = Date.now();
			this.emit({
				...identity,
				kind: 'attempt',
				attempt,
				traceId: requestSpan.spanContext().traceId,
				spanId: requestSpan.spanContext().spanId,
				propagated: isPropagated,
				startedAt,
				...(headersAt !== undefined && { headersAt }),
				finishedAt,
				elapsedMs: finishedAt - startedAt,
				...(status !== undefined && { status }),
				body,
				...(error !== undefined && { errorType: errorType(error) })
			});
			this.options.onChange(-1, 0);
		};
		const abandon = (): void => {
			finish('incomplete');
		};
		unfinished.add(abandon);
		this.options.onChange(1, 1);
		try {
			const response = await this.options.fetcher(input, {
				...init,
				headers,
				...(this.options.propagate && { redirect: 'error' })
			});
			headersAt = Date.now();
			status = response.status;
			requestSpan.setAttribute('http.response.status_code', status);
			if (status >= 500) {
				requestSpan.setStatus({ code: SpanStatusCode.ERROR });
			}
			return observeBody(response, finish);
		} catch (error) {
			finish('error', error);
			throw error;
		}
	}
	get droppedRecords(): number {
		return this.#droppedRecords;
	}

	emit(diagnostic: TenantDependencyDiagnostic): void {
		try {
			this.options.onDiagnostic?.(diagnostic);
		} catch (error) {
			this.#droppedRecords += 1;
			try {
				this.options.onDiagnosticError?.(error);
			} catch {
				return;
			}
		}
	}

	async run<T>(
		input: MetadataProbeInput,
		operation: (fetcher: typeof fetch) => Promise<MetadataProbeResult<T>>
	): Promise<T> {
		const ordered = JSON.stringify(input.inputs);
		const identity: MetadataRequestIdentity = {
			version: 1,
			source: this.options.source,
			requestId: randomUUID(),
			operation: input.operation,
			inputCount: input.inputs.length,
			inputOrderFingerprint: createHash('sha256').update(ordered).digest('hex'),
			inputFingerprint: createHash('sha256')
				.update(
					input.operation === 'metadata'
						? JSON.stringify(input.inputs.toSorted(byCodeUnit))
						: ordered
				)
				.digest('hex')
		};
		const startedAt = Date.now();
		let attempts = 0;
		const unfinished = new Set<() => void>();
		const fetcher: typeof fetch = (request, init) =>
			this.#attempt(
				{ identity, attempt: ++attempts, unfinished },
				request,
				init
			);
		let outcome: MetadataRequestDiagnostic['outcome'] = {
			status: 'error',
			errorType: 'UnknownError'
		};
		try {
			const result = await operation(retryingFetcher(fetcher, 'replay-safe'));
			outcome = result.outcome;
			return result.value;
		} catch (error) {
			outcome = { status: 'error', errorType: errorType(error) };
			throw error;
		} finally {
			for (const finish of unfinished) {
				finish();
			}
			const finishedAt = Date.now();
			this.emit({
				...identity,
				kind: 'request',
				traceId: trace.getSpanContext(this.options.parent)?.traceId ?? '',
				startedAt,
				finishedAt,
				elapsedMs: finishedAt - startedAt,
				attempts,
				outcome
			});
		}
	}
}

/*
Adapted from opentelemetry-js-cloudflare-workers-adapter 0.1.4,
https://github.com/irvinebroque/opentelemetry-js-cloudflare-workers-adapter
at commit 2f2c3ac. The upstream project recommends copying this file into the
Worker rather than installing it, and it is not published to npm. This copy is
reformatted to this repository's conventions; its behaviour is unchanged
except that registration no longer supports duplicate bundles or development
module reloads, which this Worker does not have.

MIT License

Copyright (c) 2026 the contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
import { AsyncLocalStorage } from 'node:async_hooks';

import {
	type Attributes,
	type Context,
	context,
	type ContextManager,
	createContextKey,
	diag,
	type Exception,
	INVALID_SPAN_CONTEXT,
	type Link,
	ROOT_CONTEXT,
	type Span,
	type SpanContext,
	SpanKind,
	type SpanOptions,
	type SpanStatus,
	SpanStatusCode,
	type TimeInput,
	trace,
	type Tracer,
	type TracerProvider
} from '@opentelemetry/api';
import { tracing } from 'cloudflare:workers';

type NativeSpan = ReturnType<typeof tracing.startSpan>;

interface Scope {
	readonly context: Context;
	readonly native: NativeSpan | undefined;
}

const nativeNameLimitBytes = 64;
const spans = new WeakMap<NativeSpan, Span>();
const reported = new Set<string>();
// Shared with `suppressTracing()` from `@opentelemetry/core`, without depending
// on the SDK.
const suppressionKey = createContextKey(
	'OpenTelemetry SDK Context Key SUPPRESS_TRACING'
);

function isSuppressed(parent: Context): boolean {
	return parent.getValue(suppressionKey) === true;
}

function unsupported(feature: string): void {
	if (reported.has(feature)) {
		return;
	}

	reported.add(feature);
	try {
		diag.warn(`[workers-otel] Unsupported: ${feature}.`);
	} catch {
		// Diagnostics must never affect the traced code.
	}
}

// Catches telemetry failures only. Application callbacks must stay outside this
// boundary, so that their errors propagate and they never run twice.
function safely<T>(operation: () => T): T | undefined {
	try {
		return operation();
	} catch {
		unsupported('telemetry operation failed (ignored)');
		return undefined;
	}
}

// The native byte limit can cut through a UTF-8 character, so names are
// truncated at a character boundary before they reach the runtime.
function nativeName(name: string): string {
	const bytes = new TextEncoder().encode(name);

	if (bytes.length <= nativeNameLimitBytes) {
		return name;
	}

	let end = nativeNameLimitBytes;

	while (((bytes[end] ?? 0) & 0xc0) === 0x80) {
		end -= 1;
	}

	unsupported('span names over 64 UTF-8 bytes (truncated)');

	return new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(
		bytes.subarray(0, end)
	);
}

function wrap(native: NativeSpan): Span {
	const existing = spans.get(native);

	if (existing !== undefined) {
		return existing;
	}

	const span = new WorkersSpan(native);
	spans.set(native, span);

	return span;
}

function nativeStatusCode(code: SpanStatusCode): 'error' | 'ok' | undefined {
	switch (code) {
		case SpanStatusCode.ERROR: {
			return 'error';
		}
		case SpanStatusCode.OK: {
			return 'ok';
		}
		case SpanStatusCode.UNSET: {
			return undefined;
		}
	}
}

class WorkersSpan implements Span {
	// Native spans are request-owned I/O objects, and their IDs must outlive
	// the request.
	private readonly ids: SpanContext;
	private status: SpanStatusCode = SpanStatusCode.UNSET;

	constructor(private readonly native: NativeSpan) {
		this.ids = native.spanContext();
	}

	spanContext(): SpanContext {
		return { ...this.ids };
	}

	isRecording(): boolean {
		return safely(() => this.native.isTraced) ?? false;
	}

	setAttribute(key: string, value: unknown): this {
		if (key === '' || value === undefined || !this.isRecording()) {
			return this;
		}

		if (
			typeof value === 'string' ||
			typeof value === 'boolean' ||
			typeof value === 'number'
		) {
			safely(() => this.native.setAttribute(key, value));
		} else {
			unsupported('non-scalar attributes (dropped)');
		}

		return this;
	}

	setAttributes(attributes: Attributes): this {
		if (this.isRecording()) {
			safely(() => {
				for (const [key, value] of Object.entries(attributes)) {
					this.setAttribute(key, value);
				}
			});
		}

		return this;
	}

	setStatus(status: SpanStatus): this {
		safely(() => {
			const code = nativeStatusCode(status.code);

			// OTel lets an `OK` status stand once set.
			if (code === undefined || this.status === SpanStatusCode.OK) {
				return;
			}

			this.native.setStatus({
				code,
				message: code === 'error' ? status.message : undefined
			});
			this.status = status.code;
		});

		return this;
	}

	updateName(name: string): this {
		safely(() => this.native.updateName(nativeName(name)));

		return this;
	}

	recordException(exception: Exception, time?: TimeInput): void {
		if (time !== undefined) {
			unsupported('custom exception timestamps (using runtime time)');
		}

		safely(() => {
			this.native.recordException(exception);
		});
	}

	end(time?: TimeInput): void {
		if (time !== undefined) {
			unsupported('custom end timestamps (using runtime time)');
		}

		safely(() => {
			this.native.end();
		});
	}

	addEvent(): this {
		unsupported('span events other than recordException (dropped)');

		return this;
	}

	addLink(): this {
		unsupported('span links (dropped)');

		return this;
	}

	addLinks(links: Link[]): this {
		if (links.length > 0) {
			unsupported('span links (dropped)');
		}

		return this;
	}
}

class WorkersContextManager implements ContextManager {
	storage: AsyncLocalStorage<Scope> | undefined;

	active(): Context {
		if (this.storage === undefined) {
			return ROOT_CONTEXT;
		}

		const scope = this.storage.getStore();
		const native = safely(() => tracing.getActiveSpan());

		// An explicit OTel context wins until code enters a new native span.
		if (scope !== undefined && native === scope.native) {
			return scope.context;
		}

		const base = scope?.context ?? ROOT_CONTEXT;

		return native === undefined
			? base
			: (safely(() => trace.setSpan(base, wrap(native))) ?? base);
	}

	with<A extends unknown[], F extends (...parameters: A) => ReturnType<F>>(
		activeContext: Context,
		callback: F,
		thisArgument?: ThisParameterType<F>,
		...parameters: A
	): ReturnType<F> {
		const run = (): ReturnType<F> =>
			Reflect.apply(callback, thisArgument, parameters);

		if (this.storage === undefined) {
			return run();
		}

		return this.storage.run(
			{
				context: activeContext,
				native: safely(() => tracing.getActiveSpan())
			},
			run
		);
	}

	bind<T>(boundContext: Context, target: T): T {
		if (typeof target !== 'function') {
			unsupported('context.bind on non-functions (unchanged)');
			return target;
		}

		const run = (thisArgument: unknown, parameters: unknown[]): unknown =>
			this.with(boundContext, (): unknown => {
				const result: unknown = Reflect.apply(target, thisArgument, parameters);

				return result;
			});

		return function (this: unknown, ...parameters: unknown[]): unknown {
			return run(this, parameters);
		} as T;
	}

	enable(): this {
		this.storage ??= new AsyncLocalStorage<Scope>();

		return this;
	}

	// Workers has no `AsyncLocalStorage.disable()`, so this drops access to
	// the old scopes instead.
	disable(): this {
		this.storage = undefined;

		return this;
	}
}

const manager = new WorkersContextManager();

// Uses OTel's no-op propagation when a native span cannot represent the
// request faithfully.
function nonRecording(options: SpanOptions, parent: Context): Span {
	const wanted = safely(() =>
		options.root === true || isSuppressed(parent)
			? undefined
			: trace.getSpanContext(parent)
	);

	return trace.wrapSpanContext(
		wanted !== undefined && trace.isSpanContextValid(wanted)
			? wanted
			: INVALID_SPAN_CONTEXT
	);
}

function unsupportedCreation(
	options: SpanOptions,
	wanted: SpanContext,
	actual: SpanContext | undefined,
	hasHiddenParent: boolean
): string | undefined {
	if (
		!hasHiddenParent &&
		(!trace.isSpanContextValid(wanted) ||
			wanted.isRemote === true ||
			(wanted.traceState?.serialize() ?? '') !== '' ||
			wanted.traceId !== actual?.traceId ||
			wanted.spanId !== actual.spanId ||
			wanted.traceFlags !== actual.traceFlags)
	) {
		return 'parent context';
	}

	if (options.kind !== undefined && options.kind !== SpanKind.INTERNAL) {
		return 'span kind';
	}

	if (options.startTime !== undefined) {
		return 'custom start timestamp';
	}

	if ((options.links?.length ?? 0) > 0) {
		return 'links at span creation';
	}

	return undefined;
}

function canCreate(
	options: SpanOptions,
	noop: Span,
	isImplicit: boolean
): boolean {
	const wanted = noop.spanContext();
	const actual = tracing.getActiveSpan()?.spanContext();
	const scope = manager.storage?.getStore();
	// Hibernatable WebSocket events can have a native parent without exposing
	// an active span. Only default ambient creation may ask the runtime to use
	// it.
	const hasHiddenParent =
		actual === undefined &&
		isImplicit &&
		options.root !== true &&
		!trace.isSpanContextValid(wanted) &&
		(scope === undefined ||
			(scope.context !== ROOT_CONTEXT &&
				trace.getSpan(scope.context) === undefined));

	if (
		!hasHiddenParent &&
		(actual === undefined || !trace.isSpanContextValid(actual))
	) {
		return false;
	}

	const reason = unsupportedCreation(options, wanted, actual, hasHiddenParent);

	if (reason === undefined) {
		return true;
	}

	unsupported(`${reason} (span will not record)`);

	return false;
}

function created(native: NativeSpan, options: SpanOptions, noop: Span): Span {
	const span = safely(() => wrap(native));

	// A native span that is not recorded can have zero IDs even in an
	// invocation that keeps its logs.
	if (span === undefined || !trace.isSpanContextValid(span.spanContext())) {
		safely(() => {
			native.end();
		});
		return noop;
	}

	safely(() => {
		span.setAttributes(options.attributes ?? {});
	});

	return span;
}

function startSpan(
	name: string,
	options: SpanOptions = {},
	parent?: Context
): Span {
	const isImplicit = parent === undefined;
	const effectiveParent = parent ?? context.active();
	const noop = nonRecording(options, effectiveParent);

	return (
		safely(() =>
			!isSuppressed(effectiveParent) && canCreate(options, noop, isImplicit)
				? created(tracing.startSpan(nativeName(name)), options, noop)
				: noop
		) ?? noop
	);
}

function startActiveSpan<F extends (span: Span) => unknown>(
	name: string,
	optionsOrCallback: SpanOptions | F | undefined,
	parentOrCallback?: Context | F,
	maybeCallback?: F
): ReturnType<F> {
	const options =
		typeof optionsOrCallback === 'function' ? {} : (optionsOrCallback ?? {});
	const hasExplicitParent =
		parentOrCallback !== undefined && typeof parentOrCallback === 'object';
	const parent = hasExplicitParent ? parentOrCallback : context.active();
	let callback = maybeCallback;

	if (typeof optionsOrCallback === 'function') {
		callback = optionsOrCallback;
	} else if (typeof parentOrCallback === 'function') {
		callback = parentOrCallback;
	}

	if (callback === undefined) {
		return undefined as ReturnType<F>;
	}

	const body = callback;
	const run = (span: Span): ReturnType<F> =>
		context.with(
			safely(() => trace.setSpan(parent, span)) ??
				trace.setSpan(ROOT_CONTEXT, span),
			() => body(span)
		) as ReturnType<F>;
	const noop = nonRecording(options, parent);

	if (
		safely(
			() =>
				!isSuppressed(parent) && canCreate(options, noop, !hasExplicitParent)
		) !== true
	) {
		return run(noop);
	}

	// The native callback activates platform child spans, and OTel owns
	// `span.end()`.
	const entry = { hasEntered: false };

	try {
		return tracing.startActiveSpan(nativeName(name), (native) => {
			const span = created(native, options, noop);
			entry.hasEntered = true;

			return run(span);
		});
	} catch (error) {
		// Never swallow or retry the application's callback.
		if (entry.hasEntered) {
			throw error;
		}

		unsupported('telemetry operation failed (ignored)');

		return run(noop);
	}
}

const tracer: Tracer = { startSpan, startActiveSpan };
const provider: TracerProvider = { getTracer: () => tracer };

/**
Whether this runtime has every native tracing API that the bridge needs.
*/
export function hasNativeTracing(): boolean {
	// Older runtimes lack some of these members although the types declare
	// them, so each one is read reflectively.
	const spanClass: unknown = Reflect.get(tracing, 'Span');
	const spanPrototype: unknown =
		typeof spanClass === 'function' ? spanClass.prototype : undefined;

	return (
		['getActiveSpan', 'startSpan', 'startActiveSpan'].every(
			(key) => typeof Reflect.get(tracing, key) === 'function'
		) &&
		typeof spanPrototype === 'object' &&
		spanPrototype !== null &&
		['spanContext', 'setStatus', 'updateName'].every(
			(key) => typeof Reflect.get(spanPrototype, key) === 'function'
		)
	);
}

/**
Registers the bridge as the global OTel context manager and tracer provider.
Call it once per isolate. A repeated call returns the registered provider,
and a competing OTel registration throws.
*/
export function registerWorkersTracing(): TracerProvider {
	if (manager.storage !== undefined) {
		return provider;
	}

	if (!hasNativeTracing()) {
		throw new Error(
			'This Workers runtime lacks the native tracing APIs that the OTel bridge needs.'
		);
	}

	if (!context.setGlobalContextManager(manager)) {
		throw new Error('Another OTel context manager is already registered.');
	}

	manager.enable();

	if (!trace.setGlobalTracerProvider(provider)) {
		// Roll back only the context manager that this call installed.
		context.disable();
		manager.disable();
		throw new Error('Another OTel tracer provider is already registered.');
	}

	return provider;
}

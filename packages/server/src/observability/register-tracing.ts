// Imported for its side effect by each Worker entrypoint, before any other
// module, so that spans and the trace fields in logs use Workers tracing from
// the first request.
//
// Tracing must never stop a Worker from starting. Where the bridge cannot
// register, the OTel API stays unregistered and spans are no-ops, so this
// warns once per isolate instead of throwing. The `workerd` that the test pool
// and older Wrangler releases run predates some of the native tracing APIs;
// tests that read spans register their own provider. The logger is not yet
// configured when this module runs, so the warnings go to the console.
import {
	hasNativeTracing,
	registerWorkersTracing
} from './workers-otel-bridge.ts';

if (hasNativeTracing()) {
	try {
		registerWorkersTracing();
	} catch (error) {
		console.warn(
			'Workers tracing is disabled: the OTel bridge did not register.',
			error
		);
	}
} else {
	console.warn(
		'Workers tracing is disabled: this runtime lacks native tracing APIs that the OTel bridge needs. Update Wrangler or the Workers runtime.'
	);
}

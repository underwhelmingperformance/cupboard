import { z } from 'zod';

export const requestCorrelationSchema = z.object({
	requestId: z.string().max(128).optional(),
	cfRay: z.string().max(128).optional(),
	clientTraceId: z
		.string()
		.regex(/^[0-9a-f]{32}$/u)
		.optional(),
	clientSpanId: z
		.string()
		.regex(/^[0-9a-f]{16}$/u)
		.optional()
});

export type RequestCorrelation = z.infer<typeof requestCorrelationSchema>;

/**
Returns correlation fields established by the public ingress.
*/
export function requestCorrelation(request: Request): Record<string, string> {
	const fields: Record<string, string> = {};
	const requestId = request.headers.get('x-request-id');
	const clientTraceId = request.headers.get('x-cupboard-client-trace-id');
	const clientSpanId = request.headers.get('x-cupboard-client-span-id');
	const cfRay = request.headers.get('cf-ray');

	if (cfRay !== null) {
		fields.cfRay = cfRay.slice(0, 128);
	}

	if (requestId !== null) {
		fields.requestId = requestId.slice(0, 128);
	}

	if (clientTraceId !== null && /^[0-9a-f]{32}$/u.test(clientTraceId)) {
		fields.clientTraceId = clientTraceId;
	}

	if (clientSpanId !== null && /^[0-9a-f]{16}$/u.test(clientSpanId)) {
		fields.clientSpanId = clientSpanId;
	}

	return fields;
}

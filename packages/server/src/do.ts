import { DurableObject } from 'cloudflare:workers';

export class CupboardServer extends DurableObject<Env> {
	fetch(_request: Request): Response {
		return new Response('not yet implemented', { status: 501 });
	}
}

const markers = [
	'cupboard-hook-relay: delivery failed:',
	'cupboard: failed to protect every completed output'
] as const;
const overlapLength = Math.max(...markers.map((marker) => marker.length)) - 1;
const markerPattern = new RegExp(markers.join('|'), 'u');

export class HookFailureDetector {
	#overlap = '';
	#failed = false;

	accept(chunk: string): boolean {
		if (this.#failed) {
			return true;
		}

		const current = this.#overlap + chunk;
		this.#failed = markerPattern.test(current);
		this.#overlap = this.#failed ? '' : current.slice(-overlapLength);
		return this.#failed;
	}
}

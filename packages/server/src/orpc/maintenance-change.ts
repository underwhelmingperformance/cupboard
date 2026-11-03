/**
Records whether one request changed state. The tenant router creates one for
each request and reconciles maintenance after a `'when-changed'` procedure
only when its handler records a change.
*/
export class MaintenanceChange {
	private hasRecorded = false;

	get isRecorded(): boolean {
		return this.hasRecorded;
	}

	record(): void {
		this.hasRecorded = true;
	}
}

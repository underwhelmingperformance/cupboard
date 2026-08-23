import type { CommitSessionFrame } from '@cupboard/protocol/upload';

export function sendCommitSessionFrame(
	socket: WebSocket,
	frame: CommitSessionFrame
): void {
	try {
		socket.send(JSON.stringify(frame));
	} catch {
		// This frame was not delivered. Reconnect replay can recover an affected
		// commit entry. Do not throw here because the caller may still need to settle
		// other entries from the same batch.
	}
}

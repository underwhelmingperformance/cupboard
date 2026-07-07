import type { CommitSessionFrame } from '@cupboard/protocol/upload';

// One encoder for every frame the commit session carries, so the protocol
// module's schema stays the single source of the wire shape. A frame lost to
// a closed socket is always recoverable through the client's reconnect replay,
// so a send error ends here and the caller's batch-mates keep settling.
export function sendCommitSessionFrame(
	socket: WebSocket,
	frame: CommitSessionFrame
): void {
	try {
		socket.send(JSON.stringify(frame));
	} catch {
		// The client half closed mid-batch. The client will reconnect and replay
		// any unacknowledged entries, so the frame is not lost.
	}
}

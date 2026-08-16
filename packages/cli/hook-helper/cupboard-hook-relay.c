/*
 * cupboard-hook-relay: relays one post-build event from standard input to
 * the invocation socket named by argv[1].
 *
 * A non-zero exit from a post-build hook fails the derivation's goal in
 * Nix, so every failure path here warns on standard error and exits zero.
 * Reads and writes run under a poll-based inactivity timeout, so an
 * unresponsive supervisor cannot hold a build open beyond it.
 */

#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

/* Inactivity between poll events, not total transfer time. */
static const int inactivity_timeout_ms = 3000;

/* Linux suppresses SIGPIPE per send; Darwin per socket via SO_NOSIGPIPE.
 * A SIGPIPE death would break the exit-zero contract above. */
#ifndef MSG_NOSIGNAL
#define MSG_NOSIGNAL 0
#endif

static int warn(const char *detail)
{
	fprintf(stderr, "cupboard-hook-relay: delivery failed: %s\n", detail);
	return 0;
}

static int wait_for_listener(int sock)
{
	unsigned char response;

	if (shutdown(sock, SHUT_WR) < 0)
		return warn(strerror(errno));

	for (;;) {
		struct pollfd input = { .fd = sock, .events = POLLIN };

		if (poll(&input, 1, inactivity_timeout_ms) <= 0)
			return warn("the listener did not confirm the event");

		ssize_t received = read(sock, &response, sizeof(response));

		if (received < 0 && (errno == EAGAIN || errno == EWOULDBLOCK))
			continue;

		if (received < 0)
			return warn(strerror(errno));

		if (received == 0)
			return warn("Cupboard did not accept the completed outputs");

		if (response == 1)
			return 0;

		return warn("Cupboard returned an invalid response");
	}
}

static int relay(int sock)
{
	char buffer[4096];

	for (;;) {
		struct pollfd input = { .fd = STDIN_FILENO, .events = POLLIN };

		if (poll(&input, 1, inactivity_timeout_ms) <= 0)
			return warn("standard input went quiet");

		ssize_t received = read(STDIN_FILENO, buffer, sizeof(buffer));

		if (received < 0)
			return warn(strerror(errno));

		/* End of input: wait until the listener has accepted the event. */
		if (received == 0)
			return wait_for_listener(sock);

		size_t written = 0;

		while (written < (size_t)received) {
			struct pollfd output = { .fd = sock, .events = POLLOUT };

			if (poll(&output, 1, inactivity_timeout_ms) <= 0)
				return warn("the listener went quiet");

			ssize_t sent = send(sock, buffer + written,
					    (size_t)received - written, MSG_NOSIGNAL);

			if (sent < 0 && (errno == EAGAIN || errno == EWOULDBLOCK))
				continue;

			if (sent < 0)
				return warn(strerror(errno));

			written += (size_t)sent;
		}
	}
}

int main(int argc, char **argv)
{
	if (argc != 2)
		return warn("expected exactly one argument, the socket path");

	struct sockaddr_un address;

	memset(&address, 0, sizeof(address));
	address.sun_family = AF_UNIX;

	if (strlen(argv[1]) >= sizeof(address.sun_path))
		return warn("socket path does not fit sun_path");

	strncpy(address.sun_path, argv[1], sizeof(address.sun_path) - 1);

	int sock = socket(AF_UNIX, SOCK_STREAM, 0);

	if (sock < 0)
		return warn(strerror(errno));

	/* Connecting to an endpoint with no listener fails at once rather
	 * than blocking; that immediate signal is why the transport is a
	 * socket at all. */
	if (connect(sock, (struct sockaddr *)&address, sizeof(address)) < 0) {
		close(sock);
		return warn(strerror(errno));
	}

#ifdef SO_NOSIGPIPE
	int one = 1;
	setsockopt(sock, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof(one));
#endif

	/* Non-blocking sends keep the inactivity timeout honest: a full
	 * kernel buffer surfaces as a poll timeout, never an open-ended
	 * blocking write. */
	fcntl(sock, F_SETFL, O_NONBLOCK);

	int status = relay(sock);

	close(sock);

	return status;
}

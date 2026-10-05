#include <poll.h>
#include <stdio.h>
#include <unistd.h>

static int controlled_poll(struct pollfd *fds, nfds_t count, int timeout)
{
	if (count == 1 && fds[0].fd != STDIN_FILENO && fds[0].events == POLLIN) {
		printf("{\"timeoutMs\":%d}\n", timeout);
		return 0;
	}

	return poll(fds, count, timeout);
}

#define poll controlled_poll
#include "../../packages/cli/hook-helper/cupboard-hook-relay.c"

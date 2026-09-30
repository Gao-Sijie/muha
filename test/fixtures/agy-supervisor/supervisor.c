#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/signalfd.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

/* Research prototype. fd 0/1/2 belong to the CLI; fd 3 is a private duplex
 * control channel, closed before native exec. The helper is single-threaded
 * and the only reaper of its children. Its own death is outside this proof. */
static int control_fd = 3;
static int signal_fd = -1;
static int exec_fd = -1;
static pid_t native_pid = -1;
static bool closing = false;
static bool cleanup_error = false;
static long long force_at;
static char children_path[96];

static long long now_ms(void) {
    struct timespec value;
    if (clock_gettime(CLOCK_MONOTONIC, &value) < 0) _exit(125);
    return (long long)value.tv_sec * 1000 + value.tv_nsec / 1000000;
}

static void error_event(const char *operation) {
    int saved = errno;
    dprintf(control_fd, "{\"type\":\"error\",\"operation\":\"%s\",\"errno\":%d}\n", operation, saved);
    cleanup_error = true;
}

/* No wait(), SIGCHLD reaper, SA_NOCLDWAIT, or second thread may run between
 * reading a PID here and signalling it. Even an exited direct child remains
 * ours, unreaped, so its PID cannot be reused. A truncated/racing list is never
 * treated as complete: subsequent adoption passes continue until ECHILD. */
static int signal_direct_children(int signo) {
    FILE *children = fopen(children_path, "re");
    if (!children) return -1;
    long value;
    int count = 0;
    while (fscanf(children, "%ld", &value) == 1) {
        if (value <= 1 || value > INT_MAX || value == getpid()) {
            errno = EINVAL;
            fclose(children);
            return -1;
        }
        if (kill((pid_t)value, signo) < 0 && errno != ESRCH) {
            int saved = errno;
            fclose(children);
            errno = saved;
            return -1;
        }
        count++;
    }
    if (ferror(children)) {
        int saved = errno;
        fclose(children);
        errno = saved;
        return -1;
    }
    fclose(children);
    return count;
}

static void start_close(const char *reason, int signo, long grace_ms) {
    if (closing) return;
    closing = true;
    force_at = now_ms() + grace_ms;
    dprintf(control_fd, "{\"type\":\"closing\",\"reason\":\"%s\"}\n", reason);
    if (signal_direct_children(signo) < 0) error_event("signalOwnedChildren");
}

/* Returns true only after the kernel confirms that this sole owner has no
 * children left. Once native spawning is disabled, ECHILD also excludes any
 * remaining descendant that could later fork or become an adopted orphan. */
static bool reap_children(void) {
    int status;
    pid_t pid;
    while ((pid = waitpid(-1, &status, WNOHANG)) > 0) {
        if (pid == native_pid) {
            native_pid = -1;
            dprintf(control_fd, "{\"type\":\"nativeExit\",\"code\":%d,\"signal\":%d}\n",
                WIFEXITED(status) ? WEXITSTATUS(status) : -1,
                WIFSIGNALED(status) ? WTERMSIG(status) : 0);
            if (!closing) start_close("nativeExit", SIGKILL, 0);
        }
    }
    if (pid < 0 && errno != ECHILD && errno != EINTR) error_event("waitpid");
    return pid < 0 && errno == ECHILD;
}

static void start_native(char **argv, const sigset_t *original_mask, const struct sigaction *original_pipe) {
    int startup[2];
    if (pipe2(startup, O_CLOEXEC) < 0) { error_event("execPipe"); start_close("spawnError", SIGKILL, 0); return; }
    if (fcntl(startup[0], F_SETFL, O_NONBLOCK) < 0) {
        close(startup[0]); close(startup[1]); error_event("execPipeFlags"); start_close("spawnError", SIGKILL, 0); return;
    }
    native_pid = fork();
    if (native_pid == 0) {
        close(startup[0]);
        close(control_fd);
        close(signal_fd);
        if (sigprocmask(SIG_SETMASK, original_mask, NULL) < 0 || sigaction(SIGPIPE, original_pipe, NULL) < 0 || setsid() < 0) {
            int saved = errno;
            _exit(write(startup[1], &saved, sizeof(saved)) == sizeof(saved) ? 126 : 125);
        }
        execvp(argv[0], argv);
        int saved = errno;
        _exit(write(startup[1], &saved, sizeof(saved)) == sizeof(saved) ? 127 : 125);
    }
    close(startup[1]);
    if (native_pid < 0) {
        close(startup[0]); error_event("fork"); start_close("spawnError", SIGKILL, 0); return;
    }
    exec_fd = startup[0];
}

static void observe_exec(void) {
    if (exec_fd < 0) return;
    int exec_errno = 0;
    ssize_t size = read(exec_fd, &exec_errno, sizeof(exec_errno));
    if (size < 0 && (errno == EAGAIN || errno == EINTR)) return;
    close(exec_fd);
    exec_fd = -1;
    if (size != 0) {
        errno = size == sizeof(exec_errno) ? exec_errno : EIO;
        error_event("exec"); start_close("spawnError", SIGKILL, 0); return;
    }
    dprintf(control_fd, "{\"type\":\"spawned\",\"pid\":%d}\n", native_pid);
}

int main(int argc, char **argv) {
    if (argc < 3) return 64;
    char *end;
    errno = 0;
    long grace_ms = strtol(argv[1], &end, 10);
    if (errno || *end || grace_ms < 0 || grace_ms > 60000) return 64;
    struct sigaction action = { .sa_handler = SIG_DFL }, original_pipe;
    sigemptyset(&action.sa_mask);
    if (sigaction(SIGCHLD, &action, NULL) < 0) return 125;
    action.sa_handler = SIG_IGN;
    if (sigaction(SIGPIPE, &action, &original_pipe) < 0) return 125;
    sigset_t mask, original_mask;
    sigemptyset(&mask);
    sigaddset(&mask, SIGCHLD);
    if (sigprocmask(SIG_BLOCK, &mask, &original_mask) < 0 || prctl(PR_SET_CHILD_SUBREAPER, 1) < 0) return 125;
    signal_fd = signalfd(-1, &mask, SFD_CLOEXEC | SFD_NONBLOCK);
    if (signal_fd < 0) return 125;
    snprintf(children_path, sizeof(children_path), "/proc/%d/task/%d/children", getpid(), getpid());
    if (signal_direct_children(0) < 0) { error_event("ownershipPreflight"); return 125; }
    dprintf(control_fd, "{\"type\":\"ready\",\"pid\":%d}\n", getpid());
    char command[128];
    size_t used = 0;
    bool started = false, control_open = true;
    for (;;) {
        observe_exec();
        if (closing && now_ms() >= force_at && signal_direct_children(SIGKILL) < 0) error_event("forceOwnedChildren");
        if (reap_children() && closing) {
            dprintf(control_fd, "{\"type\":\"closed\",\"noChildren\":true,\"cleanupError\":%s}\n", cleanup_error ? "true" : "false");
            return cleanup_error ? 125 : 0;
        }
        struct pollfd fds[3] = { { .fd = control_open ? control_fd : -1, .events = POLLIN }, { .fd = signal_fd, .events = POLLIN }, { .fd = exec_fd, .events = POLLIN } };
        int timeout = closing ? (now_ms() >= force_at ? 1 : (int)(force_at - now_ms())) : -1;
        int count = poll(fds, 3, timeout);
        if (count < 0) { if (errno == EINTR) continue; error_event("poll"); start_close("controlError", SIGKILL, 0); continue; }
        if (fds[1].revents & POLLIN) {
            struct signalfd_siginfo info;
            while (read(signal_fd, &info, sizeof(info)) == sizeof(info)) {}
        }
        if (!(fds[0].revents & (POLLIN | POLLHUP | POLLERR | POLLNVAL))) continue;
        char chunk[128];
        ssize_t size = read(control_fd, chunk, sizeof(chunk));
        if (size <= 0) {
            if (size < 0 && (errno == EINTR || errno == EAGAIN)) continue;
            control_open = false;
            start_close("controlEof", SIGKILL, 0);
            continue;
        }
        for (ssize_t i = 0; i < size; i++) {
            if (chunk[i] != '\n') {
                if (used + 1 == sizeof(command)) { start_close("invalidControl", SIGKILL, 0); used = 0; break; }
                command[used++] = chunk[i]; continue;
            }
            command[used] = 0;
            used = 0;
            if (!strcmp(command, "go") && !started && !closing) { started = true; start_native(argv + 2, &original_mask, &original_pipe); }
            else if (!strcmp(command, "close")) start_close("close", SIGTERM, grace_ms);
            else if (!strcmp(command, "interrupt")) start_close("interrupt", SIGINT, grace_ms);
            else start_close("invalidControl", SIGKILL, 0);
        }
    }
}

#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;
static const char *directory;
static volatile sig_atomic_t stopping;

static void expired(int signal_number) { (void)signal_number; _exit(70); }
static void stop_requested(int signal_number) { (void)signal_number; stopping = 1; }
static void guard(void) { signal(SIGALRM, expired); alarm(10); }

static void event(const char *kind, const char *name) {
    char path[PATH_MAX];
    snprintf(path, sizeof(path), "%s/events.jsonl", directory);
    int fd = open(path, O_WRONLY | O_CREAT | O_APPEND, 0600);
    if (fd < 0) _exit(71);
    dprintf(fd, "{\"kind\":\"%s\",\"name\":\"%s\",\"pid\":%d,\"parent\":%d,\"group\":%d}\n", kind, name, getpid(), getppid(), getpgrp());
    close(fd);
}

static void writer(const char *name, bool late_forks) {
    guard();
    signal(SIGTERM, stop_requested);
    signal(SIGINT, stop_requested);
    char path[PATH_MAX];
    snprintf(path, sizeof(path), "%s/writes-%d", directory, getpid());
    event("writer", name);
    bool spawned = false;
    for (;;) {
        if (stopping && late_forks && !spawned) {
            spawned = true;
            event("late-fork-started", name);
            for (int i = 0; i < 3; i++) {
                pid_t child = fork();
                if (child < 0) _exit(73);
                if (!child) { if (setsid() < 0) _exit(73); writer("after-stop", false); }
            }
        }
        int fd = open(path, O_WRONLY | O_CREAT | O_APPEND, 0600);
        if (fd < 0 || write(fd, "x", 1) != 1) _exit(71);
        close(fd);
        usleep(10000);
    }
}

static void double_fork(bool nested_reaper) {
    pid_t middle = fork();
    if (middle < 0) _exit(73);
    if (!middle) {
        guard();
        if (setsid() < 0) _exit(73);
        if (nested_reaper && prctl(PR_SET_CHILD_SUBREAPER, 1) < 0) _exit(73);
        pid_t second = fork();
        if (second < 0) _exit(73);
        if (!second) {
            if (setsid() < 0) _exit(73);
            pid_t third = fork();
            if (third < 0) _exit(73);
            if (!third) {
                if (setsid() < 0) _exit(73);
                writer(nested_reaper ? "nested-detached" : "late-detached", !nested_reaper);
            }
            _exit(0);
        }
        if (nested_reaper) writer("nested-subreaper", false);
        _exit(0);
    }
    if (!nested_reaper && waitpid(middle, NULL, 0) < 0) _exit(73);
}

static void snapshot(void) {
    bool control_closed = fcntl(3, F_GETFD) < 0 && errno == EBADF;
    int subreaper = -1;
    if (prctl(PR_GET_CHILD_SUBREAPER, &subreaper) < 0) _exit(74);
    char path[PATH_MAX], cwd[PATH_MAX], link[128], target[128];
    if (!getcwd(cwd, sizeof(cwd))) _exit(74);
    snprintf(path, sizeof(path), "%s/snapshot.txt", directory);
    FILE *out = fopen(path, "w");
    if (!out) _exit(74);
    fprintf(out, "uid=%d\ngid=%d\ncwd=%s\nsubreaper=%d\ncontrolClosed=%d\n", getuid(), getgid(), cwd, subreaper, control_closed);
    sigset_t mask;
    if (sigprocmask(SIG_SETMASK, NULL, &mask) < 0) _exit(74);
    fprintf(out, "sigchldBlocked=%d\n", sigismember(&mask, SIGCHLD));
    int count = getgroups(0, NULL);
    gid_t *groups = count ? calloc((size_t)count, sizeof(*groups)) : NULL;
    if (count < 0 || (count && (!groups || getgroups(count, groups) != count))) _exit(74);
    fprintf(out, "groups=");
    for (int i = 0; i < count; i++) fprintf(out, "%s%u", i ? "," : "", groups[i]);
    fprintf(out, "\n");
    free(groups);
    const char *names[] = { "pid", "user", "mnt" };
    for (size_t i = 0; i < sizeof(names) / sizeof(names[0]); i++) {
        snprintf(link, sizeof(link), "/proc/self/ns/%s", names[i]);
        ssize_t size = readlink(link, target, sizeof(target) - 1);
        if (size < 0) _exit(74);
        target[size] = 0;
        fprintf(out, "%sNamespace=%s\n", names[i], target);
    }
    fclose(out);
    uint64_t fingerprint = UINT64_C(14695981039346656037);
    for (char **entry = environ; *entry; entry++) {
        size_t size = strlen(*entry) + 1;
        for (size_t i = 0; i < size; i++) {
            fingerprint ^= (unsigned char)(*entry)[i];
            fingerprint *= UINT64_C(1099511628211);
        }
    }
    snprintf(path, sizeof(path), "%s/environment.fingerprint", directory);
    out = fopen(path, "w");
    if (!out) _exit(74);
    fprintf(out, "%016lx\n", (unsigned long)fingerprint);
    fclose(out);
}

int main(int argc, char **argv) {
    if (argc != 3) return 64;
    directory = argv[2];
    guard();
    if (!strcmp(argv[1], "outsider")) writer("unrelated", false);
    snapshot();
    signal(SIGTERM, SIG_IGN);
    signal(SIGINT, SIG_IGN);
    pid_t child = fork();
    if (child < 0) return 73;
    if (!child) { if (setsid() < 0) _exit(73); writer("detached", false); }
    child = fork();
    if (child < 0) return 73;
    if (!child) { if (setpgid(0, 0) < 0) _exit(73); writer("independent-group", false); }
    double_fork(false);
    double_fork(true);
    event("cli-ready", "cli");
    puts("NATIVE_STDOUT_READY");
    fflush(stdout);
    fputs("NATIVE_STDERR_READY\n", stderr);
    char input[512];
    while (fgets(input, sizeof(input), stdin)) {
        if (!strcmp(input, "exit\n")) return 42;
        if (!strcmp(input, "crash\n")) { raise(SIGKILL); return 72; }
        fputs(input, stdout);
        fflush(stdout);
    }
    for (;;) pause();
}

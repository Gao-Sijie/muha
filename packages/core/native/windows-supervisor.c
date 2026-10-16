#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0602
#include <windows.h>
#include <io.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>
#include "windows-private.h"

/* Windows implementation of the private ownership protocol. fd3 is a pipe,
 * not Node IPC. Only stdin/out/err enter the native process's handle list.
 * The entry is suspended until Job assignment, including under an outer Job.
 * No breakaway flags or inheritable Job handles permit descendants to escape. */
static HANDLE control = INVALID_HANDLE_VALUE;
static HANDLE job = NULL;
static PROCESS_INFORMATION native_process;
static bool closing = false, cleanup_error = false, started = false;
static bool forced = false, native_exited = false;
static ULONGLONG force_at = 0;
static int command_start = 2;
static HANDLE worker_pipe = INVALID_HANDLE_VALUE;
static HANDLE worker_connected = NULL;
static HANDLE worker_output_done = NULL;

typedef struct { HANDLE source; HANDLE destination; } relay_direction;
static relay_direction relays[2];

static bool pipe_io(HANDLE pipe, bool read, char *buffer, DWORD size, DWORD *transferred, OVERLAPPED *operation) {
    ResetEvent(operation->hEvent);
    BOOL done = read ? ReadFile(pipe, buffer, size, transferred, operation) : WriteFile(pipe, buffer, size, transferred, operation);
    if (done) return true;
    return GetLastError() == ERROR_IO_PENDING && GetOverlappedResult(pipe, operation, transferred, TRUE);
}

static DWORD WINAPI relay_bytes(void *parameter) {
    relay_direction *direction = parameter;
    char buffer[8192];
    DWORD received;
    OVERLAPPED input = {0}, output = {0};
    input.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
    output.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
    if (!input.hEvent || !output.hEvent) return 1;
    while (pipe_io(direction->source, true, buffer, sizeof(buffer), &received, &input) && received) {
        DWORD offset = 0;
        while (offset < received) {
            DWORD written = 0;
            if (!pipe_io(direction->destination, false, buffer + offset, received - offset, &written, &output) || !written) goto done;
            offset += written;
        }
    }
done:
    CloseHandle(input.hEvent);
    CloseHandle(output.hEvent);
    if (direction == &relays[1]) SetEvent(worker_output_done);
    return 0;
}

static DWORD WINAPI connect_worker(void *unused) {
    (void)unused;
    OVERLAPPED connection = {0};
    connection.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
    if (!connection.hEvent) return 1;
    BOOL connected = ConnectNamedPipe(worker_pipe, &connection);
    DWORD error = connected ? ERROR_SUCCESS : GetLastError(), transferred = 0;
    if (!connected && error == ERROR_IO_PENDING) connected = GetOverlappedResult(worker_pipe, &connection, &transferred, TRUE);
    else if (error == ERROR_PIPE_CONNECTED) connected = TRUE;
    CloseHandle(connection.hEvent);
    ULONG client = 0;
    if (!connected || !GetNamedPipeClientProcessId(worker_pipe, &client) || client != native_process.dwProcessId) return 1;
    SetEvent(worker_connected);
    OVERLAPPED ready = {0};
    ready.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
    char handshake[] = "{\"type\":\"transport.ready\"}\n";
    DWORD written = 0;
    if (!ready.hEvent || !pipe_io(worker_pipe, false, handshake, (DWORD)strlen(handshake), &written, &ready)) return 1;
    CloseHandle(ready.hEvent);
    relays[0].source = (HANDLE)_get_osfhandle(4);
    relays[0].destination = worker_pipe;
    relays[1].source = worker_pipe;
    relays[1].destination = (HANDLE)_get_osfhandle(4);
    for (int i = 0; i < 2; i++) {
        HANDLE thread = CreateThread(NULL, 0, relay_bytes, &relays[i], 0, NULL);
        if (!thread) return 1;
        CloseHandle(thread);
    }
    return 0;
}

static bool prepare_worker(const wchar_t *name) {
    SECURITY_ATTRIBUTES attributes;
    PSECURITY_DESCRIPTOR descriptor = NULL;
    if (wcsncmp(name, L"\\\\.\\pipe\\muha-", 14) || !muha_private_security(&attributes, &descriptor, FALSE)) return false;
    worker_pipe = CreateNamedPipeW(name, PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE | FILE_FLAG_OVERLAPPED,
        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
        1, 65536, 65536, 0, &attributes);
    LocalFree(descriptor);
    if (worker_pipe == INVALID_HANDLE_VALUE) return false;
    worker_connected = CreateEventW(NULL, TRUE, FALSE, NULL);
    worker_output_done = CreateEventW(NULL, TRUE, FALSE, NULL);
    if (!worker_connected || !worker_output_done) return false;
    HANDLE thread = CreateThread(NULL, 0, connect_worker, NULL, 0, NULL);
    if (!thread) return false;
    CloseHandle(thread);
    return true;
}

static bool emit(const char *message) {
    DWORD size = (DWORD)strlen(message), written = 0;
    return WriteFile(control, message, size, &written, NULL) && written == size;
}

static void fail(const char *operation) {
    DWORD code = GetLastError();
    char message[256];
    /* A rejected launch has no descendants; keep its error distinct from
     * failure to prove cleanup. The empty Job is still checked before exit. */
    if (strcmp(operation, "spawn") && strcmp(operation, "commandLine") &&
        strcmp(operation, "duplicateStdio") && strcmp(operation, "attributesAllocation") &&
        strcmp(operation, "attributesInitialization") && strcmp(operation, "handleList")) cleanup_error = true;
    snprintf(message, sizeof(message), "{\"type\":\"error\",\"operation\":\"%s\",\"win32\":%lu}\n", operation, code);
    (void)emit(message);
}

static void start_close(const char *reason, DWORD grace) {
    char message[256];
    if (closing) return;
    closing = true;
    force_at = GetTickCount64() + grace;
    snprintf(message, sizeof(message), "{\"type\":\"closing\",\"reason\":\"%s\"}\n", reason);
    (void)emit(message);
}

static bool append_argument(wchar_t *result, size_t *used, wchar_t value) {
    if (*used >= 32766) return false;
    result[(*used)++] = value;
    return true;
}

static wchar_t *command_line(int argc, wchar_t **argv) {
    size_t used = 0;
    wchar_t *result = calloc(32767, sizeof(wchar_t));
    if (!result) return NULL;
    for (int i = command_start; i < argc; i++) {
        if (i != command_start && !append_argument(result, &used, L' ')) goto too_long;
        if (!append_argument(result, &used, L'"')) goto too_long;
        const wchar_t *value = argv[i];
        while (*value) {
            size_t slashes = 0;
            while (*value == L'\\') { slashes++; value++; }
            if (*value == L'"' || !*value) slashes *= 2;
            while (slashes--) if (!append_argument(result, &used, L'\\')) goto too_long;
            if (*value == L'"' && !append_argument(result, &used, L'\\')) goto too_long;
            if (*value && !append_argument(result, &used, *value++)) goto too_long;
        }
        if (!append_argument(result, &used, L'"')) goto too_long;
    }
    result[used] = 0;
    return result;
too_long:
    free(result);
    return NULL;
}

static bool create_native(int argc, wchar_t **argv) {
    STARTUPINFOEXW startup;
    HANDLE inherited[3] = { NULL, NULL, NULL };
    const DWORD ids[3] = { STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE };
    SIZE_T attribute_size = 0;
    bool attributes_initialized = false, success = false;
    wchar_t *line = command_line(argc, argv);
    memset(&startup, 0, sizeof(startup));
    startup.StartupInfo.cb = sizeof(startup);
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    if (!line) { SetLastError(ERROR_BAD_LENGTH); fail("commandLine"); return false; }
    for (int i = 0; i < 3; i++) {
        if (!DuplicateHandle(GetCurrentProcess(), GetStdHandle(ids[i]), GetCurrentProcess(),
                &inherited[i], 0, TRUE, DUPLICATE_SAME_ACCESS)) {
            fail("duplicateStdio"); goto done;
        }
    }
    startup.StartupInfo.hStdInput = inherited[0];
    startup.StartupInfo.hStdOutput = inherited[1];
    startup.StartupInfo.hStdError = inherited[2];
    (void)InitializeProcThreadAttributeList(NULL, 1, 0, &attribute_size);
    startup.lpAttributeList = malloc(attribute_size);
    if (!startup.lpAttributeList) { SetLastError(ERROR_NOT_ENOUGH_MEMORY); fail("attributesAllocation"); goto done; }
    if (!InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0, &attribute_size)) {
        fail("attributesInitialization"); goto done;
    }
    attributes_initialized = true;
    if (!UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
            inherited, sizeof(inherited), NULL, NULL)) { fail("handleList"); goto done; }
    if (!CreateProcessW(argv[command_start], line, NULL, NULL, TRUE,
            CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT,
            NULL, NULL, &startup.StartupInfo, &native_process)) { fail("spawn"); goto done; }
    if (!AssignProcessToJobObject(job, native_process.hProcess)) {
        fail("assignJob");
        if (!TerminateProcess(native_process.hProcess, 125)) fail("terminateUnassigned");
        if (WaitForSingleObject(native_process.hProcess, 5000) != WAIT_OBJECT_0) {
            SetLastError(ERROR_TIMEOUT); fail("waitUnassigned");
        }
        goto done;
    }
    if (ResumeThread(native_process.hThread) == (DWORD)-1) { fail("resume"); goto done; }
    success = true;
    char message[128];
    snprintf(message, sizeof(message), "{\"type\":\"spawned\",\"pid\":%lu}\n", native_process.dwProcessId);
    if (!emit(message)) { success = false; fail("spawnResponse"); }
done:
    if (attributes_initialized) DeleteProcThreadAttributeList(startup.lpAttributeList);
    free(startup.lpAttributeList);
    for (int i = 0; i < 3; i++) if (inherited[i]) CloseHandle(inherited[i]);
    free(line);
    return success;
}

static bool empty_job(void) {
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;
    if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation,
            &accounting, sizeof(accounting), NULL)) { fail("queryJob"); return false; }
    return accounting.ActiveProcesses == 0;
}

int wmain(int argc, wchar_t **argv) {
    wchar_t *end = NULL;
    long grace;
    char input[128];
    size_t used = 0;
    bool control_open = true;
    if (argc < 3) return 64;
    if (!wcscmp(argv[1], L"--ensure-private-dir") && argc == 3) {
        DWORD error = muha_ensure_private_directory(argv[2]);
        if (error) fprintf(stderr, "Windows private directory check failed (%lu)\n", error);
        return error ? 125 : 0;
    }
    if (!wcscmp(argv[1], L"--check-private-files")) {
        for (int i = 2; i < argc; i++) {
            DWORD error = muha_check_private_path(argv[i], FALSE, TRUE);
            if (error) { fprintf(stderr, "Windows private file check failed (%lu)\n", error); return 125; }
        }
        return 0;
    }
    grace = wcstol(argv[1], &end, 10);
    if (!*argv[1] || *end || grace < 0 || grace > 60000) return 64;
    control = (HANDLE)_get_osfhandle(3);
    if (control == INVALID_HANDLE_VALUE) return 125;
    if (argc >= 5 && !wcscmp(argv[2], L"--worker-pipe")) {
        command_start = 4;
        if (!prepare_worker(argv[3])) { fail("workerPipe"); return 125; }
    }
    job = CreateJobObjectW(NULL, NULL);
    if (!job) { fail("createJob"); return 125; }
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
    memset(&limits, 0, sizeof(limits));
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
        fail("jobLimits"); CloseHandle(job); return 125;
    }
    char ready[128];
    snprintf(ready, sizeof(ready), "{\"type\":\"ready\",\"pid\":%lu}\n", GetCurrentProcessId());
    if (!emit(ready)) start_close("controlEof", 0);
    for (;;) {
        if (native_process.hProcess && !native_exited) {
            DWORD wait = WaitForSingleObject(native_process.hProcess, 0);
            if (wait == WAIT_OBJECT_0) {
                DWORD code = 0;
                native_exited = true;
                if (!GetExitCodeProcess(native_process.hProcess, &code)) fail("exitCode");
                char message[128];
                snprintf(message, sizeof(message), "{\"type\":\"nativeExit\",\"code\":%lu,\"signal\":0}\n", code);
                (void)emit(message);
                start_close("nativeExit", 0);
            } else if (wait == WAIT_FAILED) { fail("waitNative"); start_close("waitError", 0); }
        }
        if (closing && GetTickCount64() >= force_at && !forced) {
            forced = true;
            if (!TerminateJobObject(job, 1)) fail("terminateJob");
        }
        if (closing && empty_job() && (!native_process.hProcess ||
                WaitForSingleObject(native_process.hProcess, 0) == WAIT_OBJECT_0) &&
                (!worker_connected || WaitForSingleObject(worker_connected, 0) != WAIT_OBJECT_0 ||
                    WaitForSingleObject(worker_output_done, 0) == WAIT_OBJECT_0)) {
            char message[128];
            snprintf(message, sizeof(message), "{\"type\":\"closed\",\"noChildren\":true,\"cleanupError\":%s}\n", cleanup_error ? "true" : "false");
            (void)emit(message);
            break;
        }
        if (closing && GetTickCount64() > force_at + 5000) {
            SetLastError(ERROR_TIMEOUT); fail("cleanupTimeout"); break;
        }
        DWORD available = 0;
        if (control_open && !PeekNamedPipe(control, NULL, 0, NULL, &available, NULL)) {
            if (GetLastError() != ERROR_BROKEN_PIPE) fail("controlPeek");
            control_open = false;
            start_close("controlEof", 0);
        }
        if (!available || !control_open) { Sleep(5); continue; }
        char chunk[128];
        DWORD received = 0;
        DWORD requested = available < sizeof(chunk) ? available : (DWORD)sizeof(chunk);
        if (!ReadFile(control, chunk, requested, &received, NULL) || received == 0) {
            control_open = false; start_close("controlEof", 0); continue;
        }
        for (DWORD i = 0; i < received; i++) {
            if (chunk[i] != '\n') {
                if (used + 1 == sizeof(input)) { start_close("invalidControl", 0); used = 0; break; }
                input[used++] = chunk[i]; continue;
            }
            input[used] = 0; used = 0;
            if (!strcmp(input, "go") && !started && !closing) {
                started = true;
                if (!create_native(argc, argv)) start_close("spawnError", 0);
            } else if (!strcmp(input, "close")) start_close("close", (DWORD)grace);
            else if (!strcmp(input, "interrupt")) start_close("interrupt", (DWORD)grace);
            else start_close("invalidControl", 0);
        }
    }
    if (native_process.hThread) CloseHandle(native_process.hThread);
    if (native_process.hProcess) CloseHandle(native_process.hProcess);
    CloseHandle(job);
    return cleanup_error ? 125 : 0;
}

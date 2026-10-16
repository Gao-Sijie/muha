#ifndef MUHA_WINDOWS_PRIVATE_H
#define MUHA_WINDOWS_PRIVATE_H
#include <windows.h>

BOOL muha_private_security(SECURITY_ATTRIBUTES *attributes,
    PSECURITY_DESCRIPTOR *descriptor, BOOL inherit);
DWORD muha_check_private_path(const wchar_t *path, BOOL directory, BOOL missing_ok);
DWORD muha_ensure_private_directory(const wchar_t *path);
#endif

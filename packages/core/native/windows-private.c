#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <stdio.h>
#include <stdlib.h>
#include "windows-private.h"

static PTOKEN_USER current_user(void) {
    HANDLE token = NULL;
    DWORD size = 0;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return NULL;
    (void)GetTokenInformation(token, TokenUser, NULL, 0, &size);
    PTOKEN_USER user = size && size < 65536 ? malloc(size) : NULL;
    if (user && !GetTokenInformation(token, TokenUser, user, size, &size)) {
        free(user); user = NULL;
    }
    CloseHandle(token);
    return user;
}

BOOL muha_private_security(SECURITY_ATTRIBUTES *attributes,
        PSECURITY_DESCRIPTOR *descriptor, BOOL inherit) {
    PTOKEN_USER user = current_user();
    LPWSTR sid = NULL;
    wchar_t sddl[512];
    BOOL success = FALSE;
    if (!user) return FALSE;
    if (!ConvertSidToStringSidW(user->User.Sid, &sid)) goto done;
    const wchar_t *flags = inherit ? L"OICI" : L"";
    int size = swprintf(sddl, 512, L"D:P(A;%ls;FA;;;SY)(A;%ls;FA;;;BA)(A;%ls;FA;;;%ls)",
        flags, flags, flags, sid);
    if (size < 0 || size >= 512) { SetLastError(ERROR_BAD_LENGTH); goto done; }
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, SDDL_REVISION_1, descriptor, NULL)) goto done;
    attributes->nLength = sizeof(*attributes);
    attributes->lpSecurityDescriptor = *descriptor;
    attributes->bInheritHandle = FALSE;
    success = TRUE;
done:
    if (sid) LocalFree(sid);
    free(user);
    return success;
}

static BOOL trusted_sid(PSID sid, PSID user) {
    return EqualSid(sid, user) || IsWellKnownSid(sid, WinLocalSystemSid) ||
        IsWellKnownSid(sid, WinBuiltinAdministratorsSid);
}

DWORD muha_check_private_path(const wchar_t *path, BOOL directory, BOOL missing_ok) {
    HANDLE file = CreateFileW(path, READ_CONTROL | FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
    if (file == INVALID_HANDLE_VALUE) {
        DWORD error = GetLastError();
        return missing_ok && (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND) ? ERROR_SUCCESS : error;
    }
    DWORD result = ERROR_ACCESS_DENIED;
    BY_HANDLE_FILE_INFORMATION information;
    PSECURITY_DESCRIPTOR descriptor = NULL;
    PSID owner = NULL;
    PACL dacl = NULL;
    PTOKEN_USER user = current_user();
    if (!user) goto done;
    if (!GetFileInformationByHandle(file, &information)) { result = GetLastError(); goto done; }
    if ((information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) ||
        ((information.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) != (directory != FALSE)) goto done;
    result = GetSecurityInfo(file, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
        &owner, NULL, &dacl, NULL, &descriptor);
    if (result != ERROR_SUCCESS) goto done;
    result = ERROR_ACCESS_DENIED;
    if (!owner || !trusted_sid(owner, user->User.Sid) || !dacl) goto done;
    for (DWORD index = 0; index < dacl->AceCount; index++) {
        ACE_HEADER *header = NULL;
        if (!GetAce(dacl, index, (void **)&header)) goto done;
        if (header->AceType == ACCESS_DENIED_ACE_TYPE) continue;
        if (header->AceType != ACCESS_ALLOWED_ACE_TYPE) goto done;
        ACCESS_ALLOWED_ACE *ace = (ACCESS_ALLOWED_ACE *)header;
        PSID sid = (PSID)&ace->SidStart;
        if (ace->Mask && !trusted_sid(sid, user->User.Sid) &&
            !((header->AceFlags & INHERIT_ONLY_ACE) && IsWellKnownSid(sid, WinCreatorOwnerSid))) goto done;
    }
    result = ERROR_SUCCESS;
done:
    if (descriptor) LocalFree(descriptor);
    if (user) free(user);
    CloseHandle(file);
    return result;
}

DWORD muha_ensure_private_directory(const wchar_t *path) {
    SECURITY_ATTRIBUTES attributes;
    PSECURITY_DESCRIPTOR descriptor = NULL;
    if (!muha_private_security(&attributes, &descriptor, TRUE)) return GetLastError();
    BOOL created = CreateDirectoryW(path, &attributes);
    DWORD error = created ? ERROR_SUCCESS : GetLastError();
    LocalFree(descriptor);
    if (error != ERROR_SUCCESS && error != ERROR_ALREADY_EXISTS) return error;
    return muha_check_private_path(path, TRUE, FALSE);
}

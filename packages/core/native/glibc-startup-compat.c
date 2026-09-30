/* Link-only x86-64 glibc compatibility shim for the shared independent helper.
 * Ubuntu 22.04 CRT references the default GLIBC_2.34 startup symbol. This
 * helper has no program constructors, so the preserved GLIBC_2.2.5 startup
 * entry is sufficient. Qualify under the actual minimum libc as well as
 * checking the final ELF version requirements; do not infer portability from
 * this source alone. Build with -Wl,--wrap=__libc_start_main. */
typedef int (*main_function)(int, char **, char **);
typedef void (*init_function)(void);

extern int legacy_libc_start_main(main_function main, int argc, char **argv,
    init_function init, init_function fini, init_function rtld_fini, void *stack_end);
__asm__(".symver legacy_libc_start_main,__libc_start_main@GLIBC_2.2.5");

int __wrap___libc_start_main(main_function main, int argc, char **argv,
    init_function init, init_function fini, init_function rtld_fini, void *stack_end) {
    return legacy_libc_start_main(main, argc, argv, init, fini, rtld_fini, stack_end);
}

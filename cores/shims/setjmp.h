#ifndef LIBRETRO_WASM_SETJMP_STUB_H
#define LIBRETRO_WASM_SETJMP_STUB_H

#ifdef __cplusplus
extern "C" {
#endif

typedef struct wasm_stub_jmp_buf {
  int _unused;
} wasm_stub_jmp_buf;

typedef wasm_stub_jmp_buf jmp_buf[1];

static inline int setjmp(jmp_buf env) {
  (void)env;
  return 0;
}

static inline void longjmp(jmp_buf env, int value) {
  (void)env;
  (void)value;
#if defined(__clang__) || defined(__GNUC__)
  __builtin_trap();
#else
  for (;;)
    ;
#endif
}

#ifdef __cplusplus
}
#endif

#endif /* LIBRETRO_WASM_SETJMP_STUB_H */

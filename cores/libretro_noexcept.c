#include <stdint.h>
#include <stdlib.h>

#ifdef __cplusplus
extern "C" {
#endif

void *__cxa_allocate_exception(uint32_t size) {
  return size ? malloc(size) : NULL;
}

void __cxa_throw(void *exception, void *typeinfo, void (*destructor)(void *)) {
  (void)exception;
  (void)typeinfo;
  (void)destructor;
  abort();
}

#ifdef __cplusplus
}
#endif

// Minimal SDL logging stub so OpenBoardView's file parsers compile standalone.
#pragma once
#include <cstdio>
#define SDL_LOG_CATEGORY_APPLICATION 0
#define SDL_LOG_CATEGORY_ERROR 1
#define SDL_LogError(cat, ...) (std::fprintf(stderr, __VA_ARGS__), std::fputc('\n', stderr))
#define SDL_LogWarn(cat, ...) (std::fprintf(stderr, __VA_ARGS__), std::fputc('\n', stderr))
#define SDL_Log(...) (std::fprintf(stderr, __VA_ARGS__), std::fputc('\n', stderr))

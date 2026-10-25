#ifndef DECODER_H
#define DECODER_H

#include <stddef.h>
#include <stdint.h>

typedef struct Dav1dDecoder Dav1dDecoder;

/* 固定长度数组在 Swift 里会变成元组，取用很别扭；这里拆成具名字段。 */
typedef struct {
    int width;
    int height;
    int bitdepth;
    int full_range;
    uint64_t pts;
    const uint8_t *y;
    const uint8_t *u;
    const uint8_t *v;
    ptrdiff_t stride_y;
    ptrdiff_t stride_u;
    ptrdiff_t stride_v;
} Dav1dFrame;

typedef void (*Dav1dFrameCallback)(void *context, const Dav1dFrame *frame);

Dav1dDecoder *dav1d_decoder_new(int threads);
void dav1d_decoder_free(Dav1dDecoder *decoder);
int dav1d_decoder_push(Dav1dDecoder *decoder, const uint8_t *data, size_t size, uint64_t pts,
                       Dav1dFrameCallback callback, void *context);
int dav1d_decoder_flush(Dav1dDecoder *decoder, Dav1dFrameCallback callback, void *context);

#endif

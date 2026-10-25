// dav1d 的薄封装：只负责「送 OBU 进去、把解出来的帧交出来」。
// Swift 一侧要拿 C 的平面指针去填 CVPixelBuffer，所以在 C 里把它整理成一个干净的结构体。
#include "Decoder.h"

#include <dav1d/dav1d.h>
#include <stdlib.h>
#include <string.h>

struct Dav1dDecoder {
    Dav1dContext *context;
    int bitdepth;
};

Dav1dDecoder *dav1d_decoder_new(int threads) {
    Dav1dDecoder *decoder = calloc(1, sizeof(Dav1dDecoder));
    if (!decoder) return NULL;
    Dav1dSettings settings;
    dav1d_default_settings(&settings);
    settings.n_threads = threads;
    settings.max_frame_delay = 1;
    if (dav1d_open(&decoder->context, &settings) < 0) {
        free(decoder);
        return NULL;
    }
    return decoder;
}

void dav1d_decoder_free(Dav1dDecoder *decoder) {
    if (!decoder) return;
    dav1d_close(&decoder->context);
    free(decoder);
}

static void deliver(Dav1dDecoder *decoder, Dav1dPicture *picture, uint64_t pts,
                    Dav1dFrameCallback callback, void *context) {
    Dav1dFrame frame;
    memset(&frame, 0, sizeof(frame));
    frame.width = picture->p.w;
    frame.height = picture->p.h;
    frame.bitdepth = picture->p.bpc;
    frame.pts = pts;
    frame.y = (const uint8_t *)picture->data[0];
    frame.u = (const uint8_t *)picture->data[1];
    frame.v = (const uint8_t *)picture->data[2];
    frame.stride_y = picture->stride[0];
    frame.stride_u = picture->stride[1];
    frame.stride_v = picture->stride[1];
    frame.full_range = picture->seq_hdr && picture->seq_hdr->color_range;
    decoder->bitdepth = picture->p.bpc;
    callback(context, &frame);
}

int dav1d_decoder_push(Dav1dDecoder *decoder, const uint8_t *data, size_t size, uint64_t pts,
                       Dav1dFrameCallback callback, void *context) {
    if (!decoder || size == 0) return 0;
    Dav1dData buffer;
    if (!dav1d_data_create(&buffer, size)) return -1;
    memcpy(buffer.data, data, size);

    int guard = 0;
    while (buffer.sz > 0) {
        const int sent = dav1d_send_data(decoder->context, &buffer);
        if (sent < 0 && sent != DAV1D_ERR(EAGAIN)) {
            dav1d_data_unref(&buffer);
            return -2;
        }
        Dav1dPicture picture;
        int got = dav1d_get_picture(decoder->context, &picture);
        while (got == 0) {
            deliver(decoder, &picture, pts, callback, context);
            dav1d_picture_unref(&picture);
            got = dav1d_get_picture(decoder->context, &picture);
        }
        if (++guard > 16) break;
    }
    dav1d_data_unref(&buffer);
    return 0;
}

int dav1d_decoder_flush(Dav1dDecoder *decoder, Dav1dFrameCallback callback, void *context) {
    if (!decoder) return 0;
    int count = 0;
    Dav1dPicture picture;
    while (dav1d_get_picture(decoder->context, &picture) == 0) {
        deliver(decoder, &picture, 0, callback, context);
        dav1d_picture_unref(&picture);
        count++;
    }
    return count;
}

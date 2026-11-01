#include <stdint.h>

#include "bindings/bindings.h"

// 端上转码：Swift 那边用 @_cdecl 导出两个入口，Rust 侧要拿到它们的函数指针。
//
// 为什么不在 Rust 里 dlsym：Release 归档打包时导出符号会被裁掉——实测装到手机上
// 的 IPA，整张导出表只剩 `__mh_execute_header`，`dlsym("courseai_transcode_video")`
// 一个都找不到，转码会被判成「这个版本没编入」而瞬间失败（点重试也一样）。
// 这里在启动时显式取地址交给 Rust：构造函数引用到这两个函数，链接器就会保留它们，
// 完全不依赖导出符号表。
extern "C" int32_t courseai_transcode_video(const char *source, const char *destination);
extern "C" int32_t courseai_transcode_progress(void);
extern "C" void courseai_register_transcode(
	int32_t (*run)(const char *, const char *),
	int32_t (*progress)(void));

__attribute__((constructor)) static void courseai_install_transcode() {
	courseai_register_transcode(courseai_transcode_video, courseai_transcode_progress);
}

int main(int argc, char * argv[]) {
	ffi::start_app();
	return 0;
}

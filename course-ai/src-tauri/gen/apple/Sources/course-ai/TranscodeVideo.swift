// 端上转码：AV1（或其它 WKWebView 解不了的编码）→ H.264 mp4。
//
// 流程：AVAssetReader 拿压缩样本（不解码）→ dav1d 解 → I420 转 NV12 → AVAssetWriter 编 H.264；
// 音轨不解码，passthrough 原样搬。导出两个 C 函数给 Rust 调（iOS 上 Rust 只能这样跨到 Swift）。
//
// 为什么不用 ffmpeg：iOS 不允许起子进程（sidecar 那套在手机上不成立），而 AVFoundation 又没有
// AV1 解码器（A12X 这一代没有硬解）。dav1d 是唯一缺的那块，编码交给系统的 VideoToolbox。
import AVFoundation
import CoreVideo
import Foundation

/// 当前转码进度（0…100）。Rust 侧轮询这个函数，比跨语言传回调指针简单、也不容易悬垂。
private var currentProgress: Int32 = 0

@_cdecl("courseai_transcode_progress")
public func courseai_transcode_progress() -> Int32 {
    currentProgress
}

private func fourCCString(_ code: FourCharCode) -> String {
    let bytes = [UInt8((code >> 24) & 0xff), UInt8((code >> 16) & 0xff), UInt8((code >> 8) & 0xff), UInt8(code & 0xff)]
    return String(bytes: bytes, encoding: .ascii) ?? "?"
}

/// av1C 盒子去掉 4 字节头就是 configOBUs，序列头通常在这里（样本里没有）。
private func av1ConfigOBUs(_ format: CMFormatDescription) -> Data? {
    guard
        let atoms = CMFormatDescriptionGetExtension(
            format, extensionKey: "SampleDescriptionExtensionAtoms" as CFString
        ) as? [String: Any],
        let box = atoms["av1C"] as? Data,
        box.count > 4
    else { return nil }
    return box.subdata(in: 4..<box.count)
}

private final class Writer {
    let writer: AVAssetWriter
    let videoInput: AVAssetWriterInput
    let adaptor: AVAssetWriterInputPixelBufferAdaptor
    let width: Int
    let height: Int
    var frames = 0
    /// 上一帧的 pts（AVAssetWriter 要求时间单调，重复或不增会整段失败）。
    var lastPts = CMTime.invalid
    var skippedNonMonotonic = 0
    /// 有一帧没写进去（编码器一直不收、像素缓冲建不出来、append 失败）。成片会缺帧，
    /// 整次转码按失败算——宁可让用户重试，也不交出一段卡顿、跳帧的「成品」。
    var failed = false

    init(writer: AVAssetWriter, width: Int, height: Int) {
        self.writer = writer
        self.width = width
        self.height = height
        let settings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: max(1_200_000, width * height * 4),
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
                AVVideoAllowFrameReorderingKey: false,
            ],
        ]
        videoInput = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
        videoInput.expectsMediaDataInRealTime = false
        adaptor = AVAssetWriterInputPixelBufferAdaptor(
            assetWriterInput: videoInput,
            sourcePixelBufferAttributes: [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
                kCVPixelBufferWidthKey as String: width,
                kCVPixelBufferHeightKey as String: height,
                kCVPixelBufferIOSurfacePropertiesKey as String: [:] as [String: Any],
            ]
        )
    }

    /// dav1d 解出一帧就写一帧。
    func append(_ frame: Dav1dFrame) {
        if failed { return }
        let input = videoInput
        // 编码器忙时等它；30 秒还不收就是卡死了。
        var spins = 0
        while !input.isReadyForMoreMediaData && spins < 30_000 && writer.status == .writing {
            usleep(1000)
            spins += 1
        }
        // 还没准备好就硬写会抛 ObjC 异常（这个异常 Swift 接不住，直接闪退），只能放弃。
        guard input.isReadyForMoreMediaData else {
            trace("encoder never became ready at frame \(frames)")
            failed = true
            return
        }
        guard let buffer = makePixelBuffer(frame) else {
            trace("pixel buffer failed at frame \(frames) (bitdepth \(frame.bitdepth))")
            failed = true
            return
        }
        let pts = CMTime(value: CMTimeValue(frame.pts), timescale: 1_000_000)
        // 时间戳不增的只会是重复帧（同一时刻再显示一次），丢掉不缺画面。
        if lastPts.isValid && CMTimeCompare(pts, lastPts) <= 0 {
            skippedNonMonotonic += 1
            return
        }
        if adaptor.append(buffer, withPresentationTime: pts) {
            frames += 1
            lastPts = pts
        } else {
            trace("append failed at frame \(frames): \(writer.error.map(String.init(describing:)) ?? "")")
            failed = true
        }
    }

    /// I420 → NV12。
    ///
    /// 刻意**不用** `adaptor.pixelBufferPool`：池子里拿到的 buffer 交给
    /// `appendPixelBuffer` 时会在 AVAssetWriterInputWritingHelper 里抛 ObjC 异常、
    /// 直接把 App 干掉（真机 crash 日志指向 appendTaggedPixelBufferGroup）。手动
    /// CVPixelBufferCreate 这条在真机上跑通过 180 帧，就按它来。
    private func makePixelBuffer(_ frame: Dav1dFrame) -> CVPixelBuffer? {
        guard frame.bitdepth <= 8, let y = frame.y, let u = frame.u, let v = frame.v else { return nil }
        var pixelBuffer: CVPixelBuffer?
        let attributes: [String: Any] = [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
            kCVPixelBufferWidthKey as String: width,
            kCVPixelBufferHeightKey as String: height,
        ]
        guard CVPixelBufferCreate(
            nil, width, height, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
            attributes as CFDictionary, &pixelBuffer) == kCVReturnSuccess,
            let buffer = pixelBuffer
        else { return nil }
        return fill(buffer, y: y, u: u, v: v, frame: frame)
    }

    private func fill(_ buffer: CVPixelBuffer, y: UnsafePointer<UInt8>, u: UnsafePointer<UInt8>,
                      v: UnsafePointer<UInt8>, frame: Dav1dFrame) -> CVPixelBuffer? {
        // 必须锁住再拿 base address：不锁时 write 落不到真正的 surface 上，
        // 编码器读到的是一片 0 —— 解出来就是满屏绿色（YUV 全 0）。
        guard CVPixelBufferLockBaseAddress(buffer, []) == kCVReturnSuccess else { return nil }
        defer { CVPixelBufferUnlockBaseAddress(buffer, []) }

        // 按解出来的帧实际尺寸拷：轨道头里的 naturalSize 可能比编码尺寸大（非方形像素、
        // 裁切过的片子），照它拷会读出解码器缓冲区的边界。帧比画布小时，多出来的部分涂黑。
        let copyWidth = min(width, Int(frame.width))
        let copyHeight = min(height, Int(frame.height))
        let partial = copyWidth < width || copyHeight < height

        if let destination = CVPixelBufferGetBaseAddressOfPlane(buffer, 0) {
            let stride = CVPixelBufferGetBytesPerRowOfPlane(buffer, 0)
            if partial {
                memset(destination, 16, stride * CVPixelBufferGetHeightOfPlane(buffer, 0))
            }
            for row in 0..<copyHeight {
                memcpy(destination + row * stride, y + row * frame.stride_y, copyWidth)
            }
        }
        if let destination = CVPixelBufferGetBaseAddressOfPlane(buffer, 1) {
            let stride = CVPixelBufferGetBytesPerRowOfPlane(buffer, 1)
            if partial {
                memset(destination, 128, stride * CVPixelBufferGetHeightOfPlane(buffer, 1))
            }
            let chromaWidth = (copyWidth + 1) / 2
            let chromaHeight = (copyHeight + 1) / 2
            let target = destination.assumingMemoryBound(to: UInt8.self)
            for row in 0..<chromaHeight {
                let sourceU = u + row * frame.stride_u
                let sourceV = v + row * frame.stride_v
                let rowStart = target + row * stride
                for column in 0..<chromaWidth {
                    rowStart[column * 2] = sourceU[column]
                    rowStart[column * 2 + 1] = sourceV[column]
                }
            }
        }
        return buffer
    }
}


/// 阶段跟踪：写到 Documents/transcode-trace.log。真机上 NSLog 进不了 syslog，
/// 卡住时只有落盘的记录能说明停在哪儿。只在调试构建里写：正式版不该往用户的
/// 「文件」App 里塞一个只增不减的日志。
private func trace(_ message: String) {
    #if DEBUG
    guard let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else { return }
    let url = directory.appendingPathComponent("transcode-trace.log")
    let line = "\(Date().timeIntervalSince1970) \(message)\n"
    guard let data = line.data(using: .utf8) else { return }
    if let handle = try? FileHandle(forWritingTo: url) {
        defer { try? handle.close() }
        _ = try? handle.seekToEnd()
        try? handle.write(contentsOf: data)
    } else {
        try? data.write(to: url)
    }
    #endif
}

/// 转码入口。返回值：0 成功；负数为错误码。
///
/// 全程同步：不用 `Task` + 信号量等待。先前那版在真机上卡死在 1%（`.partial` 一直是 0 字节）——
/// 阻塞线程等信号量时，Swift 并发池里那个 Task 迟迟不推进（同时还有别的视频在转，池子被占）。
/// AVFoundation 的同步属性就够用，没有异步等待就不会有这种死结。
@_cdecl("courseai_transcode_video")
public func courseai_transcode_video(
    _ sourcePath: UnsafePointer<CChar>?,
    _ destinationPath: UnsafePointer<CChar>?
) -> Int32 {
    currentProgress = 0
    trace("enter")
    guard let sourcePath, let destinationPath else { return -1 }
    let source = URL(fileURLWithPath: String(cString: sourcePath))
    let destination = URL(fileURLWithPath: String(cString: destinationPath))

    // 写临时文件、成功后再改名：中途崩溃/被杀掉时，目标位置不会留下 0 字节的「成品」。
    // 临时文件必须仍以 .mp4 结尾：AVFoundation 按扩展名认容器，
    // `playable.mp4.partial` 会被当成未知格式，读出来一条轨道都没有（踩过）。
    let partial = destination.deletingLastPathComponent()
        .appendingPathComponent("playable.partial.mp4")
    try? FileManager.default.removeItem(at: partial)
    try? FileManager.default.removeItem(at: destination)

    let asset = AVURLAsset(url: source)
    trace("asset created")
    guard
        let videoTrack = asset.tracks(withMediaType: .video).first,
        let videoFormat = (videoTrack.formatDescriptions as? [CMFormatDescription])?.first,
        let configOBUs = av1ConfigOBUs(videoFormat)
    else { return -2 }

    trace("tracks+av1C ok")
    let natural = videoTrack.naturalSize
    let width = Int(natural.width.rounded())
    let height = Int(natural.height.rounded())
    guard width > 0, height > 0 else { return -3 }

    guard let writer = try? AVAssetWriter(outputURL: partial, fileType: .mp4) else { return -4 }
    let sink = Writer(writer: writer, width: width, height: height)
    guard writer.canAdd(sink.videoInput) else { return -5 }
    writer.add(sink.videoInput)

    // 一个 reader、两个输出：两个 AVAssetReader 同时解同一个文件会互相卡死
    //（实测加音频 reader 后视频第 4 帧就停了，单开视频能跑完 7441 个样本）。
    guard let reader = try? AVAssetReader(asset: asset) else { return -6 }
    let compressed = AVAssetReaderTrackOutput(track: videoTrack, outputSettings: nil)
    guard reader.canAdd(compressed) else { return -7 }
    reader.add(compressed)

    guard reader.startReading() else { return -8 }
    trace("readers ready")
    guard writer.startWriting() else { return -9 }
    trace("writer started")
    writer.startSession(atSourceTime: .zero)

    guard let decoder = dav1d_decoder_new(0) else { return -10 }
    defer { dav1d_decoder_free(decoder) }

    let box = Unmanaged.passUnretained(sink).toOpaque()
    let callback: Dav1dFrameCallback = { context, frame in
        guard let context, let frame else { return }
        Unmanaged<Writer>.fromOpaque(context).takeUnretainedValue().append(frame.pointee)
    }

    let seconds = CMTimeGetSeconds(asset.duration)
    let frameRate = max(Double(videoTrack.nominalFrameRate), 24)
    let estimatedFrames = max(1, Int(seconds * frameRate))

    configOBUs.withUnsafeBytes { raw in
        if let base = raw.bindMemory(to: UInt8.self).baseAddress {
            _ = dav1d_decoder_push(decoder, base, configOBUs.count, 0, callback, box)
        }
    }

    trace("decoding")
    var samples = 0
    var decodeError: Int32 = 0
    var bytes = [UInt8]()
    while !sink.failed, decodeError == 0, let sample = compressed.copyNextSampleBuffer() {
        if samples == 0 { trace("first sample") }
        samples += 1
        let pts = CMSampleBufferGetPresentationTimeStamp(sample)
        let micros = UInt64(max(0, CMTimeGetSeconds(pts) * 1_000_000))
        if let block = CMSampleBufferGetDataBuffer(sample), CMBlockBufferGetDataLength(block) > 0 {
            // 拷出来再送：样本的数据块可能由几段拼成，GetDataPointer 给的指针只管第一段，
            // 按总长读会越界。
            let length = CMBlockBufferGetDataLength(block)
            if bytes.count < length { bytes = [UInt8](repeating: 0, count: length) }
            let copied = bytes.withUnsafeMutableBytes { raw in
                CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: raw.baseAddress!)
            }
            if copied == kCMBlockBufferNoErr {
                decodeError = bytes.withUnsafeBufferPointer { buffer in
                    dav1d_decoder_push(decoder, buffer.baseAddress!, length, micros, callback, box)
                }
            }
        }
        if samples % 10 == 0 {
            currentProgress = Int32(min(99, max(1, samples * 100 / estimatedFrames)))
        }
    }
    trace("samples done: \(samples), frames \(sink.frames), decode \(decodeError)")
    if decodeError == 0, !sink.failed {
        _ = dav1d_decoder_flush(decoder, callback, box)
    }
    sink.videoInput.markAsFinished()

    let done = DispatchSemaphore(value: 0)
    writer.finishWriting { done.signal() }
    done.wait()

    trace("writer finished status \(writer.status.rawValue) frames \(sink.frames) duplicates \(sink.skippedNonMonotonic)")
    if decodeError != 0 || sink.failed {
        try? FileManager.default.removeItem(at: partial)
        return decodeError != 0 ? -13 : -14
    }
    guard writer.status == .completed, sink.frames > 0 else {
        try? FileManager.default.removeItem(at: partial)
        return -11
    }

    guard muxAudio(videoOnly: partial, from: asset, into: destination) else {
        try? FileManager.default.removeItem(at: partial)
        return -12
    }
    try? FileManager.default.removeItem(at: partial)
    currentProgress = 100
    trace("done")
    return 0
}

/// 把纯视频文件和原片音轨合成最终 mp4（passthrough，音频不重编码）。
private func muxAudio(videoOnly: URL, from source: AVURLAsset, into destination: URL) -> Bool {
    let videoAsset = AVURLAsset(url: videoOnly)
    guard let sourceVideo = videoAsset.tracks(withMediaType: .video).first else {
        trace("mux: no video track in transcoded file")
        return false
    }
    let composition = AVMutableComposition()
    guard let videoTrack = composition.addMutableTrack(
        withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else {
        trace("mux: cannot add video track")
        return false
    }
    do {
        try videoTrack.insertTimeRange(
            CMTimeRange(start: .zero, duration: videoAsset.duration), of: sourceVideo, at: .zero)
        if let sourceAudio = source.tracks(withMediaType: .audio).first,
            let audioTrack = composition.addMutableTrack(
                withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) {
            try audioTrack.insertTimeRange(
                CMTimeRange(start: .zero, duration: sourceAudio.timeRange.duration),
                of: sourceAudio, at: .zero)
            trace("mux: audio inserted")
        } else {
            trace("mux: no audio in source")
        }
    } catch {
        trace("mux insert failed: \(error)")
        return false
    }

    guard let export = AVAssetExportSession(
        asset: composition, presetName: AVAssetExportPresetPassthrough) else {
        trace("mux: export session nil")
        return false
    }
    guard export.supportedFileTypes.contains(.mp4) else {
        trace("mux: mp4 unsupported \(export.supportedFileTypes)")
        return false
    }
    // 先导出到旁边的临时文件，成功后再改名成 playable.mp4：Rust 那边只要见到
    // playable.mp4 就当成品交给播放器，导出途中（或导出时被杀）不能让它出现半截文件。
    // 临时名仍以 .mp4 结尾，AVFoundation 按扩展名认容器。
    let exporting = destination.deletingLastPathComponent()
        .appendingPathComponent("playable.exporting.mp4")
    try? FileManager.default.removeItem(at: exporting)
    export.outputURL = exporting
    export.outputFileType = .mp4
    let done = DispatchSemaphore(value: 0)
    export.exportAsynchronously { done.signal() }
    done.wait()
    trace("mux: export status \(export.status.rawValue) \(export.error.map(String.init(describing:)) ?? "")")
    guard export.status == .completed else {
        try? FileManager.default.removeItem(at: exporting)
        return false
    }
    do {
        try? FileManager.default.removeItem(at: destination)
        try FileManager.default.moveItem(at: exporting, to: destination)
    } catch {
        trace("mux: rename failed \(error)")
        try? FileManager.default.removeItem(at: exporting)
        return false
    }
    return true
}

import AVFoundation
import Foundation
import SwiftRs
import Tauri
import UIKit
import WebKit

struct ExportAudioForAsrArgs: Decodable {
  let sourcePath: String
  let outDir: String
  let preferredFormat: String
}

struct ExportFrameJpegArgs: Decodable {
  let sourcePath: String
  let atMs: Int64
  let outPath: String
}

struct ExportLumaFramesArgs: Decodable {
  let sourcePath: String
  let sampleWidth: Int
  let sampleHeight: Int
  let intervalMs: Int64
}

final class MobileFilesPlugin: Plugin {
  private let workQueue = DispatchQueue(label: "dev.courseai.mobile-files")
  private let audioWriterQueue = DispatchQueue(label: "dev.courseai.mobile-files.audio-writer")

  @objc public func exportAudioForAsr(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ExportAudioForAsrArgs.self)
    workQueue.async {
      do {
        let result = try self.exportAudioForAsr(args)
        invoke.resolve([
          "path": result.path,
          "mime": result.mime,
          "format": result.format,
        ])
      } catch {
        if let nsError = error as NSError? {
          invoke.reject("\(nsError.domain) (\(nsError.code)): \(nsError.localizedDescription)")
        } else {
          invoke.reject(error.localizedDescription)
        }
      }
    }
  }

  // 视频首帧/封面：桌面端用 ffmpeg，iOS 改用原生 AVAssetImageGenerator 截一帧落地 JPEG。
  @objc public func exportFrameJpeg(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ExportFrameJpegArgs.self)
    workQueue.async {
      do {
        try self.exportFrameJpeg(args)
        invoke.resolve(["path": args.outPath])
      } catch {
        if let nsError = error as NSError? {
          invoke.reject("\(nsError.domain) (\(nsError.code)): \(nsError.localizedDescription)")
        } else {
          invoke.reject(error.localizedDescription)
        }
      }
    }
  }

  // 课件自动提取：按固定间隔原生抽一串低分辨率亮度帧（桌面端用 ffmpeg，iOS 用
  // AVAssetImageGenerator 批量取帧），交给 Rust 端复用同一套换页检测算法。
  @objc public func exportLumaFrames(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ExportLumaFramesArgs.self)
    workQueue.async {
      do {
        let result = try self.exportLumaFrames(args)
        invoke.resolve([
          "intervalMs": result.intervalMs,
          "frames": result.frames,
        ])
      } catch {
        if let nsError = error as NSError? {
          invoke.reject("\(nsError.domain) (\(nsError.code)): \(nsError.localizedDescription)")
        } else {
          invoke.reject(error.localizedDescription)
        }
      }
    }
  }

  private func exportLumaFrames(_ args: ExportLumaFramesArgs) throws -> (
    intervalMs: Int64, frames: [String]
  ) {
    let width = max(16, min(512, args.sampleWidth))
    let height = max(16, min(512, args.sampleHeight))
    let intervalMs = max(250, args.intervalMs)
    let asset = AVURLAsset(url: URL(fileURLWithPath: args.sourcePath))
    let durationMs = try loadedDurationMs(of: asset)

    // 采样时刻：0、interval、2·interval…直到时长；至少取一帧（极短/读不到时长时取首帧）。
    var times: [NSValue] = []
    var atMs: Int64 = 0
    repeat {
      times.append(NSValue(time: CMTime(value: CMTimeValue(atMs), timescale: 1000)))
      atMs += intervalMs
    } while atMs <= durationMs
    if times.isEmpty { times = [NSValue(time: .zero)] }

    let generator = AVAssetImageGenerator(asset: asset)
    generator.appliesPreferredTrackTransform = true
    // 抽样不要求精确时间，放宽容差让 AVFoundation 复用最近关键帧、显著提速。
    generator.requestedTimeToleranceBefore = CMTime(seconds: 0.4, preferredTimescale: 600)
    generator.requestedTimeToleranceAfter = CMTime(seconds: 0.4, preferredTimescale: 600)
    // 先粗降采样加速解码，亮度计算时再精确缩到 width×height。
    generator.maximumSize = CGSize(width: width * 2, height: height * 2)

    var lumaByMs: [Int64: [UInt8]] = [:]
    let lock = NSLock()
    let group = DispatchGroup()
    for _ in times { group.enter() }
    generator.generateCGImagesAsynchronously(forTimes: times) {
      requested, image, _, _, _ in
      defer { group.leave() }
      guard let image = image else { return }
      let luma = self.cgImageToLuma(image, width: width, height: height)
      let ms = Int64((CMTimeGetSeconds(requested) * 1000.0).rounded())
      lock.lock()
      lumaByMs[ms] = luma
      lock.unlock()
    }
    group.wait()

    // 按时间顺序组装；个别时刻取帧失败时沿用上一帧（视作未换页），保持与 interval 对齐的连续序列。
    let blank = [UInt8](repeating: 0, count: width * height)
    var frames: [String] = []
    var prev: [UInt8]?
    var ms: Int64 = 0
    for _ in times {
      let luma = lumaByMs[ms] ?? prev ?? blank
      frames.append(Data(luma).base64EncodedString())
      prev = luma
      ms += intervalMs
    }
    return (intervalMs, frames)
  }

  /// 把一帧解码图画进 width×height 的 RGBA 位图，按 Rec.709 权重算亮度（与 Android / ffmpeg 一致）。
  private func cgImageToLuma(_ image: CGImage, width: Int, height: Int) -> [UInt8] {
    let count = width * height
    let blank = [UInt8](repeating: 0, count: count)
    guard
      let ctx = CGContext(
        data: nil,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: width * 4,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { return blank }
    ctx.interpolationQuality = .medium
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: CGFloat(width), height: CGFloat(height)))
    guard let data = ctx.data else { return blank }
    let ptr = data.bindMemory(to: UInt8.self, capacity: count * 4)
    var out = [UInt8](repeating: 0, count: count)
    for i in 0..<count {
      let r = Double(ptr[i * 4])
      let g = Double(ptr[i * 4 + 1])
      let b = Double(ptr[i * 4 + 2])
      out[i] = UInt8(max(0.0, min(255.0, (0.2126 * r + 0.7152 * g + 0.0722 * b).rounded())))
    }
    return out
  }

  /// 异步加载并取视频时长（毫秒）。iOS 16+ 同步访问未加载的 duration 会得 0，故先异步加载。
  private func loadedDurationMs(of asset: AVURLAsset) throws -> Int64 {
    let semaphore = DispatchSemaphore(value: 0)
    asset.loadValuesAsynchronously(forKeys: ["duration"]) { semaphore.signal() }
    semaphore.wait()
    var loadError: NSError?
    guard asset.statusOfValue(forKey: "duration", error: &loadError) == .loaded else {
      if let loadError = loadError { throw loadError }
      throw MobileFilesError.cannotReadVideo
    }
    let seconds = CMTimeGetSeconds(asset.duration)
    guard seconds.isFinite, seconds > 0 else { return 0 }
    return Int64((seconds * 1000.0).rounded())
  }

  private func exportFrameJpeg(_ args: ExportFrameJpegArgs) throws {
    let source = URL(fileURLWithPath: args.sourcePath)
    let output = URL(fileURLWithPath: args.outPath)
    try FileManager.default.createDirectory(
      at: output.deletingLastPathComponent(), withIntermediateDirectories: true)
    if FileManager.default.fileExists(atPath: output.path) {
      try FileManager.default.removeItem(at: output)
    }

    let asset = AVURLAsset(url: source)
    let generator = AVAssetImageGenerator(asset: asset)
    generator.appliesPreferredTrackTransform = true
    // 封面不要求精确时间；放宽容差到 ±1s，避免关键帧稀疏时取帧失败。
    generator.requestedTimeToleranceBefore = CMTime(seconds: 1, preferredTimescale: 600)
    generator.requestedTimeToleranceAfter = CMTime(seconds: 1, preferredTimescale: 600)

    let time = CMTime(value: CMTimeValue(max(0, args.atMs)), timescale: 1000)
    let cgImage = try generator.copyCGImage(at: time, actualTime: nil)
    guard let data = UIImage(cgImage: cgImage).jpegData(compressionQuality: 0.8) else {
      throw MobileFilesError.cannotWriteImage
    }
    try data.write(to: output)
  }

  private func exportAudioForAsr(_ args: ExportAudioForAsrArgs) throws -> (path: String, mime: String, format: String) {
    let preferredFormat = args.preferredFormat.lowercased()
    guard preferredFormat == "wav" else {
      throw MobileFilesError.unsupportedFormat(args.preferredFormat)
    }

    let outDir = URL(fileURLWithPath: args.outDir, isDirectory: true)
    try FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
    let outFile = outDir.appendingPathComponent("audio.wav")
    if FileManager.default.fileExists(atPath: outFile.path) {
      try FileManager.default.removeItem(at: outFile)
    }

    try exportWav(source: URL(fileURLWithPath: args.sourcePath), output: outFile)
    return (outFile.path, "audio/wav", "wav")
  }

  /// 取出 asset 的第一条音轨。
  /// 直接同步访问 asset.tracks(...) 在 iOS 16+ 上，若轨道尚未加载会返回空数组（即便视频确有音轨），
  /// 从而误报 noAudioTrack（处理在 iPad 上一律失败）。这里先异步加载 "tracks" 键并阻塞等待，
  /// 加载完成后再同步取轨道。用 loadValuesAsynchronously 以兼容部署目标 iOS 14（loadTracks
  /// 需 iOS 15、load(_:) 需 iOS 16）。加载若出错也会抛出真实错误，便于定位。
  private func firstAudioTrack(of asset: AVURLAsset) throws -> AVAssetTrack {
    let semaphore = DispatchSemaphore(value: 0)
    asset.loadValuesAsynchronously(forKeys: ["tracks"]) {
      semaphore.signal()
    }
    semaphore.wait()

    var loadError: NSError?
    guard asset.statusOfValue(forKey: "tracks", error: &loadError) == .loaded else {
      if let loadError = loadError {
        throw loadError
      }
      throw MobileFilesError.cannotReadAudio
    }
    guard let audioTrack = asset.tracks(withMediaType: .audio).first else {
      throw MobileFilesError.noAudioTrack
    }
    return audioTrack
  }

  private func exportWav(source: URL, output: URL) throws {
    let asset = AVURLAsset(url: source)
    let audioTrack = try firstAudioTrack(of: asset)

    let reader = try AVAssetReader(asset: asset)
    let outputSettings: [String: Any] = [
      AVFormatIDKey: kAudioFormatLinearPCM,
      AVSampleRateKey: 16000,
      AVNumberOfChannelsKey: 1,
      AVLinearPCMBitDepthKey: 16,
      AVLinearPCMIsBigEndianKey: false,
      AVLinearPCMIsFloatKey: false,
      AVLinearPCMIsNonInterleaved: false,
    ]
    let readerOutput = AVAssetReaderTrackOutput(track: audioTrack, outputSettings: outputSettings)
    readerOutput.alwaysCopiesSampleData = false
    guard reader.canAdd(readerOutput) else {
      throw MobileFilesError.cannotReadAudio
    }
    reader.add(readerOutput)

    let audioSettings: [String: Any] = [
      AVFormatIDKey: kAudioFormatLinearPCM,
      AVSampleRateKey: 16000,
      AVNumberOfChannelsKey: 1,
      AVLinearPCMBitDepthKey: 16,
      AVLinearPCMIsBigEndianKey: false,
      AVLinearPCMIsFloatKey: false,
      AVLinearPCMIsNonInterleaved: false,
    ]
    let writer = try AVAssetWriter(outputURL: output, fileType: .wav)
    let writerInput = AVAssetWriterInput(mediaType: .audio, outputSettings: audioSettings)
    writerInput.expectsMediaDataInRealTime = false
    guard writer.canAdd(writerInput) else {
      throw MobileFilesError.cannotWriteAudio
    }
    writer.add(writerInput)

    guard reader.startReading() else {
      throw reader.error ?? MobileFilesError.cannotReadAudio
    }
    guard writer.startWriting() else {
      throw writer.error ?? MobileFilesError.cannotWriteAudio
    }
    writer.startSession(atSourceTime: .zero)

    let group = DispatchGroup()
    group.enter()
    writerInput.requestMediaDataWhenReady(on: audioWriterQueue) {
      while writerInput.isReadyForMoreMediaData {
        if let sample = readerOutput.copyNextSampleBuffer() {
          if !writerInput.append(sample) {
            reader.cancelReading()
            writerInput.markAsFinished()
            group.leave()
            return
          }
        } else {
          writerInput.markAsFinished()
          group.leave()
          return
        }
      }
    }
    group.wait()

    if let error = reader.error {
      writer.cancelWriting()
      throw error
    }
    if reader.status == .failed || reader.status == .cancelled {
      writer.cancelWriting()
      throw MobileFilesError.cannotReadAudio
    }

    let finishGroup = DispatchGroup()
    finishGroup.enter()
    writer.finishWriting {
      finishGroup.leave()
    }
    finishGroup.wait()

    if let error = writer.error {
      throw error
    }
    if writer.status != .completed {
      throw MobileFilesError.cannotWriteAudio
    }
  }
}

enum MobileFilesError: LocalizedError {
  case unsupportedFormat(String)
  case noAudioTrack
  case cannotReadAudio
  case cannotWriteAudio
  case cannotWriteImage
  case cannotReadVideo

  var errorDescription: String? {
    switch self {
    case .unsupportedFormat(let format):
      return "Unsupported ASR audio export format: \(format)"
    case .noAudioTrack:
      return "No audio track found in selected video"
    case .cannotReadAudio:
      return "Failed to decode audio track"
    case .cannotWriteAudio:
      return "Failed to write WAV audio"
    case .cannotWriteImage:
      return "Failed to encode cover image"
    case .cannotReadVideo:
      return "Failed to read video for slide extraction"
    }
  }
}

@_cdecl("init_plugin_mobile_files")
func initPlugin() -> Plugin {
  return MobileFilesPlugin()
}

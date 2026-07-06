import AVFoundation
import Foundation
import UniformTypeIdentifiers
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

struct PersistPickedFileArgs: Decodable {
  let sourceUri: String
  let category: String
  let fallbackName: String
}

struct ShareFileArgs: Decodable {
  let sourcePath: String
  let mime: String
}

struct PickAndPersistFileArgs: Decodable {
  let category: String
  let fallbackName: String
  let allowedExtensions: [String]
  let prompt: String?
}

struct PickAndPersistFileResult: Encodable {
  let path: String
  let durationMs: Int64
}

final class MobileFilesPlugin: Plugin {
  private let workQueue = DispatchQueue(label: "dev.courseai.mobile-files")
  private let audioWriterQueue = DispatchQueue(label: "dev.courseai.mobile-files.audio-writer")
  private var pendingPicker: UIDocumentPickerViewController?
  private var pendingPickerDelegate: DocumentPickerDelegate?
  fileprivate var pendingPickerHandled = false

  @objc public func persistPickedFile(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(PersistPickedFileArgs.self)
    workQueue.async {
      do {
        let result = try self.persistPickedFile(args)
        invoke.resolve([
          "path": result.path,
          "durationMs": result.durationMs,
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

  @objc public func shareFile(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ShareFileArgs.self)
    DispatchQueue.main.async {
      do {
        try self.shareFile(args)
        invoke.resolve([: ])
      } catch {
        if let nsError = error as NSError? {
          invoke.reject("\(nsError.domain) (\(nsError.code)): \(nsError.localizedDescription)")
        } else {
          invoke.reject(error.localizedDescription)
        }
      }
    }
  }

  @objc public func pickAndPersistFile(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(PickAndPersistFileArgs.self)
    DispatchQueue.main.async {
      do {
        try self.pickAndPersistFile(args, invoke: invoke)
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

  private func persistPickedFile(_ args: PersistPickedFileArgs) throws -> PickAndPersistFileResult {
    let source = localFileURL(from: args.sourceUri)
    let destinationDir = try pickedDirectory(category: args.category)
    let fallback = sanitizedFileName(args.fallbackName, fallback: "video")
    let sourceName = sanitizedFileName(source.lastPathComponent, fallback: fallback)
    let destination = uniqueDestination(in: destinationDir, preferredName: sourceName)

    let didStart = source.startAccessingSecurityScopedResource()
    defer {
      if didStart {
        source.stopAccessingSecurityScopedResource()
      }
    }
    try FileManager.default.copyItem(at: source, to: destination)
    let durationMs = try loadedDurationMs(of: AVURLAsset(url: destination))
    return PickAndPersistFileResult(path: destination.path, durationMs: durationMs)
  }

  private func pickAndPersistFile(_ args: PickAndPersistFileArgs, invoke: Invoke) throws {
    let resolvedTypes = args.allowedExtensions.isEmpty
      ? [UTType.movie]
      : args.allowedExtensions.compactMap { UTType(filenameExtension: $0) }
    let types = resolvedTypes.isEmpty ? [UTType.movie] : resolvedTypes
    let picker = UIDocumentPickerViewController(forOpeningContentTypes: types, asCopy: true)
    picker.allowsMultipleSelection = false
    picker.modalPresentationStyle = .formSheet
    let delegate = DocumentPickerDelegate(
      plugin: self,
      invoke: invoke,
      category: args.category,
      fallbackName: args.fallbackName)
    picker.delegate = delegate
    pendingPicker = picker
    pendingPickerDelegate = delegate
    pendingPickerHandled = false

    guard let presenter = rootPresenter() else {
      pendingPicker = nil
      pendingPickerDelegate = nil
      pendingPickerHandled = false
      throw NSError(
        domain: "dev.courseai.mobile-files",
        code: 500,
        userInfo: [NSLocalizedDescriptionKey: "Unable to present file picker"])
    }
    presenter.present(picker, animated: true)
  }

  func handlePickedFile(
    _ url: URL,
    invoke: Invoke,
    category: String,
    fallbackName: String
  ) {
    if pendingPickerHandled {
      return
    }
    pendingPickerHandled = true
    workQueue.async {
      do {
        let result = try self.persistPickedFile(url: url, category: category, fallbackName: fallbackName)
        DispatchQueue.main.async {
          self.pendingPicker = nil
          self.pendingPickerDelegate = nil
          invoke.resolve([
            "path": result.path,
            "durationMs": result.durationMs,
          ])
        }
      } catch {
        DispatchQueue.main.async {
          self.pendingPicker = nil
          self.pendingPickerDelegate = nil
          if let nsError = error as NSError? {
            invoke.reject("\(nsError.domain) (\(nsError.code)): \(nsError.localizedDescription)")
          } else {
            invoke.reject(error.localizedDescription)
          }
        }
      }
    }
  }

  private func persistPickedFile(
    url source: URL,
    category: String,
    fallbackName: String
  ) throws -> PickAndPersistFileResult {
    let destinationDir = try pickedDirectory(category: category)
    let fallback = sanitizedFileName(fallbackName, fallback: "video")
    let sourceName = sanitizedFileName(source.lastPathComponent, fallback: fallback)
    let destination = uniqueDestination(in: destinationDir, preferredName: sourceName)

    let coordinator = NSFileCoordinator()
    var coordinationError: NSError?
    var copyError: Error?
    coordinator.coordinate(readingItemAt: source, options: [], error: &coordinationError) { coordinatedURL in
      let didStart = coordinatedURL.startAccessingSecurityScopedResource()
      defer {
        if didStart {
          coordinatedURL.stopAccessingSecurityScopedResource()
        }
      }
      do {
        if FileManager.default.fileExists(atPath: destination.path) {
          try FileManager.default.removeItem(at: destination)
        }
        try FileManager.default.copyItem(at: coordinatedURL, to: destination)
      } catch {
        copyError = error
      }
    }
    if let coordinationError {
      throw coordinationError
    }
    if let copyError {
      throw copyError
    }
    let durationMs = try loadedDurationMs(of: AVURLAsset(url: destination))
    return PickAndPersistFileResult(path: destination.path, durationMs: durationMs)
  }

  private func shareFile(_ args: ShareFileArgs) throws {
    let url = URL(fileURLWithPath: args.sourcePath)
    guard FileManager.default.fileExists(atPath: url.path) else {
      throw NSError(
        domain: "dev.courseai.mobile-files",
        code: 404,
        userInfo: [NSLocalizedDescriptionKey: "Share file not found"])
    }
    let controller = UIActivityViewController(activityItems: [url], applicationActivities: nil)
    if let root = UIApplication.shared.connectedScenes
      .compactMap({ $0 as? UIWindowScene })
      .flatMap({ $0.windows })
      .first(where: { $0.isKeyWindow })?.rootViewController
    {
      controller.popoverPresentationController?.sourceView = root.view
      controller.popoverPresentationController?.sourceRect = CGRect(
        x: UIScreen.main.bounds.midX,
        y: UIScreen.main.bounds.midY,
        width: 0,
        height: 0)
      controller.popoverPresentationController?.permittedArrowDirections = []
      root.present(controller, animated: true)
      return
    }
    throw NSError(
      domain: "dev.courseai.mobile-files",
      code: 500,
      userInfo: [NSLocalizedDescriptionKey: "Unable to present share sheet"])
  }

  private func localFileURL(from sourceUri: String) -> URL {
    let assetPrefix = "asset://localhost"
    if sourceUri.hasPrefix(assetPrefix) {
      let start = sourceUri.index(sourceUri.startIndex, offsetBy: assetPrefix.count)
      let assetPath = String(sourceUri[start...])
      return URL(fileURLWithPath: assetPath.removingPercentEncoding ?? assetPath)
    }
    if let url = URL(string: sourceUri), url.scheme == "file" {
      return url
    }
    return URL(fileURLWithPath: sourceUri.removingPercentEncoding ?? sourceUri)
  }

  private func pickedDirectory(category: String) throws -> URL {
    let appSupport = try FileManager.default.url(
      for: .applicationSupportDirectory,
      in: .userDomainMask,
      appropriateFor: nil,
      create: true)
    let safeCategory = sanitizedFileName(category, fallback: "files")
    let directory = appSupport.appendingPathComponent("picked", isDirectory: true)
      .appendingPathComponent(safeCategory, isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    return directory
  }

  private func sanitizedFileName(_ name: String, fallback: String) -> String {
    let decoded = name.removingPercentEncoding ?? name
    let stripped = decoded.split(separator: "/").last.map(String.init) ?? decoded
    let invalid = CharacterSet(charactersIn: "/:")
      .union(.newlines)
      .union(.controlCharacters)
    let cleaned = stripped
      .components(separatedBy: invalid)
      .joined(separator: "_")
      .trimmingCharacters(in: .whitespacesAndNewlines)
    return cleaned.isEmpty ? fallback : cleaned
  }

  private func uniqueDestination(in directory: URL, preferredName: String) -> URL {
    let ext = (preferredName as NSString).pathExtension
    let stem = (preferredName as NSString).deletingPathExtension
    var candidate = directory.appendingPathComponent(preferredName)
    var index = 1
    while FileManager.default.fileExists(atPath: candidate.path) {
      let name = ext.isEmpty ? "\(stem)-\(index)" : "\(stem)-\(index).\(ext)"
      candidate = directory.appendingPathComponent(name)
      index += 1
    }
    return candidate
  }

  private func rootPresenter() -> UIViewController? {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    let keyWindow = scenes.flatMap { $0.windows }.first(where: { $0.isKeyWindow })
    return keyWindow?.rootViewController
  }

  func clearPendingPicker() {
    pendingPicker = nil
    pendingPickerDelegate = nil
    pendingPickerHandled = false
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

final class DocumentPickerDelegate: NSObject, UIDocumentPickerDelegate {
  private weak var plugin: MobileFilesPlugin?
  private let invoke: Invoke
  private let category: String
  private let fallbackName: String

  init(plugin: MobileFilesPlugin, invoke: Invoke, category: String, fallbackName: String) {
    self.plugin = plugin
    self.invoke = invoke
    self.category = category
    self.fallbackName = fallbackName
  }

  func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
    controller.dismiss(animated: true)
    guard let url = urls.first, let plugin else {
      invoke.reject("No file selected")
      return
    }
    plugin.handlePickedFile(url, invoke: invoke, category: category, fallbackName: fallbackName)
  }

  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    guard let plugin, !plugin.pendingPickerHandled else {
      return
    }
    plugin.clearPendingPicker()
    invoke.resolve(["path": NSNull()])
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

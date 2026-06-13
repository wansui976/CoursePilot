import AVFoundation
import Foundation
import SwiftRs
import Tauri
import WebKit

struct ExportAudioForAsrArgs: Decodable {
  let sourcePath: String
  let outDir: String
  let preferredFormat: String
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
        invoke.reject(error.localizedDescription)
      }
    }
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
    }
  }
}

@_cdecl("init_plugin_mobile_files")
func initPlugin() -> Plugin {
  return MobileFilesPlugin()
}

package dev.courseai.mobilefiles

import android.app.Activity
import android.graphics.Bitmap
import android.media.AudioFormat
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.media.MediaMuxer
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Base64
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONArray
import java.nio.ByteBuffer
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.util.concurrent.Executors

@InvokeArg
class PersistPickedFileArgs {
  lateinit var sourceUri: String
  lateinit var category: String
  lateinit var fallbackName: String
}

@InvokeArg
class ExportAudioForAsrArgs {
  lateinit var sourcePath: String
  lateinit var outDir: String
  lateinit var preferredFormat: String
}

@InvokeArg
class ExportFrameJpegArgs {
  lateinit var sourcePath: String
  var atMs: Long = 0
  lateinit var outPath: String
}

@InvokeArg
class ExportLumaFramesArgs {
  lateinit var sourcePath: String
  var sampleWidth: Long = 128
  var sampleHeight: Long = 72
  var intervalMs: Long = 1000
}

private data class AudioExportResult(val path: String, val mime: String, val format: String)

@TauriPlugin
class MobileFilesPlugin(private val activity: Activity) : Plugin(activity) {
  private val ioExecutor = Executors.newSingleThreadExecutor { runnable ->
    Thread(runnable, "course-ai-mobile-files")
  }

  @Command
  fun persistPickedFile(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(PersistPickedFileArgs::class.java)
      val source = args.sourceUri
      val uri = Uri.parse(source)
      val folderName = sanitizeName(args.category, "picked")
      val displayName = sanitizeName(displayName(uri) ?: uri.lastPathSegment ?: args.fallbackName, args.fallbackName)
      val fileName = "${java.lang.Long.toString(System.currentTimeMillis(), 36)}-$displayName"
      val dir = File(File(activity.dataDir, "picked"), folderName)
      if (!dir.exists() && !dir.mkdirs()) {
        throw IllegalStateException("Failed to create picked file directory")
      }

      val outFile = File(dir, fileName)
      val input = when (uri.scheme) {
        "content", "file" -> activity.contentResolver.openInputStream(uri)
        else -> File(source).inputStream()
      } ?: throw IllegalArgumentException("Cannot open picked file")

      input.use { inputStream ->
        outFile.outputStream().use { outputStream ->
          inputStream.copyTo(outputStream, 1024 * 1024)
        }
      }

      val result = JSObject()
      result.put("path", outFile.absolutePath)
      invoke.resolve(result)
    } catch (error: Exception) {
      invoke.reject(error.message ?: "Failed to persist picked file", error)
    }
  }

  @Command
  fun exportAudioForAsr(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(ExportAudioForAsrArgs::class.java)
      runOnIoThread(invoke, "Failed to export audio for ASR") {
        val outDir = File(args.outDir)
        if (!outDir.exists() && !outDir.mkdirs()) {
          throw IllegalStateException("Failed to create ASR audio directory")
        }
        val export = when (args.preferredFormat.lowercase()) {
          "m4a" -> exportM4a(args.sourcePath, outDir)
          "wav" -> exportWav(args.sourcePath, outDir)
          else -> throw IllegalArgumentException("Unsupported ASR audio export format: ${args.preferredFormat}")
        }

        val result = JSObject()
        result.put("path", export.path)
        result.put("mime", export.mime)
        result.put("format", export.format)
        result
      }
    } catch (error: Exception) {
      invoke.reject(error.message ?: "Failed to export audio for ASR", error)
    }
  }

  // 取视频某时刻的一帧存成 JPEG，替代桌面端的 ffmpeg 截帧（封面/截图用）。
  @Command
  fun exportFrameJpeg(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(ExportFrameJpegArgs::class.java)
      runOnIoThread(invoke, "Failed to capture frame") {
        val bitmap = readFrameBitmap(args.sourcePath, args.atMs)
        val outFile = File(args.outPath)
        outFile.parentFile?.let { if (!it.exists() && !it.mkdirs()) throw IllegalStateException("Failed to create cover directory") }
        FileOutputStream(outFile).use { stream ->
          bitmap.compress(Bitmap.CompressFormat.JPEG, 90, stream)
        }
        bitmap.recycle()

        val result = JSObject()
        result.put("path", outFile.absolutePath)
        result
      }
    } catch (error: Exception) {
      invoke.reject(error.message ?: "Failed to capture frame", error)
    }
  }

  @Command
  fun exportLumaFrames(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(ExportLumaFramesArgs::class.java)
      runOnIoThread(invoke, "Failed to export luma frames") {
        val width = args.sampleWidth.coerceIn(16, 512).toInt()
        val height = args.sampleHeight.coerceIn(16, 512).toInt()
        val intervalMs = args.intervalMs.coerceAtLeast(250L)
        val durationMs = readDurationMs(args.sourcePath).coerceAtLeast(0L)
        val frames = JSONArray()
        var atMs = 0L
        var produced = false

        while (atMs <= durationMs || !produced) {
          val bitmap = readFrameBitmap(args.sourcePath, atMs)
          val scaled = if (bitmap.width == width && bitmap.height == height) {
            bitmap
          } else {
            Bitmap.createScaledBitmap(bitmap, width, height, true)
          }
          val luma = bitmapToLuma(scaled)
          frames.put(Base64.encodeToString(luma, Base64.NO_WRAP))
          if (scaled !== bitmap) {
            scaled.recycle()
          }
          bitmap.recycle()
          produced = true
          atMs += intervalMs
        }

        val result = JSObject()
        result.put("intervalMs", intervalMs)
        result.put("frames", frames)
        result
      }
    } catch (error: Exception) {
      invoke.reject(error.message ?: "Failed to export luma frames", error)
    }
  }

  private fun runOnIoThread(
    invoke: Invoke,
    errorMessage: String,
    block: () -> JSObject,
  ) {
    ioExecutor.execute {
      try {
        invoke.resolve(block())
      } catch (error: Exception) {
        invoke.reject(error.message ?: errorMessage, error)
      }
    }
  }

  private fun displayName(uri: Uri): String? {
    var cursor = activity.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
    try {
      if (cursor != null && cursor.moveToFirst()) {
        val index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
        if (index >= 0) {
          return cursor.getString(index)
        }
      }
    } catch (_: Exception) {
      return null
    } finally {
      cursor?.close()
    }
    return null
  }

  private fun sanitizeName(name: String, fallback: String): String {
    val cleaned = name
      .replace(Regex("[\\\\/<>:\"|?*\\x00-\\x1F]"), "_")
      .replace(Regex("\\s+"), " ")
      .trim()
    return if (cleaned.isBlank()) fallback else cleaned
  }

  private fun openExtractor(source: String): MediaExtractor {
    val extractor = MediaExtractor()
    val uri = Uri.parse(source)
    when (uri.scheme) {
      "content" -> extractor.setDataSource(activity, uri, null)
      "file" -> extractor.setDataSource(uri.path ?: source)
      else -> extractor.setDataSource(source)
    }
    return extractor
  }

  private fun setRetrieverDataSource(retriever: MediaMetadataRetriever, source: String) {
    val uri = Uri.parse(source)
    when (uri.scheme) {
      "content" -> retriever.setDataSource(activity, uri)
      "file" -> retriever.setDataSource(uri.path ?: source)
      else -> retriever.setDataSource(source)
    }
  }

  private fun readDurationMs(source: String): Long {
    val retriever = MediaMetadataRetriever()
    try {
      setRetrieverDataSource(retriever, source)
      return retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L
    } finally {
      try {
        retriever.release()
      } catch (_: Exception) {
      }
    }
  }

  private fun readFrameBitmap(source: String, atMs: Long): Bitmap {
    val retriever = MediaMetadataRetriever()
    try {
      setRetrieverDataSource(retriever, source)
      val atUs = (if (atMs < 0) 0 else atMs) * 1000L
      return retriever.getFrameAtTime(atUs, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
        ?: retriever.getFrameAtTime(atUs, MediaMetadataRetriever.OPTION_CLOSEST)
        ?: retriever.getFrameAtTime(-1)
        ?: throw IllegalStateException("No decodable frame at ${atMs}ms")
    } finally {
      try {
        retriever.release()
      } catch (_: Exception) {
      }
    }
  }

  private fun bitmapToLuma(bitmap: Bitmap): ByteArray {
    val pixels = IntArray(bitmap.width * bitmap.height)
    bitmap.getPixels(pixels, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
    val out = ByteArray(pixels.size)
    for (index in pixels.indices) {
      val color = pixels[index]
      val r = (color shr 16) and 0xff
      val g = (color shr 8) and 0xff
      val b = color and 0xff
      out[index] = (0.2126 * r + 0.7152 * g + 0.0722 * b).toInt().coerceIn(0, 255).toByte()
    }
    return out
  }

  private fun selectAudioTrack(extractor: MediaExtractor): Int {
    for (index in 0 until extractor.trackCount) {
      val format = extractor.getTrackFormat(index)
      val mime = format.getString(MediaFormat.KEY_MIME)
      if (mime != null && mime.startsWith("audio/")) {
        return index
      }
    }
    return -1
  }

  private fun exportM4a(sourcePath: String, outDir: File): AudioExportResult {
    var extractor: MediaExtractor? = null
    var muxer: MediaMuxer? = null
    try {
      val outFile = File(outDir, "audio.m4a")
      replaceOutput(outFile)
      extractor = openExtractor(sourcePath)
      val sourceTrack = selectAudioTrack(extractor)
      if (sourceTrack < 0) {
        throw IllegalArgumentException("No audio track found in selected video")
      }
      extractor.selectTrack(sourceTrack)
      val audioFormat = extractor.getTrackFormat(sourceTrack)

      muxer = MediaMuxer(outFile.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
      val muxerTrack = muxer.addTrack(audioFormat)
      muxer.start()

      val maxInputSize = if (audioFormat.containsKey(MediaFormat.KEY_MAX_INPUT_SIZE)) {
        audioFormat.getInteger(MediaFormat.KEY_MAX_INPUT_SIZE)
      } else {
        1024 * 1024
      }
      val buffer = ByteBuffer.allocate(maxInputSize.coerceAtLeast(1024 * 1024))
      val info = MediaCodec.BufferInfo()

      while (true) {
        buffer.clear()
        val sampleSize = extractor.readSampleData(buffer, 0)
        if (sampleSize < 0) {
          break
        }
        info.offset = 0
        info.size = sampleSize
        info.presentationTimeUs = extractor.sampleTime
        info.flags = extractor.sampleFlags
        muxer.writeSampleData(muxerTrack, buffer, info)
        extractor.advance()
      }
      return AudioExportResult(outFile.absolutePath, "audio/mp4", "m4a")
    } finally {
      try {
        muxer?.stop()
      } catch (_: Exception) {
      }
      try {
        muxer?.release()
      } catch (_: Exception) {
      }
      try {
        extractor?.release()
      } catch (_: Exception) {
      }
    }
  }

  private fun exportWav(sourcePath: String, outDir: File): AudioExportResult {
    var extractor: MediaExtractor? = null
    var decoder: MediaCodec? = null
    var out: RandomAccessFile? = null
    try {
      val outFile = File(outDir, "audio.wav")
      replaceOutput(outFile)
      extractor = openExtractor(sourcePath)
      val sourceTrack = selectAudioTrack(extractor)
      if (sourceTrack < 0) {
        throw IllegalArgumentException("No audio track found in selected video")
      }
      extractor.selectTrack(sourceTrack)
      val inputFormat = extractor.getTrackFormat(sourceTrack)
      val mime = inputFormat.getString(MediaFormat.KEY_MIME)
        ?: throw IllegalArgumentException("Selected audio track has no MIME type")

      decoder = MediaCodec.createDecoderByType(mime)
      decoder.configure(inputFormat, null, null, 0)
      decoder.start()

      out = RandomAccessFile(outFile, "rw")
      out.setLength(0)
      out.write(ByteArray(44))

      val info = MediaCodec.BufferInfo()
      var inputDone = false
      var outputDone = false
      var sampleRate = inputFormat.getInteger(MediaFormat.KEY_SAMPLE_RATE)
      var channelCount = inputFormat.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
      var pcmBytes = 0L

      while (!outputDone) {
        if (!inputDone) {
          val inputIndex = decoder.dequeueInputBuffer(10_000)
          if (inputIndex >= 0) {
            val inputBuffer = decoder.getInputBuffer(inputIndex)
              ?: throw IllegalStateException("Decoder input buffer unavailable")
            inputBuffer.clear()
            val sampleSize = extractor.readSampleData(inputBuffer, 0)
            if (sampleSize < 0) {
              decoder.queueInputBuffer(
                inputIndex,
                0,
                0,
                0,
                MediaCodec.BUFFER_FLAG_END_OF_STREAM,
              )
              inputDone = true
            } else {
              decoder.queueInputBuffer(inputIndex, 0, sampleSize, extractor.sampleTime, 0)
              extractor.advance()
            }
          }
        }

        when (val outputIndex = decoder.dequeueOutputBuffer(info, 10_000)) {
          MediaCodec.INFO_TRY_AGAIN_LATER -> {}
          MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
            val outputFormat = decoder.outputFormat
            sampleRate = outputFormat.getInteger(MediaFormat.KEY_SAMPLE_RATE)
            channelCount = outputFormat.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
            if (outputFormat.containsKey(MediaFormat.KEY_PCM_ENCODING)) {
              val pcmEncoding = outputFormat.getInteger(MediaFormat.KEY_PCM_ENCODING)
              if (pcmEncoding != AudioFormat.ENCODING_PCM_16BIT) {
                throw IllegalStateException("Unsupported decoded PCM encoding: $pcmEncoding")
              }
            }
          }
          else -> {
            if (outputIndex >= 0) {
              if ((info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) {
                outputDone = true
              }
              if (info.size > 0) {
                val outputBuffer = decoder.getOutputBuffer(outputIndex)
                  ?: throw IllegalStateException("Decoder output buffer unavailable")
                outputBuffer.position(info.offset)
                outputBuffer.limit(info.offset + info.size)
                val bytes = ByteArray(info.size)
                outputBuffer.get(bytes)
                out.write(bytes)
                pcmBytes += info.size.toLong()
              }
              decoder.releaseOutputBuffer(outputIndex, false)
            }
          }
        }
      }

      writeWavHeader(out, pcmBytes, sampleRate, channelCount)
      return AudioExportResult(outFile.absolutePath, "audio/wav", "wav")
    } finally {
      try {
        decoder?.stop()
      } catch (_: Exception) {
      }
      try {
        decoder?.release()
      } catch (_: Exception) {
      }
      try {
        extractor?.release()
      } catch (_: Exception) {
      }
      try {
        out?.close()
      } catch (_: Exception) {
      }
    }
  }

  private fun replaceOutput(file: File) {
    if (file.exists() && !file.delete()) {
      throw IllegalStateException("Failed to replace existing ASR audio")
    }
  }

  private fun writeWavHeader(out: RandomAccessFile, pcmBytes: Long, sampleRate: Int, channels: Int) {
    val byteRate = sampleRate * channels * 2
    out.seek(0)
    out.writeBytes("RIFF")
    writeLeInt(out, (36 + pcmBytes).toInt())
    out.writeBytes("WAVE")
    out.writeBytes("fmt ")
    writeLeInt(out, 16)
    writeLeShort(out, 1)
    writeLeShort(out, channels)
    writeLeInt(out, sampleRate)
    writeLeInt(out, byteRate)
    writeLeShort(out, channels * 2)
    writeLeShort(out, 16)
    out.writeBytes("data")
    writeLeInt(out, pcmBytes.toInt())
  }

  private fun writeLeInt(out: RandomAccessFile, value: Int) {
    out.write(value and 0xff)
    out.write((value shr 8) and 0xff)
    out.write((value shr 16) and 0xff)
    out.write((value shr 24) and 0xff)
  }

  private fun writeLeShort(out: RandomAccessFile, value: Int) {
    out.write(value and 0xff)
    out.write((value shr 8) and 0xff)
  }
}

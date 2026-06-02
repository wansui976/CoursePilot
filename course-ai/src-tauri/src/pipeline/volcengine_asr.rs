use crate::error::{AppError, AppResult};
use crate::pipeline::asr::{Offsets, TokenObj, WhisperJson, WhisperSegment};
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::path::Path;
use std::time::Duration;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;
use uuid::Uuid;

const ENDPOINT: &str = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel";
// 流式语音识别大模型（小时版/按时长后付费）的资源 ID。
// 旧值 volc.seedasr.sauc.duration 不被网关接受，握手会返回 403。
const RESOURCE_ID: &str = "volc.bigasr.sauc.duration";
const PROTOCOL_VERSION_HEADER: u8 = 0x11;
const MSG_FULL_CLIENT_REQUEST: u8 = 0x1;
const MSG_AUDIO_ONLY_REQUEST: u8 = 0x2;
const MSG_FULL_SERVER_RESPONSE: u8 = 0x9;
const MSG_SERVER_ERROR: u8 = 0xF;
#[cfg(test)]
const FLAG_NONE: u8 = 0x0;
const FLAG_SEQUENCE: u8 = 0x1;
const FLAG_LAST: u8 = 0x2;
const FLAG_SEQUENCE_LAST: u8 = 0x3;
const SERIAL_NONE: u8 = 0x0;
const SERIAL_JSON: u8 = 0x1;
const COMPRESSION_NONE: u8 = 0x0;
const COMPRESSION_GZIP: u8 = 0x1;
const AUDIO_CHUNK_BYTES: usize = 3_200; // 100ms of 16kHz, 16-bit, mono PCM/WAV payload.

#[derive(Debug)]
pub struct ServerResponse {
    payload: Value,
    is_last: bool,
}

impl ServerResponse {
    pub fn is_last(&self) -> bool {
        self.is_last
    }

    pub fn into_transcript(self) -> AppResult<WhisperJson> {
        response_payload_to_transcript(&self.payload)
    }
}

pub async fn run_volcengine(
    audio: &Path,
    app_id: &str,
    access_token: &str,
) -> AppResult<WhisperJson> {
    let app_id = app_id.trim();
    let access_token = access_token.trim();
    if app_id.is_empty() || access_token.is_empty() {
        return Err(AppError::Config(
            "missing Volcengine ASR credentials：请在设置里填写 App ID 与 Access Token".into(),
        ));
    }

    let audio_bytes = tokio::fs::read(audio).await?;
    let request_id = Uuid::new_v4().to_string();
    let mut request = ENDPOINT
        .into_client_request()
        .map_err(|error| AppError::Pipeline(format!("volcengine websocket request: {error}")))?;
    let headers = request.headers_mut();
    // v3 大模型协议用 App Key + Access Key 两段鉴权；只发 X-Api-Key 会被网关 403 拒绝。
    headers.insert(
        "X-Api-App-Key",
        app_id
            .parse()
            .map_err(|error| AppError::Config(format!("invalid Volcengine App ID: {error}")))?,
    );
    headers.insert(
        "X-Api-Access-Key",
        access_token.parse().map_err(|error| {
            AppError::Config(format!("invalid Volcengine Access Token: {error}"))
        })?,
    );
    headers.insert(
        "X-Api-Resource-Id",
        RESOURCE_ID.parse().map_err(|error| {
            AppError::Config(format!("invalid Volcengine resource id: {error}"))
        })?,
    );
    headers.insert(
        "X-Api-Connect-Id",
        request_id
            .parse()
            .map_err(|error| AppError::Config(format!("invalid Volcengine request id: {error}")))?,
    );

    let (mut socket, _response) = connect_async(request).await.map_err(|error| {
        let detail = error.to_string();
        if detail.contains("403") {
            AppError::Pipeline(format!(
                "volcengine websocket connect: 403 Forbidden（鉴权失败：请核对 App ID / Access Token，\
                 并确认控制台已开通「流式语音识别大模型」且资源 ID 为 {RESOURCE_ID}）：{detail}"
            ))
        } else {
            AppError::Pipeline(format!("volcengine websocket connect: {detail}"))
        }
    })?;

    let payload = build_full_request_payload(&request_id);
    socket
        .send(Message::Binary(build_full_client_packet(&payload)?.into()))
        .await
        .map_err(|error| AppError::Pipeline(format!("volcengine send request: {error}")))?;

    for (idx, chunk) in audio_bytes.chunks(AUDIO_CHUNK_BYTES).enumerate() {
        let sequence = (idx + 2) as i32;
        let is_last = (idx + 1) * AUDIO_CHUNK_BYTES >= audio_bytes.len();
        socket
            .send(Message::Binary(
                build_audio_packet(sequence, chunk, is_last)?.into(),
            ))
            .await
            .map_err(|error| AppError::Pipeline(format!("volcengine send audio: {error}")))?;
    }

    loop {
        let frame = tokio::time::timeout(Duration::from_secs(300), socket.next())
            .await
            .map_err(|_| AppError::Pipeline("volcengine websocket timed out".into()))?
            .ok_or_else(|| AppError::Pipeline("volcengine websocket closed".into()))?
            .map_err(|error| AppError::Pipeline(format!("volcengine websocket read: {error}")))?;

        let Message::Binary(bytes) = frame else {
            continue;
        };
        let response = parse_server_message(&bytes)?;
        if response.is_last() {
            return response.into_transcript();
        }
    }
}

pub fn build_full_request_payload(uid: &str) -> Value {
    json!({
        "user": {
            "uid": uid,
        },
        "audio": {
            "format": "wav",
            "codec": "raw",
            "rate": 16000,
            "bits": 16,
            "channel": 1,
            "language": "zh-CN",
        },
        "request": {
            "model_name": "bigmodel",
            "enable_itn": true,
            "enable_punc": true,
            "enable_ddc": true,
            "show_utterances": true,
            "enable_nonstream": true,
            "result_type": "full",
            "end_window_size": 800,
        },
    })
}

pub fn build_full_client_packet(payload: &Value) -> AppResult<Vec<u8>> {
    let raw = serde_json::to_vec(payload)?;
    let compressed = gzip(&raw)?;
    let mut packet = header(
        MSG_FULL_CLIENT_REQUEST,
        FLAG_SEQUENCE,
        SERIAL_JSON,
        COMPRESSION_GZIP,
    );
    packet.extend_from_slice(&1_i32.to_be_bytes());
    append_u32(&mut packet, compressed.len());
    packet.extend_from_slice(&compressed);
    Ok(packet)
}

pub fn build_audio_packet(sequence: i32, audio: &[u8], is_last: bool) -> AppResult<Vec<u8>> {
    let compressed = gzip(audio)?;
    let flags = if is_last {
        FLAG_SEQUENCE_LAST
    } else {
        FLAG_SEQUENCE
    };
    let signed_sequence = if is_last {
        -sequence.abs()
    } else {
        sequence.abs()
    };
    let mut packet = header(MSG_AUDIO_ONLY_REQUEST, flags, SERIAL_NONE, COMPRESSION_GZIP);
    packet.extend_from_slice(&signed_sequence.to_be_bytes());
    append_u32(&mut packet, compressed.len());
    packet.extend_from_slice(&compressed);
    Ok(packet)
}

pub fn parse_server_message(input: &[u8]) -> AppResult<ServerResponse> {
    if input.len() < 4 {
        return Err(AppError::Pipeline("volcengine response too short".into()));
    }
    let header_size = ((input[0] & 0x0f) as usize) * 4;
    if input.len() < header_size {
        return Err(AppError::Pipeline(
            "volcengine response header truncated".into(),
        ));
    }
    let message_type = input[1] >> 4;
    let flags = input[1] & 0x0f;
    let serial = input[2] >> 4;
    let compression = input[2] & 0x0f;
    let mut cursor = header_size;

    match message_type {
        MSG_FULL_SERVER_RESPONSE => {
            if flags & FLAG_SEQUENCE == FLAG_SEQUENCE {
                ensure_len(input, cursor, 4)?;
                cursor += 4;
            }
            ensure_len(input, cursor, 4)?;
            let payload_size = read_u32(input, cursor)? as usize;
            cursor += 4;
            ensure_len(input, cursor, payload_size)?;
            let payload_bytes = decode_payload(&input[cursor..cursor + payload_size], compression)?;
            let payload = if serial == SERIAL_JSON {
                serde_json::from_slice(&payload_bytes)?
            } else {
                Value::String(String::from_utf8_lossy(&payload_bytes).to_string())
            };
            if let Some(code) = payload.get("code").and_then(Value::as_i64) {
                if code != 0 {
                    return Err(AppError::Pipeline(format!(
                        "volcengine asr error {code}: {}",
                        payload
                    )));
                }
            }
            Ok(ServerResponse {
                payload,
                is_last: flags & FLAG_LAST == FLAG_LAST,
            })
        }
        MSG_SERVER_ERROR => {
            ensure_len(input, cursor, 8)?;
            let code = read_u32(input, cursor)?;
            cursor += 4;
            let message_size = read_u32(input, cursor)? as usize;
            cursor += 4;
            ensure_len(input, cursor, message_size)?;
            let message = String::from_utf8_lossy(&input[cursor..cursor + message_size]);
            Err(AppError::Pipeline(format!(
                "volcengine websocket error {code}: {message}"
            )))
        }
        other => Err(AppError::Pipeline(format!(
            "unexpected volcengine message type: {other}"
        ))),
    }
}

pub(crate) fn response_payload_to_transcript(payload: &Value) -> AppResult<WhisperJson> {
    let result = payload
        .pointer("/payload_msg/result")
        .or_else(|| payload.get("result"))
        .ok_or_else(|| {
            AppError::Pipeline(format!("volcengine response missing result: {payload}"))
        })?;

    let mut transcription = Vec::new();
    if let Some(utterances) = result.get("utterances").and_then(Value::as_array) {
        for utterance in utterances {
            let text = value_str(utterance.get("text")).trim().to_string();
            if text.is_empty() {
                continue;
            }
            let from = value_i64(utterance.get("start_time")).unwrap_or(0);
            let to = value_i64(utterance.get("end_time")).unwrap_or(from);
            let tokens = utterance
                .get("words")
                .and_then(Value::as_array)
                .map(|words| {
                    words
                        .iter()
                        .filter_map(|word| {
                            let text = value_str(word.get("text")).trim().to_string();
                            if text.is_empty() {
                                return None;
                            }
                            Some(TokenObj {
                                text,
                                offsets: Offsets {
                                    from: value_i64(word.get("start_time")).unwrap_or(from),
                                    to: value_i64(word.get("end_time")).unwrap_or(to),
                                },
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            transcription.push(WhisperSegment {
                text,
                offsets: Offsets { from, to },
                tokens,
            });
        }
    }

    if transcription.is_empty() {
        let text = value_str(result.get("text")).trim().to_string();
        if !text.is_empty() {
            let duration = payload
                .pointer("/payload_msg/audio_info/duration")
                .and_then(|value| value_i64(Some(value)))
                .unwrap_or(0);
            transcription.push(WhisperSegment {
                text,
                offsets: Offsets {
                    from: 0,
                    to: duration,
                },
                tokens: Vec::new(),
            });
        }
    }

    Ok(WhisperJson { transcription })
}

fn header(message_type: u8, flags: u8, serial: u8, compression: u8) -> Vec<u8> {
    vec![
        PROTOCOL_VERSION_HEADER,
        (message_type << 4) | flags,
        (serial << 4) | compression,
        0x00,
    ]
}

fn append_u32(packet: &mut Vec<u8>, value: usize) {
    packet.extend_from_slice(&(value as u32).to_be_bytes());
}

fn read_u32(input: &[u8], offset: usize) -> AppResult<u32> {
    ensure_len(input, offset, 4)?;
    Ok(u32::from_be_bytes(
        input[offset..offset + 4].try_into().unwrap(),
    ))
}

fn ensure_len(input: &[u8], offset: usize, len: usize) -> AppResult<()> {
    if input.len() < offset + len {
        return Err(AppError::Pipeline("volcengine response truncated".into()));
    }
    Ok(())
}

fn gzip(input: &[u8]) -> AppResult<Vec<u8>> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(input)?;
    encoder.finish().map_err(AppError::Io)
}

fn gunzip(input: &[u8]) -> AppResult<Vec<u8>> {
    let mut decoder = GzDecoder::new(input);
    let mut output = Vec::new();
    decoder.read_to_end(&mut output)?;
    Ok(output)
}

fn decode_payload(input: &[u8], compression: u8) -> AppResult<Vec<u8>> {
    match compression {
        COMPRESSION_NONE => Ok(input.to_vec()),
        COMPRESSION_GZIP => gunzip(input),
        other => Err(AppError::Pipeline(format!(
            "unsupported volcengine compression: {other}"
        ))),
    }
}

fn value_str(value: Option<&Value>) -> &str {
    value.and_then(Value::as_str).unwrap_or("")
}

fn value_i64(value: Option<&Value>) -> Option<i64> {
    value.and_then(Value::as_i64)
}

#[cfg(test)]
fn build_server_response_packet(payload: &Value) -> AppResult<Vec<u8>> {
    let compressed = gzip(&serde_json::to_vec(payload)?)?;
    let mut packet = header(
        MSG_FULL_SERVER_RESPONSE,
        FLAG_SEQUENCE_LAST,
        SERIAL_JSON,
        COMPRESSION_GZIP,
    );
    packet.extend_from_slice(&1_i32.to_be_bytes());
    append_u32(&mut packet, compressed.len());
    packet.extend_from_slice(&compressed);
    Ok(packet)
}

#[cfg(test)]
fn build_server_error_packet(code: u32, message: &str) -> Vec<u8> {
    let mut packet = header(MSG_SERVER_ERROR, FLAG_NONE, SERIAL_JSON, COMPRESSION_NONE);
    packet.extend_from_slice(&code.to_be_bytes());
    append_u32(&mut packet, message.len());
    packet.extend_from_slice(message.as_bytes());
    packet
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_request_uses_volcengine_nonstream_defaults() {
        let payload = build_full_request_payload("demo-uid");

        assert_eq!(payload["audio"]["format"], "wav");
        assert_eq!(payload["audio"]["codec"], "raw");
        assert_eq!(payload["audio"]["rate"], 16000);
        assert_eq!(payload["audio"]["channel"], 1);
        assert_eq!(payload["audio"]["language"], "zh-CN");
        assert_eq!(payload["request"]["model_name"], "bigmodel");
        assert_eq!(payload["request"]["enable_nonstream"], true);
        assert_eq!(payload["request"]["show_utterances"], true);
    }

    #[test]
    fn websocket_endpoint_matches_volcengine_sauc_demo() {
        assert_eq!(
            ENDPOINT,
            "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel"
        );
    }

    #[test]
    fn client_packets_use_big_endian_gzip_protocol() {
        let full_packet = build_full_client_packet(&serde_json::json!({"hello":"world"})).unwrap();
        assert_eq!(&full_packet[..4], &[0x11, 0x11, 0x11, 0x00]);
        assert_eq!(i32::from_be_bytes(full_packet[4..8].try_into().unwrap()), 1);
        assert_eq!(
            u32::from_be_bytes(full_packet[8..12].try_into().unwrap()) as usize,
            full_packet.len() - 12
        );

        let audio_packet = build_audio_packet(7, b"abc", false).unwrap();
        assert_eq!(&audio_packet[..4], &[0x11, 0x21, 0x01, 0x00]);
        assert_eq!(
            i32::from_be_bytes(audio_packet[4..8].try_into().unwrap()),
            7
        );

        let final_packet = build_audio_packet(8, b"abc", true).unwrap();
        assert_eq!(&final_packet[..4], &[0x11, 0x23, 0x01, 0x00]);
        assert_eq!(
            i32::from_be_bytes(final_packet[4..8].try_into().unwrap()),
            -8
        );
    }

    #[test]
    fn parses_server_response_and_maps_utterances_to_whisper_shape() {
        let response_json = serde_json::json!({
            "code": 0,
            "payload_msg": {
                "result": {
                    "text": "你好，世界。",
                    "utterances": [
                        {
                            "start_time": 120,
                            "end_time": 980,
                            "text": "你好，世界。",
                            "words": [
                                {"start_time": 120, "end_time": 400, "text": "你好"},
                                {"start_time": 420, "end_time": 980, "text": "世界"}
                            ]
                        }
                    ]
                }
            }
        });
        let packet = build_server_response_packet(&response_json).unwrap();

        let parsed = parse_server_message(&packet).unwrap();
        let transcript = parsed.into_transcript().unwrap();

        assert_eq!(transcript.transcription.len(), 1);
        assert_eq!(transcript.transcription[0].text, "你好，世界。");
        assert_eq!(transcript.transcription[0].offsets.from, 120);
        assert_eq!(transcript.transcription[0].offsets.to, 980);
        assert_eq!(transcript.transcription[0].tokens[1].text, "世界");
    }

    #[test]
    fn parses_server_error_message() {
        let packet = build_server_error_packet(45000001, "Invalid request parameters");

        let err = parse_server_message(&packet).unwrap_err();

        assert!(err.to_string().contains("45000001"));
        assert!(err.to_string().contains("Invalid request parameters"));
    }
}

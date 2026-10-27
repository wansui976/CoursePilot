#!/usr/bin/env python3
"""End-to-end availability check for Alibaba Cloud DashScope file ASR.

Usage:
    DASHSCOPE_API_KEY=sk-... python3 tools/aliyun-asr/check_aliyun_asr.py
    DASHSCOPE_API_KEY=sk-... python3 tools/aliyun-asr/check_aliyun_asr.py --audio lesson.mp3
    DASHSCOPE_API_KEY=sk-... python3 tools/aliyun-asr/check_aliyun_asr.py --model fun-asr

The script mirrors what the app does: read the audio, base64 it into a data URI,
submit an async transcription task, poll it, download the result JSON, and print
the transcript. It never prints the API key.

Requirements: Python 3.9+ and network access. No third-party packages.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

BASE_CN = "https://dashscope.aliyuncs.com/api/v1"
BASE_INTL = "https://dashscope-intl.aliyuncs.com/api/v1"
SAMPLE_URL = (
    "https://dashscope.oss-cn-beijing.aliyuncs.com/samples/audio/"
    "paraformer/hello_world_female2.wav"
)
MODELS = ("qwen3-asr-flash-filetrans", "fun-asr", "paraformer-v2")


def request(url: str, key: str, body: dict | None = None, timeout: int = 120):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {"Authorization": f"Bearer {key}"}
    if data is not None:
        headers["Content-Type"] = "application/json"
        headers["X-DashScope-Async"] = "enable"
    req = urllib.request.Request(url, data=data, headers=headers, method="POST" if data else "GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        raw = error.read()
        try:
            payload = json.loads(raw)
        except Exception:
            payload = raw[:400].decode("utf-8", "replace")
        return error.code, payload


def body_for(model: str, file_ref: str, language: str) -> dict:
    """Build the same request body the app builds for this model."""
    singular = "qwen3-asr" in model
    if singular:
        body = {"model": model, "input": {"file_url": file_ref}}
        params = {"enable_words": True}
        if language:
            params["language"] = language
    else:
        body = {"model": model, "input": {"file_urls": [file_ref]}}
        params = {"language_hints": [language]} if language else {}
    if params:
        body["parameters"] = params
    return body


def result_url(payload: dict) -> str | None:
    output = payload.get("output") or {}
    result = output.get("result") or {}
    if result.get("transcription_url"):
        return result["transcription_url"]
    for item in output.get("results") or []:
        if item.get("transcription_url"):
            return item["transcription_url"]
    return None


def run_one(model: str, audio_bytes: bytes, mime: str, key: str, base: str,
            language: str, timeout: int, upload_timeout: int, use_url: bool) -> dict:
    print(f"\n=== {model} ===")
    if use_url:
        file_ref = SAMPLE_URL
        print(f"input: public URL {SAMPLE_URL}")
    else:
        file_ref = f"data:{mime};base64," + base64.b64encode(audio_bytes).decode("ascii")
        print(f"input: data URI, {len(audio_bytes) / 1024:.1f} KiB audio -> "
              f"{len(file_ref) / 1024:.1f} KiB request field")
    body = body_for(model, file_ref, language)

    started = time.time()
    status, payload = request(f"{base}/services/audio/asr/transcription", key, body,
                              timeout=upload_timeout)
    print(f"submit: HTTP {status} in {time.time() - started:.2f}s")
    if status != 200:
        print("response:", json.dumps(payload, ensure_ascii=False)[:600])
        return {"model": model, "ok": False, "stage": "submit", "http": status}

    task_id = ((payload or {}).get("output") or {}).get("task_id")
    if not task_id:
        print("response:", json.dumps(payload, ensure_ascii=False)[:600])
        return {"model": model, "ok": False, "stage": "submit (no task_id)"}

    deadline = time.time() + timeout
    task = None
    while time.time() < deadline:
        time.sleep(3)
        status, task = request(f"{base}/tasks/{task_id}", key, timeout=60)
        state = ((task or {}).get("output") or {}).get("task_status")
        print(f"poll: HTTP {status} {state}")
        if state in ("SUCCEEDED", "FAILED", "UNKNOWN", "CANCELED"):
            break
    else:
        print(f"poll: timeout after {timeout}s")
        return {"model": model, "ok": False, "stage": "poll timeout"}

    if state != "SUCCEEDED":
        output = (task or {}).get("output") or {}
        print(f"error: {output.get('code')} {output.get('message')}")
        return {"model": model, "ok": False, "stage": state, "code": output.get("code")}

    url = result_url(task or {})
    if not url:
        print("error: no transcription_url in task")
        return {"model": model, "ok": False, "stage": "result URL"}

    status, result = request(url, key, timeout=120)
    print(f"result: HTTP {status}")
    if status != 200:
        return {"model": model, "ok": False, "stage": "result download", "http": status}

    transcripts = (result or {}).get("transcripts") or []
    text = " ".join((t.get("text") or "").strip() for t in transcripts).strip()
    sentences = sum(len(t.get("sentences") or []) for t in transcripts)
    words = sum(
        len(s.get("words") or [])
        for t in transcripts
        for s in (t.get("sentences") or [])
    )
    print(f"transcript: {text[:300] or '<empty>'}")
    print(f"segments: {sentences}, word tokens: {words}")
    ok = bool(text)
    return {"model": model, "ok": ok, "stage": "done", "text": text,
            "sentences": sentences, "words": words, "seconds": time.time() - started}


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--audio", help="local audio file (default: download Aliyun's public sample)")
    parser.add_argument("--mime", default="audio/wav", help="MIME type for --audio (default: audio/wav)")
    parser.add_argument("--model", action="append", choices=MODELS,
                        help="model to test; repeatable (default: all three)")
    parser.add_argument("--language", default="zh", help="language hint (default: zh; empty to omit)")
    parser.add_argument("--timeout", type=int, default=300, help="poll timeout in seconds (default: 300)")
    parser.add_argument("--upload-timeout", type=int, default=600,
                        help="HTTP timeout for the submit request in seconds (default: 600)")
    parser.add_argument("--intl", action="store_true", help="use the Singapore endpoint/key")
    parser.add_argument("--url-mode", action="store_true", help="submit a public URL instead of a data URI")
    args = parser.parse_args()

    key = os.environ.get("DASHSCOPE_API_KEY", "").strip()
    if not key:
        print("DASHSCOPE_API_KEY is not set", file=sys.stderr)
        return 2
    base = BASE_INTL if args.intl else BASE_CN
    models = args.model or list(MODELS)

    if args.url_mode:
        audio, mime = b"", args.mime
    elif args.audio:
        path = Path(args.audio)
        if not path.is_file():
            print(f"audio not found: {path}", file=sys.stderr)
            return 2
        audio, mime = path.read_bytes(), args.mime
    else:
        print(f"downloading sample: {SAMPLE_URL}")
        try:
            with urllib.request.urlopen(SAMPLE_URL, timeout=60) as response:
                audio = response.read()
        except Exception as error:  # noqa: BLE001 - the sample is only a convenience
            print(f"could not download the sample: {type(error).__name__}: {error}", file=sys.stderr)
            print("pass --audio <file> to test a local file instead", file=sys.stderr)
            return 2
        mime = "audio/wav"

    print(f"endpoint: {base}")
    print(f"key: {key[:3]}… (redacted), {len(key)} chars")
    results = []
    for model in models:
        try:
            results.append(run_one(model, audio, mime, key, base,
                                   args.language, args.timeout, args.upload_timeout,
                                   args.url_mode))
        except Exception as error:  # noqa: BLE001 - report and continue with other models
            print(f"failed: {type(error).__name__}: {error}")
            results.append({"model": model, "ok": False, "stage": type(error).__name__})

    print("\n=== summary ===")
    for item in results:
        mark = "PASS" if item["ok"] else "FAIL"
        detail = item.get("code") or item.get("http") or item.get("stage") or ""
        print(f"{mark:4}  {item['model']:32} {detail}")
    return 0 if all(item["ok"] for item in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())

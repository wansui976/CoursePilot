"""给 src-tauri/src/llm/model_catalog.json 补上「命中前缀缓存的输入」单价（cache_read，USD / 百万 token）。

用量统计按价格估算花费：DeepSeek 命中缓存的输入只收 2%，本应用几个产物共用同一份讲稿前缀、
缓存命中率很高——不算缓存价的话，估出来的花费会比账单高好几倍。

保守起见：
- 只认 LiteLLM 里键名和目录里**完全一致**的条目（不按后缀匹配：`azure_ai/kimi-k2.6`、
  `coralbricks/glm-5.3` 这类转售商的价格和官方不同，有的还写成 0）；
- 只补 cache_read，已有的上下文、输入 / 输出单价一律不动（调价要单独核对）；
- 价格为 0 或缺失的不写——那是「不知道」，不是「免费」。

用法：python3 scripts/catalog-add-cache-price.py
"""
import datetime
import json
import urllib.request
from pathlib import Path

URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"
CATALOG = Path(__file__).resolve().parents[1] / "src-tauri/src/llm/model_catalog.json"

litellm = json.load(urllib.request.urlopen(URL, timeout=60))
catalog = json.loads(CATALOG.read_text(encoding="utf-8"))
added = 0
for key, entry in catalog["models"].items():
    price = (litellm.get(key) or {}).get("cache_read_input_token_cost")
    if isinstance(price, (int, float)) and price > 0:
        entry["cache_read"] = round(price * 1_000_000, 6)
        added += 1
catalog["meta"]["cacheReadFetchedAt"] = datetime.date.today().isoformat()
catalog["meta"]["note"] = (
    catalog["meta"]["note"].split(" cache_read")[0]
    + " cache_read = price for prompt tokens served from the provider's prefix cache (exact-key matches only)."
)
CATALOG.write_text(json.dumps(catalog, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
print(f"cache_read added for {added} of {len(catalog['models'])} models")

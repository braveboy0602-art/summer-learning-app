#!/usr/bin/env python3
"""用 DeepSeek API 把 Cambridge 例句改写成初一难度并配中文翻译

输入：data/cambridge_7a.json（词 + 原例句）
输出：examples 升级为 [{"en": "...", "zh": "..."}] 结构（每词 3 条）
特殊处理：go by 保留用户手动改动，不处理
断点续跑：已处理的词自动跳过
"""
import json
import os
import re
import sys
import time

import requests

API_URL = "https://api.deepseek.com/anthropic/v1/messages"
MODEL = "deepseek-chat"
SKIP_WORDS = set()  # 脚本只改写 examples 字段，其余字段（含用户手动改动）不受影响

PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))
OUT_JSON = os.path.join(PROJECT_ROOT, "data", "cambridge_7a.json")
DETAIL_JSON = os.path.join(PROJECT_ROOT, "data", "word_details_7a.json")
INPUT_JSON = os.path.join(PROJECT_ROOT, "data", "junior_vocabulary7A.json")

# 从 Claude Code 配置读取 DeepSeek API key（不打印）
def load_api_key():
    cfg_path = os.path.expanduser("~/.claude/settings.json")
    with open(cfg_path, encoding="utf-8") as f:
        cfg = json.load(f)
    return cfg.get("env", {}).get("ANTHROPIC_AUTH_TOKEN", "")


def get_cn(word):
    """查词的中文释义（word_details 优先，缺则用 7A 词汇表）"""
    try:
        with open(DETAIL_JSON, encoding="utf-8") as f:
            details = json.load(f).get("words", {})
        if word.lower() in details and details[word.lower()].get("cn"):
            return details[word.lower()]["cn"]
    except Exception:
        pass
    try:
        with open(INPUT_JSON, encoding="utf-8") as f:
            vocab = json.load(f)
        for group in vocab["subjects"]["english"]["groups"]:
            for cat in group.get("categories", []):
                for w in cat.get("words", []):
                    if w["en"].lower() == word.lower() and w.get("cn"):
                        return w["cn"]
    except Exception:
        pass
    return ""


def build_prompt(word, cn, examples):
    if examples:
        lines = "\n".join(f"{i+1}. {ex}" for i, ex in enumerate(examples))
        task = "请把下面的英语例句改写成适合初一新生（刚学英语一年左右）的简单句子。"
        req = "1. 保留每条例句的核心意思，单词 \"" + word + "\" 必须出现在改写后的句子中（允许 s/es/ed/ing 变形）"
        source = "原例句:\n" + lines
    else:
        task = f"请根据单词释义，为初一新生（刚学英语一年左右）造 3 条简单英语例句。"
        req = f"1. 单词 \"{word}\" 必须出现在每条例句中（允许 s/es/ed/ing 变形），例句要体现单词的含义"
        source = ""
    return f"""你是中国初中英语老师。{task}

要求：
{req}
2. 词汇用初一学生已学的简单词，句子简短（不超过 12 个单词）
3. 每条附上自然、准确的中文翻译
4. 输出严格为 JSON 数组（不要输出任何其他文字、不要 markdown 代码块），格式：
[{{"en": "英文句子", "zh": "中文翻译"}}, ...] 共 3 条

单词: {word}（{cn}）
{source}"""


def parse_response(text):
    """从 API 回复中提取 JSON 数组（容错 markdown 围栏）"""
    t = text.strip()
    t = re.sub(r"^```(?:json)?\s*|\s*```$", "", t, flags=re.S)
    try:
        return json.loads(t)
    except json.JSONDecodeError:
        m = re.search(r"\[.*\]", t, re.S)
        if m:
            return json.loads(m.group(0))
    return None


def call_api(word, cn, examples, api_key):
    prompt = build_prompt(word, cn, examples)
    resp = requests.post(
        API_URL,
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        json={
            "model": MODEL,
            "max_tokens": 1500,
            "messages": [{"role": "user", "content": prompt}],
        },
        timeout=60,
    )
    if resp.status_code != 200:
        raise RuntimeError(f"API HTTP {resp.status_code}: {resp.text[:200]}")
    data = resp.json()
    text = data["content"][0]["text"]
    parsed = parse_response(text)
    if not parsed or not isinstance(parsed, list) or not parsed:
        raise RuntimeError(f"解析失败: {text[:200]}")
    # 规范化：只保留 en/zh 字段，去重
    out = []
    seen = set()
    for item in parsed:
        en = str(item.get("en", "")).strip()
        zh = str(item.get("zh", "")).strip()
        if en and en.lower() not in seen:
            seen.add(en.lower())
            out.append({"en": en, "zh": zh})
    if len(out) < 3:
        raise RuntimeError(f"只生成了 {len(out)} 条")
    return out[:3]


def main():
    api_key = load_api_key()
    if not api_key:
        print("❌ 未找到 API key（~/.claude/settings.json）")
        sys.exit(1)

    with open(OUT_JSON, encoding="utf-8") as f:
        data = json.load(f)
    words = data["words"]

    todo = [w for w in words if w not in SKIP_WORDS
            and (not isinstance(words[w].get("examples"), list)
                 or not words[w]["examples"]
                 or not isinstance(words[w]["examples"][0], dict))]
    done = [w for w, e in words.items() if isinstance(e.get("examples"), list)
            and e["examples"] and isinstance(e["examples"][0], dict)]
    print(f"总词数 {len(words)}，需处理 {len(todo)}（含无例句造句），已完成 {len(done)}（断点续跑）", flush=True)

    stats = {"ok": 0, "fail": 0}
    failures = []

    for i, word in enumerate(todo, 1):
        cn = get_cn(word)
        old_examples = words[word].get("examples") if isinstance(words[word].get("examples"), list) else []
        if old_examples and isinstance(old_examples[0], dict):
            continue  # 已处理（结构化）

        for attempt in range(3):
            try:
                new_examples = call_api(word, cn, old_examples, api_key)
                words[word]["examples"] = new_examples
                stats["ok"] += 1
                print(f"[{i}/{len(todo)}] ok {word}: {new_examples[0]['en'][:40]}", flush=True)
                break
            except Exception as e:
                if attempt == 2:
                    stats["fail"] += 1
                    failures.append(word)
                    print(f"[{i}/{len(todo)}] ❌ {word}: {e}", flush=True)
                else:
                    time.sleep(2 * (attempt + 1))

        # 每 20 词落盘一次
        if i % 20 == 0:
            with open(OUT_JSON, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            print(f"  （已保存进度 {i}/{len(todo)}）", flush=True)

        time.sleep(0.6)  # 限速

    data["meta"]["examples_source"] = "deepseek 改写（初一难度）+ 中文翻译"
    data["meta"]["examples_ok"] = stats["ok"]
    data["meta"]["examples_fail"] = stats["fail"]
    with open(OUT_JSON, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    print(f"\n✅ 完成：成功 {stats['ok']}，失败 {stats['fail']}")
    if failures:
        print(f"失败词: {failures}")


if __name__ == "__main__":
    main()

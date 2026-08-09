#!/usr/bin/env python3
"""抓取 dictionary.cambridge.org 的音标、例句、发音音频

数据来源：data/junior_vocabulary7A.json 的 7A 词汇表
输出：
  - data/cambridge_7a.json  （音标/例句/音频 URL，查不到的词字段为 null）
  - audio/<单词>_uk.mp3 / <单词>_us.mp3  （发音音频文件）

支持断点续跑：中断后重新运行，已处理的词自动跳过。
"""
import json
import os
import re
import sys
import time

import requests

BASE_URL = "https://dictionary.cambridge.org/dictionary/english"
HEADERS = {
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"),
    "Accept-Language": "en-US,en;q=0.9",
}
PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))
INPUT_JSON = os.path.join(PROJECT_ROOT, "data", "junior_vocabulary7A.json")
OUT_JSON = os.path.join(PROJECT_ROOT, "data", "cambridge_7a.json")
AUDIO_DIR = os.path.join(PROJECT_ROOT, "audio")
PROGRESS_FILE = os.path.join(PROJECT_ROOT, "data", ".cambridge_progress.json")

MAX_EXAMPLES = 3          # 每词取 3 条例句
SLEEP_BETWEEN = 1.5       # 每词间隔秒数（限速）
MAX_RETRY = 3             # 失败重试次数


def extract_words():
    """从 7A 词汇表提取单词列表（保持原顺序，去重）"""
    with open(INPUT_JSON, encoding="utf-8") as f:
        data = json.load(f)
    words = []
    seen = set()
    for group in data["subjects"]["english"]["groups"]:
        for cat in group.get("categories", []):
            for w in cat.get("words", []):
                en = w["en"].strip()
                key = en.lower()
                if key not in seen:
                    seen.add(key)
                    words.append(en)
    return words


def safe_filename(word):
    """单词名 → 安全文件名（空格和特殊字符转下划线）"""
    name = re.sub(r"[^a-z0-9]+", "_", word.lower()).strip("_")
    return name or "word"


def normalize_phrase(s):
    """词组比较用：小写、去掉省略号占位（如 take ... apart）、压缩空白"""
    return re.sub(r"\s+", " ", s.replace("...", "").replace("…", "").strip().lower())


def phrase_has_own_pron(word, html):
    """词组（含空格的词）页面上是否有该词组自己的发音块。

    Cambridge 对没有独立发音的词组会：
      - 只标词组里某个单词的发音（put up 页面标题词是 put，发音只有 pʊt）
      - 或页面的发音属于其他词条（per cent → percent positive、sports field → collocation 页）
    检测：页面第一个标题词(hw dhw)必须与词组一致，且出现在第一个发音块(dpron-i)之前。
    不满足时整条置 null，避免抓错音标/音频。
    """
    if " " not in word:
        return True
    hw = re.search(r'class="hw dhw"[^>]*>([^<]*)<', html)
    dp = re.search(r'class="(?:uk|us) dpron-i[^"]*"', html)
    if not hw or not dp:
        return False
    return normalize_phrase(hw.group(1)) == normalize_phrase(word) and hw.start() < dp.start()


def parse_entry(html):
    """从词条 HTML 解析音标/音频/例句。

    页面结构：每个发音区块 <span class="uk dpron-i">...</span> / <span class="us dpron-i">...</span>
    内含 .ipa 音标和 <source type="audio/mpeg" src="..."/> 音频。
    例句在 <div class="examp dexamp">...</div> 内。
    """
    result = {"phonetic_uk": None, "phonetic_us": None,
              "audio_uk": None, "audio_us": None, "examples": None}

    # 按 dpron-i 块提取（uk/us 各取第一个；class 值末尾可能带空格，用正则）
    for marker, key_ph, key_au in (("uk", "phonetic_uk", "audio_uk"),
                                   ("us", "phonetic_us", "audio_us")):
        m = re.search(rf'class="{marker} dpron-i[^"]*"', html)
        if not m:
            continue
        idx = m.end()
        nxt = html.find("dpron-i", idx)
        if nxt == -1:
            # 这是页面最后一个 dpron-i 块（音标+音频都在块开头，取 2500 字符足够）
            block = html[idx:idx + 2500]
        else:
            block = html[idx:nxt + len("dpron-i") + 40]
        # 音标：块内第一个 .ipa 文本。
        # Cambridge 会把部分字母包进嵌套 <span class="sp dsp">（如 ˈnætʃ.<span>ə</span>r.<span>ə</span>l），
        # 不能只取到第一个标签为止，需按 span 嵌套深度取完整内容再去标签。
        ipa = None
        m = re.search(r'class="ipa[^"]*"[^>]*>', block)
        if m:
            start = m.end()
            depth, i = 1, start
            while i < len(block) and depth > 0:
                if block.startswith("<span", i):
                    depth += 1
                    i += 5
                elif block.startswith("</span>", i):
                    depth -= 1
                    i += 7
                else:
                    i += 1
            ipa = re.sub(r"<[^>]+>", "", block[start:i]).strip()
        if ipa:
            result[key_ph] = ipa
        # 音频：块内第一个 mp3 src
        src = re.search(r'<source type="audio/mpeg" src="([^"]+)"', block)
        if src:
            result[key_au] = src.group(1)

    # 例句：匹配所有 class 含 "examp" 的元素（含 "More examples" 折叠区的 li.eg.dexamp）
    examples = []
    for m in re.finditer(r'class="[^"]*examp[^"]*"[^>]*>(.*?)</(?:div|li)>', html, re.S):
        text = re.sub(r"<[^>]+>", "", m.group(1))
        text = text.replace("​", "").strip()
        if text and text not in examples:
            examples.append(text)
        if len(examples) >= MAX_EXAMPLES:
            break
    if examples:
        result["examples"] = examples

    return result


def fetch_word(word, session):
    """抓取单个词。

    返回：
      - (entry_dict, html)  正常解析结果
      - (None, None)        页面不存在（404）
      - ("phrase_no_pron", html)  词组页面只标了部分单词发音，整条置 null
      - ("error", None)     限流/网络等重试仍失败（不标记结果，下次运行重试）
    """
    url = f"{BASE_URL}/{word.replace(' ', '-')}"
    last_err = None
    for attempt in range(MAX_RETRY):
        try:
            resp = session.get(url, timeout=30)
            if resp.status_code == 200:
                if not phrase_has_own_pron(word, resp.text):
                    return "phrase_no_pron", resp.text
                return parse_entry(resp.text), resp.text
            if resp.status_code == 404:
                return None, None  # 页面不存在 = 查不到
            last_err = f"HTTP {resp.status_code}"
        except requests.RequestException as e:
            last_err = str(e)
        time.sleep(2 * (attempt + 1))
    print(f"  ⚠️ {word}: 重试仍失败 ({last_err})", flush=True)
    return "error", None


def download_audio(session, path, mp3_src):
    """下载单个音频，返回是否成功"""
    if not mp3_src:
        return False
    url = mp3_src if mp3_src.startswith("http") else f"https://dictionary.cambridge.org{mp3_src}"
    try:
        resp = session.get(url, timeout=30)
        if resp.status_code == 200:
            with open(path, "wb") as f:
                f.write(resp.content)
            return True
    except requests.RequestException:
        pass
    return False


def save_progress(result, stats, missing, phrase_no_pron_list):
    """保存结果到输出文件（供断点续跑和周期落盘）"""
    meta = {
        "source": "dictionary.cambridge.org",
        "scraped_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "total": len(extract_words()),
        "found": stats["found"],
        "null": stats["null"],
        "phrase_no_pron": stats["phrase_no_pron"],
        "audio_downloaded": stats["audio_downloaded"],
        "audio_failed": stats["audio_failed"],
        "missing": missing,
        "phrase_no_pron_list": phrase_no_pron_list,
    }
    with open(OUT_JSON, "w", encoding="utf-8") as f:
        json.dump({"meta": meta, "words": result}, f, ensure_ascii=False, indent=2)
    with open(PROGRESS_FILE, "w", encoding="utf-8") as f:
        json.dump({"done": sorted(result.keys())}, f)


def main():
    words = extract_words()
    print(f"共 {len(words)} 个词", flush=True)

    # 断点续跑：加载已有结果和进度
    result = {}
    if os.path.exists(OUT_JSON):
        with open(OUT_JSON, encoding="utf-8") as f:
            result = json.load(f).get("words", {})
    done = set(result.keys())
    print(f"已完成 {len(done)} 个词（断点续跑）", flush=True)

    os.makedirs(os.path.join(PROJECT_ROOT, "data"), exist_ok=True)
    os.makedirs(AUDIO_DIR, exist_ok=True)

    session = requests.Session()
    session.headers.update(HEADERS)

    stats = {"found": 0, "null": 0, "phrase_no_pron": 0,
             "audio_downloaded": 0, "audio_failed": 0}
    missing = []
    phrase_no_pron_list = []

    try:
        for i, word in enumerate(words, 1):
            if word in done:
                continue
            entry, html = fetch_word(word, session)
            if entry == "error":
                # 限流/网络等重试仍失败：不写结果、不标记 missing，下次运行会重试
                print(f"  ⏭️ {word}: 本次跳过（重试仍失败），下次运行会重试", flush=True)
                continue
            if entry == "phrase_no_pron":
                # 词组页面只标了部分单词发音（或发音属其他词条），整条置 null
                entry = {"phonetic_uk": None, "phonetic_us": None,
                         "audio_uk": None, "audio_us": None, "examples": None}
                phrase_no_pron_list.append(word)
                stats["phrase_no_pron"] += 1
                tag = "PHR-NO-PRON"
            elif entry is None or all(v is None for v in entry.values()):
                # 页面 404 或 200 但无任何内容（如搜索首页）都视为未找到
                entry = {"phonetic_uk": None, "phonetic_us": None,
                         "audio_uk": None, "audio_us": None, "examples": None}
                missing.append(word)
                stats["null"] += 1
                tag = "NULL"
            else:
                stats["found"] += 1
                tag = "ok"

            # 下载音频（查到的词才有）
            if entry["audio_uk"] or entry["audio_us"]:
                for variant, key in (("uk", "audio_uk"), ("us", "audio_us")):
                    src = entry[key]
                    if not src:
                        continue
                    fname = f"{safe_filename(word)}_{variant}.mp3"
                    path = os.path.join(AUDIO_DIR, fname)
                    if os.path.exists(path):
                        stats["audio_downloaded"] += 1
                        continue
                    if download_audio(session, path, src):
                        stats["audio_downloaded"] += 1
                    else:
                        stats["audio_failed"] += 1
                        print(f"  ⚠️ 音频下载失败: {fname}", flush=True)

            result[word] = entry
            done.add(word)

            # 每 20 词落盘一次，中断不丢进度
            if i % 20 == 0:
                save_progress(result, stats, missing, phrase_no_pron_list)
            if i % 10 == 0 or i == len(words):
                print(f"[{i}/{len(words)}] {tag} {word}", flush=True)

            time.sleep(SLEEP_BETWEEN)
    finally:
        # 无论中断与否都保存进度
        save_progress(result, stats, missing, phrase_no_pron_list)
        print(f"\n✅ 已保存: {OUT_JSON}")
        print(f"   找到 {stats['found']} / 未找到 {stats['null']} / 词组无独立发音 {stats['phrase_no_pron']} / 音频下载 {stats['audio_downloaded']}（失败 {stats['audio_failed']}）")
        print(f"   未找到清单: {missing}")
        print(f"   词组无独立发音清单: {phrase_no_pron_list}")


if __name__ == "__main__":
    main()

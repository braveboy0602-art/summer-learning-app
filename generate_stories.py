#!/usr/bin/env python3
"""用 DeepSeek API 为每个词汇分类生成「AI 精选故事」

输入：data/ 下的英语分组词汇文件（primary / junior 系列）
输出：data/stories/{groupId}.json（每个分组一个文件）

规则：
- 每篇故事使用 15~25 个单词；小分类 1 篇，大分类拆多篇（篇间不重复，合并后覆盖全部分类单词）
- 多词短语/固定句式要求原样出现
- 生成后自动校验覆盖（支持常见变形），漏词自动重试一次
- 断点续跑：已完整覆盖的分类自动跳过

用法：
  python3 generate_stories.py                          # 全量生成所有英语分组
  python3 generate_stories.py primary_vocabulary.json  # 只生成指定文件
  python3 generate_stories.py --categories colors,actions data/primary_vocabulary.json
"""
import argparse
import glob
import json
import os
import re
import sys
import time

import requests

API_URL = "https://api.deepseek.com/anthropic/v1/messages"
MODEL = "deepseek-chat"

PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(PROJECT_ROOT, "data")
STORIES_DIR = os.path.join(DATA_DIR, "stories")

# 每篇故事的单词量目标区间
TARGET_PER_STORY = 20
MIN_PER_STORY = 12
MAX_PER_STORY = 28

# ---------- 常见不规则变形（小学词汇覆盖） ----------
IRREGULAR = {
    # 动词：原形 -> 过去式/过去分词/现在分词/三单
    "go": {"went", "gone", "going", "goes"},
    "run": {"ran", "running"},
    "see": {"saw", "seen", "seeing"},
    "eat": {"ate", "eaten", "eating"},
    "take": {"took", "taken", "taking"},
    "make": {"made", "making"},
    "have": {"had", "having", "has"},
    "do": {"did", "done", "doing", "does"},
    "say": {"said", "saying", "says"},
    "get": {"got", "getting", "gotten"},
    "come": {"came", "coming"},
    "give": {"gave", "given", "giving"},
    "find": {"found", "finding"},
    "think": {"thought", "thinking"},
    "tell": {"told", "telling"},
    "become": {"became", "becoming", "becomes"},
    "feel": {"felt", "feeling"},
    "keep": {"kept", "keeping"},
    "know": {"knew", "known", "knowing"},
    "leave": {"left", "leaving"},
    "meet": {"met", "meeting"},
    "put": {"put", "putting"},
    "read": {"read", "reading"},
    "sit": {"sat", "sitting"},
    "sleep": {"slept", "sleeping"},
    "speak": {"spoke", "spoken", "speaking"},
    "stand": {"stood", "standing"},
    "teach": {"taught", "teaching"},
    "understand": {"understood", "understanding"},
    "write": {"wrote", "written", "writing"},
    "buy": {"bought", "buying"},
    "bring": {"brought", "bringing"},
    "catch": {"caught", "catching"},
    "fly": {"flew", "flown", "flying"},
    "draw": {"drew", "drawn", "drawing"},
    "drive": {"drove", "driven", "driving"},
    "grow": {"grew", "grown", "growing"},
    "sing": {"sang", "sung", "singing"},
    "swim": {"swam", "swum", "swimming"},
    "begin": {"began", "begun", "beginning"},
    "drink": {"drank", "drunk", "drinking"},
    "throw": {"threw", "thrown", "throwing"},
    "wear": {"wore", "worn", "wearing"},
    "win": {"won", "winning"},
    "lose": {"lost", "losing"},
    "break": {"broke", "broken", "breaking"},
    "choose": {"chose", "chosen", "choosing"},
    "cut": {"cut", "cutting"},
    "hit": {"hit", "hitting"},
    "hurt": {"hurt", "hurting"},
    "let": {"let", "letting"},
    "lend": {"lent", "lending"},
    "pay": {"paid", "paying"},
    "sell": {"sold", "selling"},
    "send": {"sent", "sending"},
    "spend": {"spent", "spending"},
    "build": {"built", "building"},
    "hear": {"heard", "hearing"},
    "hold": {"held", "holding"},
    "fall": {"fell", "fallen", "falling"},
    "feed": {"fed", "feeding"},
    "fight": {"fought", "fighting"},
    "hide": {"hid", "hidden", "hiding"},
    "shake": {"shook", "shaken", "shaking"},
    "smell": {"smelt", "smelled", "smelling"},
    "spell": {"spelt", "spelled", "spelling"},
    "ride": {"rode", "ridden", "riding"},
    "steal": {"stole", "stolen", "stealing"},
    "wake": {"woke", "woken", "waking"},
    "beat": {"beat", "beaten", "beating"},
    "blow": {"blew", "blown", "blowing"},
    "forget": {"forgot", "forgotten", "forgetting"},
    "freeze": {"froze", "frozen", "freezing"},
    "hang": {"hung", "hanging"},
    "lie": {"lay", "lain", "lying"},
    "light": {"lit", "lighting"},
    "shine": {"shone", "shining"},
    "shoot": {"shot", "shooting"},
    "show": {"showed", "shown", "showing"},
    "spread": {"spread", "spreading"},
    "stick": {"stuck", "sticking"},
    "strike": {"struck", "striking"},
    "sweep": {"swept", "sweeping"},
    "swing": {"swung", "swinging"},
    "tear": {"tore", "torn", "tearing"},
    "burst": {"burst", "bursting"},
    "cost": {"cost", "costing"},
    "dig": {"dug", "digging"},
    "lead": {"led", "leading"},
    "rise": {"rose", "risen", "rising"},
    "set": {"set", "setting"},
    # 名词不规则复数
    "child": {"children"},
    "man": {"men"},
    "woman": {"women"},
    "foot": {"feet"},
    "tooth": {"teeth"},
    "mouse": {"mice"},
    "person": {"people"},
    "goose": {"geese"},
    "sheep": {"sheep"},
    "fish": {"fish"},
}

# 双写规则：辅音结尾单音节，双写尾字母再加 ed/ing（run→running 已在上表，这里兜底常见词）
DOUBLE_CONSONANT = {
    "stop", "shop", "plan", "drop", "begin", "clap", "skip", "nod", "rub", "tap",
    "mop", "jog", "wrap", "spot", "hop", "trip", "drag", "snap", "beg", "pat",
}


def load_api_key():
    """从 Claude Code 配置读取 DeepSeek API key（与 generate_examples.py 一致，不打印）"""
    cfg_path = os.path.expanduser("~/.claude/settings.json")
    with open(cfg_path, encoding="utf-8") as f:
        cfg = json.load(f)
    return cfg.get("env", {}).get("ANTHROPIC_AUTH_TOKEN", "")


def is_phrase(en):
    """多词短语/固定句式（含空格）"""
    return " " in en.strip()


def word_variants(w):
    """生成单词的常见变形候选集合（用于覆盖校验）"""
    w = w.lower()
    v = {w}
    v |= IRREGULAR.get(w, set())
    # 规则变形
    v.add(w + "s")
    v.add(w + "es")
    v.add(w + "ed")
    v.add(w + "d")
    v.add(w + "ing")
    # 注意：不加 er/est —— "singer" 会误判为用了 "sing"，校验必须严格
    # 比较级/最高级（nicer/biggest）由重试提示兜底，让 AI 显式使用原形
    # 辅音+y 结尾 → ies / ied
    if w.endswith("y") and len(w) > 2 and w[-2] not in "aeiou":
        v.add(w[:-1] + "ies")
        v.add(w[:-1] + "ied")
    # 双写尾字母 + ed/ing（如 stopped, shopping）
    if w in DOUBLE_CONSONANT:
        v.add(w + w[-1] + "ed")
        v.add(w + w[-1] + "ing")
    return v


# 常见缩略词 → 完整形式（匹配前两侧统一展开）
CONTRACTIONS = {
    "you're": "you are", "i'm": "i am", "we're": "we are", "they're": "they are",
    "it's": "it is", "what's": "what is", "that's": "that is", "there's": "there is",
    "he's": "he is", "she's": "she is", "here's": "here is",
    "don't": "do not", "doesn't": "does not", "didn't": "did not",
    "can't": "cannot", "won't": "will not", "isn't": "is not", "aren't": "are not",
    "wasn't": "was not", "weren't": "were not", "haven't": "have not",
    "hasn't": "has not", "i'll": "i will", "we'll": "we will", "he'll": "he will",
    "she'll": "she will", "they'll": "they will", "let's": "let us",
    "i've": "i have", "we've": "we have", "they've": "they have", "you've": "you have",
    "couldn't": "could not", "shouldn't": "should not", "wouldn't": "would not",
}


def _tok(text):
    """文本 -> 小写单词 token 列表。

    缩略词统一展开为完整形式（What's → what is，You're → you are），
    短语与正文两侧规则一致，两种写法都能匹配上。
    """
    # 撇号保留在 token 里：先查缩略词表展开（you're → you are），再拆开
    tokens = re.findall(r"[a-z0-9']+", text.lower())
    out = []
    for t in tokens:
        if t in CONTRACTIONS:
            out.extend(CONTRACTIONS[t].split())
        else:
            out.append(t)
    return out


def check_word_in_text(word, text):
    """单词是否在文本中出现（支持变形），整词匹配。

    注意：词汇表里 "Sorry." / "Danger!" 这类词条自带句末标点，
    校验前先剥掉（正文里可能是 "Sorry," 或 "sorry" 等写法）。
    """
    base = word.strip().rstrip('.,!?;:()\'"')
    if not base:
        return False
    variants = [re.escape(v) for v in sorted(word_variants(base), key=len, reverse=True)]
    pattern = r"\b(?:" + "|".join(variants) + r")\b"
    return re.search(pattern, text.lower()) is not None


def check_phrase_in_text(phrase, text):
    """多词短语是否在文本中出现。

    校验策略（宽松窗口匹配）：短语各词按顺序出现，允许常见变形
    （get up → gets up / got up），词间最多隔 1 个词（容忍插入冠词等）。
    """
    phrase_words = _tok(phrase)
    if not phrase_words:
        return False
    text_words = _tok(text)
    if len(phrase_words) > len(text_words):
        return False
    max_gap = 1  # 短语词之间最多容忍 1 个插入词
    for start in range(len(text_words) - len(phrase_words) + 1):
        idx = start
        ok = True
        for pw in phrase_words:
            if idx >= len(text_words):
                ok = False
                break
            variants = word_variants(pw)
            if text_words[idx] in variants:
                idx += 1
                continue
            # 尝试跳过一个插入词
            if idx + 1 < len(text_words) and text_words[idx + 1] in variants and max_gap >= 1:
                idx += 2
                continue
            ok = False
            break
        if ok:
            return True
    return False


def build_batches(words, target=TARGET_PER_STORY):
    """把单词拆成多批：小分类 1 批，大分类拆多批（顺序切分，篇间不重复）"""
    n_stories = max(1, -(-len(words) // target))
    batch_size = -(-len(words) // n_stories)  # ceil
    batches = [words[i:i + batch_size] for i in range(0, len(words), batch_size)]
    # 最后一批过小时并入上一批（保证每批不至于只有几个词）
    if len(batches) > 1 and len(batches[-1]) < MIN_PER_STORY:
        last = batches.pop()
        batches[-1].extend(last)
    return batches


def build_outline_prompt(category_name, level_desc, batch, phrases):
    """阶段 1：构思故事大纲（核心线索先行，防止 AI 按单词表写流水账）"""
    word_lines = "\n".join(f"{w['en']}（{w['cn']}）" for w in batch)
    phrase_lines = "\n".join(f'"{p["en"]}"（{p["cn"]}）' for p in phrases)
    phrase_req = ("另有固定短语/句式，大纲里要为它们留出自然出现的位置（多为对话用语）：\n"
                  + phrase_lines + "\n") if phrases else ""

    return f"""你是中国小学英语老师，为 {level_desc} 的孩子写英语小故事。请先构思故事大纲，先不要写正文。

【词汇分类：{category_name}】
故事中必须用到以下单词（可用常见变形：三单/过去式/进行时/复数）：
{word_lines}
{phrase_req}
大纲要求：
1. 核心线索：故事必须围绕【一个明确的目标或小麻烦】展开（例如：找丢失的东西、帮小动物回家、准备惊喜、赢得比赛、发现一个秘密、实现一个小愿望）。所有情节都服务于这条线索，严禁并列罗列多个独立活动（"去公园→玩→看花→回家"这种流水账绝对不行）
2. 角色：1-2 个有特点的角色（孩子/动物/拟人化物品都可以，避免千篇一律的 Tom and Lily）
3. 记忆点：设计一个孩子读完后能记住的结局——反转、小幽默或暖心时刻
4. 每幕用一两句话概括即可，不要写正文
5. 输出严格为 JSON（不要输出其他任何文字、不要 markdown 代码块），格式：
{{"core": "核心线索（一句话）", "characters": "角色（一句话）", "act1": "开头：引入角色与场景", "act2": "中间：冲突或进展", "act3": "结局：解决 + 记忆点"}}"""


def build_story_prompt(category_name, level_desc, outline, batch, phrases, retry_missing=None):
    """阶段 2：按大纲写正文。单词只能服务大纲情节，禁止新增活动。

    batch    — 本批单词 [{en, cn}]
    phrases  — 本批中的多词短语 [{en, cn}]（要求原样出现）
    """
    word_lines = "\n".join(f"{w['en']}（{w['cn']}）" for w in batch)
    phrase_lines = "\n".join(f'"{p["en"]}"（{p["cn"]}）' for p in phrases)
    phrase_req = ("另有固定短语/句式，必须原样出现（不拆分、不改变词形、不改成别的说法）：\n"
                  + phrase_lines + "\n") if phrases else ""
    dialogue_hint = ("这些固定句式多为日常对话用语，让它们在人物对话中自然出现。") if phrases else ""
    outline_lines = "\n".join(f"{k}: {v}" for k, v in outline.items())

    prompt = f"""你是中国小学英语老师。根据下面的故事大纲，为【{category_name}】写一篇英语小故事，供 {level_desc} 的孩子做听力与阅读练习。

【故事大纲】
{outline_lines}

【单词清单（必须全部使用，可用常见变形：三单/过去式/进行时/复数，如 run → runs / ran / running）】
{word_lines}
{phrase_req}
写作要求：
1. 正文严格按大纲展开，每个情节都服务于核心线索，禁止添加大纲之外的新活动、禁止并列罗列
2. {dialogue_hint}全文统一用一般现在时，不混用其他时态
3. 每句话单独一条 JSON 数组元素，一句话只表达一个意思，不超过 12 个单词
4. 结尾自然落在大纲的记忆点上，让故事有回味
5. 正文全部英文，不出现任何中文；篇幅 120~220 个单词
6. 输出严格为 JSON（不要输出任何其他文字、不要 markdown 代码块），格式：
{{"title": {{"en": "英文标题", "zh": "中文标题"}}, "sentences": ["句子1", "句子2", ...]}}"""

    if retry_missing:
        missing = "、".join(retry_missing)
        prompt += f"\n\n⚠️ 上一版漏掉了以下单词/短语，本次必须确保它们都出现：{missing}。其余要求不变。"

    return prompt


def parse_response(text):
    """从 API 回复中提取 JSON 对象（容错 markdown 围栏）"""
    t = text.strip()
    t = re.sub(r"^```(?:json)?\s*|\s*```$", "", t, flags=re.S)
    try:
        return json.loads(t)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", t, re.S)
        if m:
            return json.loads(m.group(0))
    return None


def call_api(prompt, api_key):
    resp = requests.post(
        API_URL,
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        json={
            "model": MODEL,
            "max_tokens": 2500,
            "messages": [{"role": "user", "content": prompt}],
        },
        timeout=90,
    )
    if resp.status_code != 200:
        raise RuntimeError(f"API HTTP {resp.status_code}: {resp.text[:200]}")
    data = resp.json()
    return parse_response(data["content"][0]["text"])


def verify_story(sentences, batch):
    """校验故事是否用到了本批全部单词。返回 (covered, missing)"""
    text = " ".join(sentences)
    covered, missing = [], []
    for w in batch:
        en = w["en"].strip()
        ok = check_phrase_in_text(en, text) if is_phrase(en) else check_word_in_text(en, text)
        if ok:
            covered.append(en)
        else:
            missing.append(en)
    return covered, missing


def polish_story(category_name, batch, story, api_key):
    """AI 润色：修正语法（冠词/主谓一致/单复数/时态），但禁止改动必须出现的单词。

    润色后重新校验覆盖；若润色导致漏词或调用失败，回退原文（保证覆盖承诺优先）。
    返回 (story, polished_ok)。
    """
    word_lines = ", ".join(f'"{w["en"]}"' for w in batch)
    sentences_text = "\n".join(f'{i + 1}. {s}' for i, s in enumerate(story["sentences"]))
    prompt = f"""你是英语校对老师。请润色下面这篇儿童英语故事，修正语法错误（冠词、主谓一致、单复数、时态不一致），让句子更自然地道，但必须严格遵守：
1. 以下必须出现的单词不得删除、不得换成别的词（允许保留其变形）：{word_lines}
2. 每个情节、每句话的意思都要保留
3. 全文统一一般现在时
4. 保持每句话单独一条、不超过 12 个单词、一句一个意思
5. 不增加新情节、不改变故事结构
输出严格为 JSON（不要输出任何其他文字）：{{"sentences": ["句子1", "句子2", ...]}}

原故事：
{sentences_text}"""
    try:
        parsed = call_api(prompt, api_key)
    except Exception as e:
        print(f"    ⚠️ 润色调用失败，回退原文: {e}", flush=True)
        return story, False
    new_sentences = [str(s).strip() for s in parsed.get("sentences", []) if str(s).strip()] if isinstance(parsed, dict) else []
    if len(new_sentences) < 3:
        print("    ⚠️ 润色结果不完整，回退原文", flush=True)
        return story, False
    covered, missing = verify_story(new_sentences, batch)
    if missing:
        print(f"    ⚠️ 润色后漏词({missing})，回退原文", flush=True)
        return story, False
    polished = {**story, "sentences": new_sentences, "wordsUsed": covered, "wordCount": len(covered)}
    print(f"    ✨ 润色完成: {len(story['sentences'])} -> {len(new_sentences)} 句", flush=True)
    return polished, True


def generate_story(category_name, level_desc, batch, phrases, api_key, max_attempts=3):
    """两阶段生成 + 校验一篇故事。

    阶段 1：大纲先行（核心线索 + 角色 + 三幕 + 记忆点），
            防止 AI 按单词表写流水账；
    阶段 2：按大纲写正文，漏词时带提示重试。
    返回 (story, covered)。
    """
    # ---- 阶段 1：大纲 ----
    outline = None
    for attempt in range(3):
        try:
            parsed = call_api(build_outline_prompt(category_name, level_desc, batch, phrases), api_key)
        except Exception as e:
            if attempt == 2:
                raise RuntimeError(f"大纲生成失败: {e}")
            time.sleep(1.5)
            continue
        if isinstance(parsed, dict) and parsed.get("core") and parsed.get("act3"):
            outline = {k: str(parsed.get(k, "")).strip() for k in ("core", "characters", "act1", "act2", "act3")}
            break
        if attempt == 2:
            raise RuntimeError("大纲生成失败（多次解析不通过）")
        time.sleep(1.5)
    print(f"    📌 大纲: {outline['core']} | {outline['characters']}", flush=True)

    # ---- 阶段 2：正文（漏词带提示重试） ----
    covered, missing = [], None
    for attempt in range(max_attempts):
        prompt = build_story_prompt(category_name, level_desc, outline, batch, phrases,
                                    None if attempt == 0 else missing)
        try:
            parsed = call_api(prompt, api_key)
        except Exception as e:
            # API 网络/解析错误：重试（最后一步不再重试）
            print(f"    ⚠️ 第{attempt + 1}次调用出错: {e}", flush=True)
            if attempt == max_attempts - 1:
                raise
            time.sleep(1.5)
            continue
        if not parsed:
            print(f"    ⚠️ 第{attempt + 1}次解析失败，重试", flush=True)
            if attempt == max_attempts - 1:
                raise RuntimeError("解析失败（多次尝试）")
            continue

        sentences = [str(s).strip() for s in parsed.get("sentences", []) if str(s).strip()]
        title_en = str(parsed.get("title", {}).get("en", "")).strip()
        title_zh = str(parsed.get("title", {}).get("zh", "")).strip()
        if len(sentences) < 3 or not title_en:
            print(f"    ⚠️ 第{attempt + 1}次内容不完整，重试", flush=True)
            if attempt == max_attempts - 1:
                raise RuntimeError(f"内容不完整: title={title_en!r} sentences={len(sentences)}")
            continue

        covered, missing = verify_story(sentences, batch)
        if not missing:
            story = {
                "title": {"en": title_en, "zh": title_zh},
                "sentences": sentences,
                "wordsUsed": covered,
                "wordCount": len(covered),
            }
            # 润色：修语法、统一时态；润色后仍须全覆盖，否则回退原文
            polished, _ = polish_story(category_name, batch, story, api_key)
            return polished, polished["wordsUsed"]
        # 有漏词 → 下一轮重试（提示漏词）
        print(f"    ⚠️ 第{attempt + 1}次漏词: {missing}", flush=True)
    return None, covered


def process_category(group_id, group_name, cat, api_key):
    """处理单个分类。返回 (result_category, failures)"""
    words = [w for w in cat.get("words", [])]
    if not words:
        return None, []

    # 去重
    seen, unique = set(), []
    for w in words:
        en = w["en"].strip()
        if en and en.lower() not in seen:
            seen.add(en.lower())
            unique.append(w)
    words = unique

    level_desc = "小学阶段" if "小学" in group_name else "初中阶段"
    # 短语为主的分类（如 常用短语&句型）：全部是固定句式，塞进一个故事很难，
    # 大幅降低每篇目标词数（10 个左右），让 AI 更容易把每条句式都用上
    phrase_ratio = sum(1 for w in words if is_phrase(w["en"])) / len(words)
    target = 10 if phrase_ratio >= 0.8 else TARGET_PER_STORY
    batches = build_batches(words, target)
    stories, failures = [], []
    total_covered = set()

    for idx, batch in enumerate(batches, 1):
        phrases = [w for w in batch if is_phrase(w["en"])]
        batch_plain = [w for w in batch if not is_phrase(w["en"])]
        # 短语比例过高时，prompt 里短语单独列出，其余单词同样要全部用到
        print(f"  📖 {cat['name']} 第{idx}/{len(batches)}篇: {len(batch)} 词"
              f"（其中短语 {len(phrases)} 条）", flush=True)
        # 短语为主的批次给更多重试机会（AI 重写故事容易顾此失彼）
        max_attempts = 5 if len(phrases) >= len(batch) * 0.6 else 3
        try:
            story, covered = generate_story(cat["name"], level_desc, batch, phrases, api_key,
                                            max_attempts=max_attempts)
            if story is None:
                missing_batch = [w["en"].strip() for w in batch if w["en"].strip() not in covered]
                raise RuntimeError(f"重试后仍漏词: {missing_batch}")
            story["id"] = f"{cat['id']}-{idx}"
            stories.append(story)
            total_covered |= set(covered)
            print(f"    ✅ 完成，覆盖 {len(covered)}/{len(batch)} 词，{len(story['sentences'])} 句", flush=True)
        except Exception as e:
            failures.append(f"{cat['id']} 第{idx}篇: {e}")
            print(f"    ❌ {e}", flush=True)
        time.sleep(0.8)  # 限速

    all_words = {w["en"].strip() for w in words}
    missing = sorted(all_words - total_covered)
    return {
        "categoryId": cat["id"],
        "categoryName": cat["name"],
        "totalWords": len(all_words),
        "stories": stories,
        "coverage": {"covered": len(total_covered), "total": len(all_words), "missing": missing},
    }, failures


def find_group_files(files):
    """确定要处理的词汇文件列表（默认全部英语分组）"""
    if files:
        return files
    patterns = [
        os.path.join(DATA_DIR, "*vocabulary*.json"),
        os.path.join(DATA_DIR, "junior_3500_7days.json"),
    ]
    found = []
    for p in patterns:
        found.extend(glob.glob(p))
    # 只处理英语分组文件（跳过 cambridge / word_details / manifest / stories）
    return sorted(set(found))


def main():
    parser = argparse.ArgumentParser(description="AI 精选故事生成管线")
    parser.add_argument("files", nargs="*", help="词汇 JSON 文件（默认全部英语分组）")
    parser.add_argument("--categories", default="", help="只处理指定分类（逗号分隔 id）")
    parser.add_argument("--force", action="store_true", help="重新生成已完成的分类（覆盖旧故事）")
    args = parser.parse_args()

    api_key = load_api_key()
    if not api_key:
        print("❌ 未找到 API key（~/.claude/settings.json）")
        sys.exit(1)

    files = find_group_files(args.files)
    if not files:
        print("❌ 未找到词汇数据文件")
        sys.exit(1)
    print(f"📁 处理 {len(files)} 个文件: {[os.path.basename(f) for f in files]}", flush=True)

    os.makedirs(STORIES_DIR, exist_ok=True)

    for filepath in files:
        with open(filepath, encoding="utf-8") as f:
            data = json.load(f)
        subj = data["subjects"]["english"]

        # 每个分组独立处理（当前文件均为单分组，写循环保持健壮）
        for group in subj["groups"]:
            group_id = group["id"]
            group_name = group["name"]

            out_path = os.path.join(STORIES_DIR, f"{group_id}.json")

            # 断点续跑：加载已生成结果
            existing = {"groupId": group_id, "groupName": group_name, "categories": []}
            if os.path.exists(out_path):
                try:
                    with open(out_path, encoding="utf-8") as f:
                        existing = json.load(f)
                except Exception:
                    print(f"⚠️ 读取 {out_path} 失败，将重新生成", flush=True)

            # 失败记录仅本次运行有效，不持久化（避免历史失败污染后续报告）
            all_failures = []

            for cat in group["categories"]:
                if args.categories:
                    wanted = {c.strip() for c in args.categories.split(",")}
                    if cat["id"] not in wanted:
                        continue
                # 断点续跑：仅当覆盖完整才算完成；覆盖不全的分类重新处理；--force 强制重做
                prev = next((c for c in existing["categories"] if c["categoryId"] == cat["id"]), None)
                if prev and not prev["coverage"]["missing"] and not args.force:
                    print(f"⏭️  跳过已完成的分类: {cat['id']}", flush=True)
                    continue

                print(f"🔨 处理分类: {cat['name']}（{cat['id']}）", flush=True)
                result_cat, failures = process_category(group_id, group_name, cat, api_key)
                if result_cat is None:
                    continue

                # 更新（覆盖同分类旧结果）
                existing["categories"] = [c for c in existing["categories"] if c["categoryId"] != cat["id"]]
                existing["categories"].append(result_cat)
                all_failures.extend(failures)
                existing["categories"].sort(key=lambda c: c["categoryId"])

                # 每分类落盘一次（断点续跑粒度）
                with open(out_path, "w", encoding="utf-8") as f:
                    json.dump(existing, f, ensure_ascii=False, indent=2)
                print(f"  💾 已保存: {out_path}\n", flush=True)

            # 汇总
            total_words = sum(c["totalWords"] for c in existing["categories"])
            total_covered = sum(c["coverage"]["covered"] for c in existing["categories"])
            total_stories = sum(len(c["stories"]) for c in existing["categories"])
            missing_words = sorted({w for c in existing["categories"] for w in c["coverage"]["missing"]})
            print(f"📊 {group_name}: {len(existing['categories'])} 分类 / {total_stories} 篇故事 / "
                  f"覆盖 {total_covered}/{total_words} 词", flush=True)
            if missing_words:
                print(f"   ⚠️ 未覆盖: {missing_words}", flush=True)
            if all_failures:
                print(f"   ❌ 失败: {all_failures}", flush=True)


if __name__ == "__main__":
    main()

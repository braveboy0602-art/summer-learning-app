/**
 * SRS — 间隔重复记忆系统 (SM-2 算法)
 *
 * 基于 Anki 使用的 SM-2 算法，管理每个单词的复习间隔。
 * 状态独立存储在 localStorage，与 Tracker 事件日志互补。
 *
 * 核心参数 per 单词：
 *   n        — 连续答对次数
 *   ef       — 难度系数 (Easiness Factor, 1.3–2.5)
 *   interval — 当前复习间隔（天）
 *   nextReview — 下次复习时间戳
 */
const SRS = {
  STORAGE_KEY: 'srs_states',

  /** 每日新词数上限（今日复习时，除了到期词，还会带少量新词） */
  DAILY_NEW_LIMIT: 10,

  // ============================================
  // 公开 API
  // ============================================

  /**
   * 获取单词的 SRS 状态
   * @param {string} wordId - 单词英文
   * @returns {{ id, n, ef, interval, lastReview, nextReview }}
   */
  getState(wordId) {
    const states = this._load();
    return states[wordId] || this._defaultState(wordId);
  },

  /**
   * 记录一次答题结果 → SM-2 算法更新
   * @param {string} wordId   - 单词英文
   * @param {boolean} isCorrect - 是否正确
   * @returns {object} 更新后的状态
   */
  recordAnswer(wordId, isCorrect) {
    const states = this._load();
    const state = { ...(states[wordId] || this._defaultState(wordId)) };

    const quality = isCorrect ? 4 : 1; // 4=正确, 1=错误
    const today = this._today();
    const dayMs = 86400000;

    // ── SM-2: 更新 EF ──
    state.ef = state.ef + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
    state.ef = Math.max(1.3, state.ef);

    // ── SM-2: 更新间隔 ──
    if (quality >= 3) {
      // 答对
      if (state.n === 0) {
        state.interval = 1;
      } else if (state.n === 1) {
        state.interval = 6;
      } else {
        state.interval = Math.round(state.interval * state.ef);
      }
      state.n += 1;
    } else {
      // 答错 → 重置
      state.n = 0;
      state.interval = 1;
    }

    state.lastReview = today;
    state.nextReview = today + state.interval * dayMs;

    states[wordId] = state;
    this._save(states);
    return state;
  },

  /**
   * 从单词列表中筛选出今天的到期复习词
   * @param {Array} allWords - 单词对象数组，每项需有 .en 字段
   * @returns {Array} 到期单词
   */
  getDueWords(allWords) {
    const today = this._today();
    return allWords.filter(w => {
      const st = this.getState(w.en);
      return st.nextReview !== null && st.nextReview <= today;
    });
  },

  /**
   * 获取从未学过的新词
   * @param {Array} allWords
   * @param {number} [limit=10]
   * @returns {Array}
   */
  getNewWords(allWords, limit) {
    const result = allWords.filter(w => {
      const st = this.getState(w.en);
      return st.n === 0 && st.nextReview === null;
    });
    return result.slice(0, limit ?? this.DAILY_NEW_LIMIT);
  },

  /**
   * 获取今日全部待办：到期复习 + 新词
   * @param {Array} allWords
   * @param {object} [opts]
   * @returns {{ due:Array, new:Array, total:number }}
   */
  getTodayTodos(allWords, opts = {}) {
    const due = this.getDueWords(allWords);
    const newLimit = opts.newLimit ?? this.DAILY_NEW_LIMIT;
    const newWords = this.getNewWords(allWords, newLimit);
    return { due, new: newWords, total: due.length + newWords.length };
  },

  /** 导出全部 SRS 状态（用于调试 / 统计） */
  exportStates() {
    return this._load();
  },

  /** 清空所有 SRS 数据 */
  reset() {
    try { localStorage.removeItem(this.STORAGE_KEY); } catch {}
  },

  // ============================================
  // Internal
  // ============================================

  _today() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  },

  _defaultState(wordId) {
    return { id: wordId, n: 0, ef: 2.5, interval: 0, lastReview: null, nextReview: null };
  },

  _load() {
    try {
      const raw = localStorage.getItem(this.STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  },

  _save(states) {
    try { localStorage.setItem(this.STORAGE_KEY, JSON.stringify(states)); } catch {}
  }
};

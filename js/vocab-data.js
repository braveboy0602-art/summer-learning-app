/**
 * 词汇数据模块 —— 动态加载版
 *
 * 数据流：
 *   manifest.json  → 定义学科 / 分组菜单结构，英语分组通过 dataFile 指向具体词汇 JSON
 *   词汇 JSON       → 由 fetch() 在首次展开分组时按需加载，加载后缓存
 *
 * 数据结构（与加载后的缓存结构一致）：
 *   subjects → groups → categories → words（三级树形）
 *
 * 设计说明：
 * - 不再将数据硬编码在 JS 中
 * - 数学、语文因处于 disabled 状态，数据直接内嵌在 manifest.json 中
 * - 所有 API 保持与原 DataStore 兼容
 */

const DataStore = {
  /** manifest 缓存 */
  _manifest: null,

  /** 分组数据缓存：{ [groupId]: { categories: [...], _loaded: true } } */
  _groupCache: {},

  /** 加载中的 Promise 缓存，防止对同一个 group 发起重复 fetch */
  _loadingPromises: {},

  /** 是否已完成 manifest 加载 */
  _loaded: false,

  // ==========================================
  // 初始化：加载 manifest.json
  // ==========================================

  /**
   * 从 data/manifest.json 加载学科菜单结构
   * 内嵌数据的 disabled 分组也会一并缓存在 _groupCache 中
   * @returns {Promise<boolean>}
   */
  async init() {
    if (this._loaded) return true;

    try {
      const resp = await fetch('data/manifest.json');
      if (!resp.ok) throw new Error(`HTTP ${resp.status} — ${resp.statusText}`);
      const data = await resp.json();

      if (!data || !data.subjects) {
        throw new Error('manifest.json 格式错误：缺少 subjects 字段');
      }

      this._manifest = data;

      // 预缓存没有 dataFile 的分组（disabled 学科的数据内嵌在 manifest 中）
      for (const subjId of Object.keys(data.subjects)) {
        const subj = data.subjects[subjId];
        for (const group of (subj.groups || [])) {
          if (!group.dataFile && group.categories) {
            this._groupCache[group.id] = {
              categories: group.categories,
              _loaded: true
            };
          }
        }
      }

      this._loaded = true;
      return true;
    } catch (err) {
      console.error('[DataStore] manifest 加载失败:', err);
      throw err;
    }
  },

  /**
   * 按需加载指定分组的数据（从 dataFile JSON 中读取）
   * 已缓存时直接返回，不会重复 fetch
   * @param {string} subjectId
   * @param {string} groupId
   * @returns {Promise<Array>} categories 数组
   */
  async loadGroup(subjectId, groupId) {
    // 已缓存 → 直接返回
    if (this._groupCache[groupId]?._loaded) {
      return this._groupCache[groupId].categories;
    }

    // 正在加载中 → 复用已有 Promise
    if (this._loadingPromises[groupId]) {
      return this._loadingPromises[groupId];
    }

    // 查找分组定义（从 manifest 中）
    const subj = this._manifest?.subjects?.[subjectId];
    const groupDef = subj?.groups?.find(g => g.id === groupId);
    if (!groupDef) {
      throw new Error(`manifest 中未找到分组 "${groupId}"`);
    }

    // 没有 dataFile → 使用 manifest 内嵌数据
    if (!groupDef.dataFile) {
      this._groupCache[groupId] = {
        categories: groupDef.categories || [],
        _loaded: true
      };
      return this._groupCache[groupId].categories;
    }

    // 发起 fetch 加载
    const promise = (async () => {
      try {
        const resp = await fetch(groupDef.dataFile);
        if (!resp.ok) throw new Error(`HTTP ${resp.status} — ${resp.statusText}`);
        const data = await resp.json();

        if (!data || !data.subjects) {
          throw new Error(`${groupDef.dataFile} 格式错误：缺少 subjects 字段`);
        }

        // 从 JSON 中提取对应分组的数据
        const loadedGroups = data.subjects[subjectId]?.groups || [];
        const loadedGroup = loadedGroups.find(g => g.id === groupId);

        if (!loadedGroup) {
          throw new Error(`${groupDef.dataFile} 中未找到分组 "${groupId}"`);
        }

        this._groupCache[groupId] = {
          categories: loadedGroup.categories || [],
          _loaded: true
        };

        return this._groupCache[groupId].categories;
      } finally {
        delete this._loadingPromises[groupId];
      }
    })();

    this._loadingPromises[groupId] = promise;
    return promise;
  },

  /**
   * 检查分组数据是否已加载
   * @param {string} groupId
   * @returns {boolean}
   */
  isGroupLoaded(groupId) {
    return !!(this._groupCache[groupId]?._loaded);
  },

  // ==========================================
  // 学科（一级菜单）
  // ==========================================

  /**
   * 获取所有学科 ID 列表
   * @returns {string[]}
   */
  getSubjects() {
    return this._manifest ? Object.keys(this._manifest.subjects) : [];
  },

  /**
   * 获取学科数据
   * @param {string} subjectId
   */
  getSubject(subjectId) {
    return this._manifest?.subjects?.[subjectId] || null;
  },

  // ==========================================
  // 组 / 子分类（二级菜单）
  // ==========================================

  /**
   * 获取学科下的所有组
   * @param {string} subjectId
   */
  getGroups(subjectId) {
    const subject = this.getSubject(subjectId);
    return subject ? (subject.groups || []) : [];
  },

  /**
   * 获取指定组
   * @param {string} subjectId
   * @param {string} groupId
   */
  getGroup(subjectId, groupId) {
    const groups = this.getGroups(subjectId);
    return groups.find(g => g.id === groupId) || null;
  },

  /**
   * 获取组下的所有分类（仅返回已加载的数据）
   * @param {string} subjectId
   * @param {string} groupId
   */
  getGroupCategories(subjectId, groupId) {
    const cache = this._groupCache[groupId];
    if (cache?._loaded) return cache.categories;
    return [];
  },

  /**
   * 获取组下的所有单词（展平），附加分类信息
   * @param {string} subjectId
   * @param {string} groupId
   */
  getGroupWords(subjectId, groupId) {
    const categories = this.getGroupCategories(subjectId, groupId);
    const result = [];
    categories.forEach(cat => {
      (cat.words || []).forEach(word => {
        result.push({
          ...word,
          categoryId: cat.id,
          categoryName: cat.name,
          categoryIcon: cat.icon,
          groupId: groupId,
          key: this.getWordKey(cat.id, word)
        });
      });
    });
    return result;
  },

  /**
   * 计算单个组的总单词数
   * @param {string} subjectId
   * @param {string} groupId
   */
  getGroupWordCount(subjectId, groupId) {
    return this.getGroupWords(subjectId, groupId).length;
  },

  // ==========================================
  // 分类（三级菜单）& 单词
  // ==========================================

  /**
   * 获取指定分类（跨组查找，仅搜索已加载的分组）
   * @param {string} subjectId
   * @param {string} categoryId
   */
  getCategory(subjectId, categoryId) {
    for (const groupId of Object.keys(this._groupCache)) {
      const cache = this._groupCache[groupId];
      if (!cache._loaded) continue;
      const found = cache.categories.find(c => c.id === categoryId);
      if (found) return found;
    }
    return null;
  },

  /**
   * 获取分类下的所有单词
   * @param {string} subjectId
   * @param {string} categoryId
   */
  getWords(subjectId, categoryId) {
    const category = this.getCategory(subjectId, categoryId);
    return category ? (category.words || []) : [];
  },

  /**
   * 获取分类的单词（展平，附加分类信息）
   * @param {string} subjectId
   * @param {string} categoryId
   */
  getCategoryWords(subjectId, categoryId) {
    const words = this.getWords(subjectId, categoryId);
    return words.map(word => ({
      ...word,
      categoryId: categoryId,
      key: this.getWordKey(categoryId, word)
    }));
  },

  /**
   * 获取单词的唯一标识键
   * @param {string} categoryId
   * @param {object} word
   */
  getWordKey(categoryId, word) {
    return `${categoryId}_${word.en}`;
  },

  /**
   * 检查数据是否已就绪
   */
  isLoaded() {
    return this._loaded;
  }
};

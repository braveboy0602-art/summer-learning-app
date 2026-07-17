/**
 * 暑期学习管理 - 主应用逻辑
 * 三级树形导航：学科 → 组 → 分类
 * 数据联动：点击三级分类时右侧内容动态刷新
 */

const StudyApp = {
  // ----- 状态 -----
  currentSubject: 'english',
  currentGroupId: null,
  currentCategoryId: null,

  /** 已展开的学科 */
  expandedSubjects: new Set(),
  /** 已展开的组（显示其下的分类） */
  expandedGroups: new Set(),

  /** 学习状态：{ "categoryId_word": "learning" } */
  learningStatus: {},

  /** 自动跟读状态 */
  _isAutoPlaying: false,

  todayStr: '',

  // ============================================
  // 初始化（异步）
  // ============================================

  async init() {
    this.todayStr = this._getTodayString();

    this._bindEvents();
    this.loadFromStorage();
    this._bindChallengeEvents();
    this._bindDownloadEvents();

    // 默认展开英语 → 小学词汇
    this.expandedSubjects.add('english');
    this.expandedGroups.add('primary');

    // ---- 异步加载数据 ----
    try {
      await DataStore.init();
      // 预加载默认分组（小学词汇）的数据，使初始分类可渲染
      await DataStore.loadGroup('english', 'primary');
    } catch (err) {
      console.error('[StudyApp] 数据加载失败:', err);
      this._showToast('数据加载失败，请刷新重试');
      // 即使失败也继续渲染，只是侧边栏没有分组数据
    }

    this._renderHeader();
    this._renderSidebar();

    // 默认选中：英语 → 小学词汇 → 第一个分类
    const firstGroup = DataStore.getGroups('english')[0];
    if (firstGroup) {
      const cats = DataStore.getGroupCategories('english', firstGroup.id);
      const firstCat = (cats || [])[0] || null;
      if (firstCat) {
        this.selectCategory('english', firstGroup.id, firstCat.id);
      }
    }
  },

  // ============================================
  // 事件委托
  // ============================================

  _bindEvents() {
    const sidebar = document.getElementById('sidebarNav');
    if (sidebar) {
      sidebar.addEventListener('click', (e) => {
        /* ⚠️ 重要：必须从最内层元素开始检查，因为 .cat-item / .group-item
           都在 .subject-item 内部，先查 subject 会导致永远匹配不到子项 */
        // 1️⃣ 分类点击（最内层优先）
        const catItem = e.target.closest('.cat-item');
        if (catItem && catItem.dataset.subject && catItem.dataset.groupId && catItem.dataset.catId) {
          this.selectCategory(catItem.dataset.subject, catItem.dataset.groupId, catItem.dataset.catId);
          return;
        }
        // 2️⃣ 组展开/收起
        const groupItem = e.target.closest('.group-item');
        if (groupItem && groupItem.dataset.subject && groupItem.dataset.groupId) {
          this._toggleGroup(groupItem.dataset.subject, groupItem.dataset.groupId);
          return;
        }
        // 3️⃣ 学科展开/收起（最外层最后检查）
        const subjectItem = e.target.closest('.subject-item');
        if (subjectItem && subjectItem.dataset.subject) {
          // 检查是否被禁用
          if (subjectItem.classList.contains('subject-disabled')) {
            this._showToast('功能开发中，敬请期待');
            return;
          }
          this._toggleSubject(subjectItem.dataset.subject);
          return;
        }
      });
    }

    const wordGrid = document.getElementById('wordGrid');
    if (wordGrid) {
      wordGrid.addEventListener('click', (e) => {
        const playBtn = e.target.closest('.btn-play');
        if (playBtn && playBtn.dataset.word) {
          this.playAudio(playBtn.dataset.word);
          return;
        }
        const statusBtn = e.target.closest('.btn-status');
        if (statusBtn && statusBtn.dataset.key && statusBtn.dataset.status) {
          this.setStatus(statusBtn.dataset.key, statusBtn.dataset.status);
          return;
        }
      });
    }

  },

  // ============================================
  // 数据持久化
  // ============================================

  loadFromStorage() {
    try {
      const saved = localStorage.getItem('study_learning_status');
      this.learningStatus = saved ? JSON.parse(saved) : {};
    } catch { this.learningStatus = {}; }
  },

  saveLearningStatus() {
    localStorage.setItem('study_learning_status', JSON.stringify(this.learningStatus));
  },

  // ============================================
  // 侧边栏 —— 三级树形导航
  // ============================================

  _renderSidebar() {
    const container = document.getElementById('sidebarNav');
    const subjectIds = DataStore.getSubjects();

    let html = '<ul class="tree-list">';
    subjectIds.forEach(subjId => {
      const subject = DataStore.getSubject(subjId);
      if (!subject) return;

      const isSubjExpanded = this.expandedSubjects.has(subjId);
      const groups = DataStore.getGroups(subjId);

      // 一级：学科 —— 始终渲染完整结构，用 CSS .collapsed 控制显隐
      const isDisabled = subject.disabled === true;
      const disabledClass = isDisabled ? ' subject-disabled' : '';
      const displayName = subject.name + (isDisabled ? ' (暂不开放)' : '');

      html += `
        <li class="tree-item subject-item${this.currentSubject === subjId ? ' subject-current' : ''}${disabledClass}"
            data-subject="${subjId}"${isDisabled ? ' title="功能开发中，敬请期待"' : ''}>
          <div class="subject-row"${isDisabled ? ' title="功能开发中，敬请期待"' : ''}>
            <span class="tree-toggle ${isSubjExpanded ? 'expanded' : ''}">${groups.length && !isDisabled ? (isSubjExpanded ? '▾' : '▸') : ''}</span>
            <span class="subject-icon">${subject.icon}</span>
            <span class="subject-name">${displayName}</span>
          </div>
          ${isDisabled ? '' : `<ul class="group-list${isSubjExpanded ? '' : ' collapsed'}">
            ${this._renderGroupList(subjId, groups)}
          </ul>`}
        </li>`;
    });
    html += '</ul>';
    container.innerHTML = html;
  },

  /**
   * 二级：组列表（含三级分类）
   * 始终渲染全部 <li>，展开/收起由 CSS .collapsed 控制
   */
  _renderGroupList(subjId, groups) {
    if (!groups.length) return '';
    let html = '';
    groups.forEach(group => {
      const isGrpExpanded = this.expandedGroups.has(group.id);
      // 从 DataStore 缓存获取分类（未加载的分组返回 []）
      const cats = DataStore.getGroupCategories(subjId, group.id);
      const isActiveGroup = this.currentSubject === subjId && this.currentGroupId === group.id;
      // 有 dataFile（延后加载）或已有分类数据 → 显示展开箭头
      const hasChildren = group.dataFile || cats.length > 0;

      html += `
        <li class="tree-item group-item${isActiveGroup ? ' active-group' : ''}"
            data-subject="${subjId}" data-group-id="${group.id}">
          <div class="group-row">
            <span class="tree-toggle ${isGrpExpanded ? 'expanded' : ''}">${hasChildren ? (isGrpExpanded ? '▾' : '▸') : ''}</span>
            <span class="group-icon">${group.icon}</span>
            <span class="group-name">${group.name}</span>
          </div>
          <ul class="cat-list${isGrpExpanded && cats.length ? '' : ' collapsed'}">
            ${this._renderCatList(subjId, group.id, cats)}
          </ul>
        </li>`;
    });
    return html;
  },

  /**
   * 三级：分类列表（可点击加载单词）
   */
  _renderCatList(subjId, groupId, cats) {
    if (!cats.length) return '';
    let html = '';
    cats.forEach(cat => {
      const isActive = this.currentSubject === subjId &&
                       this.currentGroupId === groupId &&
                       this.currentCategoryId === cat.id;
      html += `
        <li class="tree-item cat-item${isActive ? ' active' : ''}"
            data-subject="${subjId}" data-group-id="${groupId}" data-cat-id="${cat.id}">
          <div class="cat-row">
            <span class="cat-icon">${cat.icon}</span>
            <span class="cat-name">${cat.name}</span>
            <span class="cat-count">${(cat.words || []).length}</span>
          </div>
        </li>`;
    });
    return html;
  },

  /**
   * 展开/收起学科 —— 只切换 CSS 类，不重建 DOM
   */
  _toggleSubject(subjId) {
    const item = document.querySelector(`.subject-item[data-subject="${subjId}"]`);
    if (!item) return;
    const gl = item.querySelector('.group-list');
    const toggle = item.querySelector('.subject-row .tree-toggle');

    if (this.expandedSubjects.has(subjId)) {
      this.expandedSubjects.delete(subjId);
      if (gl) gl.classList.add('collapsed');
      if (toggle) toggle.classList.remove('expanded');
    } else {
      this.expandedSubjects.add(subjId);
      if (gl) gl.classList.remove('collapsed');
      if (toggle) toggle.classList.add('expanded');
    }
  },

  /**
   * 展开/收起组 —— 首次展开时自动加载数据
   * 异步：如果数据未加载，先 fetch 再展开
   */
  async _toggleGroup(subjId, groupId) {
    const item = document.querySelector(`.group-item[data-subject="${subjId}"][data-group-id="${groupId}"]`);
    if (!item) return;
    const cl = item.querySelector('.cat-list');
    const toggle = item.querySelector('.group-row .tree-toggle');

    // 如果已经展开 → 收起
    if (this.expandedGroups.has(groupId)) {
      this.expandedGroups.delete(groupId);
      if (cl) cl.classList.add('collapsed');
      if (toggle) {
        toggle.textContent = '▸';
        toggle.classList.remove('expanded');
      }
      return;
    }

    // ---- 数据未加载 → 异步加载 ----
    if (!DataStore.isGroupLoaded(groupId)) {
      // 显示加载状态
      if (cl) {
        cl.innerHTML = '<li class="cat-loading"><span>⏳ 加载中...</span></li>';
      }

      try {
        await DataStore.loadGroup(subjId, groupId);
        // 加载完成 → 用真实分类替换加载提示
        const cats = DataStore.getGroupCategories(subjId, groupId);
        if (cl) {
          cl.innerHTML = this._renderCatList(subjId, groupId, cats);
        }
      } catch (err) {
        console.error(`[StudyApp] 加载分组 "${groupId}" 失败:`, err);
        if (cl) {
          cl.innerHTML = '<li class="cat-loading cat-error"><span>⚠️ 数据加载失败</span></li>';
        }
        this._showToast('数据加载失败，请检查文件');
        return; // ← 不展开
      }
    }

    // ---- 展开 ----
    this.expandedGroups.add(groupId);
    if (cl) cl.classList.remove('collapsed');
    if (toggle) {
      toggle.textContent = '▾';
      toggle.classList.add('expanded');
    }
  },

  // ============================================
  // 选择分类（核心切换逻辑）
  // ============================================

  /**
   * 选择三级分类，联动刷新右侧内容
   * 不重建侧边栏 DOM，只更新 CSS 高亮类
   */
  selectCategory(subjId, groupId, catId) {
    console.log(`[StudyApp] selectCategory: subject=${subjId}, group=${groupId}, category=${catId}`);

    // 先更新状态，再判断是否需要清空
    this.currentSubject = subjId;
    this.currentGroupId = groupId;
    this.currentCategoryId = catId;

    // 确保父级路径全部展开（不重建 DOM）
    this.expandedSubjects.add(subjId);
    this.expandedGroups.add(groupId);

    // ----- 更新侧边栏高亮：不重建 DOM，只切换类名 -----
    // 清除所有高亮
    document.querySelectorAll('.cat-item.active').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.group-item.active-group').forEach(el => el.classList.remove('active-group'));

    // 高亮当前分类
    const catItem = document.querySelector(`.cat-item[data-subject="${subjId}"][data-group-id="${groupId}"][data-cat-id="${catId}"]`);
    if (catItem) catItem.classList.add('active');

    // 高亮当前组
    const grpItem = document.querySelector(`.group-item[data-subject="${subjId}"][data-group-id="${groupId}"]`);
    if (grpItem) grpItem.classList.add('active-group');

    // 确保侧边栏展开路径可见
    const subjItem = document.querySelector(`.subject-item[data-subject="${subjId}"]`);
    if (subjItem) {
      const gl = subjItem.querySelector('.group-list');
      if (gl) gl.classList.remove('collapsed');
      const t1 = subjItem.querySelector('.subject-row .tree-toggle');
      if (t1) t1.classList.add('expanded');
    }
    if (grpItem) {
      const cl = grpItem.querySelector('.cat-list');
      if (cl) cl.classList.remove('collapsed');
      const t2 = grpItem.querySelector('.group-row .tree-toggle');
      if (t2) t2.classList.add('expanded');
    }

    // 如果正在跟读，立即停止
    this._stopAutoPlay();

    // 联动 Header
    this._renderHeader();

    // 渲染该分类的单词
    this._renderCategoryWords(subjId, catId);

    this._updateProgress();
  },

  // ============================================
  // Header 联动
  // ============================================

  _renderHeader() {
    const subject = DataStore.getSubject(this.currentSubject);
    const group = DataStore.getGroup(this.currentSubject, this.currentGroupId);
    const category = DataStore.getCategory(this.currentSubject, this.currentCategoryId);

    const subjName = subject ? subject.name : '';
    const groupName = group ? group.name : '';
    const catName = category ? category.name : '';

    const titleEl = document.querySelector('.header-title h1');
    if (titleEl) {
      titleEl.textContent = `${subjName} · ${groupName}`;
    }

    const subEl = document.querySelector('.header-title .subtitle');
    if (subEl) {
      const desc = category ? category.description || catName : (group ? group.description || groupName : '');
      subEl.textContent = `${subjName} · ${catName || groupName} — ${desc}`;
    }

    const dateEl = document.getElementById('headerDate');
    if (dateEl) {
      const now = new Date();
      const wds = ['日','一','二','三','四','五','六'];
      dateEl.textContent = `📅 ${now.getFullYear()}年${now.getMonth()+1}月${now.getDate()}日 周${wds[now.getDay()]}`;
    }
  },

  // ============================================
  // 单词渲染
  // ============================================

  /**
   * 渲染指定分类的单词
   */
  _renderCategoryWords(subjId, catId) {
    console.log(`[StudyApp] _renderCategoryWords: catId=${catId}`);

    const container = document.getElementById('wordGrid');
    const category = DataStore.getCategory(subjId, catId);
    const words = DataStore.getCategoryWords(subjId, catId);

    console.log(`[StudyApp]   category=`, category ? category.name : 'null');
    console.log(`[StudyApp]   words count=`, words ? words.length : 0);
    if (words && words.length > 0) {
      console.log(`[StudyApp]   first word:`, words[0].en, `→`, words[0].cn);
    }

    const titleEl = document.getElementById('categoryTitle');
    const descEl = document.getElementById('categoryDesc');

    if (category) {
      // 包含数量标签在标题内
      titleEl.innerHTML = `<span class="cat-icon">${category.icon}</span> ${category.name} <span class="word-count-badge">${words.length} 个</span>`;
      descEl.textContent = category.description || '';
      // 自动跟读按钮
      this._renderAutoPlayBtn(words.length);
    } else {
      titleEl.innerHTML = `<span class="cat-icon">📖</span> 选择分类 <span class="word-count-badge">0 个单词</span>`;
      descEl.textContent = '点击左侧分类开始学习';
    }

    if (!category || !words.length) {
      container.innerHTML = `
        <div class="empty-state">
          <span class="empty-state-icon">📭</span>
          <span class="empty-state-text">该分类暂无数据</span>
        </div>`;
      return;
    }

    container.innerHTML = words.map((word, index) => {
      const key = word.key;
      const status = this.learningStatus[key] || 'unlearned';
      return this._buildWordCard(word, key, status, index);
    }).join('');

    console.log(`[StudyApp]   ✅ word grid updated with ${words.length} cards`);
  },

  // ============================================
  // 自动跟读
  // ============================================

  /**
   * 渲染/更新头部操作按钮组（自动跟读 + 默写挑战）
   */
  _renderAutoPlayBtn(wordCount) {
    // 移除旧按钮组
    const oldActions = document.getElementById('headerActions');
    if (oldActions) oldActions.remove();

    const actions = document.createElement('div');
    actions.id = 'headerActions';
    actions.className = 'header-actions';

    // ---- 自动跟读按钮 ----
    const playBtn = document.createElement('button');
    playBtn.id = 'autoPlayBtn';
    playBtn.className = 'btn btn-autoplay';
    playBtn.textContent = this._isAutoPlaying ? '⏸ 停止播放' : '🔊 开始跟读';
    playBtn.title = this._isAutoPlaying ? '停止自动跟读' : '循环播放所有单词的发音';

    playBtn.addEventListener('click', () => {
      if (this._isAutoPlaying) {
        this._stopAutoPlay();
      } else {
        this._startAutoPlay();
      }
    });

    // ---- 默写挑战按钮 ----
    const challengeBtn = document.createElement('button');
    challengeBtn.id = 'challengeBtn';
    challengeBtn.className = 'btn btn-challenge';
    challengeBtn.textContent = '✏️ 默写挑战';
    challengeBtn.title = '开始单词默写挑战';

    challengeBtn.addEventListener('click', () => {
      this._openChallenge();
    });

    // ---- 资料下载按钮 ----
    const downloadBtn = document.createElement('button');
    downloadBtn.id = 'downloadBtn';
    downloadBtn.className = 'btn btn-download';
    downloadBtn.textContent = '📚 资料下载';
    downloadBtn.title = '查看可下载的学习资料';

    downloadBtn.addEventListener('click', () => {
      this._openDownloadModal();
    });

    actions.appendChild(playBtn);
    actions.appendChild(challengeBtn);
    actions.appendChild(downloadBtn);

    // 追加到 word-area-header 右侧
    const header = document.querySelector('.word-area-header');
    if (header) {
      header.appendChild(actions);
    }
  },

  /**
   * Promise 化的语音播放 —— 用于自动跟读循环
   * @returns {Promise<void>}
   */
  _playAudioAsync(word) {
    return speakText(word);
  },

  /**
   * 开始循环跟读
   */
  async _startAutoPlay() {
    if (this._isAutoPlaying) return;
    this._isAutoPlaying = true;
    this._renderAutoPlayBtn();

    const cards = document.querySelectorAll('#wordGrid .word-card');
    if (!cards.length) {
      this._isAutoPlaying = false;
      this._renderAutoPlayBtn();
      return;
    }

    const wordList = [];
    cards.forEach(card => {
      const btn = card.querySelector('.btn-play');
      if (btn && btn.dataset.word) {
        wordList.push({ el: card, word: btn.dataset.word });
      }
    });

    console.log(`[StudyApp] 开始跟读，共 ${wordList.length} 个单词`);

    for (let i = 0; i < wordList.length; i++) {
      if (!this._isAutoPlaying) break;

      const { el, word } = wordList[i];

      // 高亮当前卡片
      cards.forEach(c => c.classList.remove('reading'));
      el.classList.add('reading');
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

      // 播放发音
      await this._playAudioAsync(word);
      if (!this._isAutoPlaying) break;

      // 单词之间停顿 2s，给用户跟读时间
      await new Promise(r => setTimeout(r, 2000));
    }

    // 结束清理
    cards.forEach(c => c.classList.remove('reading'));
    this._isAutoPlaying = false;
    this._renderAutoPlayBtn();
    console.log(`[StudyApp] 跟读结束`);
  },

  /**
   * 停止跟读
   */
  _stopAutoPlay() {
    this._isAutoPlaying = false;
    window.speechSynthesis && window.speechSynthesis.cancel();
    document.querySelectorAll('#wordGrid .word-card.reading').forEach(c => c.classList.remove('reading'));
    this._renderAutoPlayBtn();
    console.log(`[StudyApp] 跟读已停止`);
  },

  // ============================================
  // 默写挑战 —— 第一关：单词拼写闯关
  // ============================================

  /**
   * 打开默写挑战弹窗
   */
  _openChallenge() {
    const overlay = document.getElementById('challengeOverlay');
    if (!overlay) return;

    // 停跟读
    this._stopAutoPlay();

    const category = DataStore.getCategory(this.currentSubject, this.currentCategoryId);
    let words = DataStore.getCategoryWords(this.currentSubject, this.currentCategoryId);

    if (!words || !words.length) {
      this._showToast('当前分类没有单词');
      return;
    }

    // 打乱、全部使用
    words = this._shuffleArray([...words]);

    // 更新弹窗头部信息
    const catEl = document.getElementById('challengeCategory');
    const cntEl = document.getElementById('challengeWordCount');
    if (catEl) catEl.textContent = category ? `${category.icon} ${category.name}` : '';
    if (cntEl) cntEl.textContent = `${words.length} 个单词`;

    // 初始化游戏状态
    this._challengeWords = words;
    this._challengeIndex = 0;
    this._challengeAnswer = [];   // { letter, btnId }[]
    this._challengeScore = 0;

    // 隐藏完成页、显示游戏区
    document.getElementById('challengeComplete').style.display = 'none';
    document.getElementById('challengeGameContent').style.display = 'block';

    // 渲染第一题
    this._renderChallengeQuestion();

    overlay.style.display = 'flex';
    document.body.style.overflow = 'hidden';
  },

  /**
   * 关闭默写挑战弹窗
   */
  _closeChallenge() {
    const overlay = document.getElementById('challengeOverlay');
    if (!overlay) return;
    overlay.style.display = 'none';
    document.body.style.overflow = '';
  },

  /** 绑定默写挑战弹窗事件 */
  _bindChallengeEvents() {
    // 关闭按钮
    const closeBtn = document.getElementById('challengeClose');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        if (window.confirm('确定要退出闯关吗？当前进度将会丢失哦！')) {
          this._closeChallenge();
        }
      });
    }

    // 点击背景蒙层 —— 只关闭确认弹窗（若有），绝不退出游戏
    const overlay = document.getElementById('challengeOverlay');
    if (overlay) {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
          // 不做任何操作，防止误触退出
          return;
        }
      });
    }

    // ESC 键 —— 与关闭按钮行为一致，弹出确认框
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const ov = document.getElementById('challengeOverlay');
        if (ov && ov.style.display !== 'none') {
          if (window.confirm('确定要退出闯关吗？当前进度将会丢失哦！')) {
            this._closeChallenge();
          }
        }
      }
    })

    // 提交答案（事件委托，避免重复绑定）
    const submitBtn = document.getElementById('challengeSubmit');
    if (submitBtn) {
      submitBtn.addEventListener('click', () => this._onChallengeSubmit());
    }

    // 拼写格点击（删除字母）—— 委托（通过 data-slot-idx 精准定位）
    const slotsContainer = document.getElementById('spellingSlots');
    if (slotsContainer) {
      slotsContainer.addEventListener('click', (e) => {
        const slot = e.target.closest('.slot');
        if (!slot || !slot.classList.contains('slot-filled')) return;
        const slotIdx = parseInt(slot.dataset.slotIdx);
        if (!isNaN(slotIdx) && this._challengeAnswer[slotIdx] != null) {
          this._removeLetterFromAnswer(slotIdx);
        }
      });
    }

    // 字母按键 —— 委托
    const letterGrid = document.getElementById('letterGrid');
    if (letterGrid) {
      letterGrid.addEventListener('click', (e) => {
        const btn = e.target.closest('.letter-btn');
        if (!btn || btn.disabled) return;
        this._onChallengeLetterClick(btn);
      });
    }

    // 发音（喇叭按钮）—— 事件委托，支持动态生成的按钮
    const gameContent = document.getElementById('challengeGameContent');
    if (gameContent) {
      gameContent.addEventListener('click', function(e) {
        const btn = e.target.closest('#challengeSpeaker');
        if (!btn) return;
        const word = btn.dataset.word;
        if (!word) return;
        speakText(word);
        btn.classList.remove('playing');
        void btn.offsetWidth;
        btn.classList.add('playing');
        setTimeout(() => btn.classList.remove('playing'), 600);
      });
    }
  },

  /** 渲染当前题目（支持单词/短语/句型） */
  _renderChallengeQuestion() {
    const word = this._challengeWords[this._challengeIndex];
    const total = this._challengeWords.length;
    const num = this._challengeIndex + 1;

    // 进度
    document.getElementById('challengeCurrentNum').textContent = num;
    document.getElementById('challengeTotalNum').textContent = total;

    // 中文提示 & 喇叭发音（动态生成 hint-row）
    const hintContainer = document.getElementById('hintRowContainer');
    if (hintContainer) {
      hintContainer.innerHTML =
        '<div class="hint-row">' +
          '<div class="chinese-hint" id="chineseHint">' + this._escapeHtml(word.cn) + '</div>' +
          '<button class="speaker-btn" id="challengeSpeaker" data-word="' + this._escapeAttr(word.en) + '" title="点击播放发音">' +
            '🔊' +
          '</button>' +
        '</div>';
    }

    // 解析 word.en 为 cell 数据结构
    const parsed = this._parseWord(word.en);
    this._challengeCells = parsed.cells;
    this._challengeLetterCount = parsed.letterCount;
    this._challengeWordBoundaries = parsed.wordBoundaries;
    this._challengeCurrentWord = 0;

    // 初始化答案数组（固定长度，null 表示未填）
    this._challengeAnswer = new Array(this._challengeLetterCount).fill(null);

    // 渲染拼写格（基于 cell 数组）
    this._renderSpellingSlots();

    // 渲染字母按钮（只取字母字符）
    this._renderLetterButtons(word.en);

    // 清空反馈
    const fb = document.getElementById('challengeFeedback');
    fb.style.display = 'none';
    fb.className = 'challenge-feedback';
    fb.innerHTML = '';

    // 启用提交按钮
    document.getElementById('challengeSubmit').disabled = false;
  },

  /** 渲染拼写格子（基于 _challengeCells，标点/空格固定显示） */
  _renderSpellingSlots() {
    const container = document.getElementById('spellingSlots');
    let html = '';
    for (const cell of this._challengeCells) {
      if (cell.type === 'fixed') {
        if (cell.char === ' ') {
          html += `<span class="slot-fixed slot-space">&nbsp;</span>`;
        } else {
          html += `<span class="slot-fixed">${this._escapeHtml(cell.char)}</span>`;
        }
      } else {
        html += `<span class="slot" data-slot-idx="${cell.slotIdx}">_</span>`;
      }
    }
    container.innerHTML = html;
    this._updateActiveWordHighlight();
  },

  /** 渲染字母按钮（只取字母字符，空格/标点不进入字母池） */
  _renderLetterButtons(en) {
    const container = document.getElementById('letterGrid');
    // 只取字母字符，保留原始大小写
    const letters = en.split('').filter(ch => /[a-zA-Z]/.test(ch));

    // 2-4 个干扰字母（大小写与单词匹配）
    const distCount = 2 + Math.floor(Math.random() * 3);
    const distractors = this._getDistractors(en, distCount);

    // 生成带唯一 ID 的按钮数据
    let idCounter = 0;
    const items = [
      ...letters.map(ch => ({ letter: ch, id: idCounter++ })),
      ...distractors.map(ch => ({ letter: ch, id: idCounter++ }))
    ];
    this._shuffleArray(items);

    container.innerHTML = items.map(item =>
      `<button class="btn letter-btn" data-letter="${item.letter}" data-btn-id="${item.id}">${item.letter}</button>`
    ).join('');
  },

  /** 点击字母按钮（自动填入当前单词的下一个空位 + 自动跳转下一单词） */
  _onChallengeLetterClick(btn) {
    // 找到当前单词中第一个空位
    const start = this._challengeWordBoundaries[this._challengeCurrentWord];
    const end = this._challengeWordBoundaries[this._challengeCurrentWord + 1];

    let targetSlot = -1;
    for (let i = start; i < end; i++) {
      if (this._challengeAnswer[i] == null) {
        targetSlot = i;
        break;
      }
    }
    if (targetSlot === -1) return; // 当前单词已满（安全兜底）

    this._challengeAnswer[targetSlot] = {
      letter: btn.dataset.letter,
      btnId: parseInt(btn.dataset.btnId)
    };
    btn.disabled = true;
    this._updateSlots();

    // 自动跳转：当前单词全部填满 → 移到下一个单词
    const nextEmpty = this._challengeAnswer.findIndex((v, i) => v == null && i >= start && i < end);
    if (nextEmpty === -1 && this._challengeCurrentWord < this._challengeWordBoundaries.length - 2) {
      this._challengeCurrentWord++;
    }
  },

  /** 点击已填格子 → 删除该字母（通过 slotIdx 精准定位） */
  _removeLetterFromAnswer(slotIdx) {
    const entry = this._challengeAnswer[slotIdx];
    if (!entry) return;

    // 通过唯一 btnId 精准恢复对应的按钮
    const btn = document.querySelector(`.letter-btn[data-btn-id="${entry.btnId}"]`);
    if (btn) btn.disabled = false;

    this._challengeAnswer[slotIdx] = null;

    // 若删除的字母属于更早的单词，回退当前单词指针
    const wordIdx = this._findWordForSlot(slotIdx);
    if (wordIdx >= 0 && wordIdx < this._challengeCurrentWord) {
      this._challengeCurrentWord = wordIdx;
    }

    this._updateSlots();
  },

  /** 刷新拼写格显示（基于 _challengeCells 逐格更新） */
  _updateSlots() {
    const container = document.getElementById('spellingSlots');
    const slotNodes = container.querySelectorAll('.slot');
    let domIdx = 0;
    for (const cell of this._challengeCells) {
      if (cell.type === 'fixed') continue;
      const el = slotNodes[domIdx++];
      if (!el) continue;
      const entry = this._challengeAnswer[cell.slotIdx];
      const filled = entry != null;
      el.textContent = filled ? entry.letter : '_';
      el.classList.toggle('slot-filled', filled);
    }
    this._updateActiveWordHighlight();
  },

  /** 高亮当前正在拼写的单词，锁定已完成的单词 */
  _updateActiveWordHighlight() {
    const container = document.getElementById('spellingSlots');
    const allSlots = container.querySelectorAll('.slot');
    const cells = this._challengeCells;

    // 构建每个单词对应的 DOM index 范围
    const wordSlotRanges = [];
    let domIdx = 0;
    for (const cell of cells) {
      if (cell.type === 'fixed') continue;
      const wIdx = this._findWordForSlot(cell.slotIdx);
      if (!wordSlotRanges[wIdx]) wordSlotRanges[wIdx] = { start: domIdx, end: domIdx };
      wordSlotRanges[wIdx].end = domIdx + 1;
      domIdx++;
    }

    allSlots.forEach(el => el.classList.remove('slot-active', 'slot-locked'));

    for (let w = 0; w < wordSlotRanges.length; w++) {
      const range = wordSlotRanges[w];
      if (!range) continue;
      for (let i = range.start; i < range.end; i++) {
        const el = allSlots[i];
        if (!el) continue;
        if (w < this._challengeCurrentWord) {
          el.classList.add('slot-locked');
        } else if (w === this._challengeCurrentWord) {
          el.classList.add('slot-active');
        }
      }
    }
  },

  /** 将 en 解析为 cell 数组 + 单词边界 + 字母总数 */
  _parseWord(en) {
    const cells = [];
    const wordBoundaries = [];
    let letterCount = 0;
    let inWord = false;

    for (let i = 0; i < en.length; i++) {
      const ch = en[i];
      if (/[a-zA-Z]/.test(ch)) {
        cells.push({ type: 'letter', char: ch, slotIdx: letterCount });
        if (!inWord) {
          wordBoundaries.push(letterCount);
          inWord = true;
        }
        letterCount++;
      } else {
        cells.push({ type: 'fixed', char: ch });
        if (ch === ' ') {
          inWord = false;
        }
        // 非空格固定字符（撇号、连字符、标点）不重置单词状态
      }
    }

    wordBoundaries.push(letterCount);
    return { cells, wordBoundaries, letterCount };
  },

  /** 根据 slotIdx 查找所属单词索引 */
  _findWordForSlot(slotIdx) {
    const bounds = this._challengeWordBoundaries;
    for (let w = 0; w < bounds.length - 1; w++) {
      if (slotIdx >= bounds[w] && slotIdx < bounds[w + 1]) {
        return w;
      }
    }
    return -1;
  },

  /** 生成干扰字母（只根据字母字符判断，忽略空格/标点） */
  _getDistractors(en, count) {
    const letters = en.split('').filter(ch => /[a-zA-Z]/.test(ch));
    const hasUpper = letters.some(ch => ch !== ch.toLowerCase());
    const alpha = hasUpper
      ? 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
      : 'abcdefghijklmnopqrstuvwxyz'.split('');
    const used = new Set(letters);
    const avail = alpha.filter(l => !used.has(l));
    return this._shuffleArray(avail).slice(0, count);
  },

  /** 提交答案 */
  _onChallengeSubmit() {
    const submitBtn = document.getElementById('challengeSubmit');
    if (submitBtn.disabled) return; // 已提交过

    const word = this._challengeWords[this._challengeIndex];
    // 从稀疏答案数组按顺序提取字母
    const answer = this._challengeAnswer
      .filter(v => v != null)
      .map(e => e.letter)
      .join('');
    const feedback = document.getElementById('challengeFeedback');

    // 禁止进一步操作 + 禁用剩余字母按钮
    submitBtn.disabled = true;
    document.querySelectorAll('.letter-btn').forEach(b => { b.disabled = true; });

    // 大小写敏感比较：只比较字母部分，忽略空格/标点
    const expected = word.en.replace(/[^a-zA-Z]/g, '');
    const isCorrect = answer === expected;

    if (isCorrect) {
      this._challengeScore++;
      feedback.className = 'challenge-feedback feedback-correct';
      feedback.innerHTML = `🎉 正确！<br><strong>${this._escapeHtml(word.en)}</strong>`;
      feedback.style.display = 'block';
      setTimeout(() => this._nextChallenge(), 1200);
    } else {
      feedback.className = 'challenge-feedback feedback-wrong';
      feedback.innerHTML = `❌ 拼写错误<br>正确答案：<strong>${this._escapeHtml(word.en)}</strong>`;
      feedback.style.display = 'block';
      setTimeout(() => this._nextChallenge(), 2000);
    }
  },

  /** 进入下一题 */
  _nextChallenge() {
    this._challengeIndex++;
    if (this._challengeIndex >= this._challengeWords.length) {
      this._showChallengeComplete();
      return;
    }
    this._renderChallengeQuestion();
  },

  /** 显示完成页 */
  _showChallengeComplete() {
    document.getElementById('challengeGameContent').style.display = 'none';

    const total = this._challengeWords.length;
    const correct = this._challengeScore;
    const score = total > 0 ? Math.round((correct / total) * 100) : 0;

    document.getElementById('completeTotal').textContent = total;
    document.getElementById('completeCorrect').textContent = correct;
    document.getElementById('completeScore').textContent = score;

    document.getElementById('challengeComplete').style.display = 'block';
  },

  _buildWordCard(word, key, status, index) {
    return `
      <div class="word-card status-${status}" data-word-key="${key}" style="animation-delay:${(index % 10) * 0.02}s">
        <div class="word-top">
          <span class="word-en">${this._escapeHtml(word.en)}</span>
          <button class="btn btn-play" data-word="${this._escapeAttr(word.en)}" title="点击播放发音">🔊</button>
        </div>
        ${word.phonetic ? `<div class="word-phonetic">${this._escapeHtml(word.phonetic)}</div>` : ''}
        <div class="word-cn">${this._escapeHtml(word.cn)}</div>
        <div class="word-actions">
          <button class="btn btn-status ${status === 'unlearned' ? 'active-unlearned' : ''}" data-key="${this._escapeAttr(key)}" data-status="unlearned">📖 未学习</button>
          <button class="btn btn-status ${status === 'learning' ? 'active-learning' : ''}" data-key="${this._escapeAttr(key)}" data-status="learning">🔄 学习中</button>
          <button class="btn btn-status ${status === 'mastered' ? 'active-mastered' : ''}" data-key="${this._escapeAttr(key)}" data-status="mastered">✅ 已掌握</button>
        </div>
      </div>`;
  },

  // ============================================
  // 发音
  // ============================================

  /** 单次播放（小喇叭点击） */
  playAudio(word) {
    console.log('[StudyApp] 正在播放:', word);
    speakText(word);
    this._animatePlayButton(word);
  },

  _animatePlayButton(word) {
    document.querySelectorAll('.btn-play').forEach(btn => {
      if (btn.dataset.word === word) { btn.classList.add('playing'); setTimeout(() => btn.classList.remove('playing'), 800); }
    });
  },

  // ============================================
  // 学习状态
  // ============================================

  setStatus(key, status) {
    if (status === 'unlearned') delete this.learningStatus[key];
    else this.learningStatus[key] = status;
    this.saveLearningStatus();

    const card = document.querySelector(`.word-card[data-word-key="${CSS.escape(key)}"]`);
    if (card) {
      card.className = `word-card status-${status}`;
      card.querySelectorAll('.btn-status').forEach(btn => {
        btn.classList.remove('active-learning', 'active-mastered', 'active-unlearned');
        if (btn.dataset.status === status) btn.classList.add(`active-${status}`);
      });
    }

    this._updateProgress();
  },

  // ============================================
  // 进度
  // ============================================

  _updateProgress() {
    const words = DataStore.getCategoryWords(this.currentSubject, this.currentCategoryId);
    const total = words.length;
    const mastered = words.filter(w => this.learningStatus[w.key] === 'mastered').length;
    const pct = total > 0 ? Math.round((mastered / total) * 100) : 0;
    const fill = document.querySelector('.progress-fill');
    const text = document.querySelector('.progress-text');
    if (fill) fill.style.width = `${pct}%`;
    if (text) text.textContent = `${mastered}/${total} 已掌握`;
  },

  // ============================================
  // 工具
  // ============================================

  _getTodayString() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  },

  _shuffleArray(a) {
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random()*(i+1)); [a[i],a[j]] = [a[j],a[i]]; }
    return a;
  },

  _escapeAttr(s) { return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); },
  _escapeHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); },

  _showToast(msg) {
    const old = document.querySelector('.toast');
    if (old) old.remove();
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    t.style.cssText = 'position:fixed;bottom:30px;left:50%;transform:translateX(-50%);background:#1E293B;color:#fff;padding:12px 24px;border-radius:8px;font-size:.9rem;z-index:1000;box-shadow:0 4px 12px rgba(0,0,0,.2);animation:fadeIn .3s ease';
    document.body.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s ease'; setTimeout(() => t.remove(), 300); }, 2500);
  },

  // ============================================
  // 资料下载
  // ============================================

  _openDownloadModal() {
    const overlay = document.getElementById('downloadOverlay');
    if (!overlay) return;
    overlay.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    this._loadDownloadList();
  },

  _closeDownloadModal() {
    const overlay = document.getElementById('downloadOverlay');
    if (!overlay) return;
    overlay.style.display = 'none';
    document.body.style.overflow = '';
  },

  async _loadDownloadList() {
    const listEl = document.getElementById('downloadList');
    listEl.innerHTML = '<div class="download-loading">⏳ 加载中...</div>';

    // 检查是否通过 HTTP 访问
    if (window.location.protocol === 'file:') {
      listEl.innerHTML = '<div class="download-error"><span class="download-error-icon">⚠️</span>请通过本地服务器运行网页<br><span style="font-size:0.78rem;color:var(--gray-400)">例如: python3 -m http.server 8080</span></div>';
      return;
    }

    try {
      const resp = await fetch('downloads/files.json');
      if (!resp.ok) throw new Error('NOT_FOUND');

      let files;
      try { files = await resp.json(); } catch (e) {
        listEl.innerHTML = '<div class="download-error"><span class="download-error-icon">⚠️</span>资料配置错误</div>';
        return;
      }

      if (!Array.isArray(files) || files.length === 0) {
        listEl.innerHTML = '<div class="download-empty"><span class="download-empty-icon">📭</span>暂无下载资料</div>';
        return;
      }

      listEl.innerHTML = files.map((f, i) => `
        <div class="download-item">
          <span class="download-item-icon">📄</span>
          <div class="download-item-info">
            <div class="download-item-name">${this._escapeHtml(f.name || f.file)}</div>
            ${f.desc ? `<div class="download-item-desc">${this._escapeHtml(f.desc)}</div>` : ''}
          </div>
          <a class="download-link" href="downloads/${this._escapeAttr(f.file)}"
             download="${this._escapeAttr(f.name || f.file)}" data-idx="${i}">⬇ 下载</a>
        </div>
      `).join('');

      // 下载点击反馈
      listEl.querySelectorAll('.download-link').forEach(link => {
        link.addEventListener('click', (e) => {
          const name = link.getAttribute('download') || '文件';
          this._showToast(`正在下载: ${name}`);
        });
      });

    } catch (err) {
      if (err.message === 'NOT_FOUND') {
        listEl.innerHTML = '<div class="download-empty"><span class="download-empty-icon">📭</span>暂无下载资料</div>';
      } else {
        listEl.innerHTML = '<div class="download-error"><span class="download-error-icon">⚠️</span>资料加载失败</div>';
      }
    }
  },

  _bindDownloadEvents() {
    const closeBtn = document.getElementById('downloadClose');
    if (closeBtn) closeBtn.addEventListener('click', () => this._closeDownloadModal());

    const overlay = document.getElementById('downloadOverlay');
    if (overlay) {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) this._closeDownloadModal();
      });
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const ov = document.getElementById('downloadOverlay');
        if (ov && ov.style.display !== 'none') this._closeDownloadModal();
      }
    });
  }
};

// ============================================
// 全局 TTS 发音函数 —— 纯净离线版
// 仅使用浏览器原生 speechSynthesis，无网络请求
// ============================================

/**
 * 朗读指定的英文文本
 * - 每次播放前自动 cancel()，杜绝声音重叠
 * - 手机端语速 0.8，电脑端 0.9
 * - 返回 Promise，供自动跟读等待完成
 *
 * @param {string} text - 要朗读的英文文本
 * @returns {Promise<void>}
 */
function speakText(text) {
  return new Promise((resolve) => {
    if (!window.speechSynthesis) {
      console.warn('[speakText] 浏览器不支持 speechSynthesis');
      resolve();
      return;
    }

    // 1. 停止当前语音，避免重叠
    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'en-US';

    // 2. 移动端小扬声器 → 更慢语速
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    utterance.rate = isMobile ? 0.8 : 0.9;

    // 3. Promise 安全结束
    let resolved = false;
    const done = () => {
      if (resolved) return;
      resolved = true;
      resolve();
    };
    utterance.onend = done;
    utterance.onerror = done;

    // 4. 尝试选择高质量英语语音（不强制，找不到就用默认）
    const voices = window.speechSynthesis.getVoices();
    const preferred = voices.find(v =>
      v.name.includes('Google US English') ||
      v.name.includes('Samantha') ||
      v.name.includes('Microsoft Zira') ||
      v.name.includes('Microsoft David')
    ) || voices.find(v => v.lang.startsWith('en-US'))
      || voices.find(v => v.lang.startsWith('en'))
      || null;
    if (preferred) utterance.voice = preferred;

    // 5. 开读
    console.log('[speakText] 发音:', text, preferred ? `(语音: ${preferred.name})` : '(默认语音)');
    window.speechSynthesis.speak(utterance);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  StudyApp.init().catch(err => {
    console.error('[StudyApp] 初始化失败:', err);
    // 页面上显示全局错误提示
    const main = document.querySelector('.app-main');
    if (main) {
      main.innerHTML = `
        <div style="grid-column:1/-1;text-align:center;padding:80px 20px;color:#EF4444;">
          <div style="font-size:3rem;margin-bottom:16px;">⚠️</div>
          <h2 style="margin-bottom:8px;">数据加载失败</h2>
          <p style="color:#64748B;">请确保通过 HTTP 服务器访问（而非直接打开 HTML 文件），然后刷新重试。</p>
        </div>`;
    }
  });
});

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

  /** 已展开的组（显示其下的分类） */
  expandedGroups: new Set(),

  /** 自动跟读状态 */
  _isAutoPlaying: false,

  todayStr: '',

  // ============================================
  // 初始化（异步）
  // ============================================

  async init() {
    this.todayStr = this._getTodayString();
    this._currentAudio = null;  // 当前播放中的 mp3（播下一个词前停掉）
    this._audioCtx = null;      // 已解锁的 AudioContext（移动端自动播放绕过）

    this._bindEvents();
    this._bindHeaderActions();
    this._bindChallengeEvents();
    this._bindDownloadEvents();

    // 注：小学分组默认展开改到「无记忆」分支处理，
    // 有记忆时按上次保存的展开状态恢复，不强制展开小学

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

    // ---- 加载单词详情数据（记忆方法、例句等） ----
    this._wordDetailData = {};
    try {
      const resp = await fetch('data/word_details_7a.json');
      if (resp.ok) {
        const detailData = await resp.json();
        this._wordDetailData = detailData.words || {};
        console.log('[StudyApp] 单词详情数据已加载:', Object.keys(this._wordDetailData).length, '个词');
      }
    } catch (err) {
      console.warn('[StudyApp] 单词详情数据加载失败(不影响基本功能):', err);
    }

    // ---- 加载 Cambridge 词典数据（IPA 音标等） ----
    // 7a 先加载，其余年级文件只补缺不覆盖（重叠词保留 7a 数据，不影响 7A 已有体验）
    this._cambridgeData = {};
    try {
      const resp = await fetch('data/cambridge_7a.json');
      if (resp.ok) {
        const cambridgeData = await resp.json();
        this._cambridgeData = cambridgeData.words || {};
        console.log('[StudyApp] Cambridge 数据已加载:', Object.keys(this._cambridgeData).length, '个词');
      }
    } catch (err) {
      console.warn('[StudyApp] Cambridge 数据加载失败(不影响基本功能):', err);
    }
    try {
      const resp = await fetch('data/cambridge_7b.json');
      if (resp.ok) {
        const cambridgeData = await resp.json();
        const words = cambridgeData.words || {};
        for (const [word, entry] of Object.entries(words)) {
          if (!(word in this._cambridgeData)) this._cambridgeData[word] = entry;
        }
        console.log('[StudyApp] Cambridge 7B 数据已合并:', Object.keys(words).length, '个词');
      }
    } catch (err) {
      console.warn('[StudyApp] Cambridge 7B 数据加载失败(不影响基本功能):', err);
    }

    this._renderHeader();
    this._renderSidebar();

    // 更新 SRS 到期徽章
    this._updateSRSBadge();

    // 恢复上次选中的分类（localStorage 记忆）
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem('app_last_category') || 'null');
    } catch (e) { /* 忽略解析失败 */ }

    if (saved && saved.subject && saved.groupId && saved.categoryId
        && DataStore.getGroup(saved.subject, saved.groupId)) {
      // 恢复分组展开状态
      if (Array.isArray(saved.expanded)) {
        saved.expanded.forEach(gid => this.expandedGroups.add(gid));
      }
      // 分组数据是按需异步加载的，先确保加载完成（否则词表会空白）
      let restored = true;
      try {
        await DataStore.loadGroup(saved.subject, saved.groupId);
      } catch (err) {
        console.warn('[StudyApp] 恢复分组加载失败:', err);
        restored = false;
      }
      // 加载后再校验分类仍存在（防止数据更新后分类被删），有效才恢复
      if (restored && DataStore.getCategory(saved.subject, saved.groupId, saved.categoryId)) {
        // 重新渲染侧边栏：让恢复的展开状态和分类列表生效（数据已加载）
        this._renderSidebar();
        this.selectCategory(saved.subject, saved.groupId, saved.categoryId);
        return;
      }
    }

    // 无记忆/记忆失效：默认展开小学 → 选中第一个分类
    this.expandedGroups.add('primary');
    this._renderSidebar();
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
        // 点击单词卡（非发音按钮）→ 打开详情
        const wordCard = e.target.closest('.word-card');
        if (wordCard && wordCard.dataset.wordKey) {
          const key = wordCard.dataset.wordKey;
          // key格式: categoryId_wordEn；分类 id 可能含下划线（如 grade7b_unit1），
          // 用最后一个下划线切分，单词名本身不含下划线
          const wordEn = key.substring(key.lastIndexOf('_') + 1);
          if (wordEn) {
            this._openWordDetail(wordEn);
          }
        }
      });
    }

    // 单词详情弹窗关闭按钮
    const closeBtn = document.getElementById('wordDetailClose');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => this._closeWordDetail());
    }
    // 点击遮罩关闭
    const overlay = document.getElementById('wordDetailOverlay');
    if (overlay) {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) this._closeWordDetail();
      });
    }
    // ESC键关闭
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this._closeWordDetail();
    });

  },

  // ============================================
  // 顶部全局操作按钮
  // ============================================

  _bindHeaderActions() {
    const srsBtn = document.getElementById('headerSrsBtn');
    if (srsBtn) srsBtn.addEventListener('click', () => this._startSRSReview());

    const dlBtn = document.getElementById('headerDownloadBtn');
    if (dlBtn) dlBtn.addEventListener('click', () => this._openDownloadModal());
  },

  /**
   * 更新顶部"今日复习"按钮上的到期数量徽章
   */
  _updateSRSBadge() {
    const btn = document.getElementById('headerSrsBtn');
    if (!btn) return;
    try {
      const allWords = DataStore.getAllWords();
      const dueCount = SRS.getDueWords(allWords).length;
      if (dueCount > 0) {
        btn.innerHTML = `🧠 今日复习 <span style="background:rgba(255,255,255,0.3);padding:1px 8px;border-radius:10px;font-size:.75rem;font-weight:700">${dueCount}</span>`;
      } else {
        btn.textContent = '🧠 今日复习';
      }
    } catch (e) {
      // 数据未就绪时静默跳过
    }
  },

  // ============================================
  // 侧边栏 —— 三级树形导航
  // ============================================

  _renderSidebar() {
    const container = document.getElementById('sidebarNav');
    const groups = DataStore.getGroups('english');

    let html = `<ul class="tree-list">`;
    groups.forEach(group => {
      const isGrpExpanded = this.expandedGroups.has(group.id);
      const cats = DataStore.getGroupCategories('english', group.id);
      const hasChildren = group.dataFile || cats.length > 0;
      const isActiveGroup = this.currentGroupId === group.id;

      html += `
        <li class="tree-item group-item${isActiveGroup ? ' active-group' : ''}"
            data-subject="english" data-group-id="${group.id}">
          <div class="group-row">
            <span class="tree-toggle ${isGrpExpanded ? 'expanded' : ''}">${hasChildren ? (isGrpExpanded ? '▾' : '▸') : ''}</span>
            <span class="group-icon">${group.icon}</span>
            <span class="group-name">${group.name}</span>
          </div>
          <ul class="cat-list${isGrpExpanded && cats.length ? '' : ' collapsed'}">
            ${this._renderCatList('english', group.id, cats)}
          </ul>
        </li>`;
    });
    html += '</ul>';
    container.innerHTML = html;
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

    // 确保分组展开
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
    this._renderCategoryWords(subjId, groupId, catId);

    // 记住选中状态与分组展开状态，下次打开自动恢复
    try {
      localStorage.setItem('app_last_category', JSON.stringify({
        subject: subjId,
        groupId,
        categoryId: catId,
        expanded: Array.from(this.expandedGroups)
      }));
    } catch (e) { /* 存储失败不影响功能 */ }
  },

  // ============================================
  // Header 联动
  // ============================================

  _renderHeader() {
    const subject = DataStore.getSubject(this.currentSubject);
    const group = DataStore.getGroup(this.currentSubject, this.currentGroupId);
    const category = DataStore.getCategory(this.currentSubject, this.currentGroupId, this.currentCategoryId);

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
  _renderCategoryWords(subjId, groupId, catId) {
    console.log(`[StudyApp] _renderCategoryWords: subj=${subjId}, group=${groupId}, catId=${catId}`);

    const container = document.getElementById('wordGrid');
    const category = DataStore.getCategory(subjId, groupId, catId);
    const words = DataStore.getCategoryWords(subjId, groupId, catId);

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

    const events = Tracker.getEvents();
    container.innerHTML = words.map((word, index) => {
      const key = word.key;
      const progress = getWordProgress(word.en, events);
      return this._buildWordCard(word, key, progress, index);
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

    actions.appendChild(playBtn);
    actions.appendChild(challengeBtn);

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
  /**
   * 解锁音频播放：在用户手势内创建/恢复 AudioContext。
   * 之后经该 context 播放的音频不再受移动端自动播放策略限制（默认约 5s 手势窗口）。
   * 须在按钮点击等用户手势中调用才有效。
   */
  _unlockAudio() {
    try {
      if (!this._audioCtx) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        this._audioCtx = new Ctx();
      }
      if (this._audioCtx.state === 'suspended') {
        this._audioCtx.resume();
      }
    } catch (e) {
      console.warn('[StudyApp] AudioContext 解锁失败:', e);
    }
  },

  /**
   * 统一播放单词发音：本地 Cambridge MP3（英式 UK）优先，缺失或失败回退 TTS。
   * 每个词总超时 8s 兜底：移动端自动播放限制下 play() 可能无限挂起，超时强制继续，跟读不会卡死。
   * @param {string} word
   * @returns {Promise<void>} 播放完成（或兜底朗读完成/超时）时 resolve
   */
  _playWordAudio(word) {
    const entry = this._cambridgeData ? this._cambridgeData[word] : null;

    // 播下一个词前，停掉上一个未结束的 mp3（防声音重叠）
    if (this._currentAudio) {
      try { this._currentAudio.pause(); } catch (e) {}
      this._currentAudio = null;
    }

    // 超时兜底：任何播放路径最多等 8 秒
    const withTimeout = (p) => Promise.race([
      p,
      new Promise(r => setTimeout(() => {
        console.warn('[StudyApp] 播放超时(8s)，跳过:', word);
        r();
      }, 8000))
    ]);

    if (!entry || !entry.audio_uk) {
      // 无 Cambridge 音频的词（含其他年级）：用原 TTS 方案
      return withTimeout(speakText(word));
    }

    // 播放 mp3 前停掉 TTS，防止声音重叠
    window.speechSynthesis && window.speechSynthesis.cancel();

    // 本地文件命名：单词转小写、非字母数字转下划线（与抓取脚本 safe_filename 一致）
    const fileName = word.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'word';
    const src = `audio/${fileName}_uk.mp3`;

    const playPromise = new Promise((resolve) => {
      const audio = new Audio(src);
      this._currentAudio = audio;

      // 若 AudioContext 已解锁（用户手势内 resume 过），经它播放可绕过自动播放限制
      if (this._audioCtx && this._audioCtx.state === 'running') {
        try {
          const node = this._audioCtx.createMediaElementSource(audio);
          node.connect(this._audioCtx.destination);
        } catch (e) {
          console.warn('[StudyApp] 接入 AudioContext 失败，走普通播放:', e);
        }
      }

      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (this._currentAudio === audio) this._currentAudio = null;
        resolve();
      };
      const fallback = () => {
        if (settled) return;
        settled = true;
        console.warn('[StudyApp] mp3 播放失败，回退 TTS:', word);
        if (this._currentAudio === audio) this._currentAudio = null;
        speakText(word).then(resolve);  // 外层 withTimeout 兜底
      };
      audio.onended = finish;
      audio.onerror = fallback;
      audio.play().catch(fallback);
    });

    return withTimeout(playPromise);
  },

  /**
   * Promise 化的语音播放 —— 用于自动跟读循环
   */
  _playAudioAsync(word) {
    Tracker.track('play_audio', {
      wordId: word,
      word: word,
      categoryId: this.currentCategoryId,
      source: 'auto_play'
    });
    return this._playWordAudio(word);
  },

  /**
   * 开始循环跟读
   */
  async _startAutoPlay() {
    if (this._isAutoPlaying) return;
    this._unlockAudio();  // 用户手势内解锁音频（移动端自动播放绕过）
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

    const category = DataStore.getCategory(this.currentSubject, this.currentGroupId, this.currentCategoryId);
    let words = DataStore.getCategoryWords(this.currentSubject, this.currentGroupId, this.currentCategoryId);

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
    this._challengeCombo = 0;     // 当前连续答对
    this._challengeMaxCombo = 0;  // 本次最高连续答对
    this._challengeIsSRS = false; // 普通挑战非 SRS 模式
    this._challengeRound = 1;     // 基础轮
    this._challengeWrongWords = []; // 记录基础轮答错的词
    this._originalChallengeWords = words; // 保存原始词列表用于最终统计

    // 隐藏完成页、显示游戏区
    document.getElementById('challengeComplete').style.display = 'none';
    document.getElementById('challengeGameContent').style.display = 'block';

    // 渲染第一题
    this._renderChallengeQuestion();

    // 记录闯关开始
    Tracker.track('challenge_start', {
      categoryId: this.currentCategoryId,
      wordCount: words.length
    });

    overlay.style.display = 'flex';
    document.body.style.overflow = 'hidden';
  },

  /**
   * 启动 SRS 今日复习挑战
   * @param {Array} words - 待复习的单词列表
   */
  _openSRSReview(words, todos) {
    const overlay = document.getElementById('challengeOverlay');
    if (!overlay) return;

    this._stopAutoPlay();

    if (!words || !words.length) {
      this._showToast('没有待复习的单词');
      return;
    }

    words = this._shuffleArray([...words]);

    // 更新弹窗头部（SRS 模式）
    document.getElementById('challengeCategory').textContent = '🧠 今日复习';
    const dueCount = todos?.due?.length || 0;
    document.getElementById('challengeWordCount').textContent =
      dueCount > 0 ? `${dueCount} 个到期单词` : `${words.length} 个单词`;

    // 初始化游戏状态
    this._challengeWords = words;
    this._challengeIndex = 0;
    this._challengeAnswer = [];
    this._challengeScore = 0;
    this._challengeCombo = 0;
    this._challengeMaxCombo = 0;
    this._challengeIsSRS = true;   // ← SRS 标记
    this._challengeRound = 1;

    document.getElementById('challengeComplete').style.display = 'none';
    document.getElementById('challengeGameContent').style.display = 'block';

    this._renderChallengeQuestion();

    Tracker.track('srs_review_start', { wordCount: words.length });

    overlay.style.display = 'flex';
    document.body.style.overflow = 'hidden';
  },

  /**
   * 关闭默写挑战弹窗
   */
  _closeChallenge() {
    // 记录中途退出（已开始但未完成）
    if (this._challengeWords && this._challengeIndex > 0 && this._challengeIndex < this._challengeWords.length) {
      Tracker.track('challenge_quit', {
        categoryId: this.currentCategoryId,
        completedCount: this._challengeIndex,
        totalQuestions: this._challengeWords.length
      });
    }

    // SRS 标记复位
    this._challengeIsSRS = false;

    // 清理重练相关状态，防止下次打开挑战时残留
    this._challengeRound = 1;
    this._challengeCombo = 0;
    this._challengeMaxCombo = 0;
    this._challengeWrongWords = [];
    this._originalChallengeWords = null;

    const overlay = document.getElementById('challengeOverlay');
    if (!overlay) return;
    overlay.style.display = 'none';
    document.body.style.overflow = '';
    this._updateSRSBadge();
  },

  /** 绑定默写挑战弹窗事件 */
  _bindChallengeEvents() {
    // 关闭按钮
    const closeBtn = document.getElementById('challengeClose');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        // 已完成 → 直接关闭，不需要确认
        if (this._challengeIndex >= (this._challengeWords?.length || 0)) {
          this._closeChallenge();
          return;
        }
        if (window.confirm('休息一下？\n\n下次可以继续挑战。\n\n确定退出吗？')) {
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
          // 已完成 → 直接关闭，不需要确认
          if (this._challengeIndex >= (this._challengeWords?.length || 0)) {
            this._closeChallenge();
            return;
          }
          if (window.confirm('休息一下？\n\n下次可以继续挑战。\n\n确定退出吗？')) {
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
        Tracker.track('play_audio', {
          wordId: word,
          word: word,
          categoryId: StudyApp.currentCategoryId,
          source: 'challenge'
        });
        speakText(word);
        btn.classList.remove('playing');
        void btn.offsetWidth;
        btn.classList.add('playing');
        setTimeout(() => btn.classList.remove('playing'), 600);
      });
    }

    // 完成页：错词重练按钮
    const retryBtn = document.getElementById('completeRetryBtn');
    if (retryBtn) {
      retryBtn.addEventListener('click', () => {
        const wrongWords = this._challengeWrongWords;
        if (!wrongWords || wrongWords.length === 0) {
          this._showToast('没有错词需要重练');
          return;
        }

        // 关闭完成页 → 用错词重新开启挑战
        this._challengeWords = this._shuffleArray([...wrongWords]);
        this._challengeIndex = 0;
        this._challengeAnswer = [];
        this._challengeScore = 0;
        this._challengeCombo = 0;
        this._challengeMaxCombo = 0;
        this._challengeRound = 2; // 重练轮

        document.getElementById('challengeComplete').style.display = 'none';

        // 更新头部
        const catEl = document.getElementById('challengeCategory');
        if (catEl) catEl.textContent = '🔁 错词重练';
        const cntEl = document.getElementById('challengeWordCount');
        if (cntEl) cntEl.textContent = `${wrongWords.length} 个单词`;

        document.getElementById('challengeGameContent').style.display = 'block';
        this._renderChallengeQuestion();
      });
    }

    // 完成页：继续学习按钮
    const continueBtn = document.getElementById('completeContinueBtn');
    if (continueBtn) {
      continueBtn.addEventListener('click', () => this._closeChallenge());
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
      // ---- Combo 逻辑 ----
      this._challengeCombo++;
      if (this._challengeCombo > this._challengeMaxCombo) {
        this._challengeMaxCombo = this._challengeCombo;
      }

      this._challengeScore++;

      // ---- 正确反馈文案 ----
      let comboHtml = '';
      if (this._challengeCombo >= 5) {
        comboHtml = `<div class="combo-line combo-fire">🔥 太棒了！连续正确 ${this._challengeCombo} 题！🔥</div>`;
      } else if (this._challengeCombo >= 2) {
        comboHtml = `<div class="combo-line combo-warm">🔥 连对 ${this._challengeCombo} 题！</div>`;
      }

      feedback.className = 'challenge-feedback feedback-correct';
      feedback.innerHTML =
        `<div class="feedback-line">✅ 正确！<strong>${this._escapeHtml(word.en)}</strong></div>` +
        comboHtml;
      feedback.style.display = 'block';

      // ---- 分数浮动动画 ----
      this._showScorePop(10);

      setTimeout(() => this._nextChallenge(), 1200);
    } else {
      // 答错 → 重置 combo
      this._challengeCombo = 0;

      // ---- 错误反馈文案 ----
      feedback.className = 'challenge-feedback feedback-wrong';
      feedback.innerHTML =
        `<div class="feedback-line">❌ 再想想</div>` +
        `<div class="feedback-answer">正确答案：<strong>${this._escapeHtml(word.en)}</strong> · 📝 已计入后续复习</div>`;
      feedback.style.display = 'block';

      setTimeout(() => this._nextChallenge(), 2200);
    }

    // 只有基础轮才记录到 Tracker 和 SRS；重练轮纯粹是当天强化练习，不落地任何数据
    if (this._challengeRound === 1) {
      // 记录本次答题
      Tracker.track('challenge_answer', {
        categoryId: this.currentCategoryId,
        wordId: word.en,
        word: word.en,
        isCorrect: isCorrect,
        questionIndex: this._challengeIndex,
        totalQuestions: this._challengeWords.length
      });

      // 记录到 SRS 间隔重复系统
      try { SRS.recordAnswer(word.en, isCorrect); } catch (e) {
        console.warn('[SRS] 记录失败:', e);
      }

      if (!isCorrect) {
        this._challengeWrongWords.push(word);
      }
    }
  },

  /** 显示分数浮动动画 */
  _showScorePop(points) {
    const feedback = document.getElementById('challengeFeedback');
    if (!feedback) return;
    const old = feedback.querySelector('.score-pop');
    if (old) old.remove();

    const pop = document.createElement('div');
    pop.className = 'score-pop';
    pop.textContent = `+${points}`;
    feedback.appendChild(pop);

    // 动画结束后自动移除 DOM
    pop.addEventListener('animationend', () => pop.remove(), { once: true });
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

    // Round 1: 全量统计；Round 2: 按错词范围统计
    const total = this._challengeRound === 1
      ? (this._originalChallengeWords ? this._originalChallengeWords.length : this._challengeWords.length)
      : this._challengeWords.length;
    const correct = this._challengeScore;
    const score = total > 0 ? Math.round((correct / total) * 100) : 0;

    // ---- 星级评价 ----
    let starCount = 0;
    let starComment = '';
    if (score >= 90) {
      starCount = 5;
      starComment = '🌟 太棒了！词汇达人！';
    } else if (score >= 80) {
      starCount = 4;
      starComment = '👏 很棒！继续加油！';
    } else if (score >= 60) {
      starCount = 3;
      starComment = '💪 不错哦！再接再厉！';
    } else {
      starCount = 2;
      starComment = '📖 继续练习，会更好的！';
    }
    const starsHtml = '★'.repeat(starCount) + '☆'.repeat(5 - starCount);

    // 更新 UI
    document.getElementById('completeTotal').textContent = total;
    document.getElementById('completeCorrect').textContent = correct;
    document.getElementById('completeScore').textContent = score;
    document.getElementById('completeStars').textContent = starsHtml;
    document.getElementById('completeStarComment').textContent = starComment;
    document.getElementById('completeMaxCombo').textContent = this._challengeMaxCombo;

    // ---- 错词重练按钮 ----
    const retryBtn = document.getElementById('completeRetryBtn');
    const hasWrongWords = this._challengeWrongWords.length > 0 && this._challengeRound !== 2;
    if (retryBtn) {
      retryBtn.style.display = hasWrongWords ? 'inline-flex' : 'none';
      retryBtn.textContent = `🔁 重新挑战错词 (${this._challengeWrongWords.length})`;
    }

    // 记录闯关完成
    Tracker.track('challenge_complete', {
      categoryId: this.currentCategoryId,
      totalQuestions: total,
      correctCount: correct,
      score: score
    });

    document.getElementById('challengeComplete').style.display = 'block';

    // SRS 复习结束后更新徽章
    if (this._challengeIsSRS) {
      this._challengeIsSRS = false;
      this._updateSRSBadge();
    }
  },

  _buildWordCard(word, key, progress, index) {
    const stars = this._renderStars(progress.masteryScore);
    const lastStudy = progress.lastStudyTime ? this._formatRelativeTime(progress.lastStudyTime) : null;

    let statsHtml = '';
    if (progress.audioCount > 0 || progress.challengeCount > 0) {
      const parts = [];
      if (progress.audioCount > 0) parts.push(`<span class="stat-item">🎧 <span class="stat-value">${progress.audioCount}</span>次</span>`);
      if (progress.challengeCount > 0) parts.push(`<span class="stat-item">✍️ <span class="stat-value">${progress.challengeCount}</span>次挑战</span>`);
      if (progress.challengeCount > 0) parts.push(`<span class="stat-item">✅ <span class="stat-value">${progress.correctRate}%</span>正确率</span>`);
      statsHtml = `<div class="word-stats">${parts.join('')}</div>`;
    }

    const lastStudyHtml = lastStudy ? `<div class="word-last-study">最近学习：${lastStudy}</div>` : '';

    // 音标区：左"课本"框（现有 phonetic）+ 右"IPA"框（Cambridge UK 音标，缺失则隐藏）
    const cambridgeEntry = this._cambridgeData ? this._cambridgeData[word.en] : null;
    const ipaUk = cambridgeEntry && cambridgeEntry.phonetic_uk ? cambridgeEntry.phonetic_uk : null;
    let phoneticHtml = '';
    if (word.phonetic || ipaUk) {
      phoneticHtml = `<div class="word-phonetic-row">
        ${word.phonetic ? `<div class="phonetic-box phonetic-book"><span class="phonetic-label">📖 课本</span><span class="phonetic-text">${this._escapeHtml(word.phonetic)}</span></div>` : ''}
        ${ipaUk ? `<div class="phonetic-box phonetic-ipa"><span class="phonetic-label"><img src="images/QQ20260808-202004.png" alt="IPA" class="phonetic-icon"> IPA</span><span class="phonetic-text">${this._escapeHtml(ipaUk)}</span></div>` : ''}
      </div>`;
    }

    return `
      <div class="word-card" data-word-key="${key}" style="animation-delay:${(index % 10) * 0.02}s">
        <div class="word-top">
          <span class="word-en">${this._escapeHtml(word.en)}</span>
          <button class="btn btn-play" data-word="${this._escapeAttr(word.en)}" title="点击播放发音">🔊</button>
        </div>
        ${phoneticHtml}
        <div class="word-cn">${this._escapeHtml(word.cn)}</div>
        <div class="word-mastery">
          <div class="mastery-stars">${stars}</div>
          ${statsHtml}
          ${lastStudyHtml}
        </div>
      </div>`;
  },

  // ============================================
  // 发音
  // ============================================

  /** 单次播放（小喇叭点击） */
  playAudio(word) {
    console.log('[StudyApp] 正在播放:', word);
    this._unlockAudio();  // 用户手势内解锁音频（移动端自动播放绕过）
    Tracker.track('play_audio', {
      wordId: word,
      word: word,
      categoryId: this.currentCategoryId,
      source: 'word_card'
    });
    this._playWordAudio(word);
    this._animatePlayButton(word);
  },

  _animatePlayButton(word) {
    document.querySelectorAll('.btn-play').forEach(btn => {
      if (btn.dataset.word === word) { btn.classList.add('playing'); setTimeout(() => btn.classList.remove('playing'), 800); }
    });
  },

  // ============================================
  // 工具
  // ============================================

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

  /**
   * 根据熟练度分数渲染星级
   * @param {number} score 0-100
   * @returns {string} HTML
   */
  _renderStars(score) {
    const filled = score > 80 ? 5 : score > 60 ? 4 : score > 40 ? 3 : score > 20 ? 2 : score > 0 ? 1 : 0;
    let html = '';
    for (let i = 0; i < 5; i++) {
      html += i < filled
        ? '<span class="star-filled">★</span>'
        : '<span class="star-empty">☆</span>';
    }
    return html;
  },

  /**
   * 将时间戳格式化为相对时间
   * @param {number} ts 毫秒时间戳
   * @returns {string}
   */
  _formatRelativeTime(ts) {
    const diff = Date.now() - ts;
    const seconds = Math.floor(diff / 1000);
    if (seconds < 60) return '刚刚';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}分钟前`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}小时前`;
    const days = Math.floor(hours / 24);
    if (days === 1) return '昨天';
    if (days < 7) return `${days}天前`;
    return new Date(ts).toLocaleDateString('zh-CN');
  },

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

  /**
   * 启动今日复习（SRS 模式）
   * TODO: 接入 SRS 算法模块后，替换为真正的到期单词筛选
   */
  _startSRSReview() {
    this._stopAutoPlay();

    // 清空当前分类选中态
    this.currentCategoryId = null;
    document.querySelectorAll('.cat-item.active').forEach(el => el.classList.remove('active'));

    try {
      const allWords = DataStore.getAllWords();
      console.log('[SRS] getAllWords count:', allWords.length);
      if (!allWords.length) {
        this._showToast('请先加载词汇数据');
        return;
      }

      const todos = SRS.getTodayTodos(allWords, { newLimit: 0 });
      console.log('[SRS] due words:', todos.due.length);

      if (todos.total === 0) {
        this._showToast('🎉 今日任务已完成，休息一下吧！');
        return;
      }

      // 到期词在前，新词在后
      const reviewWords = [...todos.due, ...todos.new];
      this._openSRSReview(reviewWords, todos);
    } catch (err) {
      console.error('[SRS] 今日复习出错:', err);
      this._showToast('出错：' + err.message);
    }
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
  },

  // ============================================
  // 单词详情弹窗
  // ============================================

  /**
   * 打开单词详情弹窗
   * @param {string} wordEn - 单词的英文（小写）
   */
  /**
   * 从词汇表查找单词的中文释义（用于无 word_details 数据的词）
   */
  _lookupCn(wordEn) {
    try {
      const groups = DataStore.getGroups('english') || [];
      const target = wordEn.toLowerCase();
      for (const g of groups) {
        const words = DataStore.getGroupWords('english', g.id) || [];
        const hit = words.find(w => w.en && w.en.toLowerCase() === target);
        if (hit && hit.cn) return hit.cn;
      }
    } catch (e) { /* 忽略查找失败 */ }
    return '';
  },

  _openWordDetail(wordEn) {
    const overlay = document.getElementById('wordDetailOverlay');
    const body = document.getElementById('wordDetailBody');
    if (!overlay || !body) return;

    // 显示用原始大小写，查询用小写
    const displayWord = wordEn;
    const lookupWord = wordEn.toLowerCase();
    const wordData = this._wordDetailData?.[lookupWord] || {};
    // 无详情数据的词：释义从词汇表补（例句/音标来自 Cambridge 数据）
    if (!wordData.cn) {
      wordData.cn = this._lookupCn(displayWord) || '';
    }
    const hasAnything = !!wordData.cn || !!(this._cambridgeData && this._cambridgeData[displayWord]);
    if (!hasAnything) {
      body.innerHTML = `<div class="detail-empty" style="text-align:center;padding:40px 0;">
        😅 暂无「${this._escapeHtml(displayWord)}」的详情数据</div>`;
      overlay.style.display = 'flex';
      return;
    }

    body.innerHTML = this._renderWordDetail(wordData, displayWord);
    overlay.style.display = 'flex';

    // 发音标签 → 播放单词发音
    const playTag = body.querySelector('.detail-tag-play');
    if (playTag) {
      playTag.addEventListener('click', () => this.playAudio(wordEn));
    }

    // 例句发音按钮 → TTS 朗读例句
    body.querySelectorAll('.detail-example-play').forEach(btn => {
      btn.addEventListener('click', () => speakText(btn.dataset.example));
    });

    // 例句展开/折叠
    const toggleBtn = body.querySelector('#detailExamplesToggle');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => {
        const more = body.querySelector('.detail-examples-more');
        const expanded = more.style.display !== 'none';
        more.style.display = expanded ? 'none' : 'block';
        toggleBtn.textContent = expanded
          ? `展开全部（${toggleBtn.dataset.total} 条）▾`
          : '收起 ▴';
      });
    }
  },

  /**
   * 渲染单词详情内容（移动端弹窗风格）
   */
  _renderWordDetail(wordData, wordEn) {
    const esc = (s) => this._escapeHtml(s);
    const cn = wordData.cn || '';
    const cambridgeEntry = this._cambridgeData ? this._cambridgeData[wordEn] : null;

    // 音标：优先 Cambridge UK（加方括号），缺则用详情数据
    const phonetic = cambridgeEntry && cambridgeEntry.phonetic_uk
      ? `[${cambridgeEntry.phonetic_uk}]`
      : (wordData.phonetic || '');
    const hasAudio = !!(cambridgeEntry && cambridgeEntry.audio_uk);

    // 例句：Cambridge 优先，详情数据兜底；兼容两种格式（旧字符串数组 / 新 {en,zh} 对象数组）
    const rawExamples = (cambridgeEntry && cambridgeEntry.examples && cambridgeEntry.examples.length)
      ? cambridgeEntry.examples
      : (wordData.examples || []);
    const examples = rawExamples.map(ex =>
      typeof ex === 'string' ? { en: ex, zh: '' } : { en: ex.en || '', zh: ex.zh || '' }
    );

    // 记忆方法（优先书中原装，其次AI辅助）
    const hasBookMethod = !!wordData.method;
    const hasAiMethod = !!wordData.method_ai;
    const methodText = hasBookMethod ? wordData.method : (hasAiMethod ? wordData.method_ai : '');
    const methodType = hasBookMethod ? wordData.method_type : (hasAiMethod ? wordData.method_type_ai : '');
    const methodBadge = hasBookMethod ? '📘 书中方法' : (hasAiMethod ? '🤖 AI辅助' : '');

    const derivations = wordData.derivations || [];

    // 例句中高亮目标单词（含常见变形 s/es/ed/ing）
    const highlight = (sentence) => {
      const escWord = wordEn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`\\b(${escWord}(?:s|es|ed|ing)?)\\b`, 'gi');
      return esc(sentence).replace(re, '<strong class="ex-highlight">$1</strong>');
    };

    // 拆分派生词 "greeting（n. 祝贺，问候）" → {word, pos, meaning}
    const parseDerivation = (d) => {
      const m = String(d).match(/^([^（(]+)[（(]([a-zA-Z.]*)\s*([^）)]*)[）)]/);
      if (m) return { word: m[1].trim(), pos: m[2].trim(), meaning: m[3].trim() };
      return { word: String(d), pos: '', meaning: '' };
    };

    let html = '';

    // ===== 核心信息区 =====
    html += `<div class="detail-word-header">
      <div class="detail-word-en">${esc(wordEn)}</div>
      ${cn ? `<div class="detail-word-cn">${esc(cn)}</div>` : ''}
      <div class="detail-word-tags">
        ${phonetic ? `<span class="detail-tag detail-tag-phonetic">${esc(phonetic)}</span>` : ''}
        ${hasAudio ? `<span class="detail-tag detail-tag-play" data-play-word="${esc(wordEn)}">🔊 发音</span>` : ''}
      </div>
    </div>`;

    // ===== 例句区 =====
    if (examples.length > 0) {
      const maxVisible = 2;
      const showMore = examples.length > maxVisible;
      const renderExample = (ex) => `
        <div class="detail-example-card">
          <button class="detail-example-play" data-example="${esc(ex.en)}" title="朗读例句">🔊</button>
          <div class="detail-example-en">${highlight(ex.en)}</div>
          ${ex.zh ? `<div class="detail-example-zh">${esc(ex.zh)}</div>` : ''}
        </div>`;

      html += `<div class="detail-divider"></div>`;
      html += `<div class="detail-section">
        <div class="detail-section-title"><span class="dot dot-purple"></span>例句</div>
        <div class="detail-examples">
          ${examples.slice(0, showMore ? maxVisible : examples.length).map(renderExample).join('')}
        </div>
        ${showMore ? `
          <div class="detail-examples-more" style="display:none">
            ${examples.slice(maxVisible).map(renderExample).join('')}
          </div>
          <button class="detail-examples-toggle" id="detailExamplesToggle" data-total="${examples.length}">展开全部（${examples.length} 条）▾</button>` : ''}
      </div>`;
    }

    // ===== 记忆方法 =====
    if (methodText) {
      html += `<div class="detail-divider"></div>`;
      html += `<div class="detail-section">
        <div class="detail-section-title"><span class="dot dot-pink"></span>记忆方法</div>
        <div class="detail-method-card">
          <span class="detail-method-badge">${methodBadge}</span>
          <div class="detail-method-text">
            ${methodType ? `<strong>${esc(methodType)}</strong>：` : ''}${esc(methodText)}
          </div>
        </div>
      </div>`;
    }

    // ===== 派生词 =====
    if (derivations.length > 0) {
      html += `<div class="detail-divider"></div>`;
      html += `<div class="detail-section">
        <div class="detail-section-title"><span class="dot dot-green"></span>派生词</div>
        <div class="detail-derivation-list">
          ${derivations.map(d => {
            const p = parseDerivation(d);
            return `<div class="detail-derivation-item">
              <span class="dd-word">${esc(p.word)}</span>
              ${p.pos ? `<span class="dd-pos">${esc(p.pos)}</span>` : ''}
              ${p.meaning ? `<span class="dd-meaning">${esc(p.meaning)}</span>` : ''}
            </div>`;
          }).join('')}
        </div>
      </div>`;
    }

    // ===== 来源栏 =====
    const sourceMap = {
      'pdf': '《初中英语词汇词根+联想记忆法》',
      'yu_speed': '《英语词汇速记大全》',
      'pdf_derived': '《初中英语词汇词根+联想记忆法》（派生词条）',
      'pdf_phrase': '《初中英语词汇词根+联想记忆法》（短语匹配）',
      'ai_generated': 'AI辅助生成'
    };
    const sourceText = sourceMap[wordData.source] || '';
    if (sourceText) {
      html += `<div class="detail-divider"></div>`;
      html += `<div class="detail-source">📚 来源：${sourceText}</div>`;
    }

    return html;
  },

  /**
   * 关闭单词详情弹窗
   */
  _closeWordDetail() {
    const overlay = document.getElementById('wordDetailOverlay');
    if (overlay) overlay.style.display = 'none';
  }
};

// ============================================
// 全局 TTS 发音函数 —— 纯净离线版
// 仅使用浏览器原生 speechSynthesis，无网络请求
// ============================================

/**
 * TTS 引擎预热（在用户手势中初始化，避免 Android 静默失败）
 * 仅首次调用有效，之后为空操作。
 */
let _speechReady = false;
function _ensureSpeechReady() {
  if (_speechReady) return;
  if (!window.speechSynthesis) return;
  try {
    const utter = new SpeechSynthesisUtterance('');
    utter.volume = 0;
    window.speechSynthesis.speak(utter);
    window.speechSynthesis.cancel();
  } catch (e) {
    // 预热失败不影响主流程
  }
  _speechReady = true;
}

/**
 * 等待语音列表加载（Android 上 getVoices() 首次调用可能返回空数组）
 * 多个并发调用共享同一个 Promise，避免重复监听。
 * @returns {Promise<SpeechSynthesisVoice[]>}
 */
let _pendingVoices = null;
function _waitForVoices() {
  if (_pendingVoices) return _pendingVoices;
  _pendingVoices = new Promise((resolve) => {
    const handler = () => {
      window.speechSynthesis.removeEventListener('voiceschanged', handler);
      _pendingVoices = null;
      resolve(window.speechSynthesis.getVoices());
    };
    window.speechSynthesis.addEventListener('voiceschanged', handler);
    // 兜底超时：3 秒后语音仍未就绪则用空数组继续
    setTimeout(() => {
      window.speechSynthesis.removeEventListener('voiceschanged', handler);
      if (_pendingVoices) {
        _pendingVoices = null;
        resolve([]);
      }
    }, 3000);
  });
  return _pendingVoices;
}

/**
 * 朗读指定的英文文本
 * - 每次播放前自动 cancel()，杜绝声音重叠
 * - 手机端语速 0.8，电脑端 0.9
 * - Android: 自动等待语音列表就绪，避免 TTS 静默失败
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

    // 0. 预热 TTS 引擎（在用户手势中初始化，仅首次有效）
    _ensureSpeechReady();

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
    utterance.onerror = (e) => {
      // "interrupted" 是用户切换单词时的正常中断，非错误
      if (e.error === 'interrupted') {
        console.log('[speakText] 发音被中断:', text);
      } else {
        console.warn('[speakText] 发音出错:', text, '错误类型:', e.error || 'unknown');
      }
      done();
    };

    // 4. 选择语音
    const doSpeak = (voices) => {
      // 异步路径中，可能已有其他语音在播放，先取消避免重叠
      window.speechSynthesis.cancel();
      const preferred = voices.find(v =>
        v.name.includes('Google US English') ||
        v.name.includes('Samantha') ||
        v.name.includes('Microsoft Zira') ||
        v.name.includes('Microsoft David')
      ) || voices.find(v => v.lang.startsWith('en-US'))
        || voices.find(v => v.lang.startsWith('en'))
        || null;
      if (preferred) utterance.voice = preferred;

      console.log('[speakText] 发音:', text, preferred ? `(语音: ${preferred.name})` : '(默认语音)');
      window.speechSynthesis.speak(utterance);
    };

    // 5. 检查语音列表是否就绪（Android 首次可能为空）
    const voices = window.speechSynthesis.getVoices();
    if (voices.length === 0) {
      _waitForVoices().then(doSpeak);
    } else {
      doSpeak(voices);
    }
  });
}

// ═══════════════════════════════════════════
// 单词学习进度统计（基于 Tracker 原始事件计算）
// ═══════════════════════════════════════════

/**
 * 计算单个单词的学习进度
 * @param {string} wordId  单词英文
 * @param {Array} events   Tracker.getEvents() 返回的事件数组
 * @returns {object} { audioCount, challengeCount, correctCount, wrongCount, correctRate, masteryScore, lastStudyTime }
 */
function getWordProgress(wordId, events) {
  const audioEvents = events.filter(e => e.type === 'play_audio' && e.wordId === wordId);
  const challengeEvents = events.filter(e => e.type === 'challenge_answer' && e.wordId === wordId);

  const audioCount = audioEvents.length;
  const challengeCount = challengeEvents.length;
  const correctCount = challengeEvents.filter(e => e.isCorrect).length;
  const wrongCount = challengeCount - correctCount;
  const correctRate = challengeCount > 0 ? Math.round((correctCount / challengeCount) * 100) : 0;

  // 简单熟练度算法
  let score = audioCount * 2 + correctCount * 10 - wrongCount * 5;
  score = Math.max(0, Math.min(100, score));

  // 最近学习时间：取所有相关事件的最大时间戳
  const allTimestamps = [...audioEvents, ...challengeEvents].map(e => e.timestamp);
  const lastStudyTime = allTimestamps.length > 0 ? Math.max(...allTimestamps) : null;

  return {
    audioCount,
    challengeCount,
    correctCount,
    wrongCount,
    correctRate,
    masteryScore: score,
    lastStudyTime
  };
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

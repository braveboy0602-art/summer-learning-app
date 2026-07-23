/**
 * Tracker - 用户行为记录模块
 *
 * 提供统一的行为记录接口，将用户操作持久化到 localStorage，
 * 为后续错词本、学习统计、AI 分析提供数据基础。
 *
 * 事件结构:
 *   {
 *     id:         string  — 唯一 ID（UUID v4）
 *     userId:     ?string — 用户 ID，上云后赋值（当前 null）
 *     deviceId:   string  — 设备标识（自动生成，持久化到 localStorage）
 *     appVersion: string  — 应用版本号，方便数据结构升级
 *     type:       string  — 行为类型（如 "play_audio"）
 *     ...data             — 业务数据，由调用方传入
 *     timestamp:  number  — 事件发生时间戳
 *   }
 */
const Tracker = {
  /** localStorage 存储键名 */
  STORAGE_KEY: 'learning_events',
  /** deviceId 存储键名 */
  DEVICE_KEY: 'tracker_device_id',
  /** 当前应用版本号 */
  APP_VERSION: '1.0.0',

  /**
   * 获取设备标识 —— 首次运行生成，后续复用
   * @returns {string} UUID v4
   */
  _getDeviceId() {
    try {
      let id = localStorage.getItem(this.DEVICE_KEY);
      if (!id) {
        id = crypto.randomUUID();
        localStorage.setItem(this.DEVICE_KEY, id);
      }
      return id;
    } catch {
      return 'unknown';
    }
  },

  /**
   * 记录一条用户行为
   *
   * @param {string} type   - 行为类型（如 "play_audio"）
   * @param {object} data   - 业务数据，会被合并到事件对象中
   *
   * @example
   * Tracker.track("play_audio", {
   *   wordId: "apple",
   *   word: "apple",
   *   categoryId: "unit1"
   * });
   */
  track(type, data) {
    try {
      const events = this.getEvents();
      const event = {
        id: crypto.randomUUID(),
        userId: null,
        deviceId: this._getDeviceId(),
        appVersion: this.APP_VERSION,
        type: type,
        ...data,
        timestamp: Date.now()
      };
      events.push(event);
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(events));

      // ─── 云同步入口（未来实现） ───
      // this._syncToCloud(event);
    } catch (err) {
      console.warn('[Tracker] 记录失败:', err);
    }
  },

  /**
   * 获取所有行为记录
   *
   * @returns {Array} 事件对象数组，按记录顺序排列
   */
  getEvents() {
    try {
      const raw = localStorage.getItem(this.STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  // ═══════════════════════════════════════════
  // 云同步（未来实现）
  // ═══════════════════════════════════════════
  //
  // _syncToCloud(event) {
  //   1. 收集未同步事件（可加一个标记字段 synced: true）
  //   2. 批量上传（navigator.onLine 判断网络）
  //   3. 成功后标记已同步 / 清除已同步事件
  //   4. 失败后下次重试
  // }
};

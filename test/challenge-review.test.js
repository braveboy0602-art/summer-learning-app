/**
 * 默写挑战 — 错词重练功能自动化测试
 *
 * 测试场景：
 * 1. 基础轮作答（部分正确 + 部分错误）
 * 2. 验证基础轮结束后自动进入重练轮（仅错词）
 * 3. 完成重练轮 → 验证完成页使用原始词数统计
 * 4. 关闭弹窗 → 验证状态重置
 * 5. 重新打开 → 验证全新开始
 *
 * 运行方式：
 *   cd learning-app
 *   npm install playwright          # 首次运行前安装依赖
 *   npx http-server . -p 8765 -s &  # 启动静态服务器
 *   node test/challenge-review.test.js
 */

const { chromium } = require('playwright');
const BASE = 'http://localhost:8765';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  // 自动确认弹窗（关闭挑战时的确认框）
  page.on('dialog', async dialog => { await dialog.accept(); });

  const fail = (msg) => { console.error('  ❌ FAIL:', msg); process.exit(1); };
  const check = (cond, msg) => { console.log(cond ? '  ✓' : '  ✗', msg); if (!cond) process.exit(1); };

  try {
    // ============================================
    // 1. 加载应用
    // ============================================
    console.log('=== 1. 加载应用 ===');
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForSelector('.sidebar-categories', { timeout: 10000 });
    console.log('  ✓ 应用加载成功');

    // ============================================
    // 2. 展开分组并选择分类
    // ============================================
    console.log('\n=== 2. 选择分类 ===');
    await page.evaluate(() => StudyApp._toggleGroup('english', 'primary'));
    await page.waitForTimeout(300);
    await page.evaluate(() => StudyApp.selectCategory('english', 'primary', 'food'));
    await page.waitForSelector('.word-grid', { timeout: 5000 });
    const wordCount = await page.locator('.word-card').count();
    console.log(`  ✓ 已加载分类"食物 & 饮料"，${wordCount} 个单词`);

    // ============================================
    // 3. 启动默写挑战
    // ============================================
    console.log('\n=== 3. 启动默写挑战 ===');
    await page.locator('#challengeBtn').click();
    await page.waitForSelector('#challengeOverlay[style*="flex"]', { timeout: 3000 });

    const totalWords = await page.locator('#challengeTotalNum').textContent();
    const TOTAL = parseInt(totalWords);
    console.log(`  ✓ 挑战已启动，共 ${TOTAL} 题`);

    // ============================================
    // 4. 基础轮答题（前3正确，其余故意答错）
    // ============================================
    console.log(`\n=== 4. 基础轮（${TOTAL} 题）= 前3正确 + ${TOTAL - 3} 错误 ===`);
    const CORRECT_COUNT = 3;

    for (let i = 0; i < TOTAL; i++) {
      const qNum = await page.locator('#challengeCurrentNum').textContent();

      if (i < CORRECT_COUNT) {
        // 正确作答：按顺序点击单词的所有字母
        const word = await page.evaluate(() => StudyApp._challengeWords[StudyApp._challengeIndex]);
        const letters = word.en.replace(/[^a-zA-Z]/g, '');
        console.log(`  Q${qNum} ✓ "${word.en}"`);

        for (const ch of letters) {
          const btn = page.locator(`.letter-btn[data-letter="${ch}"]:not([disabled])`).first();
          if (await btn.count() > 0) await btn.click();
          await page.waitForTimeout(50);
        }
      } else {
        // 错误作答：只点1个字母，提交时必定错误
        const word = await page.evaluate(() => StudyApp._challengeWords[StudyApp._challengeIndex]);
        console.log(`  Q${qNum} ✗ "${word.en}"`);
        const btn = page.locator('.letter-btn:not([disabled])').first();
        if (await btn.count() > 0) await btn.click();
      }

      await page.locator('#challengeSubmit').click();
      await page.waitForTimeout(2500);
    }

    // ============================================
    // 5. 验证 Round 2（错词重练）已启动
    // ============================================
    console.log('\n=== 5. 验证错词重练 ===');
    await page.waitForTimeout(500);

    const round2Header = await page.locator('#challengeCategory').textContent();
    const round2Count = await page.locator('#challengeWordCount').textContent();

    check(await page.evaluate(() => StudyApp._challengeRound === 2),
      `Round 2 已启动（_challengeRound === 2）`);
    check(round2Header === '🔁 错词重练',
      `头部显示 "🔁 错词重练"（实际: "${round2Header}"）`);

    const r2State = await page.evaluate(() => ({
      wordsLen: StudyApp._challengeWords.length,
      wrongLen: StudyApp._challengeWrongWords.length,
      origLen: StudyApp._originalChallengeWords.length,
      score: StudyApp._challengeScore,
    }));
    check(r2State.wordsLen === TOTAL - CORRECT_COUNT,
      `重练词数 = ${TOTAL - CORRECT_COUNT}（实际: ${r2State.wordsLen}）`);
    check(r2State.wrongLen === TOTAL - CORRECT_COUNT,
      `错词记录数 = ${TOTAL - CORRECT_COUNT}（实际: ${r2State.wrongLen}）`);
    check(r2State.origLen === TOTAL,
      `原始词数保持 = ${TOTAL}（实际: ${r2State.origLen}）`);
    check(r2State.score === CORRECT_COUNT,
      `分数仅来自基础轮 = ${CORRECT_COUNT}（实际: ${r2State.score}）`);

    // ============================================
    // 6. 完成重练轮
    // ============================================
    const R2_TOTAL = r2State.wordsLen;
    console.log(`\n=== 6. 完成重练轮（${R2_TOTAL} 题）===`);
    for (let i = 0; i < R2_TOTAL; i++) {
      const word = await page.evaluate(() => StudyApp._challengeWords[StudyApp._challengeIndex]);
      const letters = word.en.replace(/[^a-zA-Z]/g, '');
      console.log(`  R2 Q${i + 1}/${R2_TOTAL} "${word.en}"`);

      for (const ch of letters) {
        const btn = page.locator(`.letter-btn[data-letter="${ch}"]:not([disabled])`).first();
        if (await btn.count() > 0) await btn.click();
        await page.waitForTimeout(50);
      }
      await page.locator('#challengeSubmit').click();
      await page.waitForTimeout(2500);
    }

    // ============================================
    // 7. 验证完成页统计
    // ============================================
    console.log('\n=== 7. 验证完成页 ===');
    await page.waitForTimeout(500);

    const totalDisp = await page.locator('#completeTotal').textContent();
    const correctDisp = await page.locator('#completeCorrect').textContent();
    const scoreDisp = await page.locator('#completeScore').textContent();

    const expectedScore = Math.round((CORRECT_COUNT / TOTAL) * 100);
    check(parseInt(totalDisp) === TOTAL,
      `总题数 = ${TOTAL}（实际: ${totalDisp}）`);
    check(parseInt(correctDisp) === CORRECT_COUNT,
      `正确数 = ${CORRECT_COUNT}（实际: ${correctDisp}）`);
    check(parseInt(scoreDisp) === expectedScore,
      `得分 = ${expectedScore}%（实际: ${scoreDisp}%）`);

    // ============================================
    // 8. 关闭弹窗 → 验证状态重置
    // ============================================
    console.log('\n=== 8. 关闭弹窗 → 状态重置 ===');
    await page.locator('#challengeClose').click();
    await page.waitForTimeout(300);

    const resetState = await page.evaluate(() => ({
      round: StudyApp._challengeRound,
      wrong: StudyApp._challengeWrongWords.length,
      orig: StudyApp._originalChallengeWords,
    }));
    check(resetState.round === 1, `round 重置为 1（实际: ${resetState.round}）`);
    check(resetState.wrong === 0, `wrongWords 已清空（实际: ${resetState.wrong}）`);
    check(resetState.orig === null, `originalChallengeWords 已清空`);

    // ============================================
    // 9. 重新打开 → 验证全新开始
    // ============================================
    console.log('\n=== 9. 重新打开挑战 ===');
    await page.locator('#challengeBtn').click();
    await page.waitForTimeout(500);

    const freshState = await page.evaluate(() => ({
      round: StudyApp._challengeRound,
      score: StudyApp._challengeScore,
    }));
    check(freshState.round === 1, `round = 1（实际: ${freshState.round}）`);
    check(freshState.score === 0, `score = 0（实际: ${freshState.score}）`);

    // 关闭
    await page.locator('#challengeClose').click();
    await page.waitForTimeout(300);

  } finally {
    await browser.close();
  }

  // ============================================
  // 总结
  // ============================================
  console.log('\n' + '='.repeat(50));
  console.log('✅ ALL TESTS PASSED');
  console.log('='.repeat(50));
  process.exit(0);
})().catch(err => {
  console.error('\n💥 测试异常:', err);
  process.exit(1);
});

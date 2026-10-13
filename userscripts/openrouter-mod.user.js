// ==UserScript==
// @name         OpenRouter 回测价格 + 服务费占比
// @namespace    https://github.com/misaka/dsh-toolkits
// @version      1.1.0
// @description  模型页：Providers 表格里加一列「回测价格」（按固定 token 用量算总价，可点击表头排序），并提供「TPS」过滤器按钮；充值页：在 Purchase Credits 弹窗的服务费金额左边，显示服务费占本次充值额的百分比。
// @author       misaka
// @match        https://openrouter.ai/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

/*
 * 计费口径（可改 CONFIG）。所有价格单位都是 $/M tokens（站点列头「/M」= per million）。
 *
 *   输入总计   5.8B  tokens
 *   输出       26.5M + 14.1M = 40.6M tokens
 *   缓存读取   5.6B  tokens（其中一部分）
 *
 * 关键：OpenRouter 的 usage 里 prompt_tokens 已经包含 cached_tokens，
 * 所以「命中缓存的那 5.6B」不能再按输入价算一遍，否则就是重复计费。默认口径：
 *
 *   未命中输入 = 5.8B − 5.6B = 0.2B
 *   回测价格   = 200 × 输入价 + 40.6 × 输出价 + 5600 × 缓存读取价
 *
 * 如果你的 5.8B 是「不含缓存的净输入」，把 CONFIG.cacheReadIncludedInInput 改成 false，
 * 就变成 5800 × 输入价 + 40.6 × 输出价 + 5600 × 缓存读取价。
 *
 * 表格里「30% off」这类行：被划掉的是原价，绿色的是折后价。默认按折后价算（CONFIG.useDiscountedPrice）。
 */

(function () {
  'use strict';

  /* ============================ 配置 ============================ */
  const CONFIG = {
    // 输入总 tokens（OpenRouter 语义下已包含缓存命中部分）
    inputTokens: 5.8e9,
    // 输出 tokens（26.5M + 14.1M）
    outputTokens: [26.5e6, 14.1e6],
    // 缓存命中读取的 tokens
    cacheReadTokens: 5.6e9,

    // 5.6B 缓存是否已经含在 5.8B 输入里？
    //   true  = 含（默认，OpenRouter/OpenAI 的 prompt_tokens 语义）→ 只有 0.2B 按输入价计
    //   false = 不含（5.8B 是净输入）→ 5.8B 全额按输入价计
    cacheReadIncludedInInput: true,

    // 「TPS > 70」按钮的阈值
    tpsThreshold: 70,

    // 是否使用折后价（true）还是被划掉的原价（false）
    useDiscountedPrice: true,

    // 供应商没给缓存读取价时：true = 按输入价计，false = 按 0 计
    cacheReadFallbackToInput: true,

    // 新列插到哪个表头之后
    insertAfterHeader: /cache\s*read/i,
  };

  // 计入输入价的净输入 tokens：缓存若已含在输入里就要先扣掉
  const FRESH_INPUT_TOKENS = CONFIG.cacheReadIncludedInInput
    ? Math.max(0, CONFIG.inputTokens - CONFIG.cacheReadTokens)
    : CONFIG.inputTokens;

  // 每 1 个「$/M」价格对应的用量倍数
  const K_IN = FRESH_INPUT_TOKENS / 1e6;                                   // 200 或 5800
  const K_OUT = CONFIG.outputTokens.reduce((a, b) => a + b, 0) / 1e6;      // 40.6
  const K_CACHE = CONFIG.cacheReadTokens / 1e6;                           // 5600

  const CLS_TH = 'orbp-th';
  const CLS_TD = 'orbp-td';
  const CLS_HIDDEN = 'orbp-hidden';
  const CLS_BTN = 'orbp-btn';

  let currentTable = null;
  let sortState = null;   // null | 'asc' | 'desc'
  let filterOn = false;
  let busy = false;       // 正在写 DOM，避免观察者自激
  let throttleTimer = 0;

  /* ============================ 样式 ============================ */
  const CSS = `
    .${CLS_HIDDEN} { display: none !important; }

    .orbp-val { font-variant-numeric: tabular-nums; }

    .orbp-badge {
      margin-left: 4px; padding: 0 3px; border-radius: 3px;
      font-size: 9px; line-height: 13px; vertical-align: 1px;
      color: #34dfaa; border: 1px solid color-mix(in srgb, #34dfaa 40%, transparent);
      background: color-mix(in srgb, #34dfaa 12%, transparent);
    }

    .orbp-icon {
      width: 14px; height: 14px; flex: none;
      opacity: .3; transition: opacity .15s ease, transform .15s ease;
    }
    .${CLS_TH}:hover .orbp-icon { opacity: .6; }
    /* 站点的约定：升序 = 向上箭头（它是 arrow-down + scale-y:-1），降序 = 向下箭头 */
    .${CLS_TH}[data-dir="asc"] .orbp-icon { opacity: 1; transform: rotate(180deg); }
    .${CLS_TH}[data-dir="desc"] .orbp-icon { opacity: 1; }

    .${CLS_BTN} {
      font: inherit; font-size: 12px; line-height: 1.1;
      display: inline-flex; align-items: center; gap: 6px;
      padding: 5px 10px; margin-left: 4px; border-radius: 8px; cursor: pointer;
      white-space: nowrap; user-select: none;
      color: hsl(var(--muted-foreground, 240 4% 46%));
      border: 1px solid hsl(var(--border, 240 6% 40% / .25));
      background: hsl(var(--card, 0 0% 100%));
      transition: color .15s ease, background-color .15s ease, border-color .15s ease;
    }
    .${CLS_BTN}:hover { color: hsl(var(--foreground, 240 10% 4%)); }
    .${CLS_BTN}[aria-pressed="true"] {
      color: #34dfaa;
      border-color: color-mix(in srgb, #34dfaa 45%, transparent);
      background: color-mix(in srgb, #34dfaa 12%, transparent);
    }
    .orbp-dot {
      width: 6px; height: 6px; border-radius: 50%; flex: none;
      background: currentColor; opacity: .45;
    }
    .${CLS_BTN}[aria-pressed="true"] .orbp-dot { opacity: 1; }
    .orbp-count { opacity: .7; font-variant-numeric: tabular-nums; }
    .orbp-count:empty { display: none; }

    /* 充值弹窗里「服务费占充值额」的百分比：金额左边的小字 */
    .orbp-pct {
      margin-right: 6px; font-weight: 400;
      color: hsl(var(--muted-foreground, 240 4% 46%));
      font-variant-numeric: tabular-nums;
    }
  `;

  function ensureStyle() {
    if (document.getElementById('orbp-style')) return;
    const s = document.createElement('style');
    s.id = 'orbp-style';
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  /* ============================ 解析 ============================ */
  function numbersIn(node) {
    const text = (node.textContent || '').replace(/,/g, '');
    const out = [];
    const re = /([0-9]+(?:\.[0-9]+)?)/g;
    let m;
    while ((m = re.exec(text))) out.push(parseFloat(m[1]));
    return out.filter((n) => isFinite(n));
  }

  // 解析一个价格单元格，返回 { price, list, effective, discounted } 或 null
  function parsePriceCell(td) {
    if (!td) return null;
    const clone = td.cloneNode(true);
    // 去掉隐藏的占位字符（"000" 那种）和各种 sr-only
    clone.querySelectorAll('[aria-hidden="true"], .invisible, .sr-only').forEach((n) => n.remove());

    let list = null;
    const struck = clone.querySelector('.line-through, s, del');
    if (struck) {
      const nums = numbersIn(struck);
      if (nums.length) list = Math.min(...nums);
      struck.remove();
    }

    const rest = numbersIn(clone);
    const effective = rest.length ? Math.min(...rest) : null;

    if (list == null && effective == null) return null;
    const price = CONFIG.useDiscountedPrice ? (effective != null ? effective : list)
                                            : (list != null ? list : effective);
    return {
      price,
      list,
      effective,
      discounted: list != null && effective != null && effective < list,
    };
  }

  function parseTps(cell) {
    if (!cell) return null;
    const m = (cell.textContent || '').match(/([0-9]+(?:\.[0-9]+)?)\s*tps/i);
    return m ? parseFloat(m[1]) : null;
  }

  /* ============================ 表格定位 ============================ */
  function headerTexts(table) {
    return [...table.querySelectorAll('thead th')].map((th) =>
      (th.textContent || '').replace(/\s+/g, ' ').trim(),
    );
  }

  // Providers 表：同时有 Provider / Throughput / Cache read 三个表头
  function findProvidersTable() {
    for (const t of document.querySelectorAll('table')) {
      const hs = headerTexts(t);
      if (hs.some((h) => /provider/i.test(h)) && hs.some((h) => /throughput/i.test(h)) && hs.some((h) => /cache\s*read/i.test(h))) {
        return t;
      }
    }
    return null;
  }

  // 列号映射：直接对 thead th 与 tr 的「th,td」下标（两者一一对应，我们自己的列也在同一位置）
  function getCols(table) {
    const hs = headerTexts(table);
    const at = (re) => hs.findIndex((h) => re.test(h));
    return {
      provider: at(/^provider$/i),
      input: at(/^input/i),
      output: at(/^output/i),
      cache: at(/cache\s*read/i),
      tps: at(/throughput|tps/i),
    };
  }

  function rowCells(row) {
    return row.querySelectorAll(':scope > th, :scope > td');
  }

  function isDataRow(row) {
    return !!row.querySelector('th[scope="row"]');
  }

  /* ============================ 计算 ============================ */
  function computeCost(row, cols) {
    const cells = rowCells(row);
    const inp = parsePriceCell(cells[cols.input]);
    const out = parsePriceCell(cells[cols.output]);
    const cache = parsePriceCell(cells[cols.cache]);
    if (!inp && !out && !cache) return null;

    const inP = inp ? inp.price : 0;
    const outP = out ? out.price : 0;
    const cacheP = cache ? cache.price : (CONFIG.cacheReadFallbackToInput ? inP : 0);

    return {
      inP,
      outP,
      cacheP,
      inCost: K_IN * inP,
      outCost: K_OUT * outP,
      cacheCost: K_CACHE * cacheP,
      total: K_IN * inP + K_OUT * outP + K_CACHE * cacheP,
      discounted: !!(inp && inp.discounted) || !!(out && out.discounted) || !!(cache && cache.discounted),
      cacheMissing: !cache,
    };
  }

  function fmtUSD(v) {
    const d = Math.abs(v) < 1 ? 4 : 2;
    return '$' + v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  function fmtTokens(n) {
    if (n >= 1e9) return +(n / 1e9).toFixed(3) + 'B';
    if (n >= 1e6) return +(n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return +(n / 1e3).toFixed(1) + 'K';
    return String(n);
  }

  // 口径摘要，放在表头 tooltip 里
  function basisText() {
    const inPart = CONFIG.cacheReadIncludedInInput
      ? `${fmtTokens(FRESH_INPUT_TOKENS)} 输入(未命中)`
      : `${fmtTokens(CONFIG.inputTokens)} 输入`;
    return `${inPart} + ${fmtTokens(K_OUT * 1e6)} 输出 + ${fmtTokens(CONFIG.cacheReadTokens)} 缓存读取`;
  }

  function breakdown(cost) {
    const lines = [];
    if (CONFIG.cacheReadIncludedInInput) {
      lines.push(
        `输入 ${fmtTokens(CONFIG.inputTokens)} − 缓存命中 ${fmtTokens(CONFIG.cacheReadTokens)}` +
          ` = ${fmtTokens(FRESH_INPUT_TOKENS)} × $${cost.inP}/M = ${fmtUSD(cost.inCost)}`,
      );
    } else {
      lines.push(`输入 ${fmtTokens(CONFIG.inputTokens)} × $${cost.inP}/M = ${fmtUSD(cost.inCost)}`);
    }
    lines.push(`输出 ${fmtTokens(K_OUT * 1e6)} × $${cost.outP}/M = ${fmtUSD(cost.outCost)}`);
    lines.push(
      `缓存读取 ${fmtTokens(CONFIG.cacheReadTokens)} × $${cost.cacheP}/M = ${fmtUSD(cost.cacheCost)}` +
        (cost.cacheMissing ? '（该供应商未给缓存价，按输入价计）' : ''),
    );
    if (cost.discounted) lines.push('（使用了折后价）');
    lines.push(`合计 ${fmtUSD(cost.total)}`);
    return lines.join('\n');
  }

  /* ============================ 列 ============================ */
  function buildTh() {
    const th = document.createElement('th');
    th.className = `or-table__header-cell text-right ${CLS_TH}`;
    th.setAttribute('scope', 'col');
    th.setAttribute('aria-sort', 'none');
    const title = `按回测价格排序\n回测口径：${basisText()}`;
    th.innerHTML =
      `<button type="button" class="or-table__sort-button" title="${title}">` +
        '<span class="min-w-0"><span class="whitespace-nowrap !text-[13px] font-medium">回测价格</span></span>' +
        '<span class="inline-grid shrink-0 *:[grid-area:1/1]">' +
          '<svg class="orbp-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
            'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            '<path d="M12 5v14"></path><path d="m19 12-7 7-7-7"></path>' +
          '</svg>' +
        '</span>' +
      '</button>';
    th.querySelector('button').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleSort();
    });
    return th;
  }

  function renderCell(td, cost) {
    const key = cost ? `${cost.total.toFixed(6)}|${cost.discounted ? 1 : 0}|${cost.cacheMissing ? 1 : 0}` : 'none';
    if (td.dataset.orbpKey === key) return;   // 内容没变就别碰 DOM（避免触发观察者）
    td.dataset.orbpKey = key;

    if (!cost) {
      td.textContent = '—';
      td.removeAttribute('title');
      return;
    }
    const span = document.createElement('span');
    span.className = 'orbp-val text-foreground';
    span.textContent = fmtUSD(cost.total);

    td.textContent = '';
    td.appendChild(span);
    if (cost.discounted) {
      const b = document.createElement('span');
      b.className = 'orbp-badge';
      b.textContent = '折';
      b.title = '该行使用了折后价';
      td.appendChild(b);
    }
    td.title = breakdown(cost);
  }

  function ensureColumn(table) {
    const ths = [...table.querySelectorAll('thead th')];
    const anchorIdx = ths.findIndex((th) => CONFIG.insertAfterHeader.test((th.textContent || '')));
    const insertAt = anchorIdx >= 0 ? anchorIdx + 1 : ths.length;

    let th = table.querySelector(`th.${CLS_TH}`);
    if (!th) th = buildTh();
    const nowThs = [...table.querySelectorAll('thead th')];
    if (nowThs[insertAt] !== th) (nowThs[0] ? nowThs[0].parentElement : table.querySelector('thead tr')).insertBefore(th, nowThs[insertAt] || null);

    const cols = getCols(table);

    for (const row of table.querySelectorAll('tbody tr')) {
      if (!isDataRow(row)) {
        // 「Not used in Standard routing」这类跨列分隔行：colspan 跟着 +1
        row.querySelectorAll('td[colspan]').forEach((td) => {
          if (td.dataset.orbpBase == null) td.dataset.orbpBase = String(parseInt(td.getAttribute('colspan'), 10) || 1);
          td.setAttribute('colspan', String(parseInt(td.dataset.orbpBase, 10) + 1));
        });
        continue;
      }
      const cells = rowCells(row);
      let td = row.querySelector(`td.${CLS_TD}`);
      if (!td) {
        td = document.createElement('td');
        td.className = `or-table__cell text-right ${CLS_TD}`;
      }
      if (cells[insertAt] !== td) row.insertBefore(td, cells[insertAt] || null);

      const cost = computeCost(row, cols);
      renderCell(td, cost);
      row.dataset.orbpCost = cost ? String(cost.total) : '';
      const tps = parseTps(rowCells(row)[cols.tps]);
      row.dataset.orbpTps = tps == null ? '' : String(tps);
    }
  }

  /* ============================ 排序 ============================ */
  function toggleSort() {
    sortState = sortState === 'asc' ? 'desc' : 'asc';
    const th = currentTable && currentTable.querySelector(`th.${CLS_TH}`);
    if (th) {
      th.dataset.dir = sortState;
      th.setAttribute('aria-sort', sortState === 'asc' ? 'ascending' : 'descending');
    }
    // 其它列（React 自己的）排序标记清掉，避免同时亮两个
    if (currentTable) {
      currentTable.querySelectorAll(`thead th:not(.${CLS_TH})`).forEach((o) => o.setAttribute('aria-sort', 'none'));
    }
    run();
  }

  function clearSort() {
    if (!sortState) return;
    sortState = null;
    const th = currentTable && currentTable.querySelector(`th.${CLS_TH}`);
    if (th) {
      th.removeAttribute('data-dir');
      th.setAttribute('aria-sort', 'none');
    }
  }

  function applySort(table) {
    if (!sortState) return;
    const byParent = new Map();
    for (const row of table.querySelectorAll('tbody tr')) {
      if (!row.dataset.orbpCost) continue;   // 没有价格的行（分隔行）钉在最后
      const p = row.parentElement;
      if (!byParent.has(p)) byParent.set(p, []);
      byParent.get(p).push(row);
    }
    for (const [parent, rows] of byParent) {
      const all = [...parent.querySelectorAll(':scope > tr')];
      const rest = all.filter((r) => !rows.includes(r));
      rows.sort((a, b) => {
        const av = parseFloat(a.dataset.orbpCost);
        const bv = parseFloat(b.dataset.orbpCost);
        return sortState === 'asc' ? av - bv : bv - av;
      });
      const want = [...rows, ...rest];
      let same = true;
      for (let i = 0; i < want.length; i++) if (all[i] !== want[i]) { same = false; break; }
      if (same) continue;
      for (const r of want) parent.appendChild(r);   // 只做重排，不增删节点
    }
  }

  /* ============================ 过滤 ============================ */
  function ensureFilterButton(table) {
    let btn = document.querySelector(`.${CLS_BTN}`);
    if (btn && btn.isConnected) return btn;

    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = CLS_BTN;
    btn.setAttribute('aria-pressed', 'false');
    btn.title = `只看吞吐 > ${CONFIG.tpsThreshold} tps 的 provider`;
    btn.innerHTML =
      '<span class="orbp-dot"></span>' +
      `<span>TPS &gt; ${CONFIG.tpsThreshold}</span>` +
      '<span class="orbp-count"></span>';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      filterOn = !filterOn;
      btn.setAttribute('aria-pressed', String(filterOn));
      run();
    });

    const sec = table.closest('section');
    const host = sec ? sec.querySelector(':scope > div') : null;
    (host || document.body).appendChild(btn);
    return btn;
  }

  function applyFilter(table) {
    let visible = 0;
    for (const row of table.querySelectorAll('tbody tr')) {
      const tps = parseFloat(row.dataset.orbpTps || '');
      const hide = filterOn && !(isFinite(tps) && tps > CONFIG.tpsThreshold);
      if (row.classList.contains(CLS_HIDDEN) !== hide) row.classList.toggle(CLS_HIDDEN, hide);
      if (!hide && isDataRow(row)) visible++;
    }
    const count = document.querySelector('.orbp-count');
    if (count) count.textContent = filterOn ? String(visible) : '';
  }

  /* ==================== 充值页：服务费占充值额的百分比 ==================== */
  /*
   * 在 /settings/credits 的 Purchase Credits 弹窗里，把服务费占本次充值额的百分比
   * 显示在服务费金额的左边（$0.83 → 5.53% $0.83）。
   * 分母是 Amount 里那个数（真正买到的 credits），不是含服务费的 Total due。
   * 站点实测口径是 max($0.80, 5.5%)，小额充值会被 $0.80 顶上去，
   * 所以这个百分比不是恒定的 5.5%，值得显示。
   */
  const CLS_PCT = 'orbp-pct';
  const SERVICE_FEE_LABEL = /^service\s*fees$/i;
  const CREDITS_PATH = /^\/settings\/credits\/?$/;

  let creditsInput = null;     // Amount 输入框
  let creditsValueEl = null;   // 服务费金额元素
  let creditsObserver = null;  // 只盯这个金额元素：React 改的是文本节点，不是 childList
  let creditsBusy = false;     // 正在写 DOM，避免被自己的观察者自激

  function numberFromText(text) {
    const m = String(text == null ? '' : text).replace(/,/g, '').match(/[0-9]+(?:\.[0-9]+)?/);
    return m ? parseFloat(m[0]) : null;
  }

  function fmtMoney(v) {
    return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // Purchase Credits 弹窗里的 Amount 输入框（按弹窗标题定位，避开 Auto Top Up 那个弹窗）
  function findCreditsInput() {
    for (const h2 of document.querySelectorAll('h2')) {
      if ((h2.textContent || '').trim() !== 'Purchase Credits') continue;
      let node = h2.parentElement;
      for (let i = 0; node && i < 6; i++, node = node.parentElement) {
        const input = node.querySelector('input[name="creditAmount"]');
        if (input) return input;
      }
    }
    return null;
  }

  // 「Service fees」那一行的金额元素（该行是 label span + 金额 div）
  function findServiceFeeValue(input) {
    const root = input.closest('form') || input.closest('fieldset') || document;
    for (const row of root.querySelectorAll('div')) {
      const label = row.firstElementChild;
      if (!label || label.tagName !== 'SPAN' || row.children.length < 2) continue;
      if (!SERVICE_FEE_LABEL.test((label.textContent || '').replace(/\s+/g, ' ').trim())) continue;
      return row.lastElementChild;
    }
    return null;
  }

  // 金额元素里除我们注入的百分比以外的文字，避免把自己的输出再读回来
  function feeTextOf(valueEl) {
    let text = '';
    for (const node of valueEl.childNodes) {
      if (node.nodeType === 1 && node.classList && node.classList.contains(CLS_PCT)) continue;
      text += node.textContent || '';
    }
    return text;
  }

  function writePct(mutate) {
    creditsBusy = true;
    try {
      mutate();
    } finally {
      queueMicrotask(() => { creditsBusy = false; });
    }
  }

  function renderCredits() {
    if (!creditsInput || !creditsValueEl || !creditsValueEl.isConnected) return;

    // Amount 是 number 输入框，可能是 "1e2" 这类科学计数法，所以用 Number() 整体解析，
    // 不要用「取字符串里第一个数字段」的 numberFromText（那是给 "$0.83" 这种金额文本用的）。
    const raw = (creditsInput.value || '').trim();
    const amount = raw === '' ? NaN : Number(raw);
    const fee = numberFromText(feeTextOf(creditsValueEl));
    const pct = Number.isFinite(amount) && amount > 0 && fee != null ? (fee / amount) * 100 : null;
    const text = pct != null && isFinite(pct) ? pct.toFixed(2) + '%' : '';
    const el = creditsValueEl.querySelector(':scope > .' + CLS_PCT);

    if (!text) {
      if (el) writePct(() => el.remove());
      return;
    }
    const title = `服务费 ${fmtMoney(fee)} ÷ 充值额 ${fmtMoney(amount)}`;
    if (el) {
      if (el.textContent !== text) writePct(() => { el.textContent = text; });
      if (el.title !== title) writePct(() => { el.title = title; });
      return;
    }
    const span = document.createElement('span');
    span.className = CLS_PCT;
    span.textContent = text;
    span.title = title;
    writePct(() => creditsValueEl.insertBefore(span, creditsValueEl.firstChild));
  }

  function onCreditsInput() { renderCredits(); }

  function teardownCredits() {
    if (creditsObserver) { creditsObserver.disconnect(); creditsObserver = null; }
    if (creditsInput) creditsInput.removeEventListener('input', onCreditsInput);
    creditsInput = null;
    creditsValueEl = null;
  }

  function applyCredits(input) {
    const valueEl = input ? findServiceFeeValue(input) : null;
    if (!input || !valueEl) { teardownCredits(); return; }

    if (input !== creditsInput) {
      if (creditsInput) creditsInput.removeEventListener('input', onCreditsInput);
      creditsInput = input;
      creditsInput.addEventListener('input', onCreditsInput);
    }
    if (valueEl !== creditsValueEl) {
      creditsValueEl = valueEl;
      if (creditsObserver) creditsObserver.disconnect();
      creditsObserver = new MutationObserver(() => { if (!creditsBusy) renderCredits(); });
      creditsObserver.observe(valueEl, { childList: true, characterData: true, subtree: true });
    }
    renderCredits();
  }

  /* ============================ 主流程 ============================ */
  function apply(table) {
    ensureStyle();
    ensureColumn(table);
    ensureFilterButton(table);
    applyFilter(table);
    applySort(table);
  }

  function run() {
    const table = findProvidersTable();
    const input = findCreditsInput();

    // 只在真的有活干时才注入样式表；但观察者本身不卸载（见下面 observer 的说明）
    if (table || input || CREDITS_PATH.test(location.pathname)) ensureStyle();

    busy = true;
    try {
      currentTable = table;
      if (table) apply(table);
      applyCredits(input);
    } finally {
      // MutationObserver 的回调是微任务，排队在我们这个之后 → 它一定会看到 busy=true
      queueMicrotask(() => { busy = false; });
    }
  }

  function schedule() {
    if (busy || throttleTimer) return;
    throttleTimer = setTimeout(() => {
      throttleTimer = 0;
      run();
    }, 120);
  }

  // 观察者常驻、不卸载：站点是 SPA（pushState 跳转不触发 popstate），Providers 表格和充值弹窗
  // 又都是异步渲染的。旧版在「目标还没渲染出来」时就 disconnect，于是 SPA 跳转过去之后再也
  // 没人把我们叫醒（表格/弹窗都不会被增强）。常驻的代价只是每次 DOM 变化后做一次节流查询。
  const observer = new MutationObserver(() => schedule());
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // 用户点了 React 自己的排序表头 → 放弃我们的排序，交给它
  document.addEventListener(
    'click',
    (e) => {
      const btn = e.target && e.target.closest && e.target.closest('.or-table__sort-button');
      if (!btn) return;
      if (btn.closest(`.${CLS_TH}`)) return;
      if (currentTable && currentTable.contains(btn)) {
        clearSort();
        schedule();
      }
    },
    true,
  );

  run();
  // SPA 路由切换兜底
  window.addEventListener('popstate', schedule);
  window.addEventListener('hashchange', schedule);
})();

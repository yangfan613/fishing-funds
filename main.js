const { app, BrowserWindow, ipcMain, Menu, dialog, Tray, nativeImage } = require('electron');
const axios = require('axios');
const path = require('path');
const Store = require('electron-store');
const fs = require('fs');
const iconv = require('iconv-lite');

const store = new Store({
  name: 'funds-data',
  defaults: {
    funds: [],
    groups: ['默认分组'],
    settings: {
      autoUpdate: true,
      morningStart: '09:30',
      morningEnd: '11:31',
      afternoonStart: '13:00',
      afternoonEnd: '15:01',
      showMenuBar: true
    }
  }
});

let mainWindow = null;
let tray = null;

// ---------- 窗口创建 ----------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 820,
    height: 740,
    title: '基金估值速查',
    titleBarStyle: 'hiddenInset',
    vibrancy: 'under-window',
    visualEffectState: 'active',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile('index.html');
  Menu.setApplicationMenu(null);

  mainWindow.on('close', (e) => {
    e.preventDefault();
    mainWindow.hide();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ---------- 托盘图标（纯 SVG + 备选纯色） ----------
function createTrayIcon() {
  // SVG 黑色方块 + 白色"估"字
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18">
      <rect width="18" height="18" rx="2" fill="#000000"/>
      <text x="9" y="13" font-family="system-ui, -apple-system, sans-serif" font-size="12" font-weight="bold" fill="white" text-anchor="middle">估</text>
    </svg>
  `;
  let image = nativeImage.createFromDataURL(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);

  // 如果 SVG 无法加载（某些 macOS 版本），回退到纯黑色方块
  if (image.isEmpty()) {
    const size = 18;
    const buffer = Buffer.alloc(size * size * 4);
    for (let i = 0; i < buffer.length; i += 4) {
      buffer[i] = 0;
      buffer[i+1] = 0;
      buffer[i+2] = 0;
      buffer[i+3] = 255;
    }
    image = nativeImage.createFromBuffer(buffer, { width: size, height: size });
  }

  // 模板图像，自动适配深浅色菜单栏
  image.setTemplateImage(true);
  return image;
}

function createTray() {
  const icon = createTrayIcon();
  tray = new Tray(icon);
  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示主窗口',
      click: () => {
        if (mainWindow) {
          mainWindow.isVisible() ? mainWindow.focus() : mainWindow.show();
        } else {
          createWindow();
          mainWindow.show();
        }
      }
    },
    {
      label: '退出',
      click: () => {
        app.exit(0);
      }
    }
  ]);
  tray.setToolTip('基金估值速查');
  tray.setContextMenu(contextMenu);
  tray.on('click', () => {
    if (mainWindow) {
      mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
    } else {
      createWindow();
      mainWindow.show();
    }
  });
}

function applyMenuBarSetting() {
  if (process.platform === 'darwin') {
    const show = store.get('settings.showMenuBar', true);
    if (show) {
      app.dock.hide();
      if (!tray) createTray();
    } else {
      app.dock.show();
      if (tray) {
        tray.destroy();
        tray = null;
      }
    }
  }
}

// ---------- 存储操作 ----------
ipcMain.handle('load-funds', () => store.get('funds', []));
ipcMain.handle('save-funds', (event, funds) => { store.set('funds', funds); return true; });
ipcMain.handle('load-groups', () => store.get('groups', ['默认分组']));
ipcMain.handle('save-groups', (event, groups) => { store.set('groups', groups); return true; });
ipcMain.handle('load-settings', () => store.get('settings', {}));
ipcMain.handle('save-settings', (event, settings) => {
  store.set('settings', settings);
  applyMenuBarSetting();
  return true;
});

// ---------- 数据源函数 ----------

// 1. 天天基金（JSONP）
async function fetchFromTiantian(code) {
  const url = `https://fundgz.1234567.com.cn/js/${code}.js`;
  const response = await axios.get(url, {
    timeout: 5000,
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
    responseType: 'text'
  });
  const jsonpStr = response.data;
  const jsonStr = jsonpStr.replace(/^jsonpgz\(/, '').replace(/\);$/, '');
  const data = JSON.parse(jsonStr);
  return {
    code: data.fundcode,
    name: data.name,
    nav: parseFloat(data.dwjz || data.nav || 0),
    gsz: parseFloat(data.gsz),
    gszzl: parseFloat(data.gszzl),
    gztime: data.gztime,
    source: '天天基金'
  };
}

// 2. 腾讯证券（JSON）
async function fetchFromTencent(code) {
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fund/fundInfo?code=jj${code}`;
  const response = await axios.get(url, {
    timeout: 5000,
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  const json = response.data;
  if (json.code !== 0) throw new Error('腾讯接口返回错误');
  const dataKey = `jj${code}`;
  const fundInfo = json.data?.[dataKey]?.fundinfo;
  if (!fundInfo) throw new Error('腾讯数据缺失');
  return {
    code: fundInfo.code || code,
    name: fundInfo.name,
    nav: parseFloat(fundInfo.nav || fundInfo.netvalue || 0),
    gsz: parseFloat(fundInfo.gsz || fundInfo.estimate || 0),
    gszzl: parseFloat(fundInfo.gszzl || fundInfo.estimatet || 0),
    gztime: fundInfo.gztime || fundInfo.time || new Date().toLocaleString(),
    source: '腾讯证券'
  };
}

// 3. 新浪基金（CSV，GBK）
// 2026 起新版格式：名称,最新单位净值,累计净值,上期单位净值,净值日期,规模(亿)
// （旧版"估算净值,估算涨跌%,估算时间"格式已随盘中估值下架而失效）
async function fetchFromSina(code) {
  const url = `https://hq.sinajs.cn/list=f_${code}`;
  const response = await axios.get(url, {
    timeout: 5000,
    headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.sina.com.cn/' },
    responseType: 'arraybuffer'
  });
  const text = iconv.decode(response.data, 'gbk');
  const match = text.match(/var hq_str_f_\w+="([^"]+)"/);
  if (!match) throw new Error('新浪数据解析失败');
  const parts = match[1].split(',');
  if (parts.length < 4) throw new Error('新浪数据字段不足');
  const name = parts[0];
  const latest = parseFloat(parts[1]);
  if (!isFinite(latest) || latest <= 0) throw new Error('新浪数据无效');
  const isNavFormat = /^\d{4}-\d{2}-\d{2}/.test(parts[4] || '');
  if (isNavFormat) {
    // 新版：只有官方净值（T+1），无盘中估值
    const prevNav = parseFloat(parts[3]);
    const gszzl = isFinite(prevNav) && prevNav > 0 ? (latest - prevNav) / prevNav * 100 : null;
    return {
      code: code,
      name: name,
      nav: latest,
      gsz: latest,
      gszzl: gszzl,
      gztime: parts[4],
      navOnly: true,
      source: '新浪净值'
    };
  }
  // 旧版兼容（若恢复）：估算净值,估算涨跌%,估算时间
  return {
    code: code,
    name: name,
    nav: latest,
    gsz: latest,
    gszzl: isFinite(parseFloat(parts[2])) ? parseFloat(parts[2]) : null,
    gztime: parts[3] || new Date().toLocaleString(),
    source: '新浪基金'
  };
}

// ---------- 场内 ETF IOPV（基金份额参考净值） ----------
// 腾讯行情字段（~ 分隔，0 起算）：61=产品类型(ETF)、30=时间、3=最新价、
// 77=折溢价率(%)、78=单位净值(T-1，偶发缺失，用新浪净值接口兜底)、81=IOPV 实时参考净值（盘中每15秒更新）

// ETF 代码判定：沪市 510-529/560-563/588，深市 159 开头
function getETFMarketPrefix(code) {
  if (!/^\d{6}$/.test(code)) return null;
  if (/^(51[0-9]|52[0-9]|56[0-3]|588)/.test(code)) return 'sh';
  if (/^159/.test(code)) return 'sz';
  return null;
}

function formatQuoteTime(raw) {
  // "20261102161449" -> "2026-11-02 16:14:49"
  if (!/^\d{14}$/.test(raw || '')) return raw || '';
  const s = raw;
  return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)} ${s.slice(8,10)}:${s.slice(10,12)}:${s.slice(12,14)}`;
}

// ETF 昨日净值兜底：新浪基金净值接口（腾讯 idx78 偶发为空时使用）
async function fetchETFNavFromSina(code) {
  const url = `https://stock.finance.sina.com.cn/fundInfo/api/openapi.php/CaihuiFundInfoService.getNav?symbol=${code}&datefrom=&dateto=&page=1`;
  const response = await axios.get(url, {
    timeout: 5000,
    headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.sina.com.cn/' }
  });
  const rows = response.data?.result?.data?.data;
  if (!Array.isArray(rows) || !rows.length) throw new Error('新浪净值数据缺失');
  const nav = parseFloat(rows[0].jjjz);
  if (!isFinite(nav) || nav <= 0) throw new Error('新浪净值无效');
  return { nav, navDate: (rows[0].fbrq || '').slice(0, 10) };
}

// 4. 腾讯行情 IOPV（ETF 专用，按交易所规则由成分股实时价×PCF 清单计算）
async function fetchIOPVFromTencent(code) {
  const prefix = getETFMarketPrefix(code);
  const markets = prefix ? [prefix] : ['sh', 'sz'];
  let lastError = null;
  for (const mkt of markets) {
    try {
      const url = `https://qt.gtimg.cn/q=${mkt}${code}`;
      const response = await axios.get(url, {
        timeout: 5000,
        headers: { 'User-Agent': 'Mozilla/5.0' },
        responseType: 'arraybuffer'
      });
      const text = iconv.decode(response.data, 'gbk');
      const match = text.match(/v_[a-z]{2}\d+="([^"]*)"/);
      if (!match) throw new Error('腾讯行情解析失败');
      const f = match[1].split('~');
      if (f.length < 82 || f[61] !== 'ETF') throw new Error('非场内 ETF 或字段缺失');
      const iopv = parseFloat(f[81]);
      let nav = parseFloat(f[78]);
      const price = parseFloat(f[3]);
      if (!isFinite(iopv) || iopv <= 0) throw new Error('IOPV 数据无效');
      let navFallback = null;
      if (!isFinite(nav) || nav <= 0) {
        try {
          navFallback = await fetchETFNavFromSina(code);
          nav = navFallback.nav;
        } catch (e) { nav = null; }
      }
      const gszzl = isFinite(nav) && nav > 0 ? (iopv - nav) / nav * 100 : null;
      const premium = isFinite(iopv) && iopv > 0 && isFinite(price) && price > 0
        ? (price - iopv) / iopv * 100
        : null;
      return {
        code: code,
        name: f[1],
        nav: isFinite(nav) && nav > 0 ? nav : iopv,
        gsz: iopv,
        gszzl: gszzl,
        gztime: formatQuoteTime(f[30]),
        iopv: iopv,
        etfPrice: isFinite(price) ? price : null,
        premium: premium,
        navSource: navFallback ? '新浪净值(' + navFallback.navDate + ')' : null,
        isETF: true,
        source: '腾讯IOPV'
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('IOPV 获取失败');
}

const SOURCES = [
  { name: 'tiantian', fetch: fetchFromTiantian },
  { name: 'tencent', fetch: fetchFromTencent },
  { name: 'sina', fetch: fetchFromSina }
];

// ---------- 场外基金盘中估算（季报前十大重仓 × 实时涨跌） ----------
// 原理：估算涨跌 = Σ(占净值比% × 成分股实时涨跌%) / 100，未覆盖部分（其余持仓+现金）按持平处理
// 局限：季报持仓滞后最多一个季度、前十大覆盖率通常仅 30%-60%，估算仅供参考
const HOLDINGS_TTL = 24 * 60 * 60 * 1000;

// 东财 F10 前十大重仓（akshare 同源接口），带 24h 本地缓存
async function fetchHoldings(code) {
  const cacheKey = 'holdings.' + code;
  const cached = store.get(cacheKey, null);
  if (cached && cached.stocks && cached.stocks.length && Date.now() - cached.fetchedAt < HOLDINGS_TTL) {
    return cached;
  }
  const year = new Date().getFullYear();
  const url = `https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code=${code}&topline=10&year=${year}&month=3,6,9,12`;
  const response = await axios.get(url, {
    timeout: 8000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Referer': `https://fundf10.eastmoney.com/ccmx_${code}.html`
    },
    responseType: 'text'
  });
  const raw = String(response.data);
  const contentMatch = raw.match(/content:"([\s\S]*?)",\s*arryear/);
  if (!contentMatch) throw new Error('东财持仓数据格式异常');
  const html = contentMatch[1].replace(/\\"/g, '"').replace(/\\\//g, '/');
  const table = (html.match(/<table[\s\S]*?<\/table>/g) || [])[0];
  if (!table) throw new Error('东财持仓数据缺失');
  const stocks = [];
  const rows = table.match(/<tr[\s\S]*?<\/tr>/g) || [];
  for (const row of rows) {
    const link = row.match(/quote\.eastmoney\.com\/([a-z]{2})(\d{4,6})\.html"[^>]*>([^<]+)</i);
    const weight = row.match(/([\d.]+)\s*%/);
    if (link && weight) {
      stocks.push({
        market: link[1].toLowerCase(),
        code: link[2],
        name: link[3],
        weight: parseFloat(weight[1])
      });
    }
    if (stocks.length >= 10) break;
  }
  if (!stocks.length) throw new Error('未解析到前十大重仓');
  const quarterMatch = html.match(/(\d{4})年(第?\s*[一二三四1-4])季度/);
  const data = {
    stocks: stocks,
    quarter: quarterMatch ? quarterMatch[0] : '',
    fetchedAt: Date.now()
  };
  store.set(cacheKey, data);
  return data;
}

// 批量行情（腾讯，单次最多 ~50 只；返回 { 'sh600519': 涨跌% }）
async function fetchBatchQuotes(symbols) {
  const url = `https://qt.gtimg.cn/q=${symbols.join(',')}`;
  const response = await axios.get(url, {
    timeout: 5000,
    headers: { 'User-Agent': 'Mozilla/5.0' },
    responseType: 'arraybuffer'
  });
  const text = iconv.decode(response.data, 'gbk');
  const quotes = {};
  const items = text.split(';');
  for (const item of items) {
    const m = item.match(/v_([a-z]{2}\d+)\s*=\s*"([^"]*)"/);
    if (!m) continue;
    const f = m[2].split('~');
    const pct = parseFloat(f[32]);
    if (isFinite(pct)) quotes[m[1].toLowerCase()] = pct;
  }
  return quotes;
}

async function computeEstimate(code, nav) {
  const { stocks, quarter } = await fetchHoldings(code);
  const quotes = await fetchBatchQuotes(stocks.map(s => s.market + s.code));
  let contrib = 0;   // Σ 占净值比 × 涨跌%
  let coverage = 0;  // 实际取到行情的权重覆盖率和
  for (const s of stocks) {
    const pct = quotes[(s.market + s.code).toLowerCase()];
    if (pct !== undefined) {
      contrib += s.weight * pct;
      coverage += s.weight;
    }
  }
  if (coverage === 0) throw new Error('成分股行情全部缺失');
  return {
    estChange: contrib / 100,
    coverage: coverage,
    quarter: quarter
  };
}

async function fetchFundValue(code) {
  // 场内 ETF 优先走腾讯行情 IOPV（按 IOPV 规则实时计算），失败再降级场外估值源
  const sources = getETFMarketPrefix(code)
    ? [{ name: 'etf-iopv', fetch: fetchIOPVFromTencent }, ...SOURCES]
    : SOURCES;
  let lastError = null;
  for (const source of sources) {
    try {
      const result = await source.fetch(code);
      const hasValue = (result.gsz && !isNaN(result.gsz)) || (result.nav && !isNaN(result.nav));
      if (!hasValue) {
        throw new Error(`数据无效: gsz=${result.gsz}, nav=${result.nav}`);
      }
      console.log(`✅ 基金 ${code} 使用源: ${result.source}`);
      return result;
    } catch (error) {
      console.warn(`❌ 源 ${source.name} 失败:`, error.message);
      lastError = error;
    }
  }
  throw new Error(`所有数据源均失败: ${lastError?.message || '未知错误'}`);
}

// ---------- IPC 处理 ----------
ipcMain.handle('fetch-fund', async (event, code) => {
  try {
    const data = await fetchFundValue(code);
    return { ...data, status: 'success' };
  } catch (error) {
    return { status: 'error', message: error.message };
  }
});

ipcMain.handle('fetch-multiple-funds', async (event, fundList) => {
  const promises = fundList.map(async (item) => {
    try {
      const val = await fetchFundValue(item.code);
      // 场外基金（仅有官方净值时）按前十大重仓估算盘中估值
      if (val.navOnly && isFinite(val.nav) && val.nav > 0) {
        try {
          const est = await computeEstimate(item.code, val.nav);
          if (isFinite(est.estChange)) {
            val.gsz = +(val.nav * (1 + est.estChange / 100)).toFixed(4);
            val.gszzl = +est.estChange.toFixed(2);
            val.estimate = { coverage: +est.coverage.toFixed(1), quarter: est.quarter };
            val.source = '重仓估算';
          }
        } catch (e) {
          console.warn(`⚠️ 基金 ${item.code} 重仓估算失败:`, e.message);
        }
      }
      const currentFunds = store.get('funds', []);
      const idx = currentFunds.findIndex(f => f.code === item.code);
      if (idx !== -1 && currentFunds[idx].name !== val.name) {
        currentFunds[idx].name = val.name;
        store.set('funds', currentFunds);
      }
      return {
        ...val,
        costPrice: item.costPrice,
        shares: item.shares,
        profit: (val.gsz - item.costPrice) * item.shares,
        profitRate: ((val.gsz - item.costPrice) / item.costPrice * 100),
        status: 'success'
      };
    } catch (error) {
      return {
        code: item.code,
        status: 'error',
        message: error.message,
        costPrice: item.costPrice,
        shares: item.shares
      };
    }
  });
  return Promise.all(promises);
});

// ---------- 导入导出（含分组） ----------
ipcMain.handle('export-funds', async () => {
  const funds = store.get('funds', []);
  if (!funds.length) {
    return { success: false, message: '没有基金可导出' };
  }
  const exportData = funds.map(f => ({
    code: f.code,
    name: f.name || '',
    cyfe: f.shares,
    cbj: f.costPrice,
    group: f.group || '默认分组',
    zdfRange: 1
  }));
  const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
    title: '导出基金列表',
    defaultPath: 'funds_export.json',
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (canceled || !filePath) {
    return { success: false, message: '取消导出' };
  }
  try {
    fs.writeFileSync(filePath, JSON.stringify(exportData, null, 2), 'utf8');
    return { success: true, message: `导出成功: ${path.basename(filePath)}` };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

ipcMain.handle('import-funds', async () => {
  const { filePaths, canceled } = await dialog.showOpenDialog(mainWindow, {
    title: '导入基金列表',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile']
  });
  if (canceled || filePaths.length === 0) {
    return { success: false, message: '取消导入' };
  }
  try {
    const content = fs.readFileSync(filePaths[0], 'utf8');
    const imported = JSON.parse(content);
    if (!Array.isArray(imported)) {
      return { success: false, message: '文件格式错误：应为数组' };
    }
    const currentFunds = store.get('funds', []);
    const map = new Map();
    currentFunds.forEach(f => map.set(f.code, f));
    const allGroups = new Set(store.get('groups', ['默认分组']));
    imported.forEach(item => {
      if (item.code) {
        const group = item.group || '默认分组';
        allGroups.add(group);
        map.set(item.code, {
          code: item.code,
          name: item.name || '',
          costPrice: item.cbj || item.costPrice || 0,
          shares: item.cyfe || item.shares || 0,
          group: group
        });
      }
    });
    const merged = Array.from(map.values());
    store.set('funds', merged);
    store.set('groups', Array.from(allGroups));
    return { success: true, message: `导入成功，共 ${merged.length} 条记录` };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

// ---------- 应用启动 ----------
app.whenReady().then(() => {
  createWindow();
  applyMenuBarSetting();
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

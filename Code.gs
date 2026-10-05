/**
 * ワインセラー 在庫・棚卸管理（La Cave）
 * ------------------------------------------------------------------
 * スプレッドシートに紐づく Apps Script（コンテナバインド）。
 *
 *   setup()               … 各シートを作成・整形する（最初に1回）
 *   doGet()               … 入力用ウェブページ（index.html）を表示する
 *   getInitialData()      … 画面の初期表示に必要な情報をまとめて返す
 *   saveWine()            … フォームの内容を保存（新規追加 or 既存の更新）
 *   renderInventoryView() … 在庫データ → Cave在庫表（PDF風の整形ビュー）を作り直す
 *   refreshReport()       … 在庫データ → 棚卸表(La Cave) を作り直す
 *   rebuildMaster()       … 在庫データ → 銘柄DB を作り直す
 *
 * シート構成
 *   在庫データ（非表示） … 生データ。1行＝1ワイン（フォームの読み書き先・全集計の元）
 *   Cave在庫表           … PDF風の整形ビュー（棚×ジャンルの見出し・価格帯グループ・グレー行）
 *   棚卸表               … 左=L'occas（手入力）／右=La Cave（自動生成）。税込 ×1.10
 *   銘柄DB               … 入力済み銘柄の記録（生産者＋Cuvéeで重複排除）
 * ------------------------------------------------------------------
 */

/* ==================================================================
 *  設定（ここを編集すればフォームも集計も追従します）
 * ================================================================== */

/** シート名 */
var DATA_SHEET   = '在庫データ'; // 生データ（非表示）
var INV_SHEET    = 'Cave在庫表'; // 整形ビュー
var REPORT_SHEET = '棚卸表';     // 棚卸表（L'occas手入力 + La Cave自動）
var MASTER_SHEET = '銘柄DB';     // 入力済み銘柄の記録

/** 消費税率（税込 = 外税 × (1 + TAX_RATE)） */
var TAX_RATE = 0.10;

/** 棚と、その棚で選べるカテゴリ（プルダウンの中身） */
var SHELVES = [
  {
    code: 'A棚', note: '小売可',
    categories: ['champagne', 'ペティヤン', '白', 'オレンジ', 'ロゼ', '赤']
  },
  {
    code: 'B棚', note: '日本ワイン',
    categories: ['白', 'オレンジ', '赤']
  },
  {
    code: 'C棚', note: '店内用',
    categories: [
      'champagne', 'ペティヤン', '白', 'オレンジ', 'ロゼ', '赤',
      'ChampagneJuli', '微発泡juli', 'シードルjuli', '白juli', 'オレンジjuli', '赤juli',
      '微発泡日本', '白日本', 'オレンジ日本', 'ロゼ日本', '赤日本', '食後酒'
    ]
  }
];

/** 棚卸表(La Cave)に並べるバケット（この順番で表に出ます） */
var BUCKET_ORDER = ['Champagne', 'ペティヤン', '白', 'オレンジ', 'ロゼ', '赤', '食後酒'];

/**
 * カテゴリ → 棚卸表バケットの対応（棚をまたいで色でまとめる）。
 * ★のシードルは分類が曖昧。専用バケットにしたい場合は 'シードル' に変え、BUCKET_ORDER にも追加。
 */
var CATEGORY_TO_BUCKET = {
  'champagne': 'Champagne',
  'ペティヤン': 'ペティヤン',
  '白': '白',
  'オレンジ': 'オレンジ',
  'ロゼ': 'ロゼ',
  '赤': '赤',
  'ChampagneJuli': 'Champagne',
  '微発泡juli': 'ペティヤン',
  'シードルjuli': 'ペティヤン', // ★ シードル
  '白juli': '白',
  'オレンジjuli': 'オレンジ',
  '赤juli': '赤',
  '微発泡日本': 'ペティヤン',
  '白日本': '白',
  'オレンジ日本': 'オレンジ',
  'ロゼ日本': 'ロゼ',
  '赤日本': '赤',
  '食後酒': '食後酒'
};

/**
 * Cave在庫表に出すブロックの定義（この順番・この見出しで出力する）。
 * 既存PDF「ワイン在庫・棚卸表」の区分けをそのまま再現したもの。
 *   shelf … 棚コード / cats … このブロックにまとめるカテゴリ / title … 見出し文字列
 * ※ JULIワインの Champagne・微発泡・シードルは、PDF同様ひとつのブロックにまとめる。
 * ※ ここに無い組み合わせが入力されても、末尾に自動でブロックを作って取りこぼさない。
 */
var SECTIONS = [
  { shelf: 'A棚', cats: ['champagne'],   title: 'A棚 Champagne《小売可》' },
  { shelf: 'A棚', cats: ['ペティヤン'],  title: 'A棚 ペティヤン《小売可》' },
  { shelf: 'A棚', cats: ['白'],          title: 'A棚 白《小売可》' },
  { shelf: 'A棚', cats: ['オレンジ'],    title: 'A棚 オレンジ《小売可》' },
  { shelf: 'A棚', cats: ['ロゼ'],        title: 'A棚 ロゼ《小売可》' },
  { shelf: 'A棚', cats: ['赤'],          title: 'A棚 赤《小売可》' },

  { shelf: 'B棚', cats: ['白'],          title: 'B棚 白 日本ワイン《販売可》' },
  { shelf: 'B棚', cats: ['オレンジ'],    title: 'B棚 オレンジ 日本ワイン《販売可》' },
  { shelf: 'B棚', cats: ['赤'],          title: 'B棚 赤 日本ワイン《販売可》' },

  { shelf: 'C棚', cats: ['champagne'],   title: 'C棚 Champagne《店内用》' },
  { shelf: 'C棚', cats: ['ペティヤン'],  title: 'C棚 ペティヤン《店内用》' },
  { shelf: 'C棚', cats: ['白'],          title: 'C棚 白《店内用》' },
  { shelf: 'C棚', cats: ['オレンジ'],    title: 'C棚 オレンジ《店内用》' },
  { shelf: 'C棚', cats: ['ロゼ'],        title: 'C棚 ロゼ《店内用》' },
  { shelf: 'C棚', cats: ['赤'],          title: 'C棚 赤《店内用》' },

  { shelf: 'C棚', cats: ['ChampagneJuli', '微発泡juli', 'シードルjuli'],
    title: 'C棚 Champagne / 微発泡 / シードル JULIワイン《店内用》' },
  { shelf: 'C棚', cats: ['白juli'],       title: 'C棚 白JULIワイン《店内用》' },
  { shelf: 'C棚', cats: ['オレンジjuli'], title: 'C棚 オレンジJULIワイン《店内用》' },
  { shelf: 'C棚', cats: ['赤juli'],       title: 'C棚 赤JULIワイン《店内用》' },

  { shelf: 'C棚', cats: ['微発泡日本'],   title: 'C棚 白微発泡 日本ワイン《店内用》' },
  { shelf: 'C棚', cats: ['白日本'],       title: 'C棚 白 日本ワイン《店内用》' },
  { shelf: 'C棚', cats: ['オレンジ日本'], title: 'C棚 オレンジ 日本ワイン《店内用》' },
  { shelf: 'C棚', cats: ['ロゼ日本'],     title: 'C棚 ロゼ 日本ワイン《店内用》' },
  { shelf: 'C棚', cats: ['赤日本'],       title: 'C棚 赤 日本ワイン《店内用》' },

  { shelf: 'C棚', cats: ['食後酒'],       title: '食後酒《店内用》' }
];

/** 在庫データ（生データ）の列構成（順序がそのまま列順・A列＝1） */
var HEADERS = [
  '更新日時', '棚', 'カテゴリ', '価格帯', '小売値', '仕入れ日', '仕入れ値',
  'エリア', '生産者', 'Cuvée', 'ヴィンテージ', '品種', '備考', '在庫数',
  'グラス番号'
];

/** 列番号（1始まり） */
var COL = {
  TIMESTAMP: 1, SHELF: 2, CATEGORY: 3, BAND: 4, RETAIL: 5,
  BUY_DATE: 6, BUY_PRICE: 7, AREA: 8, PRODUCER: 9, CUVEE: 10,
  VINTAGE: 11, GRAPE: 12, NOTE: 13, QTY: 14, GLASS: 15
};

/** 銘柄DBの列構成 */
var MASTER_HEADERS = [
  '生産者', 'Cuvée', '棚', 'カテゴリ', '価格帯', '小売値',
  'エリア', 'ヴィンテージ', '品種', '仕入れ日', '仕入れ値', '備考',
  '登録回数', '最終更新'
];

/** Cave在庫表（整形ビュー）の列見出し */
var VIEW_HEADERS = [
  '価格帯', '小売値', 'グラス', '仕入れ日', '仕入れ値', 'エリア', '生産者', 'Cuvée',
  'ヴィンテージ', '品種', '備考', '在庫数'
];
var VIEW_NCOL = VIEW_HEADERS.length; // 12

/** Cave在庫表 の右隣に置く隠し列。各明細行の「在庫データ の行番号」を持ち、書き戻しの宛先になる */
var VIEW_ID_COL = VIEW_NCOL + 1; // 13

/** Cave在庫表 の明細が始まる行（1行目=タイトル, 2行目=空白） */
var VIEW_TOP = 3;

/** 在庫数の列記号。小計・Total の数式を組み立てるのに使う */
var QTY_COL_LETTER = colLetter_(VIEW_NCOL); // 'L'

/** 列番号 → 列記号（1→A, 12→L） */
function colLetter_(n) {
  var s = '';
  while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - m - 1) / 26; }
  return s;
}

/** Cave在庫表 の列番号 → 在庫データ の列番号（全列 1:1 対応） */
var VIEW_TO_DATA = {
  1: 4,   // 価格帯     → COL.BAND
  2: 5,   // 小売値     → COL.RETAIL
  3: 15,  // グラス     → COL.GLASS
  4: 6,   // 仕入れ日    → COL.BUY_DATE
  5: 7,   // 仕入れ値    → COL.BUY_PRICE
  6: 8,   // エリア     → COL.AREA
  7: 9,   // 生産者     → COL.PRODUCER
  8: 10,  // Cuvée     → COL.CUVEE
  9: 11,  // ヴィンテージ → COL.VINTAGE
  10: 12, // 品種      → COL.GRAPE
  11: 13, // 備考      → COL.NOTE
  12: 14  // 在庫数     → COL.QTY
};

/** 色 */
var C_WINE = '#7b1e3a';
var C_WINE_SOFT = '#f3e6ea';
var C_HEAD_TEXT = '#ffffff';
var C_GRAY = '#e0dcde';   // 価格帯グループ区切りのグレー行
var C_LINE = '#d9cdd2';   // 罫線

/** L'occas 手入力エリアの行数 */
var LOCCAS_ROWS = 220;


/* ==================================================================
 *  1. セットアップ
 * ================================================================== */

/**
 * 各シートを作成・整形する。★必ず「新しい空のスプレッドシート」で最初に1回実行。
 * 旧バージョンのフラットな Cave在庫表 にデータがある場合は 在庫データ へ引き継ぎます。
 */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureDataSheet_(ss);        // 生データ用の非表示シート（旧データがあれば移行）
  renderInventoryView_(ss);    // Cave在庫表（整形ビュー）
  refreshReport_(ss);          // 棚卸表
  writeMasterSheet_(ss);       // 銘柄DB
  cleanupDefaultSheet_(ss);    // 既定の空シートが残っていれば削除

  // 手入力を検知して自動再計算するトリガーを設置
  var trigMsg;
  try {
    installTriggers_();
    trigMsg = '・手入力の自動再計算：有効（最後の編集から約' + (DEBOUNCE_MS / 1000) + '秒後）';
  } catch (err) {
    trigMsg = '・手入力の自動再計算：未設定（メニュー「手入力の自動再計算を有効にする」から実行してください）';
  }

  ss.setActiveSheet(ss.getSheetByName(INV_SHEET));
  SpreadsheetApp.getUi().alert(
    'セットアップ完了',
    '「' + INV_SHEET + '」「' + REPORT_SHEET + '」「' + MASTER_SHEET + '」を準備しました。\n' +
    '（生データは非表示シート「' + DATA_SHEET + '」に入ります）\n\n' +
    trigMsg + '\n\n' +
    '次はメニュー「デプロイ」→「新しいデプロイ」からウェブアプリを公開してください。',
    SpreadsheetApp.getUi().ButtonSet.OK
  );
}

/** 生データ用シートを用意する（無ければ作成）。旧フラット Cave在庫表 があれば移行。 */
function ensureDataSheet_(ss) {
  var existed = !!ss.getSheetByName(DATA_SHEET);
  var sh = ss.getSheetByName(DATA_SHEET) || ss.insertSheet(DATA_SHEET);

  // 列が足りなければ先に広げる（項目を追加した後に setup() を再実行した場合）
  if (sh.getMaxColumns() < HEADERS.length) {
    sh.insertColumnsAfter(sh.getMaxColumns(), HEADERS.length - sh.getMaxColumns());
  }
  sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS])
    .setFontWeight('bold').setBackground(C_WINE).setFontColor(C_HEAD_TEXT);
  sh.setFrozenRows(1);
  if (sh.getMaxColumns() > HEADERS.length) {
    sh.deleteColumns(HEADERS.length + 1, sh.getMaxColumns() - HEADERS.length);
  }
  var n = Math.max(sh.getMaxRows() - 1, 1000);
  sh.getRange(2, COL.TIMESTAMP, n, 1).setNumberFormat('yyyy/mm/dd hh:mm');
  sh.getRange(2, COL.BAND, n, 1).setNumberFormat('¥#,##0');
  sh.getRange(2, COL.RETAIL, n, 1).setNumberFormat('¥#,##0');
  sh.getRange(2, COL.BUY_PRICE, n, 1).setNumberFormat('¥#,##0');
  sh.getRange(2, COL.QTY, n, 1).setNumberFormat('0');
  sh.getRange(2, COL.GLASS, n, 1).setNumberFormat('0');

  // 旧フラット Cave在庫表 からの移行（在庫データを新規作成したときだけ）
  if (!existed) {
    var old = ss.getSheetByName(INV_SHEET);
    if (old && old.getLastRow() >= 2 &&
        String(old.getRange(1, 1).getValue() || '').trim() === '更新日時') {
      var rows = old.getRange(2, 1, old.getLastRow() - 1, HEADERS.length).getValues();
      var keep = rows.filter(function (r) { return String(r.join('')).trim() !== ''; });
      if (keep.length) sh.getRange(2, 1, keep.length, HEADERS.length).setValues(keep);
    }
  }
  sh.hideSheet();
  return sh;
}

/** 既定の空シート（シート1/Sheet1）が残っていれば削除 */
function cleanupDefaultSheet_(ss) {
  ['シート1', 'Sheet1'].forEach(function (name) {
    var s = ss.getSheetByName(name);
    if (s && s.getLastRow() === 0 && ss.getSheets().length > 1) {
      try { ss.deleteSheet(s); } catch (e) {}
    }
  });
}


/* ==================================================================
 *  2. データ読み取り（全集計の共通入口）
 * ================================================================== */

/** 在庫データを読み、ワインの配列（シート行順・古い→新しい）で返す */
function readData_(ss) {
  ss = ss || SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(DATA_SHEET);
  if (!sh) return [];
  var last = sh.getLastRow();
  if (last < 2) return [];
  var vals = sh.getRange(2, 1, last - 1, HEADERS.length).getValues();
  var tz = Session.getScriptTimeZone();

  var out = [];
  for (var i = 0; i < vals.length; i++) {
    var r = vals[i];
    var producer = String(r[COL.PRODUCER - 1] || '').trim();
    var cuvee    = String(r[COL.CUVEE - 1] || '').trim();
    var category = String(r[COL.CATEGORY - 1] || '').trim();
    var area     = String(r[COL.AREA - 1] || '').trim();
    var bandN    = numOrBlank_(r[COL.BAND - 1]);
    var qtyN     = numOrBlank_(r[COL.QTY - 1]);
    if (!producer && !cuvee && !category && !area && bandN === '' && qtyN === '') continue;

    out.push({
      id: i + 2, // 在庫データ上の行番号（更新の宛先）
      updated: isDate_(r[COL.TIMESTAMP - 1])
        ? Utilities.formatDate(r[COL.TIMESTAMP - 1], tz, 'yyyy/MM/dd HH:mm') : '',
      shelf: String(r[COL.SHELF - 1] || '').trim(),
      category: category,
      band: bandN,
      retail: numOrBlank_(r[COL.RETAIL - 1]),
      // 日付型で入っている場合は「2026.9.28」の形に整える
      // （素のまま文字列化すると "Mon Sep 28 2026 00:00:00 GMT+0900 ..." になるため）
      buyDate: isDate_(r[COL.BUY_DATE - 1])
        ? Utilities.formatDate(r[COL.BUY_DATE - 1], tz, 'yyyy.M.d')
        : String(r[COL.BUY_DATE - 1] || '').trim(),
      buyPrice: numOrBlank_(r[COL.BUY_PRICE - 1]),
      area: area,
      producer: producer,
      cuvee: cuvee,
      vintage: String(r[COL.VINTAGE - 1] || '').trim(),
      grape: String(r[COL.GRAPE - 1] || '').trim(),
      note: String(r[COL.NOTE - 1] || '').trim(),
      qty: qtyN,
      glass: numOrBlank_(r[COL.GLASS - 1])
    });
  }
  return out;
}

/** 日付型かどうか（実行環境をまたいでも確実に判定できる書き方） */
function isDate_(v) {
  return Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime());
}

function numOrBlank_(v) {
  if (v === '' || v === null || v === undefined) return '';
  var n = Number(v);
  return isNaN(n) ? '' : n;
}

/** 3桁区切り */
function comma_(n) {
  n = Number(n);
  if (isNaN(n)) return '';
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}


/* ==================================================================
 *  3. Cave在庫表（PDF風の整形ビュー）
 * ================================================================== */

/** メニュー用 */
function renderInventoryView() {
  renderInventoryView_(SpreadsheetApp.getActiveSpreadsheet());
  SpreadsheetApp.getActiveSpreadsheet().toast('Cave在庫表を整形しました。', 'ワイン管理', 4);
}

/**
 * 在庫データ → Cave在庫表 をPDF風に組み立て直す。
 *   ・棚×ジャンルごとにセクション（見出しは少し大きめの太字）
 *   ・セクション間は空白2行
 *   ・価格帯グループごとに下へグレーの空白行
 */
function renderInventoryView_(ss) {
  ss = ss || SpreadsheetApp.getActiveSpreadsheet();
  var view = ss.getSheetByName(INV_SHEET) || ss.insertSheet(INV_SHEET, 0);
  view.clear();
  try { view.getRange(1, 1, view.getMaxRows(), view.getMaxColumns()).breakApart(); } catch (e) {}

  var tz = Session.getScriptTimeZone();
  view.getRange('A1').setValue('在庫リスト（La Cave）')
    .setFontSize(16).setFontWeight('bold').setFontColor(C_WINE);
  view.getRange(1, VIEW_NCOL).setValue('最終更新 ' + Utilities.formatDate(new Date(), tz, 'yyyy.M.d'))
    .setHorizontalAlignment('right').setFontColor('#777777');

  var data = readData_(ss);

  // 出力バッファ（値と書式を並行して作る）
  var vals = [], bgs = [], fws = [], fcs = [], fss = [], ids = [];
  function styleRow(bg, fw, fc, fs) {
    var a = [], b = [], c = [], d = [];
    for (var i = 0; i < VIEW_NCOL; i++) { a.push(bg); b.push(fw); c.push(fc); d.push(fs); }
    return { bg: a, fw: b, fc: c, fs: d };
  }
  // id は明細行だけ入れる（見出し・グレー行・Total行は空）。書き戻しの宛先になる。
  function pushRow(rowVals, st, id) {
    vals.push(rowVals); bgs.push(st.bg); fws.push(st.fw); fcs.push(st.fc); fss.push(st.fs);
    ids.push([id === undefined || id === null ? '' : id]);
  }

  function blank_() { var a = []; for (var i = 0; i < VIEW_NCOL; i++) a.push(''); return a; }

  /** 1ブロックぶんを出力する。入力順に関係なく価格帯順へ並べ直す。 */
  function emitSection_(title, items) {
    if (!items.length) return;

    // 並び替え：価格帯昇順（空欄は最後）→ 小売値昇順 → 生産者
    items.sort(function (a, b) {
      var ba = (a.band === '' ? Infinity : a.band), bb = (b.band === '' ? Infinity : b.band);
      if (ba !== bb) return ba - bb;
      var ra = (a.retail === '' ? Infinity : a.retail), rb = (b.retail === '' ? Infinity : b.retail);
      if (ra !== rb) return ra - rb;
      return String(a.producer).localeCompare(String(b.producer));
    });

    // セクション見出し（少し大きめの太字）
    var hRow = blank_(); hRow[0] = title;
    pushRow(hRow, styleRow(C_WINE_SOFT, 'bold', C_WINE, 12));

    // 列見出し
    pushRow(VIEW_HEADERS.slice(), styleRow(C_WINE, 'bold', C_HEAD_TEXT, 10));

    var prevBand = null, started = false, bandStart = -1;
    var greyCells = []; // 各価格帯の小計セル（Total がこれを足す）

    // 価格帯の切れ目に入るグレー行。右端にその価格帯の在庫数小計を「数式で」出す。
    // 固定値ではなく数式にすることで、明細の在庫数を書き換えた瞬間に小計とTotalが追従する。
    function flushBand_() {
      var g = blank_();
      var first = VIEW_TOP + bandStart;          // この価格帯の最初の明細行
      var last  = VIEW_TOP + (vals.length - 1);  // 直前に積んだ明細行
      g[VIEW_NCOL - 1] = '=SUM(' + QTY_COL_LETTER + first + ':' + QTY_COL_LETTER + last + ')';
      greyCells.push(QTY_COL_LETTER + (VIEW_TOP + vals.length)); // これから積むグレー行の位置
      pushRow(g, styleRow(C_GRAY, 'bold', '#000000', 10));
    }

    items.forEach(function (w) {
      var bandKey = (w.band === '' ? '' : w.band);
      if (started && bandKey !== prevBand) flushBand_();
      var firstOfBand = (bandKey !== prevBand);
      if (firstOfBand) bandStart = vals.length;  // この明細行が入る位置を覚えておく
      var rowVals = [
        firstOfBand ? (w.band === '' ? '' : w.band) : '',
        w.retail === '' ? '' : w.retail,
        w.glass === '' ? '' : w.glass,
        w.buyDate,
        w.buyPrice === '' ? '' : w.buyPrice,
        w.area, w.producer, w.cuvee, w.vintage, w.grape, w.note,
        w.qty === '' ? '' : w.qty
      ];
      var st = styleRow('#ffffff', 'normal', '#000000', 10);
      if (firstOfBand) st.fw[0] = 'bold'; // 価格帯の頭を太字
      pushRow(rowVals, st, w.id);
      prevBand = bandKey; started = true;
    });
    if (started) flushBand_(); // 最後の価格帯グループの下にもグレー行

    // ブロック合計（各価格帯の小計セルを足す数式）
    var t = blank_();
    t[VIEW_NCOL - 2] = 'Total';
    t[VIEW_NCOL - 1] = greyCells.length ? '=SUM(' + greyCells.join(',') + ')' : 0;
    pushRow(t, styleRow(C_WINE_SOFT, 'bold', C_WINE, 10));

    // セクション間の空白2行
    pushRow(blank_(), styleRow('#ffffff', 'normal', '#000000', 10));
    pushRow(blank_(), styleRow('#ffffff', 'normal', '#000000', 10));
  }

  // --- PDFと同じ順番・同じ見出しでブロックを出力 ---
  var used = {};
  SECTIONS.forEach(function (sec) {
    sec.cats.forEach(function (c) { used[sec.shelf + '\u0000' + c] = true; });
    emitSection_(sec.title, data.filter(function (w) {
      return w.shelf === sec.shelf && sec.cats.indexOf(w.category) !== -1;
    }));
  });

  // --- SECTIONS に無い棚×カテゴリも末尾にまとめて出し、取りこぼしを防ぐ ---
  var leftovers = {}, leftoverKeys = [];
  data.forEach(function (w) {
    var k = w.shelf + '\u0000' + w.category;
    if (used[k]) return;
    if (!leftovers[k]) { leftovers[k] = []; leftoverKeys.push(k); }
    leftovers[k].push(w);
  });
  leftoverKeys.forEach(function (k) {
    var p = k.split('\u0000');
    emitSection_(((p[0] ? p[0] + ' ' : '') + p[1]).trim() || '（未分類）', leftovers[k]);
  });

  if (vals.length) {
    var top = VIEW_TOP;
    var rng = view.getRange(top, 1, vals.length, VIEW_NCOL);
    rng.setValues(vals);
    rng.setBackgrounds(bgs);
    rng.setFontWeights(fws);
    rng.setFontColors(fcs);
    rng.setFontSizes(fss);
    rng.setVerticalAlignment('middle');
    rng.setBorder(true, true, true, true, true, true, C_LINE, SpreadsheetApp.BorderStyle.SOLID);
    // 数値の書式
    view.getRange(top, 1, vals.length, 1).setNumberFormat('¥#,##0'); // 価格帯
    view.getRange(top, 2, vals.length, 1).setNumberFormat('¥#,##0'); // 小売値
    view.getRange(top, 3, vals.length, 1).setNumberFormat('0')       // グラス番号
      .setHorizontalAlignment('center');
    view.getRange(top, 4, vals.length, 1).setNumberFormat('@');      // 仕入れ日（文字列のまま保つ）
    view.getRange(top, 5, vals.length, 1).setNumberFormat('¥#,##0'); // 仕入れ値
    view.getRange(top, VIEW_NCOL, vals.length, 1).setNumberFormat('0'); // 在庫数
    view.getRange(top, 11, vals.length, 1).setWrap(true); // 備考
    view.getRange(top, 10, vals.length, 1).setWrap(true); // 品種

    // 書き戻し用の隠し列（在庫データの行番号）
    if (view.getMaxColumns() < VIEW_ID_COL) {
      view.insertColumnsAfter(view.getMaxColumns(), VIEW_ID_COL - view.getMaxColumns());
    }
    view.getRange(top, VIEW_ID_COL, ids.length, 1).setValues(ids);
    view.getRange(1, VIEW_ID_COL).setValue('_id'); // 目印（隠れているので見えない）
    view.hideColumns(VIEW_ID_COL);
  }

  // 列幅
  var w = [95, 80, 50, 95, 90, 120, 210, 250, 110, 220, 240, 65];
  for (var i = 0; i < w.length; i++) view.setColumnWidth(i + 1, w[i]);
  view.setFrozenRows(2);
  return view;
}


/* ==================================================================
 *  4. 棚卸表（L'occas 手入力 + La Cave 自動）
 * ================================================================== */

function refreshReport() {
  refreshReport_(SpreadsheetApp.getActiveSpreadsheet());
  SpreadsheetApp.getActiveSpreadsheet().toast('棚卸表(La Cave)を更新しました。', 'ワイン管理', 4);
}

function refreshReport_(ss) {
  var sh = ss.getSheetByName(REPORT_SHEET);
  var firstTime = !sh;
  if (!sh) sh = ss.insertSheet(REPORT_SHEET, 1);

  var now = new Date();
  var tz = Session.getScriptTimeZone();
  sh.getRange('A1').setValue((now.getMonth() + 1) + '月 ワイン棚卸表')
    .setFontSize(16).setFontWeight('bold').setFontColor(C_WINE);
  sh.getRange('I1').setValue('棚卸日 ' + Utilities.formatDate(now, tz, 'yyyy.M.d'))
    .setHorizontalAlignment('right').setFontColor('#777777');

  var HED = ['アイテム', '本数', '販売価格(外税)', '小計(外税)'];
  sh.getRange('A3').setValue("L'occas").setFontWeight('bold').setFontSize(12);
  sh.getRange('F3').setValue('La Cave').setFontWeight('bold').setFontSize(12).setFontColor(C_WINE);
  sh.getRange(4, 1, 1, 4).setValues([HED]).setFontWeight('bold')
    .setBackground(C_WINE).setFontColor(C_HEAD_TEXT).setHorizontalAlignment('center');
  sh.getRange(4, 6, 1, 4).setValues([HED]).setFontWeight('bold')
    .setBackground(C_WINE).setFontColor(C_HEAD_TEXT).setHorizontalAlignment('center');

  if (firstTime) buildLoccasTemplate_(sh);
  buildLaCave_(sh, ss);

  var w = [150, 60, 110, 110, 24, 150, 60, 110, 110];
  for (var i = 0; i < w.length; i++) sh.setColumnWidth(i + 1, w[i]);
  return sh;
}

/** L'occas の手入力テンプレート（本数を入れると小計が出る） */
function buildLoccasTemplate_(sh) {
  var top = 5;
  var formulas = [];
  for (var i = 0; i < LOCCAS_ROWS; i++) {
    var r = top + i;
    formulas.push(['=IF(AND($B' + r + '<>"",$C' + r + '<>""),$B' + r + '*$C' + r + ',"")']);
  }
  sh.getRange(top, 4, LOCCAS_ROWS, 1).setFormulas(formulas);
  sh.getRange(top, 2, LOCCAS_ROWS, 1).setNumberFormat('0');
  sh.getRange(top, 3, LOCCAS_ROWS, 2).setNumberFormat('¥#,##0');

  var totalRow = top + LOCCAS_ROWS;
  var taxRow = totalRow + 1;
  sh.getRange(totalRow, 1).setValue('Total').setFontWeight('bold');
  sh.getRange(totalRow, 2).setFormula('=SUM(B' + top + ':B' + (totalRow - 1) + ')').setFontWeight('bold').setNumberFormat('0');
  sh.getRange(totalRow, 4).setFormula('=SUM(D' + top + ':D' + (totalRow - 1) + ')').setFontWeight('bold').setNumberFormat('¥#,##0');
  sh.getRange(totalRow, 1, 1, 4).setBackground(C_WINE_SOFT);
  sh.getRange(taxRow, 1).setValue('税込価格').setFontWeight('bold');
  sh.getRange(taxRow, 4).setFormula('=ROUND(D' + totalRow + '*(1+' + TAX_RATE + '),0)').setFontWeight('bold').setNumberFormat('¥#,##0');
}

/** La Cave（F〜I列）を在庫データから作り直す */
function buildLaCave_(sh, ss) {
  var top = 5;
  var lastRow = sh.getMaxRows();
  if (lastRow >= top) sh.getRange(top, 6, lastRow - top + 1, 4).clearContent().clearFormat();

  var agg = readAggregation_(ss);

  var rows = [];
  var grandCount = 0, grandSub = 0;
  BUCKET_ORDER.forEach(function (bucket) {
    var bands = agg[bucket];
    if (!bands) return;
    var bandKeys = Object.keys(bands).map(Number).sort(function (a, b) { return a - b; });
    if (!bandKeys.length) return;
    rows.push({ t: 'head', v: [bucket, '', '', ''] });
    var bCount = 0, bSub = 0;
    bandKeys.forEach(function (band) {
      var cnt = bands[band];
      var sub = band * cnt;
      bCount += cnt; bSub += sub;
      rows.push({ t: 'item', v: ['', cnt, band, sub] });
    });
    rows.push({ t: 'sub', v: ['小計', bCount, '', bSub] });
    grandCount += bCount; grandSub += bSub;
  });
  rows.push({ t: 'total', v: ['Total', grandCount, '', grandSub] });
  rows.push({ t: 'tax', v: ['税込価格', '', '', Math.round(grandSub * (1 + TAX_RATE))] });

  var values = rows.map(function (r) { return r.v; });
  var rng = sh.getRange(top, 6, values.length, 4);
  rng.setValues(values);
  rng.setNumberFormats(rows.map(function () { return ['@', '0', '¥#,##0', '¥#,##0']; }));
  for (var i = 0; i < rows.length; i++) {
    var r = top + i, kind = rows[i].t, band = sh.getRange(r, 6, 1, 4);
    if (kind === 'head') band.setFontWeight('bold').setBackground('#efe3e7');
    else if (kind === 'sub') { sh.getRange(r, 6).setFontColor('#777777'); band.setFontStyle('italic'); }
    else if (kind === 'total') band.setFontWeight('bold').setBackground(C_WINE_SOFT);
    else if (kind === 'tax') band.setFontWeight('bold');
  }
}

/** 在庫データを読み、bucket -> band(価格帯) -> 本数合計 を返す */
function readAggregation_(ss) {
  var agg = {};
  readData_(ss).forEach(function (w) {
    if (!w.category || w.band === '' || w.qty === '' || !w.qty) return;
    var bucket = CATEGORY_TO_BUCKET[w.category] || w.category;
    if (!agg[bucket]) agg[bucket] = {};
    agg[bucket][w.band] = (agg[bucket][w.band] || 0) + w.qty;
    if (BUCKET_ORDER.indexOf(bucket) === -1) BUCKET_ORDER.push(bucket);
  });
  return agg;
}


/* ==================================================================
 *  5. 銘柄DB（入力済み銘柄の記録）
 * ================================================================== */

/** マスタ照合用のキー（生産者＋Cuvéeを正規化） */
function masterKey_(producer, cuvee) {
  function norm(s) {
    return String(s || '').trim().toLowerCase()
      .replace(/[\s　]/g, '')
      .replace(/[０-９]/g, function (ch) { return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0); });
  }
  return norm(producer) + '|' + norm(cuvee);
}

/** 在庫データから銘柄マスタ（生産者＋Cuvéeで重複排除・後勝ち）を作る */
function computeMasters_() {
  var data = readData_(SpreadsheetApp.getActiveSpreadsheet());
  var map = {}, order = [];
  data.forEach(function (w) {
    if (!w.producer && !w.cuvee) return;
    var key = masterKey_(w.producer, w.cuvee);
    if (!map[key]) { map[key] = { count: 0 }; order.push(key); }
    var m = map[key];
    m.count++;
    m.key = key; m.producer = w.producer; m.cuvee = w.cuvee;
    m.shelf = w.shelf; m.category = w.category; m.band = w.band; m.retail = w.retail;
    m.area = w.area; m.vintage = w.vintage; m.grape = w.grape;
    m.buyDate = w.buyDate; m.buyPrice = w.buyPrice; m.note = w.note; m.updated = w.updated;
  });
  return order.map(function (k) { return map[k]; });
}

/** 銘柄DBタブを作り直す */
function writeMasterSheet_(ss) {
  ss = ss || SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(MASTER_SHEET) || ss.insertSheet(MASTER_SHEET, ss.getNumSheets());

  sh.getRange(1, 1, 1, MASTER_HEADERS.length).setValues([MASTER_HEADERS])
    .setFontWeight('bold').setBackground(C_WINE).setFontColor(C_HEAD_TEXT);
  sh.setFrozenRows(1);
  if (sh.getMaxColumns() > MASTER_HEADERS.length) {
    sh.deleteColumns(MASTER_HEADERS.length + 1, sh.getMaxColumns() - MASTER_HEADERS.length);
  }
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, MASTER_HEADERS.length).clearContent();

  var masters = computeMasters_();
  if (masters.length) {
    var rows = masters.map(function (m) {
      return [m.producer, m.cuvee, m.shelf, m.category, m.band, m.retail,
              m.area, m.vintage, m.grape, m.buyDate, m.buyPrice, m.note, m.count, m.updated];
    });
    sh.getRange(2, 1, rows.length, MASTER_HEADERS.length).setValues(rows);
    sh.getRange(2, 5, rows.length, 2).setNumberFormat('¥#,##0');
    sh.getRange(2, 11, rows.length, 1).setNumberFormat('¥#,##0');
    sh.getRange(2, 13, rows.length, 1).setNumberFormat('0');
  }
  var w = [200, 240, 55, 150, 90, 90, 120, 110, 220, 90, 90, 220, 80, 130];
  for (var i = 0; i < w.length; i++) sh.setColumnWidth(i + 1, w[i]);
  return sh;
}

function rebuildMaster() {
  writeMasterSheet_(SpreadsheetApp.getActiveSpreadsheet());
  SpreadsheetApp.getActiveSpreadsheet().toast('銘柄DBを更新しました。', 'ワイン管理', 4);
}


/* ==================================================================
 *  6. ウェブアプリ
 * ================================================================== */

function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('ワイン在庫入力')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** 画面表示に必要な情報をまとめて返す */
function getInitialData() {
  return {
    shelves: SHELVES,
    suggestions: getSuggestions_(),
    wines: getAllWines_(),
    sheetUrl: SpreadsheetApp.getActiveSpreadsheet().getUrl()
  };
}

/**
 * フォームの内容を保存する。payload.id が有れば その行を更新、無ければ新規追加。
 * 保存先は 在庫データ。保存後に Cave在庫表・棚卸表・銘柄DB を作り直す。
 */
function saveWine(payload) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new Error('ほかの処理と重なりました。少し待ってからもう一度お試しください。');
  try {
    var rec = validate_(payload);
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = ss.getSheetByName(DATA_SHEET);
    if (!sh) throw new Error('「' + DATA_SHEET + '」が見つかりません。setup() を実行してください。');

    var rowValues = [
      new Date(), rec.shelf, rec.category, rec.band, rec.retail,
      rec.buyDate, rec.buyPrice, rec.area, rec.producer, rec.cuvee,
      rec.vintage, rec.grape, rec.note, rec.qty, rec.glass
    ];

    var isUpdate = false;
    var id = Number(payload && payload.id);
    if (id && id >= 2 && id <= sh.getLastRow()) {
      sh.getRange(id, 1, 1, HEADERS.length).setValues([rowValues]);
      isUpdate = true;
    } else {
      sh.appendRow(rowValues);
    }
    SpreadsheetApp.flush();

    renderInventoryView_(ss);
    refreshReport_(ss);
    writeMasterSheet_(ss);

    var label = (rec.producer || rec.cuvee || rec.category || rec.area || '（無題）');
    var qtyTxt = (rec.qty === '' ? '' : '（' + rec.qty + '本）');
    return {
      ok: true,
      message: (isUpdate ? '更新しました：' : '登録しました：') +
               [rec.shelf, rec.category, label].filter(String).join(' / ') + qtyTxt,
      wines: getAllWines_(),
      suggestions: getSuggestions_()
    };
  } finally {
    lock.releaseLock();
  }
}

/** 入力値の検証と正規化（全項目 任意。完全に空の登録だけ拒否） */
function validate_(p) {
  p = p || {};
  var shelf = String(p.shelf || '').trim();
  var category = String(p.category || '').trim();
  var producer = String(p.producer || '').trim();
  var cuvee = String(p.cuvee || '').trim();
  var area = String(p.area || '').trim();
  var band = leniNum_(p.band);
  var retail = leniNum_(p.retail);
  var buyPrice = leniNum_(p.buyPrice);
  var qty = leniInt_(p.qty);

  if (!producer && !cuvee && !category && !area && band === '') {
    throw new Error('生産者・Cuvée・カテゴリ・エリア・価格帯のいずれか1つは入力してください。');
  }
  // グラス番号は 1〜9 のみ。範囲外や空欄は未設定（''）として扱う。
  var glass = leniInt_(p.glass);
  if (glass !== '' && (glass < 1 || glass > 9)) {
    throw new Error('グラス番号は 1〜9 で入力してください。');
  }

  return {
    shelf: shelf, category: category, band: band, retail: retail,
    buyDate: String(p.buyDate || '').trim(), buyPrice: buyPrice, area: area,
    producer: producer, cuvee: cuvee, vintage: String(p.vintage || '').trim(),
    grape: String(p.grape || '').trim(), note: String(p.note || '').trim(), qty: qty,
    glass: glass
  };
}

/** 数値化（不正・空なら ''）。「¥1,200」「１２００」等も受け取る */
function toNumber_(v) {
  if (v === null || v === undefined) return NaN;
  var s = String(v).trim();
  if (s === '') return NaN;
  s = s.replace(/[０-９．]/g, function (ch) { return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0); });
  s = s.replace(/[¥￥,\s円]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return NaN;
  return Number(s);
}
function leniNum_(v) { var n = toNumber_(v); return isNaN(n) ? '' : n; }
function leniInt_(v) { var n = toNumber_(v); if (isNaN(n)) return ''; n = Math.floor(n); return n < 0 ? 0 : n; }

/** 全ワインを画面用に返す（検索・更新用・新しい順） */
function getAllWines_() {
  return readData_(SpreadsheetApp.getActiveSpreadsheet()).reverse();
}

/** エリア・生産者・Cuvée・品種の既出値を入力候補として返す */
function getSuggestions_() {
  var data = readData_(SpreadsheetApp.getActiveSpreadsheet());
  return {
    areas:     uniq_(data.map(function (w) { return w.area; })),
    producers: uniq_(data.map(function (w) { return w.producer; })),
    cuvees:    uniq_(data.map(function (w) { return w.cuvee; })),
    grapes:    uniq_(data.map(function (w) { return w.grape; }))
  };
}

function uniq_(arr) {
  var seen = {}, out = [];
  for (var i = arr.length - 1; i >= 0 && out.length < 500; i--) {
    var v = String(arr[i] || '').trim();
    if (!v || seen[v]) continue;
    seen[v] = true; out.push(v);
  }
  return out.sort();
}


/* ==================================================================
 *  7. スプレッドシートのメニュー
 * ================================================================== */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('ワイン管理')
    .addItem('初期設定 / 書式を作り直す', 'setup')
    .addItem('Cave在庫表を今すぐ整形', 'renderInventoryView')
    .addItem('棚卸表(La Cave)を今すぐ更新', 'refreshReport')
    .addItem('銘柄DBを今すぐ更新', 'rebuildMaster')
    .addSeparator()
    .addItem('手入力の自動再計算を有効にする', 'installTriggers')
    .addItem('手入力の自動再計算を止める', 'uninstallTriggers')
    .addSeparator()
    .addItem('入力ページのURLを表示', 'showWebAppUrl')
    .addToUi();
}

function showWebAppUrl() {
  var url = ScriptApp.getService().getUrl();
  var ui = SpreadsheetApp.getUi();
  if (!url) {
    ui.alert('まだウェブアプリが公開されていません。\n右上の「デプロイ」→「新しいデプロイ」から公開してください。');
    return;
  }
  ui.alert('入力ページのURL', url + '\n\nスマホのホーム画面に追加しておくと便利です。', ui.ButtonSet.OK);
}


/* ==================================================================
 *  8. 手入力の自動検知（編集の10秒後にまとめて再計算）
 * ------------------------------------------------------------------
 *  在庫データ の「価格帯 / 小売値 / 仕入れ値 / 在庫数」を手で書き換えると、
 *  最後の編集から DEBOUNCE_MS 後に Cave在庫表・棚卸表・銘柄DB を作り直す。
 *  連続して直したときは締め切りが後ろへずれ、再計算は1回だけ走る。
 * ================================================================== */

/** 監視する列 */
var WATCH_COLS = [COL.BAND, COL.RETAIL, COL.BUY_PRICE, COL.QTY];

/** 最後の編集から待つ時間（ミリ秒） */
var DEBOUNCE_MS = 10000;

var PROP_DIRTY_AT   = 'recalcDirtyAt';   // 最後に編集された時刻
var PROP_TRIGGER_ID = 'recalcTriggerId'; // 待機中のワンショットトリガー

/**
 * 設置型 onEdit トリガーの受け口。
 * ※ 設置型トリガーはスクリプトによる書き込みでは発火しないため、
 *    フォーム登録時に二重で再計算が走ることはない。
 */
function onSheetEdit(e) {
  try {
    if (!e || !e.range) return;
    var name = e.range.getSheet().getName();
    if (name === DATA_SHEET) { handleDataEdit_(e); return; }
    if (name === INV_SHEET)  { handleViewEdit_(e); return; }
  } catch (err) {
    console.error('onSheetEdit: ' + err);
  }
}

/** 在庫データ 側の編集：監視列にかかっていれば再計算を予約するだけ */
function handleDataEdit_(e) {
  try {
    if (e.range.getLastRow() < 2) return; // 見出し行だけの編集は無視

    // 編集範囲が監視列に少しでもかかっているか
    var c1 = e.range.getColumn();
    var c2 = c1 + e.range.getNumColumns() - 1;
    var hit = false;
    for (var i = 0; i < WATCH_COLS.length; i++) {
      if (WATCH_COLS[i] >= c1 && WATCH_COLS[i] <= c2) { hit = true; break; }
    }
    if (!hit) return;

    scheduleRecalc_();
  } catch (err) {
    console.error('handleDataEdit_: ' + err);
  }
}

/**
 * Cave在庫表 側の編集：隠しID列から元の行を割り出し、在庫データ へ書き戻してから再計算を予約する。
 * 見出し行・グレー行・Total行（ID無し）は無視する。
 */
function handleViewEdit_(e) {
  try {
    var view = e.range.getSheet();
    var c1 = e.range.getColumn();
    if (c1 > VIEW_NCOL) return;             // 隠しID列より右は対象外
    var r1 = e.range.getRow();
    if (r1 + e.range.getNumRows() - 1 < 3) return; // タイトル行だけの編集

    var data = view.getParent().getSheetByName(DATA_SHEET);
    if (!data) return;

    var nR = e.range.getNumRows(), nC = e.range.getNumColumns();
    var lastDataRow = data.getLastRow();
    var ids  = view.getRange(r1, VIEW_ID_COL, nR, 1).getValues();
    var vals = e.range.getValues();

    // 編集された表示列 → 在庫データの列 に置き換え、列番号順に並べる
    var targets = [];
    for (var j = 0; j < nC; j++) {
      var dc = VIEW_TO_DATA[c1 + j];
      if (dc) targets.push({ dcol: dc, vj: j });
    }
    if (!targets.length) return;
    targets.sort(function (a, b) { return a.dcol - b.dcol; });

    // 連続した列をひとまとめにする（1かたまり＝書き込み1往復）
    var runs = [], run = [targets[0]];
    for (var t = 1; t < targets.length; t++) {
      if (targets[t].dcol === run[run.length - 1].dcol + 1) run.push(targets[t]);
      else { runs.push(run); run = [targets[t]]; }
    }
    runs.push(run);

    var now = new Date();
    var touched = 0;

    for (var i = 0; i < nR; i++) {
      var id = Number(ids[i][0]);
      if (!id || id < 2 || id > lastDataRow) continue; // 見出し・グレー行・Total行

      for (var ri = 0; ri < runs.length; ri++) {
        var g = runs[ri], row = [];
        for (var gi = 0; gi < g.length; gi++) {
          row.push(normalizeForData_(g[gi].dcol, vals[i][g[gi].vj]));
        }
        data.getRange(id, g[0].dcol, 1, g.length).setValues([row]);
      }
      data.getRange(id, COL.TIMESTAMP).setValue(now);
      touched++;
    }

    if (touched) scheduleRecalc_();
  } catch (err) {
    console.error('handleViewEdit_: ' + err);
  }
}

/** 在庫データの列に合わせて値を整える（数値列は数値に、それ以外は文字列に） */
function normalizeForData_(dataCol, v) {
  if (dataCol === COL.BAND || dataCol === COL.RETAIL || dataCol === COL.BUY_PRICE) return leniNum_(v);
  if (dataCol === COL.QTY || dataCol === COL.GLASS) return leniInt_(v);
  if (isDate_(v)) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy.M.d');
  return String(v === null || v === undefined ? '' : v).trim();
}


/** 再計算の予約。既に待機中なら締め切りだけ更新する（トリガーは作り直さない） */
function scheduleRecalc_() {
  var props = PropertiesService.getScriptProperties();
  props.setProperty(PROP_DIRTY_AT, String(Date.now()));

  if (props.getProperty(PROP_TRIGGER_ID)) return; // 既に待機中

  var t = ScriptApp.newTrigger('runPendingRecalc').timeBased().after(DEBOUNCE_MS).create();
  props.setProperty(PROP_TRIGGER_ID, t.getUniqueId());
}

/** 予約時刻に呼ばれる。まだ編集直後なら、残り時間ぶん待ち直す */
function runPendingRecalc() {
  var props = PropertiesService.getScriptProperties();
  props.deleteProperty(PROP_TRIGGER_ID);
  deleteClockTriggers_('runPendingRecalc'); // 使い終えたワンショットを掃除

  var dirtyAt = Number(props.getProperty(PROP_DIRTY_AT) || 0);
  if (!dirtyAt) return;

  var waited = Date.now() - dirtyAt;
  if (waited < DEBOUNCE_MS) {
    // 待っている間にまた編集された → 締め切りを延ばす
    var rest = Math.max(DEBOUNCE_MS - waited, 1000);
    var t = ScriptApp.newTrigger('runPendingRecalc').timeBased().after(rest).create();
    props.setProperty(PROP_TRIGGER_ID, t.getUniqueId());
    return;
  }

  props.deleteProperty(PROP_DIRTY_AT);

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return; // フォーム登録と重なったら今回は見送り（次の編集で再度走る）
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    renderInventoryView_(ss);
    refreshReport_(ss);
    writeMasterSheet_(ss);
    ss.toast('手入力を検知して再計算しました。', 'ワイン管理', 5);
  } finally {
    lock.releaseLock();
  }
}

/** 指定関数の時間ベーストリガーをすべて削除 */
function deleteClockTriggers_(fnName) {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === fnName &&
        t.getEventType() === ScriptApp.EventType.CLOCK) {
      ScriptApp.deleteTrigger(t);
    }
  });
}

/** 自動再計算を有効にする（setup から自動で呼ばれる。メニューからも実行可） */
function installTriggers() {
  installTriggers_();
  SpreadsheetApp.getUi().alert(
    '自動再計算を有効にしました',
    '「' + DATA_SHEET + '」の 価格帯 / 小売値 / 仕入れ値 / 在庫数 を手で書き換えると、\n' +
    '最後の編集から約' + (DEBOUNCE_MS / 1000) + '秒後に各シートを作り直します。',
    SpreadsheetApp.getUi().ButtonSet.OK
  );
}

function installTriggers_() {
  // 同じ役目のトリガーが残っていれば作り直す（重複発火を防ぐ）
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var fn = t.getHandlerFunction();
    if (fn === 'onSheetEdit' || fn === 'runPendingRecalc') ScriptApp.deleteTrigger(t);
  });

  ScriptApp.newTrigger('onSheetEdit')
    .forSpreadsheet(SpreadsheetApp.getActiveSpreadsheet())
    .onEdit()
    .create();

  var props = PropertiesService.getScriptProperties();
  props.deleteProperty(PROP_TRIGGER_ID);
  props.deleteProperty(PROP_DIRTY_AT);
}

/** 自動再計算を止める */
function uninstallTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var fn = t.getHandlerFunction();
    if (fn === 'onSheetEdit' || fn === 'runPendingRecalc') ScriptApp.deleteTrigger(t);
  });
  var props = PropertiesService.getScriptProperties();
  props.deleteProperty(PROP_TRIGGER_ID);
  props.deleteProperty(PROP_DIRTY_AT);
  SpreadsheetApp.getUi().alert('自動再計算を止めました。メニューから手動で更新してください。');
}

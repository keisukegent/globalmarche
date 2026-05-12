/**
 * 民泊オーナー明細 → Gmail 下書き自動作成（送信はしない）
 *
 * PDF のファイル名（優先順）:
 * (A) 3B202602.pdf … 英数字の施設コード + YYYYMM（スペースなし・台帳「施設コード」）
 * (B) THE HILLTOP GARDEN VILLA Can202602.pdf … 施設名 + YYYYMM（統一形式・台帳「施設名」と一致）
 * (C) ○○施設 2月.pdf … レガシー（施設名 + ◯月.pdf）
 *
 * シート1行目: 宛名 / メール / 施設名 / 施設コード（(A)はD列、(B)(C)は施設名）
 * 下書きは毎回 CC に DRAFT_CC を付与。
 */

var DEFAULT_DRIVE_FOLDER_ID = '1qZd-WvHbKHjBVouunSqsWKIiXpsgfx0D';
/** 全件の下書きに入れる CC（変更する場合はここだけ編集） */
var DRAFT_CC = 'k-aoki@llc-blueocean.jp';
var PROP_DRIVE_FOLDER_ID = 'DRIVE_FOLDER_ID';
var OWNER_SHEET_NAME = ''; // 空なら先頭シート

/** スプレッドシートを開いたとき */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('明細メール')
    .addItem('下書きを一括作成（ドライブのPDF）', 'createDraftsFromDriveFolder')
    .addSeparator()
    .addItem('設定: 監視フォルダID', 'promptSetFolderId')
    .addToUi();
}

/** メイン: フォルダ内の各 PDF について Gmail 下書きを作成 */
function createDraftsFromDriveFolder() {
  var ui = SpreadsheetApp.getUi();
  var folderId = getFolderId_();
  var folder;
  try {
    folder = DriveApp.getFolderById(folderId);
  } catch (e) {
    ui.alert('フォルダを開けませんでした。ID とアクセス権を確認してください。\n' + e.message);
    return;
  }

  var ownerCtx;
  try {
    ownerCtx = buildOwnerMap_();
  } catch (e) {
    ui.alert('台帳の読み込みに失敗しました。\n' + e.message);
    return;
  }

  if (!ownerCtx.hasRows) {
    ui.alert(
      '台帳に有効な行がありません。\nメールが入り、かつ「施設コード」または「施設名」のどちらかが入った行が必要です。'
    );
    return;
  }

  var files = listPdfFiles_(folder);
  if (files.length === 0) {
    ui.alert('フォルダ内に PDF がありません: ' + folder.getName());
    return;
  }

  var ok = [];
  var skip = [];
  var err = [];

  for (var i = 0; i < files.length; i++) {
    var file = files[i];
    var fname = file.getName();
    var resolved = resolvePdfToEntry_(fname, ownerCtx);
    if (!resolved) {
      skip.push(
        fname +
          '（ファイル名を解析できません。例: 3B202602.pdf または 施設名202602.pdf）'
      );
      continue;
    }

    if (!resolved.entry) {
      err.push(
        fname +
          '（台帳に一致する行がありません。施設コードまたは施設名を確認してください）'
      );
      continue;
    }

    try {
      createOneDraft_(resolved.entry, file, resolved.parsed);
      ok.push(fname + ' → ' + resolved.entry.email);
    } catch (ex) {
      err.push(fname + ' : ' + ex.message);
    }
  }

  var msg =
    '【完了】\n' +
    '成功: ' +
    ok.length +
    ' 件\n' +
    'スキップ: ' +
    skip.length +
    ' 件\n' +
    'エラー: ' +
    err.length +
    ' 件\n\n';
  if (ok.length) msg += '■ 成功\n' + ok.join('\n') + '\n\n';
  if (skip.length) msg += '■ スキップ\n' + skip.join('\n') + '\n\n';
  if (err.length) msg += '■ エラー\n' + err.join('\n');

  ui.alert(msg.length > 1500 ? msg.substring(0, 1490) + '…（全文は実行ログ）' : msg);
  Logger.log(msg);
}

/**
 * @returns {{ entry: Object|null, parsed: Object }|null} null = ファイル名形式エラー
 */
function resolvePdfToEntry_(fname, ownerCtx) {
  var parsedCode = parseStatementFilename_(fname);
  if (parsedCode) {
    var e1 = ownerCtx.byCode[parsedCode.code];
    return { entry: e1 || null, parsed: parsedCode };
  }

  var parsedYyyymm = parseFacilityYyyymmFilename_(fname);
  if (parsedYyyymm) {
    var eY = findEntryByPropertyStem_(ownerCtx.byProperty, parsedYyyymm.stem);
    return {
      entry: eY || null,
      parsed: {
        month: parsedYyyymm.month,
        year: parsedYyyymm.year,
        yyyymm: parsedYyyymm.yyyymm,
        code: '',
      },
    };
  }

  var parsedProp = parseFacilityMonthFilename_(fname);
  if (parsedProp) {
    var e2 = findEntryByPropertyStem_(ownerCtx.byProperty, parsedProp.stem);
    return {
      entry: e2 || null,
      parsed: {
        month: parsedProp.month,
        year: parsedProp.year,
        code: '',
        yyyymm: '',
      },
    };
  }

  return null;
}

function getFolderId_() {
  var p = PropertiesService.getScriptProperties().getProperty(PROP_DRIVE_FOLDER_ID);
  return (p && p.trim()) || DEFAULT_DRIVE_FOLDER_ID;
}

function promptSetFolderId() {
  var cur = getFolderId_();
  var ui = SpreadsheetApp.getUi();
  var r = ui.prompt(
    '監視フォルダID',
    'Google ドライブのフォルダIDを貼り付けてください（現在: ' + cur + '）',
    ui.ButtonSet.OK_CANCEL
  );
  if (r.getSelectedButton() !== ui.Button.OK) return;
  var v = r.getResponseText().trim();
  if (!v) return;
  PropertiesService.getScriptProperties().setProperty(PROP_DRIVE_FOLDER_ID, v);
  ui.alert('保存しました。');
}

function buildOwnerMap_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = OWNER_SHEET_NAME
    ? ss.getSheetByName(OWNER_SHEET_NAME)
    : ss.getSheets()[0];
  if (!sh) throw new Error('シートが見つかりません。');

  var values = sh.getDataRange().getValues();
  if (values.length < 2) throw new Error('データがありません。');

  var col = resolveColumns_(values[0]);
  var byCode = {};
  var byProperty = {};
  var hasRows = false;

  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    var code = String(row[col.code] != null ? row[col.code] : '').trim();
    var email = String(row[col.email] != null ? row[col.email] : '').trim();
    var addressee = String(row[col.addressee] != null ? row[col.addressee] : '').trim();
    var propName = String(row[col.property] != null ? row[col.property] : '').trim();
    if (!email) continue;
    if (!code && !propName) continue;

    hasRows = true;
    var entry = {
      email: email,
      addressee: addressee || 'オーナー様',
      propertyName: propName,
      rowNum: r + 1,
    };
    if (code) byCode[code] = entry;
    if (propName) byProperty[propName] = entry;
  }

  return { byCode: byCode, byProperty: byProperty, hasRows: hasRows };
}

function resolveColumns_(headerRow) {
  function idx(label, fallback0) {
    var j = headerRow.indexOf(label);
    return j >= 0 ? j : fallback0;
  }
  return {
    addressee: idx('宛名', 0),
    email: idx('メール', 1),
    property: idx('施設名', 2),
    code: idx('施設コード', 3),
  };
}

function listPdfFiles_(folder) {
  var it = folder.getFiles();
  var out = [];
  while (it.hasNext()) {
    var f = it.next();
    var n = f.getName();
    if (/\.pdf$/i.test(n)) out.push(f);
  }
  return out;
}

/**
 * 例: 3B202602.pdf → code=3B, year=2026, month=2
 */
function parseStatementFilename_(name) {
  var m = /^([A-Za-z0-9]+)(\d{6})\.pdf$/i.exec(name);
  if (!m) return null;
  var y = parseInt(m[2].substring(0, 4), 10);
  var mo = parseInt(m[2].substring(4, 6), 10);
  return { code: m[1], year: y, month: mo, yyyymm: m[2] };
}

/**
 * 例: THE HILLTOP GARDEN VILLA Can202602.pdf
 * 末尾 YYYYMM.pdf の直前を施設名として台帳「施設名」と突合（(A)で拾えないスペース入りファイル名向け）
 */
function parseFacilityYyyymmFilename_(name) {
  var m = /(\d{6})\.pdf$/i.exec(name);
  if (!m) return null;
  var yyyymm = m[1];
  var y = parseInt(yyyymm.substring(0, 4), 10);
  var mo = parseInt(yyyymm.substring(4, 6), 10);
  if (mo < 1 || mo > 12) return null;
  var stem = name
    .substring(0, name.length - m[0].length)
    .replace(/[\s\u3000]+$/g, '')
    .trim();
  if (!stem.length) return null;
  return { stem: stem, year: y, month: mo, yyyymm: yyyymm };
}

/**
 * 例: THE HILLTOP GARDEN VILLA Can 2月.pdf
 * 末尾の「半角数字 + 月.pdf」より前を施設名として使う（末尾基準で誤マッチを減らす）
 */
function parseFacilityMonthFilename_(name) {
  var m = /(\d{1,2})月\.pdf$/i.exec(name);
  if (!m) return null;
  var month = parseInt(m[1], 10);
  if (month < 1 || month > 12) return null;
  var stem = name
    .substring(0, name.length - m[0].length)
    .replace(/[\s\u3000]+$/g, '')
    .trim();
  if (!stem.length) return null;
  return { stem: stem, month: month, year: new Date().getFullYear() };
}

function normalizePropKey_(s) {
  return String(s)
    .replace(/[\u3000]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function findEntryByPropertyStem_(byProperty, stem) {
  var ns = normalizePropKey_(stem);
  var keys = Object.keys(byProperty);
  var i;
  for (i = 0; i < keys.length; i++) {
    var k = keys[i];
    if (normalizePropKey_(k) === ns) return byProperty[k];
  }
  for (i = 0; i < keys.length; i++) {
    var k2 = keys[i];
    var nk = normalizePropKey_(k2);
    if (ns.indexOf(nk) >= 0 || nk.indexOf(ns) >= 0) return byProperty[k2];
  }
  return null;
}

function createOneDraft_(entry, file, parsed) {
  var monthLabel = parsed.month + '月';
  var subject = monthLabel + '明細';

  var line1 = entry.addressee;
  if (line1.indexOf('様') === -1 && line1.indexOf('さん') === -1) line1 += '様';

  var plain =
    line1 +
    '\n\n' +
    'お世話になります。いつもありがとうございます！\n' +
    monthLabel +
    'の明細をお送りいたします。\n\n' +
    'よろしくお願いいたします。\n\n' +
    '(株）Blue Ocean 桑原佳介\n' +
    'https://llc-blueocean.jp/';

  var html =
    escapeHtml_(line1) +
    '<br><br>' +
    'お世話になります。いつもありがとうございます！<br>' +
    escapeHtml_(monthLabel) +
    'の明細をお送りいたします。<br><br>' +
    'よろしくお願いいたします。<br><br>' +
    '(株）Blue Ocean 桑原佳介<br>' +
    '<a href="https://llc-blueocean.jp/">https://llc-blueocean.jp/</a>';

  var blob = file.getBlob().setName(file.getName());

  GmailApp.createDraft(entry.email, subject, plain, {
    htmlBody: html,
    attachments: [blob],
    cc: DRAFT_CC,
  });
}

function escapeHtml_(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** テスト用 */
function debugParseFilename() {
  Logger.log(JSON.stringify(parseStatementFilename_('3B202602.pdf')));
  Logger.log(
    JSON.stringify(parseFacilityYyyymmFilename_('THE HILLTOP GARDEN VILLA Can202602.pdf'))
  );
  Logger.log(JSON.stringify(parseFacilityMonthFilename_('THE HILLTOP GARDEN VILLA Can 2月.pdf')));
}

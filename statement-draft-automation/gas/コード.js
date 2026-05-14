/**
 * Gmail（ラベル付き）→ kintone 登録。時間トリガーで定期実行し、24時間体制で拾い上げる。
 *
 * 初回:
 * 1. プロジェクト設定 → スクリプトプロパティ に以下を登録
 *    KINTONE_SUBDOMAIN 例: xxx.cybozu.com
 *    KINTONE_APP_ID     例: 12
 *    KINTONE_API_TOKEN  APIトークン（コードに書かない）
 *    （任意）GMAIL_LABEL_NAME 既定: Kintone転送待ち
 *    （任意）GMAIL_SUBJECT_CONTAINS 既定: 新規予約が入りました … 件名に含まないスレは処理しない
 *    （任意）MAX_THREAD_AGE_HOURS 例: 24 … 受信からこの時間を超えたスレは処理しない
 *    （任意）BODY_USE_LAST_MESSAGE に 1 … 本文だけスレッド「最新」の 1 通から取る（既定は「先頭」＝予約通知本体）
 *    （任意）FIELD_LODGING / FIELD_PLATFORM / FIELD_ROOM_NAME … 文字で記載する項目のフィールドコード
 *       既定: lodging2（【必須】宿泊施設2） platform2（【必須】予約サイト2） room_name2（【必須】部屋名2）
 *       kintone「フォーム」で各フィールドの歯車からフィールドコードを確認し、違えばスクリプトプロパティで上書き
 *    （任意）FIELD_CHECKIN / FIELD_CHECKOUT … 既定 checkin / checkout
 *    （任意）FACILITY_OPTION_MAP_JSON / PLATFORM_OPTION_MAP_JSON … メール表記を別文字列に変換したいとき（任意）
 *       DEBUG_LOG_RECORD に 1 … 送信 record を実行ログに出力（宿泊施設・予約サイト・部屋は別行で明示）
 * 2. エディタで gmailToKintone を1回手動実行して権限承認
 * 3. installHourlyTrigger()（15分間隔）または installTriggerEveryMinutes(15) でトリガー作成
 *
 * Gmail 側: 「新規予約が入りました！！」などの通知にフィルタでラベル「Kintone転送待ち」を付与。
 */

var DEFAULT_LABEL_NAME = 'Kintone転送待ち';
/** 件名フィルタ（「新規予約が入りました！！」の「！！」の揺れを避けるため部分一致） */
var DEFAULT_SUBJECT_CONTAINS = '新規予約が入りました';

function getConfig_() {
  var p = PropertiesService.getScriptProperties();
  var subdomain = p.getProperty('KINTONE_SUBDOMAIN');
  var appId = p.getProperty('KINTONE_APP_ID');
  var token = p.getProperty('KINTONE_API_TOKEN');
  if (!subdomain || !appId || !token) {
    throw new Error(
      'スクリプトプロパティに KINTONE_SUBDOMAIN, KINTONE_APP_ID, KINTONE_API_TOKEN を設定してください。'
    );
  }
  var maxAgeStr = p.getProperty('MAX_THREAD_AGE_HOURS');
  var maxAgeHours = maxAgeStr ? parseFloat(maxAgeStr) : null;
  return {
    subdomain: subdomain.replace(/^https?:\/\//, '').replace(/\/$/, ''),
    appId: appId,
    token: token,
    labelName: p.getProperty('GMAIL_LABEL_NAME') || DEFAULT_LABEL_NAME,
    subjectContains: p.getProperty('GMAIL_SUBJECT_CONTAINS') || DEFAULT_SUBJECT_CONTAINS,
    maxAgeMs: maxAgeHours && !isNaN(maxAgeHours) ? maxAgeHours * 60 * 60 * 1000 : null,
    fieldCodes: getFieldCodes_(p),
    facilityMap: parseFacilityMap_(p),
    platformMap: parsePlatformMap_(p),
    debugLogRecord: p.getProperty('DEBUG_LOG_RECORD') === '1',
    /** true のときだけ本文を最新メールから（既定 false＝先頭＝予約本文と金額が一致しやすい） */
    useLastMessageBody: p.getProperty('BODY_USE_LAST_MESSAGE') === '1',
  };
}

function parseJsonMapProperty_(p, propKey) {
  var raw = p.getProperty(propKey);
  if (!raw || !String(raw).trim()) return {};
  try {
    var o = JSON.parse(raw);
    return typeof o === 'object' && o !== null ? o : {};
  } catch (e) {
    console.log(propKey + ' が不正な JSON です');
    return {};
  }
}

/** FACILITY_OPTION_MAP_JSON: {"メール表記":"送りたい文字列"}（任意） */
function parseFacilityMap_(p) {
  return parseJsonMapProperty_(p, 'FACILITY_OPTION_MAP_JSON');
}

/** PLATFORM_OPTION_MAP_JSON: {"メール表記":"送りたい文字列"}（任意） */
function parsePlatformMap_(p) {
  return parseJsonMapProperty_(p, 'PLATFORM_OPTION_MAP_JSON');
}

/** kintone のフィールドコード（フォーム設定と一致させる） */
function getFieldCodes_(p) {
  return {
    lodging: p.getProperty('FIELD_LODGING') || 'lodging2',
    platform: p.getProperty('FIELD_PLATFORM') || 'platform2',
    checkin: p.getProperty('FIELD_CHECKIN') || 'checkin',
    checkout: p.getProperty('FIELD_CHECKOUT') || 'checkout',
    guest_name: p.getProperty('FIELD_GUEST_NAME') || 'guest_name',
    commission: p.getProperty('FIELD_COMMISSION') || 'commission',
    adult: p.getProperty('FIELD_ADULT') || 'adult',
    child: p.getProperty('FIELD_CHILD') || 'child',
    price: p.getProperty('FIELD_PRICE') || 'price',
    reservation_number: p.getProperty('FIELD_RESERVATION_NUMBER') || 'reservation_number',
    beds24_link: p.getProperty('FIELD_BEDS24_LINK') || 'beds24_link',
    room_name: p.getProperty('FIELD_ROOM_NAME') || 'room_name2',
  };
}

/** メイン: ラベル付きスレッドを kintone に登録（時間トリガーからも呼ぶ） */
function gmailToKintone() {
  var cfg = getConfig_();
  var label = GmailApp.getUserLabelByName(cfg.labelName);
  if (!label) {
    console.log('ラベルが見つかりません: ' + cfg.labelName);
    return;
  }

  var threads = label.getThreads();
  threads.forEach(function (thread) {
    try {
      if (cfg.maxAgeMs) {
        var lastDate = thread.getLastMessageDate();
        if (lastDate && Date.now() - lastDate.getTime() > cfg.maxAgeMs) {
          console.log('スキップ（経過時間）: ' + thread.getId());
          return;
        }
      }

      var messages = thread.getMessages();
      if (!messages.length) {
        console.log('スキップ（スレッドにメッセージがありません）');
        return;
      }
      var firstSubject = messages[0].getSubject();
      if (!subjectMatchesTarget_(firstSubject, cfg.subjectContains)) {
        console.log('スキップ（件名が対象外）: ' + firstSubject);
        return;
      }

      var bodySource = cfg.useLastMessageBody
        ? messages[messages.length - 1]
        : messages[0];
      var body = normalizeEmailBody_(bodySource.getPlainBody());
      var ext = extractReservationFields_(body);
      var getVal = function (regex) {
        var match = body.match(regex);
        return match ? match[1].trim() : '';
      };

      var resNumber = ext.resNumber || getVal(/(?:予約番号|ID|Confirmation)\s*[:：]\s*(\w+)/);
      var bookIdMatch = body.match(/bookid=(\d+)/i);
      var beds24BookId = bookIdMatch ? bookIdMatch[1] : '';

      var dup = recordExistsInKintone_(cfg, resNumber, beds24BookId);
      if (dup === null) {
        console.log('kintone 検索に失敗したため保留（ラベルは残します）: ' + thread.getId());
        return;
      }
      if (dup) {
        console.log('重複スキップ（既に登録あり）: res=' + resNumber + ' bookid=' + beds24BookId);
        thread.removeLabel(label);
        return;
      }

      if (!resNumber && !beds24BookId) {
        console.log(
          'スキップ（重複防止のため予約番号または Beds24 の bookid が必要）: ' + thread.getId()
        );
        return;
      }

      var fc = cfg.fieldCodes;
      var prop = ext.prop;
      var room = ext.room;
      var platform = ext.platform;
      var commission =
        extractCommissionFromBody_(body) ||
        ext.commission ||
        getVal(/コミッション\s*[:：]\s*([0-9,.]+)/);
      var checkin = ext.checkin;
      var checkout = ext.checkout;

      var lodgingText = applyOptionMap_(String(prop || '').trim(), cfg.facilityMap);
      var platformText = applyOptionMap_(String(platform || '').trim(), cfg.platformMap);
      var roomText = String(room || '').trim();

      var record = {};
      record[fc.lodging] = { value: lodgingText };
      record[fc.platform] = { value: platformText };
      record[fc.room_name] = { value: roomText };
      record[fc.guest_name] = {
        value:
          ext.guestName ||
          getVal(/お客様氏名\s*[:：]\s*(.*?)(?=\s*(?:人数|電話番号|$))/),
      };
      record[fc.commission] = { value: commission };
      record[fc.adult] = {
        value: body.match(/大人\s*(\d+)/) ? body.match(/大人\s*(\d+)/)[1] : '0',
      };
      record[fc.child] = {
        value: body.match(/子供\s*(\d+)/) ? body.match(/子供\s*(\d+)/)[1] : '0',
      };
      record[fc.price] = {
        value: extractPriceFromBody_(body),
      };
      record[fc.reservation_number] = { value: resNumber };
      record[fc.beds24_link] = {
        value:
          ext.beds24Link ||
          (body.match(/(https?:\/\/beds24\.com\/control\.php\?bookid=\d+)/) || ['', ''])[1],
      };

      if (checkin) record[fc.checkin] = { value: checkin };
      if (checkout) record[fc.checkout] = { value: checkout };

      if (!lodgingText) console.log('警告: 宿泊施設が本文から取れませんでした');
      if (!platformText) console.log('警告: 予約サイトが本文から取れませんでした');
      if (!roomText) console.log('警告: 部屋タイプが本文から取れませんでした');
      if (!checkin) console.log('警告: チェックイン日が本文から取れませんでした');
      if (!checkout) console.log('警告: チェックアウト日が本文から取れませんでした');

      var payload = {
        app: cfg.appId,
        record: record,
      };

      if (cfg.debugLogRecord) {
        logDebugRecordForKintone_(fc, record);
      }

      var response = UrlFetchApp.fetch('https://' + cfg.subdomain + '/k/v1/record.json', {
        method: 'post',
        headers: {
          'X-Cybozu-API-Token': cfg.token,
          'Content-Type': 'application/json',
        },
        payload: JSON.stringify(payload),
        muteHttpExceptions: true,
      });

      if (response.getResponseCode() === 200) {
        console.log('登録成功: ' + resNumber);
        thread.removeLabel(label);
      } else {
        console.log('エラー: ' + response.getContentText());
      }
    } catch (e) {
      console.log('実行エラー: ' + e);
    }
  });
}

/** 15分ごと（1日最大96回）。関数名は後方互換のため残す */
function installHourlyTrigger() {
  installTriggerEveryMinutes(15);
}

/**
 * N 分ごと（例: 15 → 1 日 96 回）。GAS の仕様上 1〜30 分の間隔。
 */
function installTriggerEveryMinutes(minutes) {
  var n = parseInt(minutes, 10);
  if (isNaN(n) || n < 1 || n > 30) {
    throw new Error('minutes は 1 以上 30 以下の整数にしてください');
  }

  uninstallKintoneTriggers_();
  ScriptApp.newTrigger('gmailToKintone').timeBased().everyMinutes(n).create();
}

/** gmailToKintone の時間トリガーをすべて削除 */
function uninstallKintoneTriggers() {
  uninstallKintoneTriggers_();
}

function uninstallKintoneTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'gmailToKintone') {
      ScriptApp.deleteTrigger(t);
    }
  });
}

/** 手動でトリガー一覧を確認 */
function listKintoneTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'gmailToKintone') {
      console.log(JSON.stringify({ handler: t.getHandlerFunction(), triggerSource: t.getTriggerSource() }));
    }
  });
}

function applyOptionMap_(raw, map) {
  if (!raw) return '';
  if (!map || typeof map !== 'object') return raw;
  if (map[raw]) return map[raw];
  var lower = raw.toLowerCase();
  for (var k in map) {
    if (!Object.prototype.hasOwnProperty.call(map, k)) continue;
    if (String(k).toLowerCase() === lower) return map[k];
  }
  for (var k2 in map) {
    if (!Object.prototype.hasOwnProperty.call(map, k2)) continue;
    if (raw.indexOf(k2) !== -1 || k2.indexOf(raw) !== -1) return map[k2];
  }
  return raw;
}

/** DEBUG_LOG_RECORD 用: 宿泊施設・予約サイトがどのフィールドコードで送られるか明示 */
function logDebugRecordForKintone_(fc, record) {
  console.log('DEBUG --- kintone へ送る値（このブロックを確認） ---');
  console.log(
    'DEBUG lodging フィールドコード [' +
      fc.lodging +
      '] value=' +
      safeRecordValueString_(record[fc.lodging])
  );
  console.log(
    'DEBUG platform フィールドコード [' +
      fc.platform +
      '] value=' +
      safeRecordValueString_(record[fc.platform])
  );
  if (fc.room_name) {
    console.log(
      'DEBUG room フィールドコード [' +
        fc.room_name +
        '] value=' +
        safeRecordValueString_(record[fc.room_name])
    );
  }
  console.log('DEBUG record 全体: ' + JSON.stringify(record));
}

function safeRecordValueString_(fieldObj) {
  if (!fieldObj || fieldObj.value === undefined) return '(未設定またはキーなし)';
  return JSON.stringify(fieldObj.value);
}

/** 「料金：」を優先。複数あるときは最後の一致。なければ合計／Total／従来フォールバック */
function extractPriceFromBody_(body) {
  var b = String(body || '');
  var re = /料金\s*[:：]\s*([0-9,.]+)/g;
  var last = '';
  var m;
  while ((m = re.exec(b)) !== null) last = m[1];
  if (last) return last.replace(/,/g, '');
  var m2 = b.match(/(?:合計|Total)\s*[:：]\s*([0-9,.]+)/i);
  if (m2) return m2[1].replace(/,/g, '');
  var m3 = b.match(/(?:料金|合計|Total).*?[:：]\s*([0-9,.]+)/);
  return m3 ? m3[1].replace(/,/g, '') : '0';
}

/** 複数「コミッション：」があるときは末尾側を優先 */
function extractCommissionFromBody_(body) {
  var b = String(body || '');
  var re = /コミッション\s*[:：]\s*([0-9,.]+)/g;
  var last = '';
  var m;
  while ((m = re.exec(b)) !== null) last = m[1];
  return last ? last.replace(/,/g, '') : '';
}

function normalizeEmailBody_(body) {
  return String(body || '')
    .replace(/[\u00a0\u3000]/g, ' ')
    .replace(/[\u200b\uFEFF]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

/** ゼロ幅スペース等を除去してトリム */
function stripInvisible_(s) {
  return String(s || '')
    .replace(/[\u200b\uFEFF]/g, '')
    .trim();
}

/**
 * メール本文から予約関連フィールドを抽出（ラベル表記のブレ・日付形式に複数パターン対応）
 */
function extractReservationFields_(body) {
  var ext = {
    resNumber: '',
    prop: '',
    room: '',
    platform: '',
    commission: '',
    guestName: '',
    checkin: '',
    checkout: '',
    beds24Link: '',
  };

  var bm = body.match(/https?:\/\/beds24\.com\/control\.php\?bookid=\d+/i);
  ext.beds24Link = bm ? bm[0] : '';

  ext.resNumber = firstCapture_(body, [
    /サイト予約番号\s*[:：]\s*(\w+)/,
    /(?:予約番号|Reservation\s*(?:No\.?|ID)|Confirmation\s*ID)\s*[:：]\s*(\w+)/i,
    /(?:Booking\s*ID)\s*[:：]\s*(\w+)/i,
    /(?:予約番号|ID|Confirmation)\s*[:：]\s*(\w+)/,
  ]);

  // Gmail 等で1行に詰まると [^\n]+ が次の「部屋タイプ：」まで食うため、直後のラベルまでに限定する
  ext.prop = firstCapture_(body, [
    /宿泊施設\s*[:：]\s*([\s\S]+?)(?=\s*部屋タイプ\s*[:：])/,
    /宿泊施設\s*[:：]\s*([\s\S]+?)(?=\s*お客様氏名\s*[:：])/,
    /宿泊施設\s*[:：]\s*([\s\S]+?)(?=\s*(?:人数|電話番号|予約サイト)\s*[:：])/,
    /宿泊施設\s*[:：]\s*([^\n\r]+)/,
    /(?:Property|施設名|宿泊先|物件名)\s*[:：]\s*([^\n\r]+)/i,
  ]);

  ext.room = firstCapture_(body, [
    /部屋タイプ\s*[:：]\s*([\s\S]+?)(?=\s*お客様氏名\s*[:：])/,
    /部屋タイプ\s*[:：]\s*([\s\S]+?)(?=\s*人数\s*[:：])/,
    /部屋タイプ\s*[:：]\s*([\s\S]+?)(?=\s*(?:電話番号|予約サイト)\s*[:：])/,
    /部屋タイプ\s*[:：]\s*([^\n\r]+)/,
    /(?:Room\s*type|Unit|ユニット)\s*[:：]\s*([^\n\r]+)/i,
  ]);

  ext.platform = firstCapture_(body, [
    /予約サイト\s*[:：]\s*([\s\S]+?)(?=\s*サイト予約番号\s*[:：])/,
    /予約サイト\s*[:：]\s*([\s\S]+?)(?=\s*(?:サイト予約番号|ﾁｪｯｸｲﾝ|チェックイン|ﾁｪｯｸｱｳﾄ|チェックアウト|料金|コミッション)\s*[:：])/,
    /予約サイト\s*[:：]\s*([\s\S]+?)(?=\s*料金\s*[:：])/,
    /予約サイト\s*[:：]\s*([^\n\r]+)/,
    /(?:Source|Channel|予約経路|Booking\s*source|OTA)\s*[:：]\s*([^\n\r]+)/i,
  ]);
  if (ext.platform) {
    ext.platform = ext.platform.split(/\s*[\/／,，]/)[0].trim();
  }

  ext.commission = firstCapture_(body, [
    /コミッション\s*[:：]\s*([0-9,.]+)/,
  ]);

  ext.guestName = firstCapture_(body, [/お客様氏名\s*[:：]\s*([^\n]+)/]);
  if (ext.guestName) {
    ext.guestName = ext.guestName.split(/\s+(?:人数|電話|TEL|メール|E-mail)/)[0].trim();
  }

  var cinRaw = firstCapture_(body, [
    /ﾁｪｯｸｲﾝ\s*[:：]\s*([^\n\r]+)/,
    /[ﾁチ]ェックイン\s*[:：]\s*([^\n\r]+)/,
    /チェックイン\s*[:：]\s*([^\n\r]+)/,
    /Check-in\s*[:：]\s*([^\n\r]+)/i,
    /Arrival\s*[:：]\s*([^\n\r]+)/i,
  ]);
  ext.checkin = normalizeDateToIso_(cinRaw);

  var coutRaw = firstCapture_(body, [
    /ﾁｪｯｸｱｳﾄ\s*[:：]\s*([^\n\r]+)/,
    /[ﾁチ]ェックアウト\s*[:：]\s*([^\n\r]+)/,
    /チェックアウト\s*[:：]\s*([^\n\r]+)/,
    /Check-out\s*[:：]\s*([^\n\r]+)/i,
    /Departure\s*[:：]\s*([^\n\r]+)/i,
  ]);
  ext.checkout = normalizeDateToIso_(coutRaw);

  return ext;
}

function firstCapture_(body, regexes) {
  for (var i = 0; i < regexes.length; i++) {
    var m = body.match(regexes[i]);
    if (m && m[1] != null && stripInvisible_(m[1]) !== '') return stripInvisible_(m[1]);
  }
  return '';
}

/** 日付の断片から YYYY-MM-DD（kintone の日付フィールド向け） */
function normalizeDateToIso_(fragment) {
  if (!fragment) return '';
  var s = String(fragment).trim();
  var m = s.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?/);
  if (m) return padYmd_(m[1], m[2], m[3]);
  m = s.match(/(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/);
  if (m) return padYmd_(m[1], m[2], m[3]);
  m = s.match(/\b(\d{4})(\d{2})(\d{2})\b/);
  if (m) return padYmd_(m[1], m[2], m[3]);
  return '';
}

function padYmd_(y, mo, d) {
  return (
    y +
    '-' +
    ('0' + parseInt(mo, 10)).slice(-2) +
    '-' +
    ('0' + parseInt(d, 10)).slice(-2)
  );
}

function subjectMatchesTarget_(subject, needle) {
  if (!needle) return true;
  return String(subject).indexOf(needle) !== -1;
}

/** kintone クエリ用文字列のエスケープ（" と \） */
function escapeKintoneString_(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * 予約番号または本文内 Beds24 の bookid で既存レコードを検索（二重登録防止）
 * @returns {boolean|null} true=重複, false=未登録, null=検索API失敗（呼び出し側で保留）
 */
function recordExistsInKintone_(cfg, resNumber, beds24BookId) {
  var fc = cfg.fieldCodes;
  if (resNumber) {
    var q = fc.reservation_number + ' = "' + escapeKintoneString_(resNumber) + '" limit 1';
    var c = kintoneRecordCount_(cfg, q);
    if (c === null) return null;
    if (c > 0) return true;
  }
  if (beds24BookId) {
    var q2 =
      fc.beds24_link + ' like "*bookid=' + escapeKintoneString_(beds24BookId) + '*" limit 1';
    var c2 = kintoneRecordCount_(cfg, q2);
    if (c2 === null) return null;
    if (c2 > 0) return true;
  }
  return false;
}

/** @returns {number|null} 件数、API失敗時は null */
function kintoneRecordCount_(cfg, query) {
  var url =
    'https://' +
    cfg.subdomain +
    '/k/v1/records.json?app=' +
    cfg.appId +
    '&query=' +
    encodeURIComponent(query);
  var searchRes = UrlFetchApp.fetch(url, {
    headers: { 'X-Cybozu-API-Token': cfg.token },
    muteHttpExceptions: true,
  });
  if (searchRes.getResponseCode() !== 200) {
    console.log('kintone 検索エラー: ' + searchRes.getContentText());
    return null;
  }
  var data = JSON.parse(searchRes.getContentText());
  return data.records && data.records.length ? data.records.length : 0;
}

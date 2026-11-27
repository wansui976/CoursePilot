//! 打包 Anki 牌组（.apkg）。
//!
//! .apkg 是一个 zip：里面一个旧版（schema 11）Anki 集合 `collection.anki2`（SQLite），
//! 一个 `media` 清单（JSON：`{"0": "slide-12.jpg"}`），以及按序号命名的媒体文件。
//! Anki 2.1 / 23.x / 24.x 和 AnkiDroid、AnkiMobile 都认这种包。
//!
//! 只导卡片内容，不带复习记录：在 Anki 里都是新卡，按 Anki 自己的排期从头学。
//! 笔记类型和牌组的 id 都是固定或按名字算出来的，guid 按应用里的卡片 id 算，
//! 同一门课再导一次，Anki 会认成同一批笔记去更新，而不是多出一份。

use crate::error::{AppError, AppResult};
use serde_json::{json, Value};
use sha1::Digest as _;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode};
use sqlx::{ConnectOptions as _, Connection as _};
use std::io::Write as _;
use std::path::Path;

/// 两种笔记类型的固定 id：再次导入时 Anki 认得是同一个类型，不会再建一份「问答-xxxx」。
const BASIC_MODEL_ID: i64 = 1_727_000_000_101;
const CLOZE_MODEL_ID: i64 = 1_727_000_000_102;
const BASIC_MODEL_NAME: &str = "CoursePilot 问答";
const CLOZE_MODEL_NAME: &str = "CoursePilot 填空";

/// 卡片样式：衬线读正文、出处小号淡色等宽，课件图不超过卡片宽。夜间模式跟着 Anki 走。
const CARD_CSS: &str = r#".card {
  font-family: "Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", serif;
  font-size: 20px;
  line-height: 1.6;
  text-align: left;
  color: #1f2328;
  background: #fbfaf6;
  padding: 8px 4px;
}
.nightMode.card, .night_mode .card { color: #e8e6df; background: #1f2a25; }
.cp-options { margin-top: 10px; }
.cp-back { margin-top: 4px; }
.cp-source {
  margin-top: 16px;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 13px;
  opacity: .6;
}
.cp-slide img { max-width: 100%; height: auto; margin-top: 12px; border-radius: 6px; }
.cloze { font-weight: 600; color: #2f6b4f; }
.nightMode .cloze, .night_mode .cloze { color: #8fd1ae; }
"#;

/// 一条要进牌组的笔记。文字都是纯文本，这里负责转义成 HTML。
#[derive(Debug, Clone)]
pub struct AnkiNote {
    /// 稳定来源 id（应用里的卡片 id 或「视频 id + 题干」），算 guid 用。
    pub key: String,
    /// 牌组全名，层级用 `::` 分隔（调用方已把各级名字里的 `::` 换掉）。
    pub deck: String,
    pub content: AnkiContent,
    /// 出处一行：「视频标题 · 12:34」。
    pub source: String,
    /// 卡背附的课件图：媒体文件名（见 [`AnkiMedia::name`]）。
    pub slide: Option<String>,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone)]
pub enum AnkiContent {
    Basic {
        front: String,
        /// 选择题的选项，正面题干下逐行列出。
        options: Vec<String>,
        back: String,
    },
    /// 一处挖空：`before{{c1::answer}}after`。
    Cloze {
        before: String,
        answer: String,
        after: String,
    },
}

#[derive(Debug, Clone)]
pub struct AnkiMedia {
    /// 卡片里 `<img src>` 引用的文件名，同一包里唯一。
    pub name: String,
    pub bytes: Vec<u8>,
}

/// 纯文本转成能放进 Anki 字段的 HTML：转义、换行变 `<br>`。
/// `{{` 也拆开：字段里出现模板语法会被 Anki 当成挖空或字段引用。
pub fn html_text(text: &str) -> String {
    let escaped = text
        .trim()
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace("{{", "{&#123;")
        .replace("}}", "}&#125;");
    escaped.replace("\r\n", "\n").replace('\n', "<br>")
}

/// 挖空答案里 `::` 会被 Anki 当成提示分隔符，`}}` 会提前结束挖空。
fn cloze_answer_html(answer: &str) -> String {
    html_text(answer).replace("::", ":&#58;")
}

/// Anki 字段之间用 0x1f 分隔。
const FIELD_SEP: char = '\u{1f}';

fn note_fields(note: &AnkiNote) -> Vec<String> {
    let source = html_text(&note.source);
    let slide = note
        .slide
        .as_ref()
        .map(|name| format!("<img src=\"{}\">", name.replace('"', "")))
        .unwrap_or_default();
    match &note.content {
        AnkiContent::Basic {
            front,
            options,
            back,
        } => {
            let mut front_html = html_text(front);
            if !options.is_empty() {
                front_html.push_str("<div class=\"cp-options\">");
                let lines: Vec<String> = options
                    .iter()
                    .enumerate()
                    .map(|(i, option)| {
                        let label = char::from(b'A' + (i as u8).min(25));
                        format!("{label}. {}", html_text(option))
                    })
                    .collect();
                front_html.push_str(&lines.join("<br>"));
                front_html.push_str("</div>");
            }
            vec![front_html, html_text(back), source, slide]
        }
        AnkiContent::Cloze {
            before,
            answer,
            after,
        } => {
            // 前后文不 trim：挖空可能就在句中，两边的空格要保住。
            let text = format!(
                "{}{{{{c1::{}}}}}{}",
                html_text_keep_edges(before),
                cloze_answer_html(answer),
                html_text_keep_edges(after)
            );
            vec![text, source, slide]
        }
    }
}

fn html_text_keep_edges(text: &str) -> String {
    let leading = text.len() - text.trim_start().len();
    let trailing = text.len() - text.trim_end().len();
    if text.trim().is_empty() {
        return String::new();
    }
    format!(
        "{}{}{}",
        " ".repeat(leading.min(1)),
        html_text(text),
        " ".repeat(trailing.min(1))
    )
}

/// 去掉 HTML 标签，排序字段和查重校验和用。
fn strip_html(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    for c in html.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

/// Anki 的查重校验和：首字段去标签后 SHA-1 的前 8 个十六进制位。
fn field_checksum(first_field: &str) -> i64 {
    let digest = sha1::Sha1::digest(strip_html(first_field).as_bytes());
    i64::from(u32::from_be_bytes([
        digest[0], digest[1], digest[2], digest[3],
    ]))
}

/// guid：按来源 id 稳定生成，再次导入同一张卡时 Anki 更新原笔记。
fn note_guid(key: &str) -> String {
    let digest = sha1::Sha1::digest(format!("coursepilot:{key}").as_bytes());
    digest.iter().take(10).map(|b| format!("{b:02x}")).collect()
}

/// 牌组 id 按名字算：再次导入落回同一个牌组。保持在 2^53 以内（Anki 的 JSON 里是数字）。
fn deck_id(name: &str) -> i64 {
    let digest = sha2::Sha256::digest(name.as_bytes());
    let mut bytes = [0u8; 8];
    bytes.copy_from_slice(&digest[..8]);
    let id = (u64::from_be_bytes(bytes) >> 11) as i64;
    // 1 是 Anki 的「默认」牌组，避开。
    id.max(2)
}

fn model_fields(names: &[&str]) -> Value {
    Value::Array(
        names
            .iter()
            .enumerate()
            .map(|(ord, name)| {
                json!({
                    "name": name, "ord": ord, "sticky": false, "rtl": false,
                    "font": "Arial", "size": 20, "media": []
                })
            })
            .collect(),
    )
}

fn models_json(now_s: i64, default_deck: i64) -> Value {
    let basic = json!({
        "id": BASIC_MODEL_ID,
        "name": BASIC_MODEL_NAME,
        "type": 0,
        "mod": now_s,
        "usn": -1,
        "sortf": 0,
        "did": default_deck,
        "tmpls": [{
            "name": "卡片 1",
            "ord": 0,
            "qfmt": "{{正面}}",
            "afmt": "{{FrontSide}}<hr id=answer><div class=\"cp-back\">{{背面}}</div>\
                     {{#出处}}<div class=\"cp-source\">{{出处}}</div>{{/出处}}\
                     {{#课件}}<div class=\"cp-slide\">{{课件}}</div>{{/课件}}",
            "did": null, "bqfmt": "", "bafmt": ""
        }],
        "flds": model_fields(&["正面", "背面", "出处", "课件"]),
        "css": CARD_CSS,
        "latexPre": "\\documentclass[12pt]{article}\n\\special{papersize=3in,5in}\n\\usepackage[utf8]{inputenc}\n\\usepackage{amssymb,amsmath}\n\\pagestyle{empty}\n\\setlength{\\parindent}{0in}\n\\begin{document}\n",
        "latexPost": "\\end{document}",
        "latexsvg": false,
        "req": [[0, "any", [0]]],
        "tags": [],
        "vers": []
    });
    let cloze = json!({
        "id": CLOZE_MODEL_ID,
        "name": CLOZE_MODEL_NAME,
        "type": 1,
        "mod": now_s,
        "usn": -1,
        "sortf": 0,
        "did": default_deck,
        "tmpls": [{
            "name": "填空",
            "ord": 0,
            "qfmt": "{{cloze:文本}}",
            "afmt": "{{cloze:文本}}\
                     {{#出处}}<div class=\"cp-source\">{{出处}}</div>{{/出处}}\
                     {{#课件}}<div class=\"cp-slide\">{{课件}}</div>{{/课件}}",
            "did": null, "bqfmt": "", "bafmt": ""
        }],
        "flds": model_fields(&["文本", "出处", "课件"]),
        "css": CARD_CSS,
        "latexPre": "\\documentclass[12pt]{article}\n\\special{papersize=3in,5in}\n\\usepackage[utf8]{inputenc}\n\\usepackage{amssymb,amsmath}\n\\pagestyle{empty}\n\\setlength{\\parindent}{0in}\n\\begin{document}\n",
        "latexPost": "\\end{document}",
        "latexsvg": false,
        "tags": [],
        "vers": []
    });
    json!({
        BASIC_MODEL_ID.to_string(): basic,
        CLOZE_MODEL_ID.to_string(): cloze,
    })
}

fn deck_json(id: i64, name: &str, now_s: i64) -> Value {
    json!({
        "id": id, "name": name, "mod": now_s, "usn": -1,
        "lrnToday": [0, 0], "revToday": [0, 0], "newToday": [0, 0], "timeToday": [0, 0],
        "collapsed": false, "browserCollapsed": false,
        "desc": "", "dyn": 0, "conf": 1, "extendNew": 0, "extendRev": 0
    })
}

fn dconf_json(now_s: i64) -> Value {
    json!({
        "1": {
            "id": 1, "name": "Default", "mod": now_s, "usn": 0,
            "maxTaken": 60, "autoplay": true, "timer": 0, "replayq": true, "dyn": false,
            "new": {
                "bury": false, "delays": [1.0, 10.0], "initialFactor": 2500,
                "ints": [1, 4, 0], "order": 1, "perDay": 20
            },
            "rev": {
                "bury": false, "ease4": 1.3, "ivlFct": 1.0, "maxIvl": 36500,
                "perDay": 200, "hardFactor": 1.2
            },
            "lapse": {
                "delays": [10.0], "leechAction": 1, "leechFails": 8, "minInt": 1, "mult": 0.0
            }
        }
    })
}

const SCHEMA: &[&str] = &[
    "CREATE TABLE col (id integer primary key, crt integer not null, mod integer not null,
       scm integer not null, ver integer not null, dty integer not null, usn integer not null,
       ls integer not null, conf text not null, models text not null, decks text not null,
       dconf text not null, tags text not null)",
    "CREATE TABLE notes (id integer primary key, guid text not null, mid integer not null,
       mod integer not null, usn integer not null, tags text not null, flds text not null,
       sfld integer not null, csum integer not null, flags integer not null, data text not null)",
    "CREATE TABLE cards (id integer primary key, nid integer not null, did integer not null,
       ord integer not null, mod integer not null, usn integer not null, type integer not null,
       queue integer not null, due integer not null, ivl integer not null, factor integer not null,
       reps integer not null, lapses integer not null, left integer not null, odue integer not null,
       odid integer not null, flags integer not null, data text not null)",
    "CREATE TABLE revlog (id integer primary key, cid integer not null, usn integer not null,
       ease integer not null, ivl integer not null, lastIvl integer not null, factor integer not null,
       time integer not null, type integer not null)",
    "CREATE TABLE graves (usn integer not null, oid integer not null, type integer not null)",
    "CREATE INDEX ix_notes_usn on notes (usn)",
    "CREATE INDEX ix_cards_usn on cards (usn)",
    "CREATE INDEX ix_revlog_usn on revlog (usn)",
    "CREATE INDEX ix_cards_nid on cards (nid)",
    "CREATE INDEX ix_cards_sched on cards (did, queue, due)",
    "CREATE INDEX ix_revlog_cid on revlog (cid)",
    "CREATE INDEX ix_notes_csum on notes (csum)",
];

/// 把笔记写成一个旧版 Anki 集合文件。
async fn write_collection(path: &Path, notes: &[AnkiNote], now_ms: i64) -> AppResult<()> {
    let now_s = now_ms / 1000;
    let mut conn = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Delete)
        .connect()
        .await?;
    let mut tx = conn.begin().await?;
    for statement in SCHEMA {
        sqlx::query(statement).execute(&mut *tx).await?;
    }

    let mut decks = serde_json::Map::new();
    decks.insert("1".into(), deck_json(1, "Default", now_s));
    for note in notes {
        let id = deck_id(&note.deck);
        decks
            .entry(id.to_string())
            .or_insert_with(|| deck_json(id, &note.deck, now_s));
        // 父级牌组也要在：Anki 按名字里的 `::` 建层级，缺了父级旧版会报错。
        let mut parent = note.deck.as_str();
        while let Some((head, _)) = parent.rsplit_once("::") {
            let pid = deck_id(head);
            decks
                .entry(pid.to_string())
                .or_insert_with(|| deck_json(pid, head, now_s));
            parent = head;
        }
    }
    let first_deck = notes.first().map(|n| deck_id(&n.deck)).unwrap_or(1);
    let conf = json!({
        "nextPos": notes.len() + 1, "estTimes": true, "activeDecks": [1], "sortType": "noteFld",
        "timeLim": 0, "sortBackwards": false, "addToCur": true, "curDeck": first_deck,
        "newBury": true, "newSpread": 0, "dueCounts": true, "curModel": BASIC_MODEL_ID.to_string(),
        "collapseTime": 1200
    });
    sqlx::query(
        "INSERT INTO col(id,crt,mod,scm,ver,dty,usn,ls,conf,models,decks,dconf,tags)
         VALUES (1,?,?,?,11,0,0,0,?,?,?,?,'{}')",
    )
    .bind(now_s)
    .bind(now_ms)
    .bind(now_ms)
    .bind(conf.to_string())
    .bind(models_json(now_s, first_deck).to_string())
    .bind(Value::Object(decks).to_string())
    .bind(dconf_json(now_s).to_string())
    .execute(&mut *tx)
    .await?;

    for (index, note) in notes.iter().enumerate() {
        // 笔记 / 卡片 id 是毫秒时间戳，同一批按序号错开，保证唯一。
        let note_id = now_ms + index as i64;
        let fields = note_fields(note);
        let model_id = match note.content {
            AnkiContent::Basic { .. } => BASIC_MODEL_ID,
            AnkiContent::Cloze { .. } => CLOZE_MODEL_ID,
        };
        let sort_field = strip_html(&fields[0]);
        let tags = if note.tags.is_empty() {
            String::new()
        } else {
            format!(" {} ", note.tags.join(" "))
        };
        sqlx::query(
            "INSERT INTO notes(id,guid,mid,mod,usn,tags,flds,sfld,csum,flags,data)
             VALUES (?,?,?,?,-1,?,?,?,?,0,'')",
        )
        .bind(note_id)
        .bind(note_guid(&note.key))
        .bind(model_id)
        .bind(now_s)
        .bind(tags)
        .bind(fields.join(&FIELD_SEP.to_string()))
        .bind(sort_field)
        .bind(field_checksum(&fields[0]))
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "INSERT INTO cards(id,nid,did,ord,mod,usn,type,queue,due,ivl,factor,reps,lapses,left,odue,odid,flags,data)
             VALUES (?,?,?,0,?,-1,0,0,?,0,0,0,0,0,0,0,0,'')",
        )
        .bind(note_id)
        .bind(note_id)
        .bind(deck_id(&note.deck))
        .bind(now_s)
        .bind(index as i64 + 1)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    conn.close().await?;
    Ok(())
}

/// 最小 zip 写出器：只写 deflate 压缩的普通条目（文件名按 UTF-8 标记），不支持 zip64。
/// 一份牌组远小于 4 GB；用 flate2 现成的 deflate 和 CRC，不为这点事再引一个 zip 库。
struct ZipWriter {
    out: Vec<u8>,
    central: Vec<u8>,
    count: u16,
}

impl ZipWriter {
    fn new() -> Self {
        Self {
            out: Vec::new(),
            central: Vec::new(),
            count: 0,
        }
    }

    fn add(&mut self, name: &str, data: &[u8]) -> AppResult<()> {
        let mut crc = flate2::Crc::new();
        crc.update(data);
        let crc = crc.sum();
        let mut encoder =
            flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(data)?;
        let compressed = encoder.finish()?;
        let too_big = |n: usize| u32::try_from(n).is_err();
        if too_big(data.len()) || too_big(compressed.len()) || too_big(self.out.len()) {
            return Err(AppError::Other("anki package too large".into()));
        }
        let offset = self.out.len() as u32;
        let name_bytes = name.as_bytes();
        // 0x0800：文件名是 UTF-8。时间日期写 1980-01-01 00:00（DOS 时间的零点）。
        let header = |sig: u32, central: bool| {
            let mut h = Vec::new();
            h.extend_from_slice(&sig.to_le_bytes());
            if central {
                h.extend_from_slice(&20u16.to_le_bytes()); // made by
            }
            h.extend_from_slice(&20u16.to_le_bytes()); // version needed
            h.extend_from_slice(&0x0800u16.to_le_bytes());
            h.extend_from_slice(&8u16.to_le_bytes()); // deflate
            h.extend_from_slice(&0u16.to_le_bytes()); // time
            h.extend_from_slice(&0x0021u16.to_le_bytes()); // date
            h.extend_from_slice(&crc.to_le_bytes());
            h.extend_from_slice(&(compressed.len() as u32).to_le_bytes());
            h.extend_from_slice(&(data.len() as u32).to_le_bytes());
            h.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
            h.extend_from_slice(&0u16.to_le_bytes()); // extra
            if central {
                h.extend_from_slice(&0u16.to_le_bytes()); // comment
                h.extend_from_slice(&0u16.to_le_bytes()); // disk
                h.extend_from_slice(&0u16.to_le_bytes()); // internal attrs
                h.extend_from_slice(&0u32.to_le_bytes()); // external attrs
                h.extend_from_slice(&offset.to_le_bytes());
            }
            h.extend_from_slice(name_bytes);
            h
        };
        self.out.extend_from_slice(&header(0x0403_4b50, false));
        self.out.extend_from_slice(&compressed);
        self.central.extend_from_slice(&header(0x0201_4b50, true));
        self.count = self
            .count
            .checked_add(1)
            .ok_or_else(|| AppError::Other("too many files in anki package".into()))?;
        Ok(())
    }

    fn finish(mut self) -> Vec<u8> {
        let central_offset = self.out.len() as u32;
        let central_size = self.central.len() as u32;
        self.out.extend_from_slice(&self.central);
        self.out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
        self.out.extend_from_slice(&0u16.to_le_bytes());
        self.out.extend_from_slice(&0u16.to_le_bytes());
        self.out.extend_from_slice(&self.count.to_le_bytes());
        self.out.extend_from_slice(&self.count.to_le_bytes());
        self.out.extend_from_slice(&central_size.to_le_bytes());
        self.out.extend_from_slice(&central_offset.to_le_bytes());
        self.out.extend_from_slice(&0u16.to_le_bytes());
        self.out
    }
}

/// 写出 .apkg 到 `out_path`。`work_dir` 放临时集合文件（写完即删）。
pub async fn write_apkg(
    out_path: &Path,
    work_dir: &Path,
    notes: &[AnkiNote],
    media: &[AnkiMedia],
) -> AppResult<()> {
    if notes.is_empty() {
        return Err(AppError::NotFound("no cards to export".into()));
    }
    std::fs::create_dir_all(work_dir)?;
    let collection_path = work_dir.join(format!("anki-{}.anki2", uuid::Uuid::new_v4()));
    let now_ms = chrono::Utc::now().timestamp_millis();
    let written = write_collection(&collection_path, notes, now_ms).await;
    let collection = written.and_then(|()| Ok(std::fs::read(&collection_path)?));
    let _ = std::fs::remove_file(&collection_path);
    let collection = collection?;

    let mut zip = ZipWriter::new();
    zip.add("collection.anki2", &collection)?;
    let manifest: serde_json::Map<String, Value> = media
        .iter()
        .enumerate()
        .map(|(i, m)| (i.to_string(), Value::String(m.name.clone())))
        .collect();
    zip.add("media", Value::Object(manifest).to_string().as_bytes())?;
    for (i, m) in media.iter().enumerate() {
        zip.add(&i.to_string(), &m.bytes)?;
    }
    let bytes = zip.finish();
    let tmp = out_path.with_extension("apkg.part");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, out_path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::Row as _;

    fn basic(key: &str, deck: &str, front: &str, back: &str) -> AnkiNote {
        AnkiNote {
            key: key.into(),
            deck: deck.into(),
            content: AnkiContent::Basic {
                front: front.into(),
                options: vec![],
                back: back.into(),
            },
            source: "第 1 讲 · 01:02".into(),
            slide: None,
            tags: vec!["CoursePilot".into()],
        }
    }

    #[test]
    fn html_text_escapes_and_breaks_lines() {
        assert_eq!(html_text(" a<b>&c\nd "), "a&lt;b&gt;&amp;c<br>d");
        // 模板语法拆开，不被 Anki 当成挖空。
        assert!(!html_text("{{c1::x}}").contains("{{"));
    }

    #[test]
    fn cloze_field_wraps_answer_and_keeps_spaces() {
        let note = AnkiNote {
            content: AnkiContent::Cloze {
                before: "牛顿第二定律 ".into(),
                answer: "F=ma".into(),
                after: " 描述力与加速度".into(),
            },
            ..basic("k", "D", "", "")
        };
        let fields = note_fields(&note);
        assert_eq!(fields.len(), 3);
        assert_eq!(fields[0], "牛顿第二定律 {{c1::F=ma}} 描述力与加速度");
        assert_eq!(fields[1], "第 1 讲 · 01:02");
    }

    #[test]
    fn cloze_answer_cannot_break_out() {
        assert_eq!(cloze_answer_html("a::b}}"), "a:&#58;b}&#125;");
    }

    #[test]
    fn basic_field_lists_options_and_slide() {
        let mut note = basic("k", "D", "1+1=?", "2");
        if let AnkiContent::Basic { options, .. } = &mut note.content {
            *options = vec!["1".into(), "2".into()];
        }
        note.slide = Some("slide-3.jpg".into());
        let fields = note_fields(&note);
        assert_eq!(
            fields[0],
            "1+1=?<div class=\"cp-options\">A. 1<br>B. 2</div>"
        );
        assert_eq!(fields[3], "<img src=\"slide-3.jpg\">");
    }

    #[test]
    fn ids_are_stable_and_in_range() {
        assert_eq!(deck_id("CoursePilot::物理"), deck_id("CoursePilot::物理"));
        assert_ne!(deck_id("CoursePilot::物理"), deck_id("CoursePilot::化学"));
        assert!(deck_id("x") < (1i64 << 53) && deck_id("x") > 1);
        assert_eq!(note_guid("card-1"), note_guid("card-1"));
        assert_eq!(note_guid("card-1").len(), 20);
    }

    #[test]
    fn checksum_matches_anki_definition() {
        // sha1("hello") = aaf4c61d...，Anki 取前 8 位十六进制。
        assert_eq!(field_checksum("<b>hello</b>"), 0xaaf4_c61d);
    }

    /// 从我们自己写的 zip 里读出一个条目（只认 deflate）。
    fn read_zip_entry(zip: &[u8], wanted: &str) -> Option<Vec<u8>> {
        use std::io::Read as _;
        let mut pos = 0;
        while pos + 30 <= zip.len() && zip[pos..pos + 4] == 0x0403_4b50u32.to_le_bytes() {
            let u16_at = |p: usize| u16::from_le_bytes([zip[p], zip[p + 1]]) as usize;
            let u32_at =
                |p: usize| u32::from_le_bytes([zip[p], zip[p + 1], zip[p + 2], zip[p + 3]]);
            let compressed = u32_at(pos + 18) as usize;
            let name_len = u16_at(pos + 26);
            let extra = u16_at(pos + 28);
            let name = std::str::from_utf8(&zip[pos + 30..pos + 30 + name_len]).ok()?;
            let data_start = pos + 30 + name_len + extra;
            let data = &zip[data_start..data_start + compressed];
            if name == wanted {
                let mut out = Vec::new();
                let mut decoder = flate2::read::DeflateDecoder::new(data);
                decoder.read_to_end(&mut out).ok()?;
                let mut crc = flate2::Crc::new();
                crc.update(&out);
                assert_eq!(crc.sum(), u32_at(pos + 14), "crc of {name}");
                return Some(out);
            }
            pos = data_start + compressed;
        }
        None
    }

    #[tokio::test]
    async fn writes_a_readable_package() {
        let dir = std::env::temp_dir().join(format!("anki-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let out = dir.join("deck.apkg");
        let mut slide_note = basic(
            "c2",
            "CoursePilot::物理::第 2 讲",
            "什么是惯性",
            "保持原状态",
        );
        slide_note.slide = Some("slide-7.png".into());
        let notes = vec![
            basic("c1", "CoursePilot::物理::第 1 讲", "力的单位", "牛顿"),
            slide_note,
            AnkiNote {
                content: AnkiContent::Cloze {
                    before: "".into(),
                    answer: "加速度".into(),
                    after: "与合力成正比".into(),
                },
                ..basic("c3", "CoursePilot::物理::第 1 讲", "", "")
            },
        ];
        let media = vec![AnkiMedia {
            name: "slide-7.png".into(),
            bytes: vec![1, 2, 3],
        }];
        write_apkg(&out, &dir, &notes, &media).await.unwrap();
        let zip = std::fs::read(&out).unwrap();

        let manifest: Value =
            serde_json::from_slice(&read_zip_entry(&zip, "media").unwrap()).unwrap();
        assert_eq!(manifest["0"], "slide-7.png");
        assert_eq!(read_zip_entry(&zip, "0").unwrap(), vec![1, 2, 3]);

        let db_path = dir.join("check.anki2");
        std::fs::write(&db_path, read_zip_entry(&zip, "collection.anki2").unwrap()).unwrap();
        let mut conn = SqliteConnectOptions::new()
            .filename(&db_path)
            .connect()
            .await
            .unwrap();
        let note_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM notes")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(note_count, 3);
        let card_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM cards")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(card_count, 3);
        let row = sqlx::query("SELECT decks, models FROM col")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        let decks: Value = serde_json::from_str(row.get::<&str, _>(0)).unwrap();
        let names: Vec<&str> = decks
            .as_object()
            .unwrap()
            .values()
            .map(|d| d["name"].as_str().unwrap())
            .collect();
        // 父级牌组也建好了。
        for name in [
            "Default",
            "CoursePilot",
            "CoursePilot::物理",
            "CoursePilot::物理::第 1 讲",
            "CoursePilot::物理::第 2 讲",
        ] {
            assert!(names.contains(&name), "missing deck {name}: {names:?}");
        }
        let models: Value = serde_json::from_str(row.get::<&str, _>(1)).unwrap();
        assert_eq!(models[CLOZE_MODEL_ID.to_string()]["type"], 1);
        let cloze_flds: String = sqlx::query_scalar("SELECT flds FROM notes WHERE mid=?")
            .bind(CLOZE_MODEL_ID)
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert!(cloze_flds.starts_with("{{c1::加速度}}与合力成正比\u{1f}"));
        conn.close().await.unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 写一份样例牌组到 `ANKI_SAMPLE_OUT`，拿真 Anki 导入验证用：
    /// `ANKI_SAMPLE_OUT=/tmp/sample.apkg cargo test --lib anki::tests::sample -- --ignored`
    #[tokio::test]
    #[ignore]
    async fn sample_package_for_manual_import() {
        let Ok(out) = std::env::var("ANKI_SAMPLE_OUT") else {
            return;
        };
        let out = std::path::PathBuf::from(out);
        let mut quiz = basic(
            "s1",
            "CoursePilot::物理::第 1 讲",
            "力的单位是？",
            "牛顿\n解析：国际单位制",
        );
        if let AnkiContent::Basic { options, .. } = &mut quiz.content {
            *options = vec!["牛顿".into(), "焦耳".into()];
        }
        quiz.slide = Some("coursepilot-slide-1.png".into());
        let cloze = AnkiNote {
            content: AnkiContent::Cloze {
                before: "合力等于质量乘以".into(),
                answer: "加速度".into(),
                after: "。".into(),
            },
            ..basic("s2", "CoursePilot::物理::第 2 讲", "", "")
        };
        // 1×1 透明 PNG。
        let png = vec![
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52,
            0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89, 0, 0, 0, 0x0d, 0x49,
            0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0, 1, 0, 0, 5, 0, 1, 0x0d, 0x0a, 0x2d, 0xb4, 0, 0,
            0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
        ];
        let media = vec![AnkiMedia {
            name: "coursepilot-slide-1.png".into(),
            bytes: png,
        }];
        write_apkg(&out, &std::env::temp_dir(), &[quiz, cloze], &media)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn refuses_empty_deck() {
        let dir = std::env::temp_dir();
        assert!(write_apkg(&dir.join("never.apkg"), &dir, &[], &[])
            .await
            .is_err());
    }
}

//! Typeset exports: a Word document, and HTML that the app prints to PDF.
//!
//! Both read the same chapters and sections as the Markdown export. Notes to self
//! (`<!-- ... -->`) are removed, chapter names become top-level headings, and a
//! section's own headings move down one level beneath them.

use crate::library::{atomic_write, list_library, strip_notes, Res};
use pulldown_cmark::{Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use std::fs;
use std::io::Write;
use std::path::Path;

pub struct Part {
    pub chapter: String,
    pub sections: Vec<String>,
}

/// The book's title and the text of every section, chapter by chapter.
pub fn book_parts(root: &Path, book: &str) -> Res<(String, Vec<Part>)> {
    let lib = list_library(root)?;
    let b = lib.books.iter().find(|b| b.name == book).ok_or("Book not found")?;
    let parts = b
        .chapters
        .iter()
        .map(|ch| Part {
            chapter: ch.name.clone(),
            sections: ch
                .sections
                .iter()
                .map(|s| strip_notes(&fs::read_to_string(root.join(book).join(&ch.name).join(&s.file)).unwrap_or_default()).trim().to_string())
                .filter(|t| !t.is_empty())
                .collect(),
        })
        .collect();
    Ok((b.title.clone(), parts))
}

fn options() -> Options {
    Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS | Options::ENABLE_TABLES | Options::ENABLE_SMART_PUNCTUATION
}

fn deeper(l: HeadingLevel) -> HeadingLevel {
    match l {
        HeadingLevel::H1 => HeadingLevel::H2,
        HeadingLevel::H2 => HeadingLevel::H3,
        HeadingLevel::H3 => HeadingLevel::H4,
        HeadingLevel::H4 => HeadingLevel::H5,
        _ => HeadingLevel::H6,
    }
}

fn shifted(text: &str) -> impl Iterator<Item = Event<'_>> {
    Parser::new_ext(text, options()).map(|e| match e {
        Event::Start(Tag::Heading { level, id, classes, attrs }) => Event::Start(Tag::Heading { level: deeper(level), id, classes, attrs }),
        Event::End(TagEnd::Heading(level)) => Event::End(TagEnd::Heading(deeper(level))),
        e => e,
    })
}

fn starts_with_heading(text: &str) -> bool {
    text.trim_start().starts_with('#')
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

// ---------------------------------------------------------------- HTML (printed to PDF)

pub fn export_html(root: &Path, book: &str) -> Res<String> {
    let (title, parts) = book_parts(root, book)?;
    let mut out = format!("<header class=\"pr-title\"><h1>{}</h1></header>\n", esc(&title));
    for p in &parts {
        out.push_str(&format!("<section class=\"pr-chapter\"><h1>{}</h1>\n", esc(&p.chapter)));
        for (i, s) in p.sections.iter().enumerate() {
            if i > 0 && !starts_with_heading(s) {
                out.push_str("<p class=\"pr-break\">* * *</p>\n");
            }
            pulldown_cmark::html::push_html(&mut out, shifted(s));
        }
        out.push_str("</section>\n");
    }
    Ok(out)
}

// ---------------------------------------------------------------- Word (.docx)

#[derive(Default, Clone, Copy)]
struct Fmt {
    bold: bool,
    italic: bool,
    strike: bool,
    code: bool,
}

struct ListState {
    num_id: usize,
}

struct Docx {
    body: String,
    para_open: bool,
    para_style: Option<&'static str>,
    pending_num: Option<(usize, usize)>,
    fmt: Fmt,
    lists: Vec<ListState>,
    ordered_nums: Vec<u64>, // start value for each ordered list instance (numId = 2 + index)
    quote: usize,
    in_code: bool,
}

impl Docx {
    fn new() -> Self {
        Docx { body: String::new(), para_open: false, para_style: None, pending_num: None, fmt: Fmt::default(), lists: vec![], ordered_nums: vec![], quote: 0, in_code: false }
    }

    fn open_para(&mut self) {
        if self.para_open {
            return;
        }
        self.body.push_str("<w:p><w:pPr>");
        let style = self.para_style.unwrap_or(if self.in_code { "Code" } else if self.quote > 0 { "Quote" } else if !self.lists.is_empty() { "ListParagraph" } else { "BodyText" });
        self.body.push_str(&format!("<w:pStyle w:val=\"{style}\"/>"));
        if let Some((num, lvl)) = self.pending_num.take() {
            self.body.push_str(&format!("<w:numPr><w:ilvl w:val=\"{lvl}\"/><w:numId w:val=\"{num}\"/></w:numPr>"));
        } else if !self.lists.is_empty() {
            // A second paragraph inside a list item lines up with its text.
            self.body.push_str(&format!("<w:ind w:left=\"{}\"/>", 360 * (self.lists.len() + 1)));
        }
        self.body.push_str("</w:pPr>");
        self.para_open = true;
    }

    fn close_para(&mut self) {
        if self.para_open {
            self.body.push_str("</w:p>");
            self.para_open = false;
        }
    }

    fn styled_para(&mut self, style: &'static str, text: &str) {
        self.close_para();
        self.para_style = Some(style);
        self.open_para();
        self.run(text);
        self.close_para();
        self.para_style = None;
    }

    fn run(&mut self, text: &str) {
        self.open_para();
        let f = self.fmt;
        self.body.push_str("<w:r>");
        if f.bold || f.italic || f.strike || f.code {
            self.body.push_str("<w:rPr>");
            if f.code {
                self.body.push_str("<w:rFonts w:ascii=\"Menlo\" w:hAnsi=\"Menlo\"/>");
            }
            if f.bold {
                self.body.push_str("<w:b/>");
            }
            if f.italic {
                self.body.push_str("<w:i/>");
            }
            if f.strike {
                self.body.push_str("<w:strike/>");
            }
            self.body.push_str("</w:rPr>");
        }
        let mut first = true;
        for line in text.split('\n') {
            if !first {
                self.body.push_str("<w:br/>");
            }
            first = false;
            self.body.push_str(&format!("<w:t xml:space=\"preserve\">{}</w:t>", esc(line)));
        }
        self.body.push_str("</w:r>");
    }

    fn feed<'a>(&mut self, events: impl Iterator<Item = Event<'a>>) {
        for e in events {
            match e {
                Event::Start(Tag::Paragraph) => self.open_para(),
                Event::End(TagEnd::Paragraph) => self.close_para(),
                Event::Start(Tag::Heading { level, .. }) => {
                    self.close_para();
                    self.para_style = Some(match level {
                        HeadingLevel::H1 => "Heading1",
                        HeadingLevel::H2 => "Heading2",
                        HeadingLevel::H3 => "Heading3",
                        _ => "Heading4",
                    });
                    self.open_para();
                }
                Event::End(TagEnd::Heading(_)) => {
                    self.close_para();
                    self.para_style = None;
                }
                Event::Start(Tag::BlockQuote(_)) => {
                    self.close_para();
                    self.quote += 1;
                }
                Event::End(TagEnd::BlockQuote(_)) => {
                    self.close_para();
                    self.quote -= 1;
                }
                Event::Start(Tag::CodeBlock(_)) => {
                    self.close_para();
                    self.in_code = true;
                    self.open_para();
                }
                Event::End(TagEnd::CodeBlock) => {
                    // Drop the newline that ends every code block.
                    if self.body.ends_with("<w:br/><w:t xml:space=\"preserve\"></w:t></w:r>") {
                        let cut = self.body.len() - "<w:br/><w:t xml:space=\"preserve\"></w:t></w:r>".len();
                        self.body.truncate(cut);
                        self.body.push_str("</w:r>");
                    }
                    self.close_para();
                    self.in_code = false;
                }
                Event::Start(Tag::List(start)) => {
                    self.close_para();
                    let num_id = match start {
                        Some(n) => {
                            self.ordered_nums.push(n);
                            1 + self.ordered_nums.len()
                        }
                        None => 1,
                    };
                    self.lists.push(ListState { num_id });
                }
                Event::End(TagEnd::List(_)) => {
                    self.close_para();
                    self.lists.pop();
                }
                Event::Start(Tag::Item) => {
                    self.close_para();
                    let l = self.lists.last().map(|l| l.num_id).unwrap_or(1);
                    self.pending_num = Some((l, self.lists.len().saturating_sub(1).min(8)));
                }
                Event::End(TagEnd::Item) => self.close_para(),
                Event::TaskListMarker(done) => {
                    // A checklist item shows its box instead of a bullet.
                    if let Some((1, _)) = self.pending_num {
                        self.pending_num = None;
                    }
                    self.run(if done { "☒ " } else { "☐ " });
                }
                Event::Start(Tag::Emphasis) => self.fmt.italic = true,
                Event::End(TagEnd::Emphasis) => self.fmt.italic = false,
                Event::Start(Tag::Strong) => self.fmt.bold = true,
                Event::End(TagEnd::Strong) => self.fmt.bold = false,
                Event::Start(Tag::Strikethrough) => self.fmt.strike = true,
                Event::End(TagEnd::Strikethrough) => self.fmt.strike = false,
                Event::Code(t) => {
                    self.fmt.code = true;
                    self.run(&t);
                    self.fmt.code = false;
                }
                Event::Text(t) => self.run(&t),
                Event::SoftBreak => self.run(" "),
                Event::HardBreak => self.run("\n"),
                Event::Rule => self.styled_para("SceneBreak", "* * *"),
                _ => {}
            }
        }
        self.close_para();
    }
}

const RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>"#;

const DOC_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>"#;

const CONTENT_TYPES: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>"#;

const STYLES: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia" w:eastAsia="Georgia" w:cs="Georgia"/><w:sz w:val="24"/><w:szCs w:val="24"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="360" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="BodyText"><w:name w:val="Body Text"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:ind w:firstLine="432"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="2880" w:after="240"/><w:jc w:val="center"/></w:pPr><w:rPr><w:sz w:val="56"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="BodyText"/><w:qFormat/><w:pPr><w:keepNext/><w:pageBreakBefore/><w:spacing w:before="1440" w:after="480"/><w:jc w:val="center"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:sz w:val="36"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="BodyText"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="480" w:after="240"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="BodyText"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="360" w:after="120"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/><w:basedOn w:val="Normal"/><w:next w:val="BodyText"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="3"/></w:pPr><w:rPr><w:b/><w:i/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="120" w:after="120"/><w:ind w:left="720" w:right="720"/></w:pPr><w:rPr><w:i/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:line="240" w:lineRule="auto" w:before="120" w:after="120"/><w:ind w:left="360"/></w:pPr><w:rPr><w:rFonts w:ascii="Menlo" w:hAnsi="Menlo"/><w:sz w:val="19"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="SceneBreak"><w:name w:val="Scene Break"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="240" w:after="240"/><w:jc w:val="center"/></w:pPr></w:style>
</w:styles>"#;

fn numbering(ordered: &[u64]) -> String {
    let lvls = |fmt: &str| -> String {
        (0..9)
            .map(|i| {
                let (num_fmt, text) = if fmt == "bullet" {
                    ("bullet", ["•", "◦", "▪"][i % 3].to_string())
                } else {
                    ("decimal", format!("%{}.", i + 1))
                };
                format!(
                    "<w:lvl w:ilvl=\"{i}\"><w:start w:val=\"1\"/><w:numFmt w:val=\"{num_fmt}\"/><w:lvlText w:val=\"{text}\"/><w:lvlJc w:val=\"left\"/><w:pPr><w:ind w:left=\"{}\" w:hanging=\"360\"/></w:pPr></w:lvl>",
                    720 + 360 * i
                )
            })
            .collect()
    };
    let mut x = String::from(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">"#);
    x.push_str(&format!("<w:abstractNum w:abstractNumId=\"0\"><w:multiLevelType w:val=\"hybridMultilevel\"/>{}</w:abstractNum>", lvls("bullet")));
    x.push_str(&format!("<w:abstractNum w:abstractNumId=\"1\"><w:multiLevelType w:val=\"hybridMultilevel\"/>{}</w:abstractNum>", lvls("decimal")));
    x.push_str("<w:num w:numId=\"1\"><w:abstractNumId w:val=\"0\"/></w:num>");
    for (i, start) in ordered.iter().enumerate() {
        x.push_str(&format!(
            "<w:num w:numId=\"{}\"><w:abstractNumId w:val=\"1\"/><w:lvlOverride w:ilvl=\"0\"><w:startOverride w:val=\"{start}\"/></w:lvlOverride></w:num>",
            i + 2
        ));
    }
    x.push_str("</w:numbering>");
    x
}

/// Build the .docx file's bytes.
pub fn docx_bytes(title: &str, parts: &[Part]) -> Res<Vec<u8>> {
    let mut d = Docx::new();
    d.styled_para("Title", title);
    for p in parts {
        d.styled_para("Heading1", &p.chapter);
        for (i, s) in p.sections.iter().enumerate() {
            if i > 0 && !starts_with_heading(s) {
                d.styled_para("SceneBreak", "* * *");
            }
            d.feed(shifted(s));
        }
    }
    let document = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>{}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>"#,
        d.body
    );
    let mut buf = std::io::Cursor::new(Vec::new());
    {
        let mut z = zip::ZipWriter::new(&mut buf);
        let o = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (name, body) in [
            ("[Content_Types].xml", CONTENT_TYPES.to_string()),
            ("_rels/.rels", RELS.to_string()),
            ("word/_rels/document.xml.rels", DOC_RELS.to_string()),
            ("word/document.xml", document),
            ("word/styles.xml", STYLES.to_string()),
            ("word/numbering.xml", numbering(&d.ordered_nums)),
        ] {
            z.start_file(name, o).map_err(|e| format!("Could not build the Word file: {e}"))?;
            z.write_all(body.as_bytes()).map_err(|e| format!("Could not build the Word file: {e}"))?;
        }
        z.finish().map_err(|e| format!("Could not build the Word file: {e}"))?;
    }
    Ok(buf.into_inner())
}

pub fn export_docx(root: &Path, book: &str, out: &Path) -> Res<()> {
    let (title, parts) = book_parts(root, book)?;
    atomic_write(out, &docx_bytes(&title, &parts)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn word_export_has_styles_lists_and_no_notes() {
        let parts = vec![Part {
            chapter: "One & Two".into(),
            sections: vec![
                "# Opening\n\nA **bold** and *quiet* start.<!-- fix later -->\n\n- first\n- [x] done\n\n1. a\n2. b".into(),
                "Second scene.\n\n> A quote".into(),
            ],
        }];
        let parts: Vec<Part> = parts.into_iter().map(|p| Part { chapter: p.chapter, sections: p.sections.iter().map(|s| strip_notes(s)).collect() }).collect();
        let bytes = docx_bytes("My Book", &parts).unwrap();
        if let Ok(out) = std::env::var("WS_DOCX_OUT") {
            fs::write(out, &bytes).unwrap();
        }
        let mut z = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        let mut doc = String::new();
        std::io::Read::read_to_string(&mut z.by_name("word/document.xml").unwrap(), &mut doc).unwrap();
        assert!(doc.contains("One &amp; Two"));
        assert!(doc.contains(r#"<w:pStyle w:val="Heading2"/>"#), "section heading moves under the chapter");
        assert!(doc.contains("<w:b/>") && doc.contains("<w:i/>"));
        assert!(doc.contains(r#"<w:numId w:val="1"/>"#) && doc.contains(r#"<w:numId w:val="2"/>"#));
        assert!(doc.contains("☒ "));
        assert!(doc.contains("* * *"), "scene break between sections");
        assert!(doc.contains(r#"<w:pStyle w:val="Quote"/>"#));
        assert!(!doc.contains("fix later"));
        assert!(z.by_name("word/numbering.xml").is_ok());
    }

    #[test]
    fn html_export_shifts_headings() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        crate::library::create_book(root, "Bk").unwrap();
        let lib = list_library(root).unwrap();
        let ch = &lib.books[0].chapters[0];
        let rel = format!("Bk/{}/{}", ch.name, ch.sections[0].file);
        crate::library::save_section(root, &rel, "# Head\n\nText <!-- hidden --> here.", None).unwrap();
        crate::library::save_section(root, &rel, "# Head\n\nText <!-- hidden --> here, with *feeling* and **force**.\n\nA second paragraph that runs on long enough to wrap across the line and show the indent.\n\n- one\n- [x] two\n\n> A quote.", Some(&crate::library::hash("# Head\n\nText <!-- hidden --> here."))).unwrap();
        let html = export_html(root, "Bk").unwrap();
        if let Ok(out) = std::env::var("WS_HTML_OUT") {
            fs::write(out, &html).unwrap();
        }
        assert!(html.contains("<h2>Head</h2>"));
        assert!(!html.contains("hidden"));
    }
}

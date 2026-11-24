//! Typeset exports: a Word document and a PDF.
//!
//! Both read the same chapters and sections as the Markdown export. Notes to self
//! (`<!-- ... -->`) are removed, chapter names become top-level headings, and a
//! section's own headings move down one level beneath them.

use crate::library::{atomic_write, list_library, strip_notes, Res};
use pulldown_cmark::{Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

pub struct Part {
    pub chapter: String,
    pub sections: Vec<String>,
    /// The chapter's folder, for finding the pictures its sections use.
    pub dir: PathBuf,
}

/// A picture a section uses, read from the book's `_Images` folder.
struct Picture {
    bytes: Vec<u8>,
    ext: &'static str,
    w: u32,
    h: u32,
}

fn load_picture(dir: &Path, src: &str) -> Option<Picture> {
    let root = dir.ancestors().nth(2)?;
    let path = crate::images::picture_file(root, dir, src)?;
    let bytes = fs::read(&path).ok()?;
    let ext = match path.extension()?.to_str()?.to_lowercase().as_str() {
        "png" => "png",
        "jpg" | "jpeg" => "jpeg",
        "gif" => "gif",
        _ => return None,
    };
    let (w, h) = image::load_from_memory(&bytes).ok().map(|i| image::GenericImageView::dimensions(&i))?;
    Some(Picture { bytes, ext, w, h })
}

/// Screenshots on a Mac are taken at twice the screen's resolution, so show them at 144 pixels
/// per inch, shrunk further when they would not fit. Returns (width, height) in inches.
fn picture_inches(p: &Picture, max_w: f64, max_h: f64) -> (f64, f64) {
    let (mut w, mut h) = (p.w as f64 / 144.0, p.h as f64 / 144.0);
    let k = (max_w / w).min(max_h / h).min(1.0);
    w *= k;
    h *= k;
    (w, h)
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
            dir: root.join(book).join(&ch.name),
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
    in_image: bool,
    dir: PathBuf,
    media: Vec<(String, Vec<u8>)>,
}

impl Docx {
    fn new() -> Self {
        Docx { body: String::new(), para_open: false, para_style: None, pending_num: None, fmt: Fmt::default(), lists: vec![], ordered_nums: vec![], quote: 0, in_code: false, in_image: false, dir: PathBuf::new(), media: vec![] }
    }

    fn picture(&mut self, src: &str) {
        let Some(p) = load_picture(&self.dir, src) else {
            self.run("[picture]");
            return;
        };
        // A picture on its own line is centred, without the paragraph indent.
        const BODY_OPEN: &str = r#"<w:p><w:pPr><w:pStyle w:val="BodyText"/></w:pPr>"#;
        if self.body.ends_with(BODY_OPEN) {
            let cut = self.body.len() - BODY_OPEN.len();
            self.body.truncate(cut);
            self.body.push_str(r#"<w:p><w:pPr><w:pStyle w:val="Figure"/></w:pPr>"#);
        }
        self.open_para();
        let n = self.media.len() + 1;
        let target = format!("image{n}.{}", p.ext);
        let (w, h) = picture_inches(&p, 6.0, 8.0);
        let (cx, cy) = ((w * 914400.0) as u64, (h * 914400.0) as u64);
        self.body.push_str(&format!(
            r#"<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="{cx}" cy="{cy}"/><wp:docPr id="{n}" name="Picture {n}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="{n}" name="{target}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdImg{n}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>"#
        ));
        self.media.push((target, p.bytes));
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
                Event::Start(Tag::Image { dest_url, .. }) => {
                    self.picture(&dest_url);
                    self.in_image = true;
                }
                Event::End(TagEnd::Image) => self.in_image = false,
                Event::Text(_) if self.in_image => {}
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
<w:style w:type="paragraph" w:styleId="Figure"><w:name w:val="Figure"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="240" w:after="240" w:line="240" w:lineRule="auto"/><w:jc w:val="center"/></w:pPr></w:style>
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
            d.dir = p.dir.clone();
            d.feed(shifted(s));
        }
    }
    let document = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><w:body>{}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>"#,
        d.body
    );
    let mut buf = std::io::Cursor::new(Vec::new());
    {
        let mut z = zip::ZipWriter::new(&mut buf);
        let o = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        let pic_rels: String = d.media.iter().enumerate().map(|(i, (t, _))| format!(r#"<Relationship Id="rIdImg{}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/{t}"/>"#, i + 1)).collect();
        let content_types = CONTENT_TYPES.replace(
            r#"<Default Extension="xml" ContentType="application/xml"/>"#,
            r#"<Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="gif" ContentType="image/gif"/>"#,
        );
        for (name, body) in [
            ("[Content_Types].xml", content_types),
            ("_rels/.rels", RELS.to_string()),
            ("word/_rels/document.xml.rels", DOC_RELS.replace("</Relationships>", &format!("{pic_rels}</Relationships>"))),
            ("word/document.xml", document),
            ("word/styles.xml", STYLES.to_string()),
            ("word/numbering.xml", numbering(&d.ordered_nums)),
        ] {
            z.start_file(name, o).map_err(|e| format!("Could not build the Word file: {e}"))?;
            z.write_all(body.as_bytes()).map_err(|e| format!("Could not build the Word file: {e}"))?;
        }
        for (t, bytes) in &d.media {
            z.start_file(format!("word/media/{t}"), o).map_err(|e| format!("Could not build the Word file: {e}"))?;
            z.write_all(bytes).map_err(|e| format!("Could not build the Word file: {e}"))?;
        }
        z.finish().map_err(|e| format!("Could not build the Word file: {e}"))?;
    }
    Ok(buf.into_inner())
}

pub fn export_docx(root: &Path, book: &str, out: &Path) -> Res<()> {
    let (title, parts) = book_parts(root, book)?;
    atomic_write(out, &docx_bytes(&title, &parts)?)
}

// ---------------------------------------------------------------- PDF

use genpdf::elements::{Break, PageBreak, Paragraph};
use genpdf::fonts::{FontData, FontFamily};
use genpdf::style::{Color, Style};
use genpdf::{Alignment, Element, Margins};

/// Serif font files to try, best first: Georgia and Times on the Mac, Liberation on Linux.
const FONT_SETS: &[[&str; 4]] = &[
    [
        "/System/Library/Fonts/Supplemental/Georgia.ttf",
        "/System/Library/Fonts/Supplemental/Georgia Bold.ttf",
        "/System/Library/Fonts/Supplemental/Georgia Italic.ttf",
        "/System/Library/Fonts/Supplemental/Georgia Bold Italic.ttf",
    ],
    [
        "/Library/Fonts/Georgia.ttf",
        "/Library/Fonts/Georgia Bold.ttf",
        "/Library/Fonts/Georgia Italic.ttf",
        "/Library/Fonts/Georgia Bold Italic.ttf",
    ],
    [
        "/System/Library/Fonts/Supplemental/Times New Roman.ttf",
        "/System/Library/Fonts/Supplemental/Times New Roman Bold.ttf",
        "/System/Library/Fonts/Supplemental/Times New Roman Italic.ttf",
        "/System/Library/Fonts/Supplemental/Times New Roman Bold Italic.ttf",
    ],
    [
        "/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSerif-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSerif-Italic.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSerif-BoldItalic.ttf",
    ],
];

fn serif_family() -> Res<FontFamily<FontData>> {
    for set in FONT_SETS {
        let load = |p: &str| fs::read(p).ok().and_then(|b| FontData::new(b, None).ok());
        if let (Some(regular), Some(bold), Some(italic), Some(bold_italic)) = (load(set[0]), load(set[1]), load(set[2]), load(set[3])) {
            return Ok(FontFamily { regular, bold, italic, bold_italic });
        }
    }
    Err("Could not find a font for the PDF (Georgia or Times New Roman).".into())
}

const BODY_PT: u8 = 12;
const INDENT_MM: f64 = 7.0;

struct Pdf {
    doc: genpdf::Document,
    para: Option<Paragraph>,
    /// Style of the block being written (heading size, quote italics).
    block: Style,
    bold: usize,
    italic: usize,
    lists: Vec<Option<u64>>,
    prefix: Option<String>,
    quote: usize,
    in_code: bool,
    space_after: f64,
    align: Alignment,
    boxes: (&'static str, &'static str),
    in_image: bool,
    dir: PathBuf,
}

impl Pdf {
    fn style(&self) -> Style {
        let mut s = self.block;
        if self.bold > 0 {
            s.set_bold();
        }
        if self.italic > 0 || self.quote > 0 {
            s.set_italic();
        }
        s
    }

    fn text(&mut self, t: &str) {
        let style = self.style();
        let prefix = self.prefix.take();
        let p = self.para.get_or_insert_with(Paragraph::default);
        if let Some(pre) = prefix {
            p.push_styled(pre, Style::new());
        }
        if !t.is_empty() {
            p.push_styled(t.to_string(), style);
        }
    }

    fn flush(&mut self) {
        if let Some(mut p) = self.para.take() {
            p.set_alignment(self.align);
            let left = INDENT_MM * (self.lists.len() as f64 + 1.5 * self.quote as f64);
            let right = if self.quote > 0 { INDENT_MM * 1.5 } else { 0.0 };
            self.doc.push(p.padded(Margins::trbl(0, right, self.space_after, left)));
        }
    }

    fn block_para(&mut self, text: &str, style: Style, align: Alignment, before: f64, after: f64) {
        self.flush();
        if before > 0.0 {
            self.doc.push(Break::new(before));
        }
        let mut p = Paragraph::default();
        p.push_styled(text.to_string(), style);
        self.doc.push(p.aligned(align).padded(Margins::trbl(0, 0, after, 0)));
    }

    fn picture(&mut self, src: &str) {
        self.flush();
        let pic = load_picture(&self.dir, src).and_then(|p| {
            let img = image::load_from_memory(&p.bytes).ok()?;
            // Flatten any transparency onto white paper.
            let rgba = img.to_rgba8();
            let mut rgb = image::RgbImage::new(rgba.width(), rgba.height());
            for (x, y, px) in rgba.enumerate_pixels() {
                let a = px[3] as u32;
                let mix = |c: u8| ((c as u32 * a + 255 * (255 - a)) / 255) as u8;
                rgb.put_pixel(x, y, image::Rgb([mix(px[0]), mix(px[1]), mix(px[2])]));
            }
            let indent = INDENT_MM * (self.lists.len() as f64 + 1.5 * self.quote as f64);
            let (w, _) = picture_inches(&p, (165.0 - indent) / 25.4, 200.0 / 25.4);
            let dpi = p.w as f64 / w;
            genpdf::elements::Image::from_dynamic_image(image::DynamicImage::ImageRgb8(rgb)).ok().map(|i| i.with_dpi(dpi).with_alignment(Alignment::Center))
        });
        match pic {
            Some(i) => self.doc.push(i.padded(Margins::trbl(2, 0, 4, 0))),
            None => self.text("[picture]"),
        }
    }

    fn scene_break(&mut self) {
        self.block_para("*   *   *", Style::new(), Alignment::Center, 0.0, 4.0);
    }

    fn feed<'a>(&mut self, events: impl Iterator<Item = Event<'a>>) {
        for e in events {
            match e {
                Event::Start(Tag::Paragraph) => {}
                Event::End(TagEnd::Paragraph) => self.flush(),
                Event::Start(Tag::Heading { level, .. }) => {
                    self.flush();
                    let (size, before) = match level {
                        HeadingLevel::H1 | HeadingLevel::H2 => (15, 1.0),
                        HeadingLevel::H3 => (13, 0.6),
                        _ => (BODY_PT, 0.4),
                    };
                    self.doc.push(Break::new(before));
                    self.block = Style::new().bold().with_font_size(size);
                    self.space_after = 2.5;
                }
                Event::End(TagEnd::Heading(_)) => {
                    self.flush();
                    self.block = Style::new();
                    self.space_after = 3.0;
                }
                Event::Start(Tag::BlockQuote(_)) => {
                    self.flush();
                    self.quote += 1;
                }
                Event::End(TagEnd::BlockQuote(_)) => {
                    self.flush();
                    self.quote -= 1;
                }
                Event::Start(Tag::CodeBlock(_)) => {
                    self.flush();
                    self.in_code = true;
                    self.space_after = 0.0;
                }
                Event::End(TagEnd::CodeBlock) => {
                    self.in_code = false;
                    self.space_after = 3.0;
                    self.doc.push(Break::new(0.5));
                }
                Event::Start(Tag::List(start)) => {
                    self.flush();
                    self.lists.push(start);
                    self.space_after = 1.0;
                }
                Event::End(TagEnd::List(_)) => {
                    self.flush();
                    self.lists.pop();
                    if self.lists.is_empty() {
                        self.space_after = 3.0;
                        self.doc.push(Break::new(0.3));
                    }
                }
                Event::Start(Tag::Item) => {
                    self.flush();
                    let marker = match self.lists.last_mut() {
                        Some(Some(n)) => {
                            let m = format!("{n}.  ");
                            *n += 1;
                            m
                        }
                        _ => "•  ".to_string(),
                    };
                    self.prefix = Some(marker);
                }
                Event::End(TagEnd::Item) => self.flush(),
                Event::TaskListMarker(done) => {
                    // A checklist item shows its box instead of a bullet.
                    self.prefix = Some(format!("{}  ", if done { self.boxes.1 } else { self.boxes.0 }));
                }
                Event::Start(Tag::Emphasis) => self.italic += 1,
                Event::End(TagEnd::Emphasis) => self.italic = self.italic.saturating_sub(1),
                Event::Start(Tag::Strong) => self.bold += 1,
                Event::End(TagEnd::Strong) => self.bold = self.bold.saturating_sub(1),
                Event::Code(t) => self.text(&t),
                Event::Start(Tag::Image { dest_url, .. }) => {
                    self.picture(&dest_url);
                    self.in_image = true;
                }
                Event::End(TagEnd::Image) => self.in_image = false,
                Event::Text(_) if self.in_image => {}
                Event::Text(t) => {
                    if self.in_code {
                        for line in t.lines() {
                            self.text(if line.is_empty() { " " } else { line });
                            self.flush();
                        }
                    } else {
                        self.text(&t);
                    }
                }
                Event::SoftBreak => self.text(" "),
                Event::HardBreak => {
                    let keep = self.space_after;
                    self.space_after = 0.0;
                    self.flush();
                    self.space_after = keep;
                }
                Event::Rule => self.scene_break(),
                _ => {}
            }
        }
        self.flush();
    }
}

/// Build the PDF's bytes: a title page, then each chapter on a new page.
pub fn pdf_bytes(title: &str, parts: &[Part]) -> Res<Vec<u8>> {
    let family = serif_family()?;
    let mut doc = genpdf::Document::new(family);
    doc.set_title(title);
    doc.set_font_size(BODY_PT);
    doc.set_line_spacing(1.35);
    doc.set_paper_size(genpdf::Size::new(215.9, 279.4)); // US Letter
    let mut deco = genpdf::SimplePageDecorator::new();
    deco.set_margins(Margins::trbl(14, 25, 25, 25));
    deco.set_header(|page| {
        // Page numbers sit quietly at the top; the title page has none.
        let label = if page > 1 { page.to_string() } else { " ".into() };
        Paragraph::new(genpdf::style::StyledString::new(label, Style::new().with_font_size(9).with_color(Color::Greyscale(120))))
            .aligned(Alignment::Center)
            .padded(Margins::trbl(0, 0, 10, 0))
    });
    doc.set_page_decorator(deco);

    // Use real check boxes when the font has them.
    let font = doc.font_cache().default_font_family().regular;
    let has = |c: &str| font.glyph_ids(doc.font_cache(), c.chars()).iter().all(|g| *g != 0);
    let boxes = if has("☐☑") { ("☐", "☑") } else if has("○●") { ("○", "●") } else { ("[ ]", "[x]") };

    let mut pdf = Pdf { doc, para: None, block: Style::new(), bold: 0, italic: 0, lists: vec![], prefix: None, quote: 0, in_code: false, space_after: 3.0, align: Alignment::Left, boxes, in_image: false, dir: PathBuf::new() };
    pdf.doc.push(Break::new(12));
    pdf.block_para(title, Style::new().with_font_size(28), Alignment::Center, 0.0, 0.0);
    for p in parts {
        pdf.flush();
        pdf.doc.push(PageBreak::new());
        pdf.block_para(&p.chapter, Style::new().with_font_size(20), Alignment::Center, 5.0, 14.0);
        for (i, s) in p.sections.iter().enumerate() {
            if i > 0 && !starts_with_heading(s) {
                pdf.scene_break();
            }
            pdf.dir = p.dir.clone();
            pdf.feed(shifted(s));
        }
    }
    let mut out = Vec::new();
    pdf.doc.render(&mut out).map_err(|e| format!("Could not build the PDF: {e}"))?;
    Ok(out)
}

pub fn export_pdf(root: &Path, book: &str, out: &Path) -> Res<()> {
    let (title, parts) = book_parts(root, book)?;
    atomic_write(out, &pdf_bytes(&title, &parts)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A library folder with one chapter and a 600x300 screenshot-like picture.
    fn picture_library() -> (tempfile::TempDir, PathBuf) {
        let d = tempfile::tempdir().unwrap();
        let ch = d.path().join("Bk/One");
        fs::create_dir_all(&ch).unwrap();
        fs::create_dir_all(d.path().join("Bk/_Images")).unwrap();
        let img = image::RgbaImage::from_fn(600, 300, |x, y| image::Rgba([(x % 255) as u8, (y % 255) as u8, 160, if x < 30 { 0 } else { 255 }]));
        image::DynamicImage::ImageRgba8(img).save(d.path().join("Bk/_Images/shot one.png")).unwrap();
        (d, ch)
    }

    #[test]
    fn word_export_has_styles_lists_and_no_notes() {
        let (_tmp, dir) = picture_library();
        let parts = vec![Part {
            chapter: "One & Two".into(),
            dir,
            sections: vec![
                "# Opening\n\nA **bold** and *quiet* start.<!-- fix later -->\n\n![a screenshot](<../_Images/shot one.png>)\n\n- first\n- [x] done\n\n1. a\n2. b".into(),
                "Second scene.\n\n> A quote".into(),
            ],
        }];
        let parts: Vec<Part> = parts.into_iter().map(|p| Part { chapter: p.chapter, sections: p.sections.iter().map(|s| strip_notes(s)).collect(), dir: p.dir }).collect();
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
        assert!(z.by_name("word/media/image1.png").is_ok(), "the picture is embedded");
        assert!(doc.contains(r#"r:embed="rIdImg1""#) && doc.contains(r#"<w:pStyle w:val="Figure"/>"#));
        assert!(!doc.contains("a screenshot"), "alt text is not printed");
    }

    #[test]
    fn pdf_export_renders_pages() {
        let (_tmp, dir) = picture_library();
        let parts = vec![
            Part {
                chapter: "One & Two".into(),
                dir,
                sections: vec![
                    "![](<../_Images/shot one.png>)\n\n# Opening\n\nA **bold** and *quiet* start, with “quotes” — and a dash. ".repeat(1) + &"A longer paragraph that keeps going so it wraps across several lines of the page and shows the spacing. ".repeat(12) + "\n\n- first\n- [x] done\n- [ ] open\n  - nested\n\n1. a\n2. b\n\n> A quote that is long enough to wrap onto a second line inside the margins of the page.",
                    "Second scene.\n\n---\n\nAfter a rule.".into(),
                ],
            },
            Part { chapter: "Three".into(), sections: vec!["Last words.".into()], dir: PathBuf::new() },
        ];
        let bytes = pdf_bytes("My Book", &parts).unwrap();
        if let Ok(out) = std::env::var("WS_PDF_OUT") {
            fs::write(out, &bytes).unwrap();
        }
        assert!(bytes.starts_with(b"%PDF"));
        assert!(bytes.len() > 10_000, "fonts and pages were written");
    }

    #[test]
    fn pdf_export_writes_book_without_notes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        crate::library::create_book(root, "Bk").unwrap();
        let lib = list_library(root).unwrap();
        let ch = &lib.books[0].chapters[0];
        let rel = format!("Bk/{}/{}", ch.name, ch.sections[0].file);
        crate::library::save_section(root, &rel, "# Head\n\nText <!-- hidden --> here.", None).unwrap();
        crate::library::save_section(root, &rel, "# Head\n\nText <!-- hidden --> here, with *feeling* and **force**.\n\nA second paragraph that runs on long enough to wrap across the line and show the indent.\n\n- one\n- [x] two\n\n> A quote.", Some(&crate::library::hash("# Head\n\nText <!-- hidden --> here."))).unwrap();
        let (_, parts) = book_parts(root, "Bk").unwrap();
        assert!(parts[0].sections[0].starts_with("# Head"));
        assert!(!parts[0].sections[0].contains("hidden"));
        let out = root.join("Bk.pdf");
        export_pdf(root, "Bk", &out).unwrap();
        assert!(fs::read(&out).unwrap().starts_with(b"%PDF"));
    }
}

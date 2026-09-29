//! Read-only Inno Setup inspector.
//!
//! Parses the setup data stream embedded in a repack's `setup.exe` without
//! executing it: offset table (rDlPtS magic) -> 64-byte version string ->
//! block-filtered (4 KiB CRC chunks) LZMA1 stream -> TSetupHeader -> language
//! entries. Supports Unicode Inno >= 6.0.0 (every current repacker); older or
//! unrecognized layouts return `None` rather than erroring so callers can fall
//! back to generic silent flags.

// Offset-table magics. Only the two >=5.1.5 layouts are parsed; the older
// rDlPtS0x loaders predate the data format we support anyway.
const OFFSET_TABLE_MAGICS: &[[u8; 12]] = &[
    *b"rDlPtS\xCD\xE6\xD7\x7B\x0B\x2A",
    *b"nS5W7dT\x83\xAA\x1B\x0Fj",
];

const VERSION_FIELD_SIZE: usize = 64;
const BLOCK_CHUNK: usize = 4096;

type InspectResult<T> = Result<T, String>;

fn err(message: impl Into<String>) -> String {
    message.into()
}

/// (major, minor, patch, tweak) — Inno's 4-part version, e.g. (6,4,0,1).
type InnoVersion = (u32, u32, u32, u32);

pub struct InnoLanguageInfo {
    pub name: String,
    pub display_name: String,
}

pub enum ShowLanguageDialog {
    Yes,
    No,
    Auto,
}

pub struct InnoSetupInfo {
    pub version: String,
    pub app_name: Option<String>,
    pub languages: Vec<InnoLanguageInfo>,
    pub component_count: u32,
    pub task_count: u32,
    pub show_language_dialog: ShowLanguageDialog,
}

struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn new(buf: &'a [u8]) -> Self {
        Reader { buf, pos: 0 }
    }

    fn take(&mut self, n: usize) -> InspectResult<&'a [u8]> {
        if self.pos + n > self.buf.len() {
            return Err(err(format!(
                "unexpected end of setup header at {} (+{}, len {})",
                self.pos,
                n,
                self.buf.len()
            )));
        }
        let slice = &self.buf[self.pos..self.pos + n];
        self.pos += n;
        Ok(slice)
    }

    fn u8(&mut self) -> InspectResult<u8> {
        Ok(self.take(1)?[0])
    }

    fn u32(&mut self) -> InspectResult<u32> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }

    fn i64(&mut self) -> InspectResult<i64> {
        Ok(i64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }

    fn utf16_string(&mut self) -> InspectResult<String> {
        // Stored as a u32 BYTE count; -1 marks a null string.
        let byte_len = self.u32()?;
        if byte_len == u32::MAX {
            return Ok(String::new());
        }
        let byte_len = byte_len as usize;
        if byte_len > 0x00FF_FFFF {
            return Err(err(format!(
                "implausible utf16 string length {byte_len} at {}",
                self.pos
            )));
        }
        let bytes = self.take(byte_len)?;
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        Ok(String::from_utf16_lossy(&units))
    }

    fn ansi_string(&mut self) -> InspectResult<String> {
        let byte_len = self.u32()?;
        if byte_len == u32::MAX {
            return Ok(String::new());
        }
        let bytes = self.take(byte_len as usize)?;
        Ok(String::from_utf8_lossy(bytes).into_owned())
    }

    fn skip_bytes(&mut self, n: usize) -> InspectResult<()> {
        self.take(n).map(|_| ())
    }
}

/// Packed flag sets: one byte per 8 flags; a 3-byte total is padded to 4.
struct FlagReader<'r, 'a> {
    reader: &'r mut Reader<'a>,
    bit: u8,
    bytes: usize,
}

impl<'r, 'a> FlagReader<'r, 'a> {
    fn new(reader: &'r mut Reader<'a>) -> Self {
        FlagReader {
            reader,
            bit: 0,
            bytes: 0,
        }
    }

    fn add(&mut self) -> InspectResult<()> {
        if self.bit == 0 {
            self.reader.u8()?;
            self.bytes += 1;
        }
        self.bit = (self.bit + 1) % 8;
        Ok(())
    }

    fn finalize(self) -> InspectResult<()> {
        if self.bytes == 3 {
            // 3-byte flag sets are padded to 4 bytes on 32-bit builds.
            self.reader.skip_bytes(1)?;
        }
        Ok(())
    }
}

fn parse_version_field(field: &[u8]) -> Option<InnoVersion> {
    let end = field.iter().position(|b| *b == 0).unwrap_or(field.len());
    let text = std::str::from_utf8(&field[..end]).ok()?;
    if !text.contains("Inno Setup") {
        return None;
    }
    let open = text.find('(')?;
    let close = text[open + 1..]
        .find(')')
        .map(|i| open + 1 + i)
        .unwrap_or(text.len());
    let digits: Vec<u32> = text[open + 1..close]
        .split('.')
        .filter_map(|part| part.trim().parse::<u32>().ok())
        .collect();
    if digits.is_empty() || digits.len() > 4 {
        return None;
    }
    let mut version = [0u32; 4];
    for (i, d) in digits.iter().enumerate() {
        version[i] = *d;
    }
    Some((version[0], version[1], version[2], version[3]))
}

/// The >=5.1.5 offset table: magic[12], revision u32, total u32, exe_offset
/// u32, exe_uncompressed_size u32, exe_checksum u32, header_offset u32,
/// data_offset u32, table_crc u32.
fn find_header_offset(file: &[u8]) -> Option<u32> {
    for magic in OFFSET_TABLE_MAGICS {
        let mut scan = 0usize;
        while scan + magic.len() <= file.len() {
            let window = &file[scan..scan + magic.len()];
            if window != magic.as_slice() {
                scan += 1;
                continue;
            }

            let table = &file[scan..];
            if table.len() >= 44 {
                let header_offset = u32::from_le_bytes(table[32..36].try_into().unwrap());
                let data_offset = u32::from_le_bytes(table[36..40].try_into().unwrap());
                if (header_offset as usize) < file.len()
                    && (data_offset as usize) < file.len()
                    && header_offset > 0
                {
                    return Some(header_offset);
                }
            }
            scan += 1;
        }
    }
    None
}

/// Header streams are stored as 4 KiB blocks each prefixed with a CRC32;
/// concatenate the payloads and let the CRC flag corruption (best-effort —
/// a bad CRC still returns the data so a repacker quirk doesn't kill the
/// whole inspection).
fn unfilter_blocks(stored: &[u8]) -> InspectResult<Vec<u8>> {
    let mut out = Vec::with_capacity(stored.len());
    let mut pos = 0usize;
    while pos < stored.len() {
        if pos + 4 > stored.len() {
            return Err(err("truncated header block checksum"));
        }
        let expected = u32::from_le_bytes(stored[pos..pos + 4].try_into().unwrap());
        pos += 4;
        let chunk = (stored.len() - pos).min(BLOCK_CHUNK);
        let payload = &stored[pos..pos + chunk];
        if crc32fast::hash(payload) != expected {
            return Err(err("header block CRC mismatch"));
        }
        out.extend_from_slice(payload);
        pos += chunk;
    }
    Ok(out)
}

/// Inno's LZMA1 container is just the 5-byte raw header (props byte + LE dict
/// size) followed by the compressed stream — no uncompressed-size field, so
/// tell lzma-rs none is present and let the stream's EOS marker stop it.
fn decompress_lzma1(stream: &[u8]) -> InspectResult<Vec<u8>> {
    if stream.len() < 5 {
        return Err(err("inno lzma stream too short"));
    }

    let mut output = Vec::new();
    let mut cursor = std::io::Cursor::new(stream);
    lzma_rs::lzma_decompress_with_options(
        &mut cursor,
        &mut output,
        &lzma_rs::decompress::Options {
            unpacked_size: lzma_rs::decompress::UnpackedSize::UseProvided(None),
            allow_incomplete: true,
            memlimit: None,
        },
    )
    .map_err(|e| err(format!("inno header lzma decompress failed: {e}")))?;
    Ok(output)
}

fn parse_language_entries(
    reader: &mut Reader,
    count: u32,
    is_640: bool,
) -> InspectResult<Vec<InnoLanguageInfo>> {
    let mut languages = Vec::with_capacity(count.min(64) as usize);
    for _ in 0..count {
        let name = reader.utf16_string()?;
        let display_name = reader.utf16_string()?;
        // dialog/title/welcome/copyright font names
        for _ in 0..4 {
            reader.utf16_string()?;
        }
        // Data + per-language license/info blobs are ANSI strings; the
        // u32 is a byte count either way so utf16_string() would consume
        // the same bytes, but ansi_string() decodes them correctly.
        for _ in 0..4 {
            reader.ansi_string()?;
        }
        reader.u32()?; // language_id
        if !is_640 {
            reader.take(2)?; // code_page
        }
        reader.skip_bytes(16)?; // four font sizes
        if !is_640 {
            reader.take(4)?; // no_letter_spacing (>=6.0.0)
        }
        if is_640 {
            reader.u8()?; // right_to_left
        }
        languages.push(InnoLanguageInfo { name, display_name });
    }
    Ok(languages)
}

fn parse_header(data: &[u8], version: InnoVersion) -> InspectResult<InnoSetupInfo> {
    let mut reader = Reader::new(data);
    let is_630 = version >= (6, 3, 0, 0);
    let is_640 = version >= (6, 4, 0, 0);
    let is_642 = version >= (6, 4, 2, 0);

    let app_name = reader.utf16_string()?;
    // 29 fixed binary strings follow, then >=6.3.0 adds the two
    // architecture expression strings and >=6.4.2 the close-applications
    // filter before the ansi license block.
    for _ in 0..29 {
        reader.utf16_string()?;
    }
    if is_630 {
        reader.utf16_string()?; // architectures_allowed_expr
        reader.utf16_string()?; // architectures_installed_in_64bit_mode_expr
    }
    if is_642 {
        reader.utf16_string()?; // close_applications_filter_excludes
    }
    reader.ansi_string()?; // license_text
    reader.ansi_string()?; // info_before
    reader.ansi_string()?; // info_after
    reader.utf16_string()?; // compiled_code

    let language_count = reader.u32()?;
    // message, permission, type counts — entries we don't consume
    for _ in 0..3 {
        reader.u32()?;
    }
    let component_count = reader.u32()?;
    let task_count = reader.u32()?;
    // directory/file/data/icon/ini/registry/delete/uninstall-delete/
    // run/uninstall-run counts
    for _ in 0..10 {
        reader.u32()?;
    }

    reader.skip_bytes(20)?; // windows_version_range
    if !is_640 {
        reader.skip_bytes(8)?; // back_color, back_color2
    }

    reader.u8()?; // wizard_style
    reader.u32()?; // wizard_resize_percent_x
    reader.u32()?; // wizard_resize_percent_y
    reader.u8()?; // image_alpha_format

    if is_640 {
        reader.skip_bytes(4 + 44)?; // sha256 prefix + pbkdf2 salt blob
    } else {
        reader.skip_bytes(20 + 8)?; // sha1 + password salt
    }

    reader.i64()?; // extra_disk_space_required
    reader.u32()?; // slices_per_disk
    reader.u8()?; // uninstall_log_mode
    reader.u8()?; // dir_exists_warning
    reader.u8()?; // privileges_required
    reader.u8()?; // privileges_required_override_allowed (2 flags, 1 byte)

    let show_language_dialog = match reader.u8()? {
        0 => ShowLanguageDialog::Yes,
        1 => ShowLanguageDialog::No,
        _ => ShowLanguageDialog::Auto,
    };
    reader.u8()?; // language_detection
    reader.u8()?; // compression enum

    if !is_630 {
        reader.u8()?; // architectures_allowed flags
        reader.u8()?; // architectures_installed_in_64bit_mode flags
    }

    reader.u8()?; // disable_dir_page
    reader.u8()?; // disable_program_group_page
    reader.take(8)?; // uninstall_display_size u64

    // Stored flag set. Count the adds the format performs for this version,
    // mirroring innoextract's flagreader sequence.
    let mut flags = FlagReader::new(&mut reader);
    for _ in 0..5 {
        flags.add()?; // DisableStartupPrompt..AlwaysUsePersonalGroup
    }
    if !is_640 {
        for _ in 0..4 {
            flags.add()?; // WindowVisible..WindowStartMaximized
        }
    }
    for _ in 0..4 {
        flags.add()?; // EnableDirDoesntExistWarning..DisableFinishedPage
    }
    flags.add()?; // UsePreviousAppDir
    if !is_640 {
        flags.add()?; // BackColorHorizontal
    }
    for _ in 0..3 {
        flags.add()?; // UsePreviousGroup..UsePreviousSetupType
    }
    for _ in 0..6 {
        flags.add()?; // DisableReadyMemo..DisableReadyPage
    }
    for _ in 0..3 {
        flags.add()?; // AlwaysShowDirOnReadyPage..AllowUNCPath
    }
    for _ in 0..5 {
        flags.add()?; // UserInfoPage..ShowTasksTreeLines
    }
    for _ in 0..5 {
        flags.add()?; // AllowCancelDuringInstall..EncryptionUsed
    }
    for _ in 0..4 {
        flags.add()?; // SetupLogging..DisableWelcomePage
    }
    for _ in 0..3 {
        flags.add()?; // CloseApplications..AllowNetworkDrive
    }
    flags.add()?; // ForceCloseApplications
    for _ in 0..3 {
        flags.add()?; // AppNameHasConsts..WizardResizable
    }
    if is_630 {
        flags.add()?; // UninstallLogging
    }
    flags.finalize()?;

    let languages = parse_language_entries(&mut reader, language_count, is_640)?;

    Ok(InnoSetupInfo {
        version: format!("{}.{}.{}.{}", version.0, version.1, version.2, version.3),
        app_name: if app_name.is_empty() {
            None
        } else {
            Some(app_name)
        },
        languages,
        component_count,
        task_count,
        show_language_dialog,
    })
}

pub fn inspect(setup_path: &str) -> InspectResult<Option<InnoSetupInfo>> {
    let file =
        std::fs::read(setup_path).map_err(|e| err(format!("could not read installer: {e}")))?;

    let Some(header_offset) = find_header_offset(&file) else {
        return Ok(None);
    };

    let region = &file[header_offset as usize..];
    if region.len() < VERSION_FIELD_SIZE + 9 {
        return Ok(None);
    }

    let Some(version) = parse_version_field(&region[..VERSION_FIELD_SIZE]) else {
        return Ok(None);
    };
    if version < (6, 0, 0, 0) {
        return Ok(None);
    }

    let block = &region[VERSION_FIELD_SIZE..];
    let expected_crc = u32::from_le_bytes(block[0..4].try_into().unwrap());
    let stored_size = u32::from_le_bytes(block[4..8].try_into().unwrap());
    let compressed = block[8];
    if crc32fast::hash(&block[4..9]) != expected_crc {
        return Err(err("header stream CRC mismatch"));
    }
    if block.len() < 9 + stored_size as usize {
        return Err(err("header stream truncated"));
    }

    let stored = &block[9..9 + stored_size as usize];
    let stream = unfilter_blocks(stored)?;
    let decompressed = if compressed != 0 {
        decompress_lzma1(&stream)?
    } else {
        stream
    };

    let info = parse_header(&decompressed, version)?;
    Ok(Some(info))
}

#[cfg(test)]
mod tests {
    use super::*;

    // A real Inno-made setup.exe (e.g. innosetup-6.x.x.exe) — point
    // INNO_TEST_EXE at it. Skipped without the fixture; the file is too
    // large to commit.
    #[test]
    fn parses_real_inno_setup() {
        let Ok(path) = std::env::var("INNO_TEST_EXE") else {
            return;
        };
        let info = inspect(&path)
            .expect("inspect failed")
            .expect("expected a supported Inno setup");
        assert!(info.version.starts_with('6'), "version {}", info.version);
        assert!(
            info.app_name.as_deref().unwrap_or_default().len() > 0,
            "app_name empty — header misaligned"
        );
        assert!(
            info.component_count < 10_000 && info.task_count < 10_000,
            "implausible counts {} / {} — header misaligned",
            info.component_count,
            info.task_count
        );
        for language in &info.languages {
            assert!(!language.name.is_empty());
        }
        println!(
            "version={} app={:?} langs={:?} components={} tasks={} show_dialog={}",
            info.version,
            info.app_name,
            info.languages
                .iter()
                .map(|l| format!("{} ({})", l.name, l.display_name))
                .collect::<Vec<_>>(),
            info.component_count,
            info.task_count,
            match info.show_language_dialog {
                ShowLanguageDialog::Yes => "yes",
                ShowLanguageDialog::No => "no",
                ShowLanguageDialog::Auto => "auto",
            }
        );
    }
}

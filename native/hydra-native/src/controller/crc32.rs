//! Reflected CRC-32 (poly 0xEDB88320, zlib flavor) as used by Sony BT reports.
//! Head byte 0xA2 seeds output-report checksums, 0xA1 validates input reports.
//! If the output CRC is wrong the controller silently ignores the report.

const POLY: u32 = 0xEDB8_8320;

const fn build_table() -> [u32; 256] {
    let mut table = [0u32; 256];
    let mut i = 0usize;
    while i < 256 {
        let mut c = i as u32;
        let mut k = 0;
        while k < 8 {
            c = if c & 1 != 0 { (c >> 1) ^ POLY } else { c >> 1 };
            k += 1;
        }
        table[i] = c;
        i += 1;
    }
    table
}

static TABLE: [u32; 256] = build_table();

pub fn crc32(data: &[u8]) -> u32 {
    let mut c = 0xFFFF_FFFFu32;
    for &b in data {
        c = TABLE[((c ^ b as u32) & 0xFF) as usize] ^ (c >> 8);
    }
    !c
}

/// CRC over a synthetic buffer: single head byte followed by `data`.
/// Equivalent to DS4Windows `Crc32.Compute([head] ++ payload)`.
pub fn crc32_with_head(head: u8, data: &[u8]) -> u32 {
    let mut c = 0xFFFF_FFFFu32;
    c = TABLE[((c ^ head as u32) & 0xFF) as usize] ^ (c >> 8);
    for &b in data {
        c = TABLE[((c ^ b as u32) & 0xFF) as usize] ^ (c >> 8);
    }
    !c
}

pub const BT_OUTPUT_HEAD: u8 = 0xA2;
pub const BT_INPUT_HEAD: u8 = 0xA1;

/// Trailing CRC position for 78-byte BT reports.
pub const BT_CRC_OFFSET: usize = 74;

/// Write the output-report checksum into the tail of a 78-byte BT buffer.
pub fn seal_bt_output(report: &mut [u8]) {
    let crc = crc32_with_head(BT_OUTPUT_HEAD, &report[..BT_CRC_OFFSET]);
    report[BT_CRC_OFFSET..BT_CRC_OFFSET + 4].copy_from_slice(&crc.to_le_bytes());
}

/// Validate an inbound BT report's trailing CRC. Clones send garbage CRCs —
/// callers should tolerate failures (count/warn, not drop).
pub fn bt_input_crc_valid(report: &[u8]) -> bool {
    if report.len() < BT_CRC_OFFSET + 4 {
        return false;
    }
    let expected = u32::from_le_bytes([
        report[BT_CRC_OFFSET],
        report[BT_CRC_OFFSET + 1],
        report[BT_CRC_OFFSET + 2],
        report[BT_CRC_OFFSET + 3],
    ]);
    crc32_with_head(BT_INPUT_HEAD, &report[..BT_CRC_OFFSET]) == expected
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zlib_crc_known_vector() {
        // Canonical zlib CRC-32 check value.
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
    }

    #[test]
    fn head_byte_changes_checksum() {
        let payload = [0x11u8; 74];
        assert_ne!(
            crc32_with_head(BT_OUTPUT_HEAD, &payload),
            crc32_with_head(BT_INPUT_HEAD, &payload)
        );
    }

    #[test]
    fn seal_round_trips() {
        let mut report = [0u8; 78];
        report[0] = 0x11;
        report[3] = 0x07;
        report[8] = 0xFF;
        seal_bt_output(&mut report);
        let expected = crc32_with_head(BT_OUTPUT_HEAD, &report[..BT_CRC_OFFSET]);
        let stored = u32::from_le_bytes([report[74], report[75], report[76], report[77]]);
        assert_eq!(expected, stored);
    }
}

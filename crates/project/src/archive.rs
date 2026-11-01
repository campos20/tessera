//! `.tessera` archives: an uncompressed (stored) zip holding `project.json` and the audio
//! files. Audio is most of the size and barely compresses, so storing keeps this small and
//! dependency-free. Only archives written by [`write`] (or any zip using the stored method)
//! can be read.

use crate::ProjectError;

const LOCAL_HEADER: u32 = 0x0403_4b50;
const CENTRAL_HEADER: u32 = 0x0201_4b50;
const END_OF_CENTRAL: u32 = 0x0605_4b50;
/// Language-encoding flag: file names are UTF-8.
const UTF8_FLAG: u16 = 1 << 11;

/// Builds an archive from `(path, bytes)` entries. Paths must pass [`check_path`].
pub fn write(entries: &[(String, Vec<u8>)]) -> Result<Vec<u8>, ProjectError> {
    let mut out = Vec::new();
    let mut central = Vec::new();
    for (name, data) in entries {
        check_path(name)?;
        let size = u32::try_from(data.len()).map_err(|_| invalid("entry larger than 4 GiB"))?;
        let offset = u32::try_from(out.len()).map_err(|_| invalid("archive larger than 4 GiB"))?;
        let crc = crc32(data);
        let name_len = name.len() as u16;

        put32(&mut out, LOCAL_HEADER);
        put16(&mut out, 20); // version needed
        put16(&mut out, UTF8_FLAG);
        put16(&mut out, 0); // stored
        put32(&mut out, 0); // mod time/date
        put32(&mut out, crc);
        put32(&mut out, size);
        put32(&mut out, size);
        put16(&mut out, name_len);
        put16(&mut out, 0);
        out.extend_from_slice(name.as_bytes());
        out.extend_from_slice(data);

        put32(&mut central, CENTRAL_HEADER);
        put16(&mut central, 20); // version made by
        put16(&mut central, 20);
        put16(&mut central, UTF8_FLAG);
        put16(&mut central, 0);
        put32(&mut central, 0);
        put32(&mut central, crc);
        put32(&mut central, size);
        put32(&mut central, size);
        put16(&mut central, name_len);
        put16(&mut central, 0); // extra
        put16(&mut central, 0); // comment
        put16(&mut central, 0); // disk
        put16(&mut central, 0); // internal attrs
        put32(&mut central, 0); // external attrs
        put32(&mut central, offset);
        central.extend_from_slice(name.as_bytes());
    }
    let central_offset =
        u32::try_from(out.len()).map_err(|_| invalid("archive larger than 4 GiB"))?;
    let count = u16::try_from(entries.len()).map_err(|_| invalid("too many entries"))?;
    out.extend_from_slice(&central);
    put32(&mut out, END_OF_CENTRAL);
    put16(&mut out, 0);
    put16(&mut out, 0);
    put16(&mut out, count);
    put16(&mut out, count);
    put32(&mut out, central.len() as u32);
    put32(&mut out, central_offset);
    put16(&mut out, 0);
    Ok(out)
}

/// Reads every entry of a stored zip, verifying CRCs and paths.
pub fn read(bytes: &[u8]) -> Result<Vec<(String, Vec<u8>)>, ProjectError> {
    // The end-of-central-directory record is the last 22 bytes plus an optional comment.
    let eocd = (0..bytes.len().saturating_sub(21))
        .rev()
        .take(22 + u16::MAX as usize)
        .find(|&i| get32(bytes, i) == Some(END_OF_CENTRAL))
        .ok_or_else(|| invalid("not a .tessera archive"))?;
    let count = get16(bytes, eocd + 10).ok_or_else(|| invalid("truncated archive"))? as usize;
    let mut pos = get32(bytes, eocd + 16).ok_or_else(|| invalid("truncated archive"))? as usize;

    let mut entries = Vec::with_capacity(count);
    for _ in 0..count {
        if get32(bytes, pos) != Some(CENTRAL_HEADER) {
            return Err(invalid("corrupt central directory"));
        }
        let field =
            |off: usize| get16(bytes, pos + off).ok_or_else(|| invalid("truncated archive"));
        let field32 =
            |off: usize| get32(bytes, pos + off).ok_or_else(|| invalid("truncated archive"));
        let method = field(10)?;
        let crc = field32(16)?;
        let size = field32(20)? as usize;
        let name_len = field(28)? as usize;
        let extra_len = field(30)? as usize;
        let comment_len = field(32)? as usize;
        let local = field32(42)? as usize;
        let name = bytes
            .get(pos + 46..pos + 46 + name_len)
            .and_then(|n| std::str::from_utf8(n).ok())
            .ok_or_else(|| invalid("bad entry name"))?
            .to_string();
        pos += 46 + name_len + extra_len + comment_len;

        if method != 0 {
            return Err(invalid(&format!(
                "{name}: compressed entries are not supported"
            )));
        }
        check_path(&name)?;
        if get32(bytes, local) != Some(LOCAL_HEADER) {
            return Err(invalid("corrupt local header"));
        }
        let local_name =
            get16(bytes, local + 26).ok_or_else(|| invalid("truncated archive"))? as usize;
        let local_extra =
            get16(bytes, local + 28).ok_or_else(|| invalid("truncated archive"))? as usize;
        let start = local + 30 + local_name + local_extra;
        let data = bytes
            .get(start..start + size)
            .ok_or_else(|| invalid("truncated entry"))?
            .to_vec();
        if crc32(&data) != crc {
            return Err(invalid(&format!("{name}: checksum mismatch")));
        }
        entries.push((name, data));
    }
    Ok(entries)
}

/// Accepts only plain relative paths (`project.json`, `audio/1-take.wav`): no absolute
/// paths, drive letters, backslashes, `.`/`..` components or empty segments. This is what
/// stops a crafted archive from writing outside the project folder.
pub fn check_path(path: &str) -> Result<(), ProjectError> {
    let ok = !path.is_empty()
        && path.len() <= 255
        && !path.contains('\\')
        && !path.contains(':')
        && !path.contains('\0')
        && path
            .split('/')
            .all(|seg| !seg.is_empty() && seg != "." && seg != "..");
    if ok {
        Ok(())
    } else {
        Err(invalid(&format!("unsafe path in archive: {path:?}")))
    }
}

fn invalid(msg: &str) -> ProjectError {
    ProjectError::Invalid(msg.to_string())
}

fn put16(out: &mut Vec<u8>, v: u16) {
    out.extend_from_slice(&v.to_le_bytes());
}

fn put32(out: &mut Vec<u8>, v: u32) {
    out.extend_from_slice(&v.to_le_bytes());
}

fn get16(b: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(b.get(at..at + 2)?.try_into().ok()?))
}

fn get32(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(at..at + 4)?.try_into().ok()?))
}

/// CRC-32 (IEEE), as zip requires.
pub fn crc32(data: &[u8]) -> u32 {
    static TABLE: std::sync::OnceLock<[u32; 256]> = std::sync::OnceLock::new();
    let table = TABLE.get_or_init(|| {
        let mut t = [0u32; 256];
        for (n, slot) in t.iter_mut().enumerate() {
            let mut c = n as u32;
            for _ in 0..8 {
                c = if c & 1 != 0 {
                    0xEDB8_8320 ^ (c >> 1)
                } else {
                    c >> 1
                };
            }
            *slot = c;
        }
        t
    });
    !data.iter().fold(!0u32, |c, &b| {
        table[((c ^ u32::from(b)) & 0xff) as usize] ^ (c >> 8)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_entries() {
        let entries = vec![
            (
                "project.json".to_string(),
                b"{\"schemaVersion\":1}".to_vec(),
            ),
            (
                "audio/1-voz\u{e3}o.wav".to_string(),
                (0..=255u8).cycle().take(70_000).collect(),
            ),
            ("audio/empty.flac".to_string(), Vec::new()),
        ];
        assert_eq!(read(&write(&entries).unwrap()).unwrap(), entries);
    }

    #[test]
    fn crc_matches_reference() {
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
    }

    #[test]
    fn rejects_unsafe_paths() {
        for bad in [
            "../evil",
            "/etc/passwd",
            "audio/../../x",
            "C:/x",
            "a\\b",
            "",
            "a//b",
            "./a",
        ] {
            assert!(check_path(bad).is_err(), "{bad:?}");
            assert!(write(&[(bad.to_string(), vec![])]).is_err(), "{bad:?}");
        }
        assert!(check_path("audio/3-take 2.wav").is_ok());
    }

    #[test]
    fn rejects_unsafe_paths_inside_crafted_archives() {
        // Build a valid archive, then rewrite the stored name to a traversal path.
        let mut bytes = write(&[("aaaaaaa".to_string(), b"x".to_vec())]).unwrap();
        let text = b"aaaaaaa";
        for i in 0..bytes.len() - text.len() {
            if &bytes[i..i + text.len()] == text {
                bytes[i..i + text.len()].copy_from_slice(b"../evil");
            }
        }
        assert!(
            read(&bytes)
                .unwrap_err()
                .to_string()
                .contains("unsafe path")
        );
    }

    #[test]
    fn detects_corruption_and_garbage() {
        let mut bytes = write(&[("a".to_string(), b"hello".to_vec())]).unwrap();
        let pos = bytes.windows(5).position(|w| w == b"hello").unwrap();
        bytes[pos] = b'j';
        assert!(read(&bytes).unwrap_err().to_string().contains("checksum"));
        assert!(read(b"not a zip at all, definitely not").is_err());
        assert!(read(&[]).is_err());
        let ok = write(&[("a".to_string(), b"hello".to_vec())]).unwrap();
        assert!(read(&ok[..ok.len() - 5]).is_err());
    }
}

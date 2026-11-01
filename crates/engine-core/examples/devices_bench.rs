//! Per-device processing cost: `cargo run --release -p engine-core --example devices_bench`.

use std::time::Instant;

use engine_core::devices::{DeviceKind, ProcessContext, create};

fn main() {
    let sr = 48_000.0;
    let seconds = 10;
    let ctx = ProcessContext { tempo: 120.0 };
    for &kind in DeviceKind::ALL {
        let mut d = create(kind, sr);
        // Enable every EQ band so the EQ is measured at its heaviest.
        if kind == DeviceKind::Eq {
            for band in 0..8 {
                d.set_param(band * 5, 1.0);
                d.set_param(band * 5 + 3, 3.0);
            }
        }
        let mut l = [0f32; 128];
        let mut r = [0f32; 128];
        let blocks = seconds * sr as usize / 128;
        let start = Instant::now();
        for b in 0..blocks {
            for i in 0..128 {
                let t = (b * 128 + i) as f32 / sr as f32;
                l[i] = (t * 1382.0).sin() * 0.3;
                r[i] = (t * 1777.0).sin() * 0.3;
            }
            d.process(&mut l, &mut r, &ctx);
        }
        let ms = start.elapsed().as_secs_f64() * 1000.0;
        println!(
            "{:<11} {:>7.1} ms per {seconds} s ({:.0}× real time)",
            kind.name(),
            ms,
            seconds as f64 * 1000.0 / ms
        );
    }
}
